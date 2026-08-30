import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { DEFAULT_WORKSPACE_NAME, type Workspace } from '@talyn/shared';
import { workspaceRoutes } from '../../routes/workspaces.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';

/**
 * Every owner gets a workspace without being asked to name one — onboarding
 * opens on connecting GitHub instead.
 *
 * The listing is what mints it, because that is the one call every client makes
 * on boot. That makes idempotence the property worth pinning hardest: the list
 * is hit constantly, and a bootstrap that fired twice would leave the user
 * staring at two identical workspaces.
 */

const OTHER_USER_ID = 'user-other';
const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/workspaces', requireAuth, workspaceRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}

describe('default workspace bootstrap', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;

  const list = (h: Record<string, string> = headers) =>
    fetch(`${url}/workspaces`, { headers: h });

  const ownedBy = (ownerId: string) =>
    db.select().from(workspacesTable).where(eq(workspacesTable.ownerId, ownerId));

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    await close();
    await cleanup();
  });

  it('mints one for a brand-new owner, with the default name and a logo', async () => {
    expect(await ownedBy(TEST_USER_ID)).toHaveLength(0);

    const res = await list();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Workspace[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe(DEFAULT_WORKSPACE_NAME);
    // An identicon, so the sidebar has something to render immediately.
    expect(body.data[0].logo?.kind).toBe('identicon');
    // Returned by the SAME request that created it — the client must not have
    // to list twice to see it.
    expect(await ownedBy(TEST_USER_ID)).toHaveLength(1);
  });

  it('is idempotent across repeated listings', async () => {
    await list();
    await list();
    await list();
    expect(await ownedBy(TEST_USER_ID)).toHaveLength(1);
  });

  it('does not mint a second one for an owner who already has any workspace', async () => {
    await db.insert(workspacesTable).values({
      id: 'ws-existing',
      ownerId: TEST_USER_ID,
      name: 'PostHog',
      settings: {},
    });
    const res = await list();
    const body = (await res.json()) as { data: Workspace[] };
    expect(body.data.map((w) => w.name)).toEqual(['PostHog']);
    expect(await ownedBy(TEST_USER_ID)).toHaveLength(1);
  });

  it('mints again for an owner who deleted their last workspace', async () => {
    await list();
    const [existing] = await ownedBy(TEST_USER_ID);
    await db.delete(workspacesTable).where(eq(workspacesTable.id, existing.id));

    await list();
    const rows = await ownedBy(TEST_USER_ID);
    // Otherwise the user is stranded in an app with no workspace to act in —
    // which is the dead end the old client-side inverse migration papered over.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(existing.id);
  });

  it('scopes to the caller — one owner listing never mints for another', async () => {
    await seedUser(db, { id: OTHER_USER_ID });
    await list();
    expect(await ownedBy(TEST_USER_ID)).toHaveLength(1);
    expect(await ownedBy(OTHER_USER_ID)).toHaveLength(0);

    await list({ ...internalProxyHeaders(OTHER_USER_ID), 'content-type': 'application/json' });
    expect(await ownedBy(OTHER_USER_ID)).toHaveLength(1);
    expect(await ownedBy(TEST_USER_ID)).toHaveLength(1);
  });

  it('mints exactly one when listings race', async () => {
    // Desktop and web signing in together, or a reconnect racing the first
    // load. There is no unique constraint to catch a double insert.
    //
    // Caveat worth knowing: pglite is single-connection and the bootstrap skips
    // its advisory lock there, so this pins the re-check-inside-the-guard shape
    // rather than the lock itself. The lock is what holds this up against real
    // Postgres, and only a multi-connection DB can prove it.
    await Promise.all([list(), list(), list(), list()]);
    expect(await ownedBy(TEST_USER_ID)).toHaveLength(1);
  });
});
