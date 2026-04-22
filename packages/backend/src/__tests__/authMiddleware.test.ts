import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import {
  extractBearerToken,
  requireAuth,
  handleAccessError,
  AccessError,
  AuthError,
  requireWorkspaceAccess,
  requireEnvironmentAccess,
  requireTaskAccess,
  requireAgentAccess,
  requireInboxAccess,
  requireRepositoryAccess,
  requireBacklogSourceAccess,
  assertUser,
  internalProxyHeaders,
} from '../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  tasks as tasksTable,
  agents as agentsTable,
  inboxItems as inboxItemsTable,
  repositories as repositoriesTable,
  backlogSources as backlogSourcesTable,
} from '../db/schema.js';

const OTHER_USER_ID = 'user-other';

describe('extractBearerToken', () => {
  it('parses a well-formed Bearer header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('returns null for a missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(extractBearerToken('Basic deadbeef')).toBeNull();
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer my-token')).toBe('my-token');
  });

  it('trims leading/trailing whitespace in the token', () => {
    expect(extractBearerToken('Bearer   spaced-token   ')).toBe('spaced-token');
  });
});

describe('handleAccessError', () => {
  function makeRes() {
    const statusCalls: number[] = [];
    const bodies: unknown[] = [];
    return {
      status(code: number) {
        statusCalls.push(code);
        return this;
      },
      json(b: unknown) {
        bodies.push(b);
        return this;
      },
      statusCalls,
      bodies,
    };
  }

  it('maps AccessError to 404 with the error message', () => {
    const res = makeRes();
    handleAccessError(new AccessError('not found'), res as unknown as express.Response);
    expect(res.statusCalls).toEqual([404]);
    expect(res.bodies[0]).toEqual({ success: false, error: 'not found' });
  });

  it('maps unknown errors to 500 with a generic message', () => {
    const res = makeRes();
    handleAccessError(new Error('boom'), res as unknown as express.Response);
    expect(res.statusCalls).toEqual([500]);
    expect(res.bodies[0]).toEqual({ success: false, error: 'Internal error' });
  });
});

describe('assertUser', () => {
  it('returns req.user when it is set', () => {
    const req = { user: { id: 'u', email: 'e' } } as unknown as express.Request;
    expect(assertUser(req)).toEqual({ id: 'u', email: 'e' });
  });

  it('throws when requireAuth has not run yet', () => {
    const req = {} as unknown as express.Request;
    expect(() => assertUser(req)).toThrow(/requireAuth/);
  });
});

describe('AuthError', () => {
  it('carries the code field alongside the message', () => {
    const err = new AuthError('unauthorized', 'bad token');
    expect(err.code).toBe('unauthorized');
    expect(err.message).toBe('bad token');
    expect(err).toBeInstanceOf(Error);
  });
});

// ---- Integration: the requireAuth middleware over a real Express server ----

async function makeProbeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.get('/probe', requireAuth, (req, res) => {
    res.json({ userId: req.user?.id });
  });
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

describe('requireAuth (JWT + internal-proxy)', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    const s = await makeProbeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
  });

  it('401s when no headers are provided', async () => {
    expect((await fetch(`${serverUrl}/probe`)).status).toBe(401);
  });

  it('401s when the Bearer token is malformed (no Supabase round-trip needed)', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: { authorization: 'Bearer ' },
    });
    // Empty token after "Bearer " → extractBearerToken returns null → 401.
    expect(res.status).toBe(401);
  });

  it('accepts valid internal-proxy headers', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: internalProxyHeaders(TEST_USER_ID),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(TEST_USER_ID);
  });

  it('401s with "malformed" header error when one internal header is missing', async () => {
    // Only the token present — no user id → checkInternalAuth returns
    // null (missing → no-op). Then the Bearer path is taken and it's
    // empty → 401 "Missing bearer token".
    const res = await fetch(`${serverUrl}/probe`, {
      headers: {
        'x-fastowl-internal-token': 'anything',
      },
    });
    expect(res.status).toBe(401);
  });

  it('401s when the internal token is wrong', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: {
        'x-fastowl-internal-token': 'not-the-real-secret',
        'x-fastowl-internal-user': TEST_USER_ID,
      },
    });
    expect(res.status).toBe(401);
  });

  it('401s when the internal user id does not exist in the users table', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: internalProxyHeaders('no-such-user'),
    });
    expect(res.status).toBe(401);
  });
});

// ---- Ownership helpers (exercised without the real HTTP route layer) ----

function makeReq(userId: string): express.Request {
  return { user: { id: userId, email: `${userId}@test` } } as unknown as express.Request;
}

describe('ownership helpers', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
    await db.insert(workspacesTable).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws-theirs', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
    ]);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('requireWorkspaceAccess passes for the owner and 404s otherwise', async () => {
    await expect(
      requireWorkspaceAccess(makeReq(TEST_USER_ID), 'ws-mine')
    ).resolves.toBeUndefined();
    await expect(
      requireWorkspaceAccess(makeReq(TEST_USER_ID), 'ws-theirs')
    ).rejects.toThrow(AccessError);
    await expect(
      requireWorkspaceAccess(makeReq(TEST_USER_ID), 'missing')
    ).rejects.toThrow(AccessError);
  });

  it('requireEnvironmentAccess uses the env.ownerId column directly', async () => {
    await db.insert(environmentsTable).values([
      {
        id: 'env-mine', ownerId: TEST_USER_ID, name: 'e', type: 'local',
        status: 'connected', config: {},
      },
      {
        id: 'env-theirs', ownerId: OTHER_USER_ID, name: 'e', type: 'local',
        status: 'connected', config: {},
      },
    ]);
    await expect(
      requireEnvironmentAccess(makeReq(TEST_USER_ID), 'env-mine')
    ).resolves.toBeUndefined();
    await expect(
      requireEnvironmentAccess(makeReq(TEST_USER_ID), 'env-theirs')
    ).rejects.toThrow(AccessError);
  });

  it('requireTaskAccess walks via workspaces.owner_id', async () => {
    const now = new Date();
    await db.insert(tasksTable).values([
      {
        id: 't-mine', workspaceId: 'ws-mine', type: 'code_writing',
        status: 'queued', priority: 'medium', title: 't', description: 'd',
        createdAt: now, updatedAt: now,
      },
      {
        id: 't-theirs', workspaceId: 'ws-theirs', type: 'code_writing',
        status: 'queued', priority: 'medium', title: 't', description: 'd',
        createdAt: now, updatedAt: now,
      },
    ]);
    const ws = await requireTaskAccess(makeReq(TEST_USER_ID), 't-mine');
    expect(ws).toBe('ws-mine');
    await expect(
      requireTaskAccess(makeReq(TEST_USER_ID), 't-theirs')
    ).rejects.toThrow(AccessError);
    await expect(
      requireTaskAccess(makeReq(TEST_USER_ID), 'missing')
    ).rejects.toThrow(AccessError);
  });

  it('requireAgentAccess walks via workspaces.owner_id', async () => {
    const now = new Date();
    await db.insert(environmentsTable).values({
      id: 'env', ownerId: TEST_USER_ID, name: 'e', type: 'local',
      status: 'connected', config: {},
    });
    await db.insert(agentsTable).values([
      {
        id: 'a-mine', environmentId: 'env', workspaceId: 'ws-mine', status: 'idle',
        attention: 'none', terminalOutput: '', lastActivity: now, createdAt: now,
      },
      {
        id: 'a-theirs', environmentId: 'env', workspaceId: 'ws-theirs', status: 'idle',
        attention: 'none', terminalOutput: '', lastActivity: now, createdAt: now,
      },
    ]);
    await expect(requireAgentAccess(makeReq(TEST_USER_ID), 'a-mine')).resolves.toBe('ws-mine');
    await expect(
      requireAgentAccess(makeReq(TEST_USER_ID), 'a-theirs')
    ).rejects.toThrow(AccessError);
  });

  it('requireInboxAccess and requireRepositoryAccess honour workspace ownership', async () => {
    const now = new Date();
    await db.insert(inboxItemsTable).values([
      {
        id: 'in-mine', workspaceId: 'ws-mine', type: 'agent_question', status: 'unread',
        priority: 'medium', title: 't', summary: 's', source: {}, actions: [], createdAt: now,
      },
      {
        id: 'in-theirs', workspaceId: 'ws-theirs', type: 'agent_question', status: 'unread',
        priority: 'medium', title: 't', summary: 's', source: {}, actions: [], createdAt: now,
      },
    ]);
    await db.insert(repositoriesTable).values([
      {
        id: 'rp-mine', workspaceId: 'ws-mine', name: 'a',
        url: 'https://github.com/a/b', defaultBranch: 'main',
      },
      {
        id: 'rp-theirs', workspaceId: 'ws-theirs', name: 'a',
        url: 'https://github.com/a/b', defaultBranch: 'main',
      },
    ]);

    await expect(
      requireInboxAccess(makeReq(TEST_USER_ID), 'in-mine')
    ).resolves.toBe('ws-mine');
    await expect(
      requireInboxAccess(makeReq(TEST_USER_ID), 'in-theirs')
    ).rejects.toThrow(AccessError);
    await expect(
      requireRepositoryAccess(makeReq(TEST_USER_ID), 'rp-mine')
    ).resolves.toBe('ws-mine');
    await expect(
      requireRepositoryAccess(makeReq(TEST_USER_ID), 'rp-theirs')
    ).rejects.toThrow(AccessError);
  });

  it('requireBacklogSourceAccess honours workspace ownership', async () => {
    const now = new Date();
    await db.insert(backlogSourcesTable).values([
      {
        id: 's-mine', workspaceId: 'ws-mine', type: 'markdown_file',
        enabled: true, config: { type: 'markdown_file', path: '/b.md' },
        createdAt: now, updatedAt: now,
      },
      {
        id: 's-theirs', workspaceId: 'ws-theirs', type: 'markdown_file',
        enabled: true, config: { type: 'markdown_file', path: '/b.md' },
        createdAt: now, updatedAt: now,
      },
    ]);
    await expect(
      requireBacklogSourceAccess(makeReq(TEST_USER_ID), 's-mine')
    ).resolves.toBe('ws-mine');
    await expect(
      requireBacklogSourceAccess(makeReq(TEST_USER_ID), 's-theirs')
    ).rejects.toThrow(AccessError);
  });
});
