import { eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { users as usersTable, workspaces as workspacesTable } from '../../db/schema.js';

/**
 * Who may use the self-hosted Firecracker fleet.
 *
 * The fleet runs on hardware we own, with a memory budget that fits a couple of
 * concurrent runs. It is not a product surface yet — it is one box, and the
 * point of this gate is that turning `FLEET_ENABLED` on for the backend does
 * not simultaneously turn it on for every workspace that happens to configure
 * credentials.
 *
 * # Fail closed, and not in the UI
 *
 * `FLEET_ALLOWED_EMAILS` unset means NOBODY, not everybody. That is the
 * opposite of the obvious default and it is deliberate: the failure mode of
 * getting it backwards is "the fleet quietly serves people it should not",
 * which is exactly the shape of the billing `clientGate` bug this codebase
 * already paid for — a paywall that read as opt-in, so the CLI, the MCP server
 * and plain `curl` all bypassed it with no error, no log and no metric.
 *
 * For the same reason the gate is enforced where the work happens — at dispatch
 * and at credential-write — rather than by filtering a list the desktop
 * renders. Hiding a provider from one client is not a gate; it is a decoration
 * that three other callers walk straight past.
 */

/** Parsed once per process. The env is not going to change under us. */
let cachedRaw: string | undefined;
let cachedSet: Set<string> | null = null;

function allowedEmails(): Set<string> {
  const raw = process.env.FLEET_ALLOWED_EMAILS ?? '';
  if (cachedSet && cachedRaw === raw) return cachedSet;
  cachedRaw = raw;
  cachedSet = new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  return cachedSet;
}

/** Exposed for tests, which need to change the env between cases. */
export function resetFleetAccessCache(): void {
  cachedSet = null;
  cachedRaw = undefined;
}

/**
 * True when this email may use the fleet.
 *
 * Case-insensitive, because an allowlist that lets `Tom@Example.com` through
 * and refuses `tom@example.com` is a support ticket rather than a policy.
 */
export function isFleetAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().has(email.trim().toLowerCase());
}

/** Whether anyone at all is allowed — used only to explain a refusal. */
export function fleetAllowlistIsEmpty(): boolean {
  return allowedEmails().size === 0;
}

/**
 * True when the workspace's owner is on the allowlist.
 *
 * Keyed on the OWNER rather than on whoever triggered the task. A task can be
 * dispatched by a webhook, the poller, a scheduled sweep or another member —
 * none of which has a user attached — and a gate that silently passes when it
 * cannot identify a caller is not a gate at all. The owner is the one identity
 * every task provably has.
 */
export async function workspaceMayUseFleet(workspaceId: string): Promise<boolean> {
  if (fleetAllowlistIsEmpty()) return false; // fail closed, cheaply
  const rows = await getDbClient()
    .select({ email: usersTable.email })
    .from(workspacesTable)
    .innerJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return isFleetAllowedEmail(rows[0]?.email);
}

/**
 * The message a refusal carries. Deliberately says which of the two reasons it
 * is: "nobody is allowed" is a deployment that forgot its config, and "you are
 * not on the list" is working as intended. Reading one as the other is an hour.
 */
export function fleetRefusalReason(): string {
  return fleetAllowlistIsEmpty()
    ? 'the self-hosted fleet has no allowlist configured (FLEET_ALLOWED_EMAILS is empty), so it is available to nobody'
    : 'this workspace is not on the self-hosted fleet allowlist';
}
