import { v4 as uuid } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_WORKSPACE_NAME, type WorkspaceLogo } from '@talyn/shared';
import {
  getDbClient,
  getPoolDbClient,
  getScopedDb,
  isRealPostgres,
} from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';
import { advisoryLockKey, withBlockingAdvisoryLock } from '../services/advisoryLock.js';

/**
 * Every owner has at least one workspace.
 *
 * Onboarding used to open by asking the user to name one, which is a question
 * they cannot answer well before they have seen the product — a workspace
 * groups repos, and they have not connected any repos yet. So the first one is
 * created for them under a generic name and the wizard starts at the step that
 * actually needs them: connecting GitHub. Renaming lives in Settings.
 *
 * This is the ONLY auto-create. An earlier version lived client-side in the
 * desktop's initial data load and was removed when the wizard shipped, because
 * a client-side create races the wizard's own step. Server-side it covers every
 * client — desktop, web, CLI, MCP — from one place, and none of them need to
 * know it happened.
 *
 * **It changes what "has this user onboarded?" can be inferred from.** The
 * desktop and web load paths used to read `workspaces.length > 0` as "returning
 * user, skip the wizard". That is now true of everyone, including someone who
 * signed up ten seconds ago, so those clients key off an actual GitHub
 * connection instead. If you add another caller here, check you are not
 * teaching some other code that a row's existence means the user is set up.
 */
export async function ensureDefaultWorkspace(ownerId: string): Promise<void> {
  if (await hasWorkspace(ownerId)) return;

  // Two clients signing in at once (desktop + web, or a reconnect racing the
  // first load) would both read empty and both insert — there is no unique
  // constraint to catch it, and the user would land on two identical
  // workspaces. Serialize per owner and re-check inside the lock. Same shape as
  // the free-plan gates in services/billing/entitlements.ts, including the
  // pglite escape hatch: the single-connection test harness would self-deadlock,
  // and cross-connection races do not exist there.
  if (!isRealPostgres()) {
    await insertDefaultWorkspace(ownerId);
    return;
  }

  const scoped = getScopedDb();
  if (scoped) {
    // Inside a request's ownerScope transaction: take the lock on that
    // transaction so it outlives the re-check AND the insert, releasing at
    // commit. A concurrent request blocks, then sees the committed row.
    const key = advisoryLockKey(`workspaceBootstrap:${ownerId}`).toString();
    await scoped.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
    if (await hasWorkspace(ownerId)) return;
    await insertDefaultWorkspace(ownerId);
    return;
  }

  await withBlockingAdvisoryLock(
    getPoolDbClient(),
    `workspaceBootstrap:${ownerId}`,
    async () => {
      if (await hasWorkspace(ownerId)) return;
      await insertDefaultWorkspace(ownerId);
    }
  );
}

async function hasWorkspace(ownerId: string): Promise<boolean> {
  const rows = await getDbClient()
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.ownerId, ownerId))
    .limit(1);
  return rows.length > 0;
}

async function insertDefaultWorkspace(ownerId: string): Promise<void> {
  const now = new Date();
  const logo: WorkspaceLogo = { kind: 'identicon', seed: uuid() };
  await getDbClient().insert(workspacesTable).values({
    id: uuid(),
    ownerId,
    name: DEFAULT_WORKSPACE_NAME,
    description: null,
    logo,
    settings: {},
    createdAt: now,
    updatedAt: now,
  });
}
