import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { taskRoutes } from '../../routes/tasks.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import {
  installFakeEnvironment,
  type FakeEnvironmentHandle,
} from '../helpers/fakeEnvironment.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../../db/schema.js';
import { agentService } from '../../services/agent.js';
import * as aiModule from '../../services/ai.js';
import * as taskCommitSnapshotModule from '../../services/taskCommitSnapshot.js';
import * as prModule from '../../services/taskPullRequest.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.use('/tasks', requireAuth, taskRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
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
}

async function insertTask(
  db: Database,
  overrides: Partial<{
    id: string;
    workspaceId: string;
    type: string;
    status: string;
    branch: string | null;
    assignedEnvironmentId: string | null;
    repositoryId: string | null;
    metadata: Record<string, unknown>;
    assignedAgentId: string | null;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? `t-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  await db.insert(tasksTable).values({
    id,
    workspaceId: overrides.workspaceId ?? 'ws1',
    type: overrides.type ?? 'code_writing',
    status: overrides.status ?? 'queued',
    priority: 'medium',
    title: 'task',
    description: 'd',
    prompt: 'do it',
    branch: overrides.branch === undefined ? null : overrides.branch,
    assignedEnvironmentId:
      overrides.assignedEnvironmentId === undefined ? 'env1' : overrides.assignedEnvironmentId,
    repositoryId: overrides.repositoryId === undefined ? 'repo1' : overrides.repositoryId,
    assignedAgentId: overrides.assignedAgentId ?? null,
    metadata: overrides.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/tasks lifecycle', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  let fake: FakeEnvironmentHandle;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);

    // Leaf-level git ops go through fakeEnvironment so gitService's
    // own logic is still exercised but nothing spawns a real process.
    fake = installFakeEnvironment();

    // Short-circuit AI calls — the fire-and-forget title refinement
    // in POST / already gates on isConfigured, which is false by
    // default. These stubs cover any code path that DOES reach an
    // AI call so tests don't hang waiting on a daemon that isn't
    // connected.
    vi.spyOn(aiModule, 'generateCommitMessage').mockResolvedValue('feat: LLM-generated message');
    vi.spyOn(aiModule, 'generateTaskTitle').mockResolvedValue('Refined title');
    vi.spyOn(aiModule, 'isConfigured').mockReturnValue(false);
    // Short-circuit autocommit — individual approve/ready-for-review
    // tests override this to assert end-to-end wiring when needed.
    vi.spyOn(taskCommitSnapshotModule, 'autoCommitAndSnapshot').mockResolvedValue({
      committed: false,
      reason: 'no-changes',
    });
    vi.spyOn(taskCommitSnapshotModule, 'writeFinalFilesSnapshot').mockResolvedValue();

    // PR creation is a network call — keep it out of tests by default.
    vi.spyOn(prModule, 'openPullRequestForTask').mockImplementation(async (taskId) => {
      // Match the real helper's "set success metadata" behaviour so
      // the approve handler's follow-up read sees a realistic shape.
      const dbClient = await import('../../db/client.js').then((m) => m.getDbClient());
      const rows = await dbClient
        .select({ metadata: tasksTable.metadata })
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId));
      const existing = (rows[0]?.metadata as Record<string, unknown>) ?? {};
      await dbClient
        .update(tasksTable)
        .set({
          metadata: {
            ...existing,
            pullRequest: {
              number: 1,
              url: 'https://github.com/acme/widgets/pull/1',
              createdAt: new Date().toISOString(),
            },
          },
        })
        .where(eq(tasksTable.id, taskId));
    });

    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    fake.restore();
    await cleanup();
    vi.restoreAllMocks();
  });

  // -------- /start --------

  describe('POST /tasks/:id/start', () => {
    it('rejects a non-agent task', async () => {
      const id = await insertTask(db, { type: 'manual' });
      const res = await fetch(`${serverUrl}/tasks/${id}/start`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/agent tasks/i);
    });

    it('is idempotent when an agent is already running for the task', async () => {
      const id = await insertTask(db, { status: 'in_progress' });
      // Simulate "agent already running" via the in-memory service
      // map. We push a stub active agent onto the service's internal
      // state via its public API — there's none, so we use the spy
      // layer to return a fake.
      vi.spyOn(agentService, 'getAgentByTaskId').mockReturnValue({
        id: 'a-running',
        workspaceId: 'ws1',
        environmentId: 'env1',
        sessionId: 's',
        status: 'working',
        attention: 'none',
        lastActivityTime: new Date(),
        currentTaskId: id,
      } as unknown as ReturnType<typeof agentService.getAgentByTaskId>);

      const res = await fetch(`${serverUrl}/tasks/${id}/start`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
    });

    it('spawns an agent + flips the task to in_progress on the happy path', async () => {
      const id = await insertTask(db);
      vi.spyOn(agentService, 'getAgentByTaskId').mockReturnValue(null);
      const startSpy = vi
        .spyOn(agentService, 'startAgent')
        .mockResolvedValue({
          id: 'a-new',
          workspaceId: 'ws1',
          environmentId: 'env1',
          status: 'working',
          attention: 'none',
          terminalOutput: '',
          lastActivity: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });

      const res = await fetch(`${serverUrl}/tasks/${id}/start`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);

      const rows = await db
        .select({ status: tasksTable.status, assignedEnvironmentId: tasksTable.assignedEnvironmentId })
        .from(tasksTable)
        .where(eq(tasksTable.id, id));
      expect(rows[0].status).toBe('in_progress');
      expect(rows[0].assignedEnvironmentId).toBe('env1');
      expect(startSpy).toHaveBeenCalled();
    });

    it('rolls back to queued and surfaces the error when agent start fails', async () => {
      const id = await insertTask(db);
      vi.spyOn(agentService, 'getAgentByTaskId').mockReturnValue(null);
      vi.spyOn(agentService, 'startAgent').mockRejectedValue(new Error('claude missing'));

      const res = await fetch(`${serverUrl}/tasks/${id}/start`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);

      const rows = await db
        .select({ status: tasksTable.status })
        .from(tasksTable)
        .where(eq(tasksTable.id, id));
      // Whatever the rollback target is (queued), it's not in_progress.
      expect(rows[0].status).not.toBe('in_progress');
    });
  });

  // -------- /stop --------

  describe('POST /tasks/:id/stop', () => {
    it('400s a task that is not running', async () => {
      const id = await insertTask(db, { status: 'queued' });
      const res = await fetch(`${serverUrl}/tasks/${id}/stop`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not running/i);
    });

    it('stops the agent + flips the task to failed with "Stopped by user"', async () => {
      const id = await insertTask(db, { status: 'in_progress' });
      const getByTask = vi.spyOn(agentService, 'getAgentByTaskId').mockReturnValue({
        id: 'a-run',
        workspaceId: 'ws1',
        environmentId: 'env1',
        sessionId: 's',
        status: 'working',
        attention: 'none',
        lastActivityTime: new Date(),
        currentTaskId: id,
      } as unknown as ReturnType<typeof agentService.getAgentByTaskId>);
      const stopSpy = vi.spyOn(agentService, 'stopAgent').mockImplementation(() => {});

      const res = await fetch(`${serverUrl}/tasks/${id}/stop`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      expect(getByTask).toHaveBeenCalledWith(id);
      expect(stopSpy).toHaveBeenCalledWith('a-run');

      const rows = await db
        .select({ status: tasksTable.status, result: tasksTable.result })
        .from(tasksTable)
        .where(eq(tasksTable.id, id));
      expect(rows[0].status).toBe('failed');
      expect((rows[0].result as { error?: string })?.error).toMatch(/Stopped by user/);
    });
  });

  // -------- /input --------

  describe('POST /tasks/:id/input', () => {
    it('forwards input to the running agent', async () => {
      const id = await insertTask(db, { status: 'in_progress' });
      vi.spyOn(agentService, 'getAgentByTaskId').mockReturnValue({
        id: 'a-live',
      } as unknown as ReturnType<typeof agentService.getAgentByTaskId>);
      const sendSpy = vi.spyOn(agentService, 'sendInput').mockImplementation(() => {});

      const res = await fetch(`${serverUrl}/tasks/${id}/input`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ input: 'hello\n' }),
      });
      expect(res.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledWith('a-live', 'hello\n');
    });

    it('400s when the task is not running', async () => {
      const id = await insertTask(db, { status: 'queued' });
      const res = await fetch(`${serverUrl}/tasks/${id}/input`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ input: 'hi' }),
      });
      expect(res.status).toBe(400);
    });

    it('400s when the task has no active agent', async () => {
      const id = await insertTask(db, { status: 'in_progress' });
      vi.spyOn(agentService, 'getAgentByTaskId').mockReturnValue(null);

      const res = await fetch(`${serverUrl}/tasks/${id}/input`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ input: 'hi' }),
      });
      expect(res.status).toBe(400);
    });

    it('400s when input is missing', async () => {
      const id = await insertTask(db, { status: 'in_progress' });
      const res = await fetch(`${serverUrl}/tasks/${id}/input`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // -------- /continue --------

  describe('POST /tasks/:id/continue', () => {
    it('400s on empty prompt', async () => {
      const id = await insertTask(db, { status: 'completed' });
      const res = await fetch(`${serverUrl}/tasks/${id}/continue`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ prompt: '   ' }),
      });
      expect(res.status).toBe(400);
    });

    it('is idempotent — returns task when already in_progress', async () => {
      const id = await insertTask(db, { status: 'in_progress' });
      const cont = vi.spyOn(agentService, 'continueTask');
      const res = await fetch(`${serverUrl}/tasks/${id}/continue`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ prompt: 'go again' }),
      });
      expect(res.status).toBe(200);
      expect(cont).not.toHaveBeenCalled();
    });

    it('delegates to agentService.continueTask on the happy path', async () => {
      const id = await insertTask(db, { status: 'awaiting_review' });
      const cont = vi.spyOn(agentService, 'continueTask').mockResolvedValue({} as never);
      const res = await fetch(`${serverUrl}/tasks/${id}/continue`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ prompt: 'one more thing' }),
      });
      expect(res.status).toBe(200);
      expect(cont).toHaveBeenCalledWith(expect.objectContaining({
        taskId: id,
        workspaceId: 'ws1',
        prompt: 'one more thing',
      }));
    });

    it('surfaces service errors as 400', async () => {
      const id = await insertTask(db, { status: 'awaiting_review' });
      vi.spyOn(agentService, 'continueTask').mockRejectedValue(
        new Error('session id missing')
      );
      const res = await fetch(`${serverUrl}/tasks/${id}/continue`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ prompt: 'x' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/session id missing/);
    });
  });

  // -------- /ready-for-review --------

  describe('POST /tasks/:id/ready-for-review', () => {
    it('flips a running agent task to awaiting_review + stops the agent', async () => {
      const id = await insertTask(db, { status: 'in_progress' });
      vi.spyOn(agentService, 'getAgentByTaskId').mockReturnValue({
        id: 'a-live',
      } as unknown as ReturnType<typeof agentService.getAgentByTaskId>);
      const stopSpy = vi.spyOn(agentService, 'stopAgent').mockImplementation(() => {});
      const autoCommitSpy = vi.spyOn(
        taskCommitSnapshotModule,
        'autoCommitAndSnapshot'
      );

      const res = await fetch(`${serverUrl}/tasks/${id}/ready-for-review`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      expect(stopSpy).toHaveBeenCalledWith('a-live');
      // Auto-commit + snapshot runs on the transition — this is what
      // makes "Files tab stays complete" work.
      expect(autoCommitSpy).toHaveBeenCalledWith(id);

      const rows = await db
        .select({ status: tasksTable.status })
        .from(tasksTable)
        .where(eq(tasksTable.id, id));
      expect(rows[0].status).toBe('awaiting_review');
    });

    it('still transitions when autoCommitAndSnapshot reports no changes', async () => {
      const id = await insertTask(db, { status: 'in_progress' });
      vi.spyOn(agentService, 'getAgentByTaskId').mockReturnValue(undefined);
      // Default beforeEach mock already returns `no-changes`; assert
      // the transition still completes instead of wedging the task.
      const res = await fetch(`${serverUrl}/tasks/${id}/ready-for-review`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const rows = await db
        .select({ status: tasksTable.status })
        .from(tasksTable)
        .where(eq(tasksTable.id, id));
      expect(rows[0].status).toBe('awaiting_review');
    });

    it('refuses to mark a non-running task', async () => {
      const id = await insertTask(db, { status: 'queued' });
      const res = await fetch(`${serverUrl}/tasks/${id}/ready-for-review`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(400);
    });

    it('refuses manual tasks', async () => {
      const id = await insertTask(db, { status: 'in_progress', type: 'manual' });
      const res = await fetch(`${serverUrl}/tasks/${id}/ready-for-review`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(400);
    });
  });

  // -------- /approve --------

  describe('POST /tasks/:id/approve', () => {
    async function insertApprovableTask(
      overrides: Partial<Parameters<typeof insertTask>[1]> = {}
    ): Promise<string> {
      return insertTask(db, {
        status: 'awaiting_review',
        branch: 'fastowl/abc-slug',
        assignedEnvironmentId: 'env1',
        repositoryId: 'repo1',
        ...overrides,
      });
    }

    it('400s without a branch', async () => {
      const id = await insertApprovableTask({ branch: null });
      const res = await fetch(`${serverUrl}/tasks/${id}/approve`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no branch/i);
    });

    it('400s when the repo has no local path', async () => {
      const id = await insertApprovableTask();
      await db
        .update(repositoriesTable)
        .set({ localPath: null })
        .where(eq(repositoriesTable.id, 'repo1'));

      const res = await fetch(`${serverUrl}/tasks/${id}/approve`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('attaches a fallback connected env when assignedEnvironmentId is null', async () => {
      const id = await insertApprovableTask({ assignedEnvironmentId: null });
      const res = await fetch(`${serverUrl}/tasks/${id}/approve`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      // The "no env" 400 path should NOT fire — the fallback lookup
      // should attach env1 before push/PR even start.
      if (res.status === 400) {
        const body = await res.json();
        expect(body.error).not.toMatch(/no assigned environment/i);
      }
      const rows = await db
        .select({ assignedEnvironmentId: tasksTable.assignedEnvironmentId })
        .from(tasksTable)
        .where(eq(tasksTable.id, id));
      expect(rows[0].assignedEnvironmentId).toBe('env1');
    });

    it('happy path: pushes branch, opens PR, marks completed', async () => {
      const id = await insertApprovableTask();
      fake.restore();
      const scripted = installFakeEnvironment({
        outputs: {
          'git rev-parse --abbrev-ref HEAD': 'fastowl/abc-slug\n',
          'git status --porcelain': '',
        },
      });

      try {
        const res = await fetch(`${serverUrl}/tasks/${id}/approve`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);

        const rows = await db
          .select({
            status: tasksTable.status,
            metadata: tasksTable.metadata,
            completedAt: tasksTable.completedAt,
          })
          .from(tasksTable)
          .where(eq(tasksTable.id, id));
        expect(rows[0].status).toBe('completed');
        expect(rows[0].completedAt).not.toBeNull();
        const meta = rows[0].metadata as Record<string, unknown>;
        expect(meta.pullRequest).toEqual(
          expect.objectContaining({ number: 1 })
        );
      } finally {
        scripted.restore();
        fake = installFakeEnvironment();
      }
    });

    it('refuses to complete when the working tree is still dirty after push', async () => {
      const id = await insertApprovableTask();
      fake.restore();
      const scripted = installFakeEnvironment({
        outputs: {
          'git rev-parse --abbrev-ref HEAD': 'fastowl/abc-slug\n',
          // Post-push safety-net check: ' M file' → uncommitted work
          // remains even though autoCommit was mocked to no-op.
          'git status --porcelain': ' M leftover.ts\n',
        },
      });

      try {
        const res = await fetch(`${serverUrl}/tasks/${id}/approve`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toMatch(/uncommitted changes/i);
      } finally {
        scripted.restore();
        fake = installFakeEnvironment();
      }
    });
  });

  // -------- /reject --------

  describe('POST /tasks/:id/reject', () => {
    it('resets the tree and requeues the task', async () => {
      const id = await insertTask(db, {
        status: 'awaiting_review',
        branch: 'fastowl/abc',
        metadata: { pullRequest: { number: 9, url: 'x' } },
      });

      const res = await fetch(`${serverUrl}/tasks/${id}/reject`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);

      const rows = await db
        .select({
          status: tasksTable.status,
          branch: tasksTable.branch,
        })
        .from(tasksTable)
        .where(eq(tasksTable.id, id));
      expect(rows[0].status).toBe('queued');
      // Branch is cleared so retry gets a fresh prepareTaskBranch.
      expect(rows[0].branch).toBeNull();
    });

    it('404s a cross-tenant task', async () => {
      const id = await insertTask(db, {
        workspaceId: 'ws2',
        status: 'awaiting_review',
      });
      const res = await fetch(`${serverUrl}/tasks/${id}/reject`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });
  });

  // -------- /retry-pr --------

  describe('POST /tasks/:id/retry-pr', () => {
    it('400s a task with no branch', async () => {
      const id = await insertTask(db, { branch: null });
      const res = await fetch(`${serverUrl}/tasks/${id}/retry-pr`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(400);
    });

    it('returns the PR when openPullRequestForTask succeeds', async () => {
      const id = await insertTask(db, {
        status: 'completed',
        branch: 'fastowl/abc',
      });
      // Default stub writes { pullRequest: { number: 1, ... }}
      const res = await fetch(`${serverUrl}/tasks/${id}/retry-pr`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.pullRequest.number).toBe(1);
    });

    it('502s when openPullRequestForTask left metadata.pullRequestError', async () => {
      const id = await insertTask(db, {
        status: 'completed',
        branch: 'fastowl/abc',
      });
      // Replace the default happy stub with one that writes an error.
      vi.spyOn(prModule, 'openPullRequestForTask').mockImplementation(async (taskId) => {
        const dbClient = await import('../../db/client.js').then((m) => m.getDbClient());
        const rows = await dbClient
          .select({ metadata: tasksTable.metadata })
          .from(tasksTable)
          .where(eq(tasksTable.id, taskId));
        const existing = (rows[0]?.metadata as Record<string, unknown>) ?? {};
        await dbClient
          .update(tasksTable)
          .set({
            metadata: { ...existing, pullRequestError: 'rate limited' },
          })
          .where(eq(tasksTable.id, taskId));
      });

      const res = await fetch(`${serverUrl}/tasks/${id}/retry-pr`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toMatch(/rate limited/);
    });
  });

});
