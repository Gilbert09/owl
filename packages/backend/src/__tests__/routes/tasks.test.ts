import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { taskRoutes } from '../../routes/tasks.js';
import { gitService } from '../../services/git.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../../db/schema.js';

const OTHER_USER_ID = 'user-other';

/**
 * Stand up an Express app with requireAuth + the tasks router so tests
 * hit the real handlers over real HTTP. Auth flows through the
 * internal-proxy headers (same mechanism the daemon WS handler uses)
 * so tests don't need a Supabase JWT round-trip.
 */
async function makeServer(): Promise<{
  url: string;
  server: Server;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.use('/tasks', requireAuth, taskRoutes());

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function seed(db: Database): Promise<{
  workspaceId: string;
  otherWorkspaceId: string;
  envId: string;
  repoId: string;
}> {
  await seedUser(db, { id: TEST_USER_ID });
  await seedUser(db, { id: OTHER_USER_ID });
  await db.insert(workspacesTable).values([
    { id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
    { id: 'ws2', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
  ]);
  await db.insert(environmentsTable).values({
    id: 'env1',
    ownerId: TEST_USER_ID,
    name: 'local',
    type: 'local',
    status: 'connected',
    config: {},
  });
  await db.insert(repositoriesTable).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: 'acme/widgets',
    url: 'https://github.com/acme/widgets',
    localPath: '/tmp/widgets',
    defaultBranch: 'main',
  });
  return { workspaceId: 'ws1', otherWorkspaceId: 'ws2', envId: 'env1', repoId: 'repo1' };
}

async function insertTask(
  db: Database,
  overrides: Partial<{
    id: string;
    workspaceId: string;
    type: string;
    status: string;
    priority: string;
    title: string;
    description: string;
    repositoryId: string | null;
    branch: string | null;
    assignedEnvironmentId: string | null;
    metadata: Record<string, unknown>;
    completedAt: Date | null;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? `t${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  await db.insert(tasksTable).values({
    id,
    workspaceId: overrides.workspaceId ?? 'ws1',
    type: overrides.type ?? 'code_writing',
    status: overrides.status ?? 'queued',
    priority: overrides.priority ?? 'medium',
    title: overrides.title ?? 'task',
    description: overrides.description ?? 'desc',
    repositoryId: overrides.repositoryId === undefined ? 'repo1' : overrides.repositoryId,
    branch: overrides.branch ?? null,
    assignedEnvironmentId:
      overrides.assignedEnvironmentId === undefined ? 'env1' : overrides.assignedEnvironmentId,
    metadata: overrides.metadata ?? {},
    completedAt: overrides.completedAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('POST /tasks — auth + validation', () => {
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

  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`${serverUrl}/tasks`);
    expect(res.status).toBe(401);
  });

  it('creates an agent task when the caller owns the workspace', async () => {
    const res = await fetch(`${serverUrl}/tasks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId: 'ws1',
        type: 'code_writing',
        title: 'First task',
        description: 'do a thing',
        prompt: 'do the thing',
        repositoryId: 'repo1',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.title).toBe('First task');
    expect(body.data.status).toBe('queued');
  });

  it('refuses to create a task in a workspace the user does not own', async () => {
    const res = await fetch(`${serverUrl}/tasks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId: 'ws2',
        type: 'code_writing',
        title: 'cross-tenant',
        description: 'nope',
        repositoryId: 'repo1',
      }),
    });
    // requireWorkspaceAccess 404s on missing-or-unowned to avoid leaking existence.
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('refuses agent tasks without a repositoryId', async () => {
    const res = await fetch(`${serverUrl}/tasks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId: 'ws1',
        type: 'code_writing',
        title: 'no repo',
        description: 'missing',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/repositoryId is required/);
  });

  it('allows manual tasks without a repositoryId', async () => {
    const res = await fetch(`${serverUrl}/tasks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId: 'ws1',
        type: 'manual',
        title: 'manual task',
        description: 'todo',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.type).toBe('manual');
  });
});

describe('GET /tasks — listing + filtering', () => {
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

  it('returns tasks belonging to the user', async () => {
    await insertTask(db, { id: 't1', title: 'mine-1' });
    await insertTask(db, { id: 't2', title: 'mine-2' });
    // Task in a workspace the user doesn't own — should not appear.
    await insertTask(db, { id: 't3', workspaceId: 'ws2', title: 'not-mine' });

    const res = await fetch(`${serverUrl}/tasks?workspaceId=ws1`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.data as Array<{ id: string }>).map((t) => t.id).sort();
    expect(ids).toEqual(['t1', 't2']);
  });

  it('filters by status and type', async () => {
    await insertTask(db, { id: 'q1', status: 'queued', type: 'code_writing' });
    await insertTask(db, { id: 'c1', status: 'completed', type: 'code_writing' });
    await insertTask(db, { id: 'm1', status: 'queued', type: 'manual' });

    const res = await fetch(
      `${serverUrl}/tasks?workspaceId=ws1&status=queued&type=code_writing`,
      { headers: authHeaders }
    );
    const body = await res.json();
    const ids = (body.data as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual(['q1']);
  });
});

describe('GET /tasks/:id — ownership', () => {
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

  it('returns a task the user owns', async () => {
    await insertTask(db, { id: 'mine', title: 'hello' });
    const res = await fetch(`${serverUrl}/tasks/mine`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe('hello');
  });

  it('404s a task that belongs to another user', async () => {
    await insertTask(db, { id: 'theirs', workspaceId: 'ws2' });
    const res = await fetch(`${serverUrl}/tasks/theirs`, { headers: authHeaders });
    expect(res.status).toBe(404);
  });

  it('404s a task id that does not exist', async () => {
    const res = await fetch(`${serverUrl}/tasks/nope`, { headers: authHeaders });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /tasks/:id — partial updates', () => {
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

  it('updates title and description', async () => {
    await insertTask(db, { id: 'p1', title: 'old', description: 'old-desc' });
    const res = await fetch(`${serverUrl}/tasks/p1`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ title: 'new', description: 'new-desc' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe('new');
    expect(body.data.description).toBe('new-desc');
  });

  it('404s when the task belongs to another user', async () => {
    await insertTask(db, { id: 'p2', workspaceId: 'ws2' });
    const res = await fetch(`${serverUrl}/tasks/p2`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ title: 'hacked' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /tasks/:id', () => {
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

  it('removes an owned task', async () => {
    await insertTask(db, { id: 'd1' });
    const res = await fetch(`${serverUrl}/tasks/d1`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const rows = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.id, 'd1'));
    expect(rows).toHaveLength(0);
  });

  it('does not delete a task the user does not own', async () => {
    await insertTask(db, { id: 'd2', workspaceId: 'ws2' });
    const res = await fetch(`${serverUrl}/tasks/d2`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
    const rows = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.id, 'd2'));
    expect(rows).toHaveLength(1); // still present
  });
});

describe('POST /tasks/:id/retry', () => {
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

  it('flips a failed task back to queued and clears the result', async () => {
    await insertTask(db, {
      id: 'r1',
      status: 'failed',
      completedAt: new Date(),
    });
    const res = await fetch(`${serverUrl}/tasks/r1/retry`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, 'r1'))
      .limit(1);
    expect(rows[0].status).toBe('queued');
    expect(rows[0].completedAt).toBeNull();
    expect(rows[0].assignedAgentId).toBeNull();
  });
});

describe('GET /tasks/:id/git-log', () => {
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

  it('returns an empty log for a task with no git activity', async () => {
    await insertTask(db, { id: 'g1' });
    const res = await fetch(`${serverUrl}/tasks/g1/git-log`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.entries).toEqual([]);
  });

  it('returns the persisted entries from metadata', async () => {
    const entries = [
      {
        ts: '2026-04-22T10:00:00.000Z',
        command: 'git status --porcelain',
        exitCode: 0,
        stdoutPreview: '',
        stderrPreview: '',
        durationMs: 4,
      },
      {
        ts: '2026-04-22T10:00:01.000Z',
        command: 'git fetch origin main',
        exitCode: 0,
        stdoutPreview: '',
        stderrPreview: '',
        durationMs: 120,
      },
    ];
    await insertTask(db, { id: 'g2', metadata: { gitLog: entries } });

    const res = await fetch(`${serverUrl}/tasks/g2/git-log`, { headers: authHeaders });
    const body = await res.json();
    expect(body.data.entries).toHaveLength(2);
    expect(body.data.entries[1].command).toBe('git fetch origin main');
  });
});

describe('GET /tasks/:id/diff/files — snapshot path', () => {
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

  it('serves the finalFiles snapshot when present (post-completion path)', async () => {
    const finalFiles = [
      {
        path: 'src/a.ts',
        status: 'modified' as const,
        added: 3,
        removed: 1,
        binary: false,
        diff: '+foo\n-bar\n',
      },
      {
        path: 'src/b.ts',
        status: 'added' as const,
        added: 10,
        removed: 0,
        binary: false,
        diff: '+new file\n',
      },
    ];
    await insertTask(db, {
      id: 'f1',
      status: 'completed',
      branch: 'fastowl/f1-slug',
      metadata: { finalFiles },
    });

    const filesRes = await fetch(`${serverUrl}/tasks/f1/diff/files`, { headers: authHeaders });
    expect(filesRes.status).toBe(200);
    const body = await filesRes.json();
    expect(body.data.files).toHaveLength(2);
    // diff field is stripped from the list endpoint response.
    expect(body.data.files[0]).not.toHaveProperty('diff');
    expect(body.data.files[0].path).toBe('src/a.ts');
  });

  it('serves per-file diff from the snapshot', async () => {
    const finalFiles = [
      {
        path: 'src/a.ts',
        status: 'modified' as const,
        added: 3,
        removed: 1,
        binary: false,
        diff: '+three\n-one\n',
      },
    ];
    await insertTask(db, {
      id: 'f2',
      status: 'completed',
      branch: 'fastowl/f2-slug',
      metadata: { finalFiles },
    });

    const res = await fetch(
      `${serverUrl}/tasks/f2/diff/file?path=${encodeURIComponent('src/a.ts')}`,
      { headers: authHeaders }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.diff).toBe('+three\n-one\n');
  });

  it('requires a path query param on /diff/file', async () => {
    await insertTask(db, { id: 'f3', metadata: {} });
    const res = await fetch(`${serverUrl}/tasks/f3/diff/file`, { headers: authHeaders });
    expect(res.status).toBe(400);
  });
});

// Exercise the live-diff path (no snapshot). These routes share
// resolveTaskDiffContext, which owns env/repo selection + auth + git
// context lookup — cover both success and every error exit.
describe('GET /tasks/:id/diff* — live-diff path (no snapshot)', () => {
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

    // Stub the gitService surface the diff routes call into —
    // resolveTaskDiffContext itself doesn't shell out.
    vi.spyOn(gitService, 'getDiff').mockResolvedValue('unified diff body');
    vi.spyOn(gitService, 'getChangedFiles').mockResolvedValue([
      { path: 'src/a.ts', status: 'modified', added: 1, removed: 0, binary: false },
    ]);
    vi.spyOn(gitService, 'getFileDiff').mockResolvedValue('+hello\n');
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
    vi.restoreAllMocks();
  });

  it('/diff — happy path with assigned env + repo localPath shells out to gitService.getDiff', async () => {
    await insertTask(db, {
      id: 'd1',
      branch: 'fastowl/d1-slug',
      assignedEnvironmentId: 'env1',
    });
    const res = await fetch(`${serverUrl}/tasks/d1/diff`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.diff).toBe('unified diff body');
    expect(gitService.getDiff).toHaveBeenCalledWith(
      'env1',
      'fastowl/d1-slug',
      'main',
      '/tmp/widgets'
    );
  });

  it('/diff — 400 when the task has no branch', async () => {
    await insertTask(db, { id: 'd2', branch: null });
    const res = await fetch(`${serverUrl}/tasks/d2/diff`, { headers: authHeaders });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no branch/i);
  });

  it('/diff/files — falls back to live gitService.getChangedFiles when no snapshot is present', async () => {
    await insertTask(db, {
      id: 'd3',
      branch: 'fastowl/d3-slug',
      assignedEnvironmentId: 'env1',
      metadata: {},
    });
    const res = await fetch(`${serverUrl}/tasks/d3/diff/files`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.files).toHaveLength(1);
    expect(body.data.files[0].path).toBe('src/a.ts');
    expect(gitService.getChangedFiles).toHaveBeenCalled();
  });

  it('/diff/file — falls back to live gitService.getFileDiff when no snapshot hit for path', async () => {
    await insertTask(db, {
      id: 'd4',
      branch: 'fastowl/d4-slug',
      assignedEnvironmentId: 'env1',
      metadata: {},
    });
    const res = await fetch(
      `${serverUrl}/tasks/d4/diff/file?path=${encodeURIComponent('src/a.ts')}`,
      { headers: authHeaders }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.diff).toBe('+hello\n');
    expect(gitService.getFileDiff).toHaveBeenCalledWith('env1', 'main', 'src/a.ts', '/tmp/widgets');
  });

  it('/diff — auto-picks a connected env when the task has no assigned env', async () => {
    await insertTask(db, {
      id: 'd5',
      branch: 'fastowl/d5-slug',
      assignedEnvironmentId: null,
    });
    const res = await fetch(`${serverUrl}/tasks/d5/diff`, { headers: authHeaders });
    expect(res.status).toBe(200);
    // env1 is the only connected env owned by TEST_USER_ID — picked as the
    // fallback and passed into gitService.getDiff.
    expect(gitService.getDiff).toHaveBeenCalledWith(
      'env1',
      'fastowl/d5-slug',
      'main',
      '/tmp/widgets'
    );
  });

  it('/diff — 400 when there is no assigned env AND no connected env to fall back on', async () => {
    await db
      .update(environmentsTable)
      .set({ status: 'disconnected' })
      .where(eq(environmentsTable.id, 'env1'));
    await insertTask(db, {
      id: 'd6',
      branch: 'fastowl/d6-slug',
      assignedEnvironmentId: null,
    });
    const res = await fetch(`${serverUrl}/tasks/d6/diff`, { headers: authHeaders });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No connected environment/i);
  });

  it('/diff — refuses (5xx) when the task pins an env the caller does not own', async () => {
    // Env owned by a different user. requireEnvironmentAccess throws
    // AccessError('environment not found'), which resolveTaskDiffContext
    // surfaces as a 500 with that message. (The handler has a dead
    // `=== 'Forbidden'` branch for a 403 — cleanup target, not a
    // behavioural expectation.)
    await db.insert(environmentsTable).values({
      id: 'env-other',
      ownerId: OTHER_USER_ID,
      name: 'other-user',
      type: 'local',
      status: 'connected',
      config: {},
    });
    await insertTask(db, {
      id: 'd7',
      branch: 'fastowl/d7-slug',
      assignedEnvironmentId: 'env-other',
    });
    const res = await fetch(`${serverUrl}/tasks/d7/diff`, { headers: authHeaders });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/environment not found/i);
    expect(gitService.getDiff).not.toHaveBeenCalled();
  });

  it('/diff — 400 when the task has a branch but the repo has no localPath', async () => {
    await db
      .update(repositoriesTable)
      .set({ localPath: null })
      .where(eq(repositoriesTable.id, 'repo1'));
    await insertTask(db, {
      id: 'd8',
      branch: 'fastowl/d8-slug',
      assignedEnvironmentId: 'env1',
    });
    const res = await fetch(`${serverUrl}/tasks/d8/diff`, { headers: authHeaders });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Could not resolve a git working directory/i);
  });
});
