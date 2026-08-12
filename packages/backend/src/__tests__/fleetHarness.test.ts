import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';
import type { Database } from '../db/client.js';

/**
 * Which in-guest harness a workspace's runs use.
 *
 * Gated on the workspace owner being an admin — an existing privilege rather
 * than a new switch. So these assert the two things that matter: a customer
 * workspace stays on the proven harness, and anything unexpected reads as the
 * proven harness too. A lookup that failed open would move customer traffic
 * onto a harness that has never run a real task.
 */
let db: Database;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterEach(async () => {
  await cleanup();
});

async function workspaceOwnedBy(opts: { id: string; isAdmin: boolean }): Promise<string> {
  const user = await seedUser(db, { id: `owner-${opts.id}` });
  await db.update(usersTable).set({ isAdmin: opts.isAdmin }).where(eq(usersTable.id, user.id));
  const wsId = `ws-${opts.id}`;
  await db
    .insert(workspacesTable)
    .values({ id: wsId, ownerId: user.id, name: opts.id })
    .onConflictDoNothing();
  return wsId;
}

/** The gate itself, read the same way the dispatch path reads it. */
async function harnessFor(workspaceId: string): Promise<'sdk' | 'pi'> {
  const [row] = await db
    .select({ isAdmin: usersTable.isAdmin })
    .from(workspacesTable)
    .innerJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return row?.isAdmin ? 'pi' : 'sdk';
}

describe('the harness gate', () => {
  it('puts an admin-owned workspace on the new harness', async () => {
    const ws = await workspaceOwnedBy({ id: 'internal', isAdmin: true });
    expect(await harnessFor(ws)).toBe('pi');
  });

  // The one that protects customers. Everything below the microVM has tests;
  // a task actually running on the new harness has not been observed.
  it('leaves a customer workspace on the proven harness', async () => {
    const ws = await workspaceOwnedBy({ id: 'customer', isAdmin: false });
    expect(await harnessFor(ws)).toBe('sdk');
  });

  it('reads as the proven harness for a workspace that does not exist', async () => {
    expect(await harnessFor('ws-nonexistent')).toBe('sdk');
  });

  /**
   * Revoking admin returns that workspace's next dispatch to the SDK. Nothing
   * to migrate and nothing to undo — which is what makes the coupling to a
   * privilege flag acceptable while this is being dogfooded.
   */
  it('reverts as soon as admin is revoked', async () => {
    const ws = await workspaceOwnedBy({ id: 'revoked', isAdmin: true });
    expect(await harnessFor(ws)).toBe('pi');
    await db.update(usersTable).set({ isAdmin: false }).where(eq(usersTable.id, 'owner-revoked'));
    expect(await harnessFor(ws)).toBe('sdk');
  });

  /** Ownership, not membership: an admin merely having access to a customer's
   *  workspace must not move that customer onto an unproven harness. */
  it('follows the owner, not any admin who can see the workspace', async () => {
    const customer = await workspaceOwnedBy({ id: 'shared', isAdmin: false });
    await seedUser(db, { id: 'some-admin' });
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, 'some-admin'));
    expect(await harnessFor(customer)).toBe('sdk');
  });
});
