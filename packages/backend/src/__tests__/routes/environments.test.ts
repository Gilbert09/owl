import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { environmentRoutes } from '../../routes/environments.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { environments as environmentsTable } from '../../db/schema.js';
import { daemonRegistry } from '../../services/daemonRegistry.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/environments', requireAuth, environmentRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/environments', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
    vi.restoreAllMocks();
  });

  it('401s unauthenticated requests', async () => {
    expect((await fetch(`${serverUrl}/environments`)).status).toBe(401);
  });

  describe('GET /environments', () => {
    it('returns envs belonging to the caller', async () => {
      await db.insert(environmentsTable).values([
        { id: 'e1', ownerId: TEST_USER_ID, name: 'mine-1', type: 'local', status: 'connected', config: {} },
        { id: 'e2', ownerId: TEST_USER_ID, name: 'mine-2', type: 'remote', status: 'disconnected', config: {} },
        { id: 'e3', ownerId: OTHER_USER_ID, name: 'not-mine', type: 'local', status: 'connected', config: {} },
      ]);
      const res = await fetch(`${serverUrl}/environments`, { headers: authHeaders });
      const body = await res.json();
      const ids = (body.data as Array<{ id: string }>).map((e) => e.id).sort();
      expect(ids).toEqual(['e1', 'e2']);
    });
  });

  describe('POST /environments', () => {
    it('creates a local env; autonomousBypassPermissions defaults to false', async () => {
      const res = await fetch(`${serverUrl}/environments`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'This Mac', type: 'local', config: {} }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.type).toBe('local');
      expect(body.data.status).toBe('disconnected');
      expect(body.data.autonomousBypassPermissions).toBe(false);
    });

    it('creates a remote env with autonomousBypassPermissions defaulting to true', async () => {
      const res = await fetch(`${serverUrl}/environments`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'VM', type: 'remote', config: {} }),
      });
      const body = await res.json();
      expect(body.data.autonomousBypassPermissions).toBe(true);
    });

    it('respects an explicit autonomousBypassPermissions override', async () => {
      const res = await fetch(`${serverUrl}/environments`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'Strict Mac',
          type: 'local',
          config: {},
          autonomousBypassPermissions: true,
        }),
      });
      const body = await res.json();
      expect(body.data.autonomousBypassPermissions).toBe(true);
    });
  });

  describe('GET /environments/:id', () => {
    it('returns an owned env', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: TEST_USER_ID, name: 'e', type: 'local', status: 'connected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1`, { headers: authHeaders });
      expect(res.status).toBe(200);
    });

    it('404s an env owned by another user', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: OTHER_USER_ID, name: 'e', type: 'local', status: 'connected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1`, { headers: authHeaders });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /environments/:id', () => {
    it('updates name + renderer + autoUpdateDaemon', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: TEST_USER_ID, name: 'old', type: 'local', status: 'connected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'new',
          renderer: 'structured',
          autoUpdateDaemon: true,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('new');
      expect(body.data.renderer).toBe('structured');
      expect(body.data.autoUpdateDaemon).toBe(true);
    });

    it('dedupes the toolAllowlist on update', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: TEST_USER_ID, name: 'e', type: 'local', status: 'connected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({
          toolAllowlist: ['Bash', ' Bash ', '', 'Read', 'Bash', 'Write'],
        }),
      });
      const body = await res.json();
      expect(body.data.toolAllowlist).toEqual(['Bash', 'Read', 'Write']);
    });

    it('404s an env belonging to another user', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: OTHER_USER_ID, name: 'e', type: 'local', status: 'connected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ name: 'hijack' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /environments/:id', () => {
    it('removes an owned env', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: TEST_USER_ID, name: 'e', type: 'local', status: 'connected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const rows = await db.select().from(environmentsTable);
      expect(rows).toHaveLength(0);
    });

    it('404s deletion of an env owned by someone else', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: OTHER_USER_ID, name: 'e', type: 'local', status: 'connected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
      const rows = await db.select().from(environmentsTable);
      expect(rows).toHaveLength(1);
    });
  });

  describe('POST /environments/:id/pairing-token', () => {
    it('mints a pairing token for an owned env', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: TEST_USER_ID, name: 'e', type: 'local', status: 'disconnected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1/pairing-token`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.pairingToken).toMatch(/^[0-9a-f]{32,}$/);
      expect(body.data.expiresInSeconds).toBe(600);
    });

    it('404s when the env belongs to another user (no token minted)', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: OTHER_USER_ID, name: 'e', type: 'local', status: 'disconnected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1/pairing-token`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /environments/:id/update-daemon', () => {
    it('refuses an update for a `local` env (desktop app ships its own)', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: TEST_USER_ID, name: 'Mac', type: 'local', status: 'connected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1/update-daemon`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/local daemon updates/i);
    });

    it('refuses an update when the daemon is not connected', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: TEST_USER_ID, name: 'VM', type: 'remote', status: 'disconnected', config: {},
      });
      vi.spyOn(daemonRegistry, 'isConnected').mockReturnValue(false);
      const res = await fetch(`${serverUrl}/environments/e1/update-daemon`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not connected/i);
    });

    it('forwards the request to the daemon and returns the result', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: TEST_USER_ID, name: 'VM', type: 'remote', status: 'connected', config: {},
      });
      vi.spyOn(daemonRegistry, 'isConnected').mockReturnValue(true);
      vi.spyOn(daemonRegistry, 'request').mockResolvedValue({
        newSha: 'abc1234',
        message: 'Update applied',
      } as unknown as never);

      const res = await fetch(`${serverUrl}/environments/e1/update-daemon`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({ newSha: 'abc1234', message: 'Update applied' });
    });

    it('404s an env the caller does not own', async () => {
      await db.insert(environmentsTable).values({
        id: 'e1', ownerId: OTHER_USER_ID, name: 'VM', type: 'remote', status: 'connected', config: {},
      });
      const res = await fetch(`${serverUrl}/environments/e1/update-daemon`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });
  });
});
