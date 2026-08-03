import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { integrations as integrationsTable } from '../../db/schema.js';
import {
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  type EncryptedEnvelope,
} from '../tokenCrypto.js';
import { FleetCapacityError, FleetClient } from './client.js';
import { pickFleetHost } from '../fleetHosts.js';

const INTEGRATION_TYPE = 'selfhosted';

interface SelfHostedIntegrationConfig {
  /** The workspace's own Claude credential — an OAuth token from a Claude
   *  subscription, or a Console API key. This is the ONE secret a user supplies,
   *  and the only key this config carries. */
  anthropicKeyEnc?: EncryptedEnvelope;

  // Legacy, read nowhere. Both were fields on the settings card and neither was
  // ever the workspace's to give: `fleetTokenEnc` authenticated the BACKEND to a
  // host, and `fleetEndpoint` chose WHICH host, which is the registry's job.
  // They live in deployment config now (FLEET_API_TOKEN / FLEET_PINNED_ENDPOINT)
  // and stay in the type so an old row is recognisably old rather than
  // mysteriously shaped.
  fleetTokenEnc?: EncryptedEnvelope;
  fleetEndpoint?: string;
}

export interface SelfHostedCredentials {
  /** `sk-ant-oat…` (OAuth) or `sk-ant-api…` (Console key) — the fleet's
   *  credential proxy accepts either and picks the right auth header. */
  claudeToken: string;
}

/**
 * The bearer the backend presents to a fleet host's API.
 *
 * Deployment config, not a workspace secret. It authenticates ONE service to
 * another — every host in a deployment shares it, and no user of the product
 * has any reason to know it exists, let alone to paste it into a settings form.
 * Putting it in the UI made the workspace responsible for a credential it does
 * not own and cannot rotate.
 *
 * Set it on the backend and on every host's `/etc/fleet/secrets.env`
 * (`FLEET_API_TOKEN`); the two must match or dispatch 401s.
 */
export function fleetApiToken(): string {
  return process.env.FLEET_API_TOKEN ?? '';
}

/**
 * Force every run onto one host, bypassing the registry. Blank = registry.
 *
 * This is a DEBUGGING escape hatch and it is deployment-level for the same
 * reason the bearer is: which box a run lands on is infrastructure. A workspace
 * has no way to know which host is healthy, which is draining, or which is the
 * one you are currently bisecting a bug on — the registry does, from reports
 * seconds old. Exposing the pin as a settings field asked users to answer a
 * question they cannot answer, and a stale one silently routed every task to a
 * box that had been offline for a week.
 */
export function fleetPinnedEndpoint(): string {
  return (process.env.FLEET_PINNED_ENDPOINT ?? '').replace(/\/+$/, '');
}

/** Thrown when the deployment itself is misconfigured — not a per-workspace fault. */
export class FleetNotDeployedError extends Error {
  constructor() {
    super(
      'FLEET_API_TOKEN is not set on the backend, so it cannot authenticate to any fleet host. ' +
        'This is deployment configuration, not a workspace setting.',
    );
    this.name = 'FleetNotDeployedError';
  }
}

function readEnc(env: EncryptedEnvelope | undefined, label: string): string | null {
  if (env && isEncryptedEnvelope(env)) {
    try {
      return decryptString(env);
    } catch (err) {
      console.error(`[selfhosted] failed to decrypt ${label}:`, err);
      return null;
    }
  }
  return null;
}

/** Resolve a workspace's fleet credentials, or null if unset. */
export async function getSelfHostedCredentials(
  workspaceId: string,
): Promise<SelfHostedCredentials | null> {
  const db = getDbClient();
  const rows = await db
    .select({ config: integrationsTable.config, enabled: integrationsTable.enabled })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.enabled) return null;

  const config = (row.config as SelfHostedIntegrationConfig | null) ?? {};
  // The CLAUDE TOKEN is what makes a workspace configured, and it is now the
  // only thing this config holds. Nothing else could play that role: the fleet
  // bearer is identical for every workspace so it distinguishes nothing, and
  // the endpoint answers "which host", which the registry answers better.
  //
  // A row written before this change carries `fleetTokenEnc`/`fleetEndpoint`
  // and no Claude token; it reads as unconfigured, which is accurate — the user
  // still has to supply the one secret that is now actually theirs.
  const claudeToken = readEnc(config.anthropicKeyEnc, 'Claude token');
  if (!claudeToken) return null;

  return { claudeToken };
}

/** Build a client for a workspace, or null if it isn't configured. */
export async function getSelfHostedClient(workspaceId: string): Promise<FleetClient | null> {
  const target = await resolveFleetTarget(workspaceId);
  return target ? new FleetClient(target.endpoint, target.token) : null;
}

/** Where a workspace's fleet runs, and how to authenticate to it. */
export interface FleetTarget {
  endpoint: string;
  token: string;
  /** The registered host this resolved to, when it came from the registry.
   *  Absent when FLEET_PINNED_ENDPOINT overrode it. */
  host?: string;
}

/**
 * Resolve which fleet host this workspace's next run should go to.
 *
 * The credential says WHETHER a workspace may use the fleet; the registry says
 * WHERE. Splitting them is what makes more than one host possible: a workspace
 * does not know which box is least loaded, or which is draining, or which has
 * stopped reporting, so it was never in a position to choose one.
 *
 * Order:
 *   1. FLEET_PINNED_ENDPOINT, if the operator set one. A debugging override —
 *      it forces every run onto one box regardless of load or health, which is
 *      exactly what you want while bisecting a host and exactly what you do not
 *      want otherwise.
 *   2. The least-loaded dispatchable host in the registry. The normal path.
 *
 * Returns null when the workspace has no credential at all — the fleet is not
 * configured for it, which is different from "configured and nothing is up".
 * That distinction is why the second case throws rather than returning null:
 * "you have not set this up" and "your hardware is down" need different
 * answers, and collapsing them into one silent null gives neither.
 */
export async function resolveFleetTarget(workspaceId: string): Promise<FleetTarget | null> {
  const creds = await getSelfHostedCredentials(workspaceId);
  if (!creds) return null;

  // Deliberately thrown, not returned as null: a missing deployment token is
  // an operator error and every workspace hits it identically. Reporting it as
  // "not configured" would send the user back to a settings form they have
  // already filled in correctly.
  const token = fleetApiToken();
  if (!token) throw new FleetNotDeployedError();

  const pinned = fleetPinnedEndpoint();
  if (pinned) return { endpoint: pinned, token };

  const host = await pickFleetHost();
  if (!host?.apiEndpoint) {
    // A capacity error, not a terminal one: no host is dispatchable right now,
    // which is exactly the condition fail-back exists for (§11.6). Failing the
    // user's task because every box is busy or offline would be the wrong
    // shape — another provider can still run it.
    throw new FleetCapacityError(
      'no self-hosted fleet host is currently dispatchable ' +
        '(none registered, all draining, all at capacity, or none advertising an endpoint)',
    );
  }
  return { endpoint: host.apiEndpoint, token, host: host.name };
}

/** Upsert a workspace's fleet credentials (secrets encrypted at rest). */
export async function storeSelfHostedCredentials(
  workspaceId: string,
  input: { claudeToken: string },
): Promise<void> {
  const db = getDbClient();
  const existing = await db
    .select({ id: integrationsTable.id })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);

  // Written whole, not merged into what was there. A workspace configured
  // before the fleet bearer and endpoint left the card still has them on disk;
  // carrying them forward would keep a dead per-workspace endpoint alive as a
  // silent routing override long after the field that set it was removed.
  const config: SelfHostedIntegrationConfig = {
    anthropicKeyEnc: encryptString(input.claudeToken),
  };

  const now = new Date();
  if (existing[0]) {
    await db
      .update(integrationsTable)
      .set({ config, enabled: true, updatedAt: now })
      .where(eq(integrationsTable.id, existing[0].id));
  } else {
    await db.insert(integrationsTable).values({
      id: uuid(),
      workspaceId,
      type: INTEGRATION_TYPE,
      enabled: true,
      config,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** Remove a workspace's fleet credentials. */
export async function removeSelfHostedCredentials(workspaceId: string): Promise<void> {
  const db = getDbClient();
  await db
    .delete(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    );
}
