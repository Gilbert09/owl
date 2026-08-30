import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { AUTO_KEEP_DEFAULT_ERROR_CODE } from '@talyn/shared';
import { workspaceRoutes } from '../../routes/workspaces.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { users as usersTable, workspaces as workspacesTable } from '../../db/schema.js';

/**
 * "Auto-keep new PRs mergeable" is an Unlimited feature, and the gate is on the
 * OFF→ON TRANSITION rather than the state. The grandfathering rule is the whole
 * point: a free workspace that already had it on must keep working, and must
 * only be asked to pay if it gives that up and asks for it back.
 *
 * Mounts the REAL apiErrorHandler so the 402 + code contract is production's.
 */

const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};
const savedPolarToken = process.env.POLAR_ACCESS_TOKEN;

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/workspaces', requireAuth, wrapAsyncRoutes(workspaceRoutes()));
  app.use(apiErrorHandler);
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

describe('workspace default auto-keep-mergeable is an Unlimited feature', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;

  async function seedWorkspace(defaultAutoKeepMergeable?: boolean) {
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws1',
      settings:
        defaultAutoKeepMergeable === undefined ? {} : { defaultAutoKeepMergeable },
    });
  }

  function setDefault(enabled: boolean) {
    return fetch(`${url}/workspaces/ws1`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ settings: { defaultAutoKeepMergeable: enabled } }),
    });
  }

  async function storedValue(): Promise<unknown> {
    const [row] = await db
      .select({ settings: workspacesTable.settings })
      .from(workspacesTable)
      .where(eq(workspacesTable.id, 'ws1'));
    return (row.settings as { defaultAutoKeepMergeable?: unknown })
      .defaultAutoKeepMergeable;
  }

  const goUnlimited = () =>
    db
      .update(usersTable)
      .set({ planOverride: 'unlimited' })
      .where(eq(usersTable.id, TEST_USER_ID));

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    await seedUser(db);
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    if (savedPolarToken === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolarToken;
    await close();
    await cleanup();
  });

  it('402s a free plan turning it on, and does not write the setting', async () => {
    await seedWorkspace();
    const res = await setDefault(true);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { code: string }).code).toBe(AUTO_KEEP_DEFAULT_ERROR_CODE);
    expect(await storedValue()).toBeUndefined();
  });

  it.each([undefined, false])(
    'gates the transition from %p — the absent and explicit-off states are both OFF',
    async (from) => {
      await seedWorkspace(from);
      expect((await setDefault(true)).status).toBe(402);
    }
  );

  it('lets an unlimited plan turn it on', async () => {
    await seedWorkspace();
    await goUnlimited();
    expect((await setDefault(true)).status).toBe(200);
    expect(await storedValue()).toBe(true);
  });

  it('leaves a grandfathered free workspace alone — re-asserting ON is not a transition', async () => {
    // The product promise: nobody loses a feature they were already using. A
    // client that PATCHes the whole settings object on an unrelated edit must
    // not trip the gate.
    await seedWorkspace(true);
    expect((await setDefault(true)).status).toBe(200);
    expect(await storedValue()).toBe(true);
  });

  it('always lets a free plan turn it OFF', async () => {
    await seedWorkspace(true);
    expect((await setDefault(false)).status).toBe(200);
    expect(await storedValue()).toBe(false);
  });

  it('charges for the turn-on after a free plan gives the grandfathered state up', async () => {
    await seedWorkspace(true);
    expect((await setDefault(false)).status).toBe(200);
    const res = await setDefault(true);
    expect(res.status).toBe(402);
    expect(await storedValue()).toBe(false);
  });

  it('does not gate an unrelated settings edit on a free plan', async () => {
    await seedWorkspace();
    const res = await fetch(`${url}/workspaces/ws1`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ settings: { defaultCloudProvider: 'claude_code' } }),
    });
    expect(res.status).toBe(200);
  });

  it('no POLAR env → no enforcement (the kill switch)', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    await seedWorkspace();
    expect((await setDefault(true)).status).toBe(200);
    expect(await storedValue()).toBe(true);
  });
});
