import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import {
  permissionHookRoutes,
  permissionDesktopRoutes,
} from '../../routes/permission.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  tasks as tasksTable,
} from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { permissionService } from '../../services/permissionService.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  // Hook route is unauthenticated by JWT — auth is the per-run token
  // in a header. Mount at root.
  app.use('/', permissionHookRoutes());
  // Desktop routes require JWT — gate with requireAuth.
  app.use('/', requireAuth, permissionDesktopRoutes());

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
  await db.insert(environmentsTable).values({
    id: 'env1',
    ownerId: TEST_USER_ID,
    name: 'e',
    type: 'local',
    status: 'connected',
    config: {},
  });
  const now = new Date();
  await db.insert(tasksTable).values([
    {
      id: 'mine-task',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 'mine',
      description: 'd',
      assignedEnvironmentId: 'env1',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'their-task',
      workspaceId: 'ws2',
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 'theirs',
      description: 'd',
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/permission', () => {
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
  });

  describe('POST /permission-hook (child-process auth via header token)', () => {
    it('401s when the run token header is missing', async () => {
      const res = await fetch(`${serverUrl}/permission-hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool_name: 'Bash' }),
      });
      expect(res.status).toBe(401);
    });

    it('401s when the run token is invalid', async () => {
      const res = await fetch(`${serverUrl}/permission-hook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fastowl-permission-token': 'totally-made-up-token',
        },
        body: JSON.stringify({ tool_name: 'Bash' }),
      });
      expect(res.status).toBe(401);
    });

    it('400s when tool_name is missing', async () => {
      const token = permissionService.registerRun({
        agentId: 'a1',
        environmentId: 'env1',
        workspaceId: 'ws1',
        taskId: 'mine-task',
      });
      try {
        const res = await fetch(`${serverUrl}/permission-hook`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-fastowl-permission-token': token,
          },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
      } finally {
        permissionService.unregisterRun(token);
      }
    });

    it('auto-allows tools that are on the env allowlist', async () => {
      await db
        .update(environmentsTable)
        .set({ toolAllowlist: ['Read'] })
        .where(eq(environmentsTable.id, 'env1'));

      const token = permissionService.registerRun({
        agentId: 'a1',
        environmentId: 'env1',
        workspaceId: 'ws1',
        taskId: 'mine-task',
      });
      try {
        const res = await fetch(`${serverUrl}/permission-hook`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-fastowl-permission-token': token,
          },
          body: JSON.stringify({
            tool_name: 'Read',
            tool_input: { file_path: '/tmp/x' },
            tool_use_id: 'u1',
            session_id: 's1',
          }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.decision).toBe('allow');
      } finally {
        permissionService.unregisterRun(token);
      }
    });
  });

  describe('POST /tasks/:taskId/permission (desktop Approve/Deny)', () => {
    it('401s without auth', async () => {
      const res = await fetch(`${serverUrl}/tasks/mine-task/permission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'r1', decision: 'allow' }),
      });
      expect(res.status).toBe(401);
    });

    it('404s a missing task', async () => {
      const res = await fetch(`${serverUrl}/tasks/nope/permission`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ requestId: 'r1', decision: 'allow' }),
      });
      expect(res.status).toBe(404);
    });

    it("403s someone else's task", async () => {
      const res = await fetch(`${serverUrl}/tasks/their-task/permission`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ requestId: 'r1', decision: 'allow' }),
      });
      expect(res.status).toBe(403);
    });

    it('400s without a requestId or with an invalid decision', async () => {
      const res = await fetch(`${serverUrl}/tasks/mine-task/permission`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ decision: 'allow' }),
      });
      expect(res.status).toBe(400);

      const res2 = await fetch(`${serverUrl}/tasks/mine-task/permission`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ requestId: 'r1', decision: 'maybe' }),
      });
      expect(res2.status).toBe(400);
    });

    it('410s when the request id has no pending entry (already resolved/expired)', async () => {
      const res = await fetch(`${serverUrl}/tasks/mine-task/permission`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ requestId: 'unknown', decision: 'allow' }),
      });
      expect(res.status).toBe(410);
    });
  });

  describe('GET /tasks/:taskId/permission/pending', () => {
    it('401s without auth', async () => {
      const res = await fetch(`${serverUrl}/tasks/mine-task/permission/pending`);
      expect(res.status).toBe(401);
    });

    it('404s a missing task', async () => {
      const res = await fetch(`${serverUrl}/tasks/nope/permission/pending`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });

    it("403s someone else's task", async () => {
      const res = await fetch(`${serverUrl}/tasks/their-task/permission/pending`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(403);
    });

    it('returns an empty list when no pending prompts exist', async () => {
      const res = await fetch(`${serverUrl}/tasks/mine-task/permission/pending`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.pending).toEqual([]);
    });
  });
});
