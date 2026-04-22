import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { workspaceRoutes } from '../../routes/workspaces.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  integrations as integrationsTable,
} from '../../db/schema.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/workspaces', requireAuth, workspaceRoutes());
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

describe('routes/workspaces', () => {
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
  });

  it('rejects unauthenticated callers', async () => {
    const res = await fetch(`${serverUrl}/workspaces`);
    expect(res.status).toBe(401);
  });

  describe('POST /workspaces', () => {
    it('creates a workspace owned by the caller with default settings', async () => {
      const res = await fetch(`${serverUrl}/workspaces`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'My Workspace', description: 'desc' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.name).toBe('My Workspace');
      expect(body.data.description).toBe('desc');
      expect(body.data.settings).toEqual({
        autoAssignTasks: true,
        maxConcurrentAgents: 3,
      });
      expect(body.data.repos).toEqual([]);
      expect(body.data.integrations).toEqual({});
    });
  });

  describe('GET /workspaces', () => {
    it('returns only the caller own workspaces with repos + integrations hydrated', async () => {
      await db.insert(workspacesTable).values([
        { id: 'a', ownerId: TEST_USER_ID, name: 'Alpha', settings: {} },
        { id: 'b', ownerId: TEST_USER_ID, name: 'Beta', settings: {} },
        { id: 'c', ownerId: OTHER_USER_ID, name: 'Other', settings: {} },
      ]);
      await db.insert(repositoriesTable).values([
        {
          id: 'r1',
          workspaceId: 'a',
          name: 'acme/widgets',
          url: 'https://github.com/acme/widgets',
          defaultBranch: 'main',
        },
      ]);
      await db.insert(integrationsTable).values([
        { id: 'i1', workspaceId: 'a', type: 'github', enabled: true, config: {} },
      ]);

      const res = await fetch(`${serverUrl}/workspaces`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      const names = (body.data as Array<{ name: string }>).map((w) => w.name).sort();
      expect(names).toEqual(['Alpha', 'Beta']);
      const alpha = (body.data as Array<{ id: string; repos: unknown[]; integrations: Record<string, unknown> }>).find((w) => w.id === 'a')!;
      expect(alpha.repos).toHaveLength(1);
      // Only the enabled flag should leak; no config blob.
      expect(alpha.integrations.github).toEqual({ enabled: true, watchedRepos: [] });
    });

    it('returns an empty array for a user with no workspaces', async () => {
      const res = await fetch(`${serverUrl}/workspaces`, { headers: authHeaders });
      const body = await res.json();
      expect(body.data).toEqual([]);
    });
  });

  describe('GET /workspaces/:id', () => {
    it('returns an owned workspace', async () => {
      await db.insert(workspacesTable).values({
        id: 'a',
        ownerId: TEST_USER_ID,
        name: 'Alpha',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/a`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe('a');
    });

    it('404s a workspace owned by someone else', async () => {
      await db.insert(workspacesTable).values({
        id: 'x',
        ownerId: OTHER_USER_ID,
        name: 'Other',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/x`, { headers: authHeaders });
      expect(res.status).toBe(404);
    });

    it('404s a missing workspace id', async () => {
      const res = await fetch(`${serverUrl}/workspaces/nope`, { headers: authHeaders });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /workspaces/:id', () => {
    it('merges settings with existing values rather than replacing', async () => {
      await db.insert(workspacesTable).values({
        id: 'a',
        ownerId: TEST_USER_ID,
        name: 'Alpha',
        settings: { autoAssignTasks: true, maxConcurrentAgents: 3 },
      });
      const res = await fetch(`${serverUrl}/workspaces/a`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ settings: { maxConcurrentAgents: 5 } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.settings).toEqual({
        autoAssignTasks: true, // preserved
        maxConcurrentAgents: 5, // overridden
      });
    });

    it('updates name + description independently', async () => {
      await db.insert(workspacesTable).values({
        id: 'a',
        ownerId: TEST_USER_ID,
        name: 'Alpha',
        description: 'old',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/a`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ name: 'Renamed' }),
      });
      const body = await res.json();
      expect(body.data.name).toBe('Renamed');
      expect(body.data.description).toBe('old');
    });

    it('404s a workspace owned by someone else', async () => {
      await db.insert(workspacesTable).values({
        id: 'x',
        ownerId: OTHER_USER_ID,
        name: 'Other',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/x`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ name: 'hijack' }),
      });
      expect(res.status).toBe(404);
      const rows = await db
        .select({ name: workspacesTable.name })
        .from(workspacesTable)
        .where(eq(workspacesTable.id, 'x'));
      expect(rows[0].name).toBe('Other');
    });
  });

  describe('DELETE /workspaces/:id', () => {
    it('removes an owned workspace', async () => {
      await db.insert(workspacesTable).values({
        id: 'a',
        ownerId: TEST_USER_ID,
        name: 'Alpha',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/a`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const rows = await db.select().from(workspacesTable);
      expect(rows).toHaveLength(0);
    });

    it('404s on a workspace owned by someone else (no leak)', async () => {
      await db.insert(workspacesTable).values({
        id: 'x',
        ownerId: OTHER_USER_ID,
        name: 'Other',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/x`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
      const rows = await db.select().from(workspacesTable);
      expect(rows).toHaveLength(1);
    });
  });
});
