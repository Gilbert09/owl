import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { agentRoutes } from '../../routes/agents.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  agents as agentsTable,
} from '../../db/schema.js';
import { agentService } from '../../services/agent.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/agents', requireAuth, agentRoutes());
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
  await db.insert(environmentsTable).values([
    { id: 'env1', ownerId: TEST_USER_ID, name: 'mine', type: 'local', status: 'connected', config: {} },
    { id: 'env2', ownerId: OTHER_USER_ID, name: 'theirs', type: 'local', status: 'connected', config: {} },
  ]);
}

async function insertAgent(
  db: Database,
  overrides: Partial<{
    id: string;
    workspaceId: string;
    environmentId: string;
    status: string;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? `a${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  await db.insert(agentsTable).values({
    id,
    environmentId: overrides.environmentId ?? 'env1',
    workspaceId: overrides.workspaceId ?? 'ws1',
    status: overrides.status ?? 'idle',
    attention: 'none',
    terminalOutput: '',
    lastActivity: now,
    createdAt: now,
  });
  return id;
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/agents', () => {
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
    expect((await fetch(`${serverUrl}/agents`)).status).toBe(401);
  });

  describe('GET /agents', () => {
    it('returns agents only from workspaces the caller owns', async () => {
      await insertAgent(db, { id: 'a1', workspaceId: 'ws1' });
      await insertAgent(db, { id: 'a2', workspaceId: 'ws1' });
      await insertAgent(db, { id: 'a3', workspaceId: 'ws2', environmentId: 'env2' });

      const res = await fetch(`${serverUrl}/agents`, { headers: authHeaders });
      const body = await res.json();
      const ids = (body.data as Array<{ id: string }>).map((a) => a.id).sort();
      expect(ids).toEqual(['a1', 'a2']);
    });

    it('filters by workspaceId + environmentId + status', async () => {
      await insertAgent(db, { id: 'idle-1', status: 'idle' });
      await insertAgent(db, { id: 'work-1', status: 'working' });

      const res = await fetch(
        `${serverUrl}/agents?workspaceId=ws1&environmentId=env1&status=working`,
        { headers: authHeaders }
      );
      const body = await res.json();
      expect((body.data as Array<{ id: string }>).map((a) => a.id)).toEqual(['work-1']);
    });

    it('404s when filtering by a workspace the caller does not own', async () => {
      const res = await fetch(`${serverUrl}/agents?workspaceId=ws2`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });

    it('404s when filtering by an env the caller does not own', async () => {
      const res = await fetch(`${serverUrl}/agents?environmentId=env2`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /agents/:id', () => {
    it('returns an owned agent', async () => {
      await insertAgent(db, { id: 'mine' });
      const res = await fetch(`${serverUrl}/agents/mine`, { headers: authHeaders });
      expect(res.status).toBe(200);
    });

    it('404s an agent belonging to another user', async () => {
      await insertAgent(db, { id: 'theirs', workspaceId: 'ws2', environmentId: 'env2' });
      const res = await fetch(`${serverUrl}/agents/theirs`, { headers: authHeaders });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /agents/start', () => {
    it('creates an agent row for an owned workspace + env', async () => {
      const res = await fetch(`${serverUrl}/agents/start`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws1',
          environmentId: 'env1',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.workspaceId).toBe('ws1');
      expect(body.data.environmentId).toBe('env1');
      expect(body.data.status).toBe('idle');
      expect(body.data.currentTaskId).toBeUndefined();
    });

    it('404s when the workspace is not owned', async () => {
      const res = await fetch(`${serverUrl}/agents/start`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws2', environmentId: 'env1' }),
      });
      expect(res.status).toBe(404);
    });

    it('404s when the env is not owned', async () => {
      const res = await fetch(`${serverUrl}/agents/start`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1', environmentId: 'env2' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /agents/:id/input', () => {
    it('forwards input to agentService.sendInput', async () => {
      const sendInput = vi.spyOn(agentService, 'sendInput').mockImplementation(() => {});
      await insertAgent(db, { id: 'a1' });
      const res = await fetch(`${serverUrl}/agents/a1/input`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ input: 'hello\n' }),
      });
      expect(res.status).toBe(200);
      expect(sendInput).toHaveBeenCalledWith('a1', 'hello\n');

      const rows = await db
        .select({ lastActivity: agentsTable.lastActivity })
        .from(agentsTable)
        .where(eq(agentsTable.id, 'a1'));
      // lastActivity is touched on the input call.
      expect(rows[0].lastActivity).toBeInstanceOf(Date);
    });

    it('404s when the agent belongs to another user', async () => {
      vi.spyOn(agentService, 'sendInput').mockImplementation(() => {});
      await insertAgent(db, { id: 'a1', workspaceId: 'ws2', environmentId: 'env2' });
      const res = await fetch(`${serverUrl}/agents/a1/input`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ input: 'x' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /agents/:id/stop', () => {
    it('flips an agent to idle', async () => {
      await insertAgent(db, { id: 'a1', status: 'working' });
      const res = await fetch(`${serverUrl}/agents/a1/stop`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('idle');
    });

    it('404s when the agent is not owned', async () => {
      await insertAgent(db, { id: 'a1', workspaceId: 'ws2', environmentId: 'env2' });
      const res = await fetch(`${serverUrl}/agents/a1/stop`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /agents/:id', () => {
    it('removes an owned agent', async () => {
      await insertAgent(db, { id: 'a1' });
      const res = await fetch(`${serverUrl}/agents/a1`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const rows = await db.select().from(agentsTable);
      expect(rows).toHaveLength(0);
    });

    it('404s an agent belonging to another user', async () => {
      await insertAgent(db, { id: 'a1', workspaceId: 'ws2', environmentId: 'env2' });
      const res = await fetch(`${serverUrl}/agents/a1`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
      const rows = await db.select().from(agentsTable);
      expect(rows).toHaveLength(1);
    });
  });
});
