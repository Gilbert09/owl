import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { backlogRoutes } from '../../routes/backlog.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';
import { backlogService } from '../../services/backlog/service.js';
import { continuousBuildScheduler } from '../../services/continuousBuild.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/backlog', requireAuth, backlogRoutes());
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

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await seedUser(db, { id: OTHER_USER_ID });
  await db.insert(workspacesTable).values([
    { id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
    { id: 'ws2', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
  ]);
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/backlog', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
    vi.restoreAllMocks();
  });

  it('401s unauthenticated callers', async () => {
    expect((await fetch(`${serverUrl}/backlog/sources?workspaceId=ws1`)).status).toBe(401);
  });

  describe('GET /backlog/sources', () => {
    it('requires a workspaceId', async () => {
      const res = await fetch(`${serverUrl}/backlog/sources`, { headers: authHeaders });
      expect(res.status).toBe(400);
    });

    it('404s a workspace the caller does not own', async () => {
      const res = await fetch(`${serverUrl}/backlog/sources?workspaceId=ws2`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });

    it('returns an empty list for a workspace with no sources', async () => {
      const res = await fetch(`${serverUrl}/backlog/sources?workspaceId=ws1`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });

    it('round-trips a created source', async () => {
      // Use the service directly — the POST route exercises the same
      // path and is covered below; seeding this way keeps the list
      // assertion isolated from creation-side bugs.
      const created = await backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/backlog.md' },
      });
      const res = await fetch(`${serverUrl}/backlog/sources?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(created.id);
    });
  });

  describe('POST /backlog/sources', () => {
    it('400s when required fields are missing', async () => {
      const res = await fetch(`${serverUrl}/backlog/sources`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
      expect(res.status).toBe(400);
    });

    it('404s a cross-tenant workspace', async () => {
      const res = await fetch(`${serverUrl}/backlog/sources`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws2',
          type: 'markdown_file',
          config: { type: 'markdown_file', path: '/backlog.md' },
        }),
      });
      expect(res.status).toBe(404);
    });

    it('creates a source for an owned workspace', async () => {
      const res = await fetch(`${serverUrl}/backlog/sources`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws1',
          type: 'markdown_file',
          config: { type: 'markdown_file', path: '/backlog.md' },
          enabled: true,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.workspaceId).toBe('ws1');
      expect(body.data.type).toBe('markdown_file');
    });
  });

  describe('PATCH /backlog/sources/:id', () => {
    it('updates an owned source', async () => {
      const created = await backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/backlog.md' },
      });
      const res = await fetch(`${serverUrl}/backlog/sources/${created.id}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.enabled).toBe(false);
    });

    it('404s a source owned by another user', async () => {
      const created = await backlogService.createSource({
        workspaceId: 'ws2',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/backlog.md' },
      });
      const res = await fetch(`${serverUrl}/backlog/sources/${created.id}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /backlog/sources/:id', () => {
    it('removes an owned source', async () => {
      const created = await backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/backlog.md' },
      });
      const res = await fetch(`${serverUrl}/backlog/sources/${created.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      expect(await backlogService.getSource(created.id)).toBeNull();
    });

    it('404s a source owned by another user', async () => {
      const created = await backlogService.createSource({
        workspaceId: 'ws2',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/backlog.md' },
      });
      const res = await fetch(`${serverUrl}/backlog/sources/${created.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /backlog/sources/:id/sync', () => {
    it('surfaces service errors as 500', async () => {
      const created = await backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/backlog.md' },
      });
      vi.spyOn(backlogService, 'syncSource').mockRejectedValue(new Error('env not available'));
      const res = await fetch(`${serverUrl}/backlog/sources/${created.id}/sync`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/env not available/);
    });

    it('happy path returns the service result', async () => {
      const created = await backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/backlog.md' },
      });
      vi.spyOn(backlogService, 'syncSource').mockResolvedValue({
        added: 2,
        updated: 1,
        retired: 0,
      });
      const res = await fetch(`${serverUrl}/backlog/sources/${created.id}/sync`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({ added: 2, updated: 1, retired: 0 });
    });
  });

  describe('GET /backlog/items', () => {
    it('requires workspaceId', async () => {
      const res = await fetch(`${serverUrl}/backlog/items`, { headers: authHeaders });
      expect(res.status).toBe(400);
    });

    it('returns items for the owned workspace', async () => {
      const source = await backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/backlog.md' },
      });
      vi.spyOn(backlogService, 'listItemsForWorkspace').mockResolvedValue([
        {
          id: 'item-1',
          sourceId: source.id,
          workspaceId: 'ws1',
          externalId: 'e1',
          text: 'do the thing',
          completed: false,
          blocked: false,
          orderIndex: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      const res = await fetch(`${serverUrl}/backlog/items?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].text).toBe('do the thing');
    });
  });

  describe('POST /backlog/schedule', () => {
    it('requires workspaceId', async () => {
      const res = await fetch(`${serverUrl}/backlog/schedule`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('404s a cross-tenant workspace', async () => {
      const res = await fetch(`${serverUrl}/backlog/schedule`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws2' }),
      });
      expect(res.status).toBe(404);
    });

    it('delegates to continuousBuildScheduler.scheduleNext on success', async () => {
      const spy = vi
        .spyOn(continuousBuildScheduler, 'scheduleNext')
        .mockResolvedValue(undefined);
      const res = await fetch(`${serverUrl}/backlog/schedule`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith('ws1');
    });
  });
});
