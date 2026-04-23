import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskQueueService } from '../services/taskQueue.js';
import { agentService } from '../services/agent.js';
import { environmentService } from '../services/environment.js';
import { gitService } from '../services/git.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../db/schema.js';

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({
    id: 'ws1',
    ownerId: TEST_USER_ID,
    name: 'ws',
    settings: { autoAssignTasks: true, maxConcurrentAgents: 3 },
  });
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
    name: 'a/b',
    url: 'https://github.com/a/b',
    localPath: '/tmp/b',
    defaultBranch: 'main',
  });
}

async function insertQueuedTask(
  db: Database,
  overrides: Partial<{
    id: string;
    type: string;
    status: string;
    repositoryId: string | null;
    assignedEnvironmentId: string | null;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? `t-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: overrides.type ?? 'code_writing',
    status: overrides.status ?? 'queued',
    priority: 'medium',
    title: `task-${id}`,
    description: 'd',
    prompt: 'do',
    repositoryId: overrides.repositoryId === undefined ? 'repo1' : overrides.repositoryId,
    assignedEnvironmentId:
      overrides.assignedEnvironmentId === undefined ? null : overrides.assignedEnvironmentId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('taskQueueService.processQueue', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);

    // Default: no idle agents, one connected env.
    vi.spyOn(agentService, 'getIdleAgents').mockResolvedValue([]);
    vi.spyOn(agentService, 'getAgentsByWorkspace').mockResolvedValue([]);
    vi.spyOn(agentService, 'isAgentActive').mockReturnValue(false);
    // Short-circuit git prep — no real repo on disk.
    vi.spyOn(gitService, 'prepareTaskBranch').mockResolvedValue('fastowl/test-branch');
    vi.spyOn(gitService, 'checkoutBranch').mockResolvedValue();
  });

  afterEach(async () => {
    taskQueueService.shutdown();
    await cleanup();
    vi.restoreAllMocks();
  });

  it('no-ops when the queue is empty', async () => {
    const startSpy = vi.spyOn(agentService, 'startAgent');
    await taskQueueService.processQueue();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('starts an agent on a connected env for a queued agent task', async () => {
    const id = await insertQueuedTask(db);
    const startSpy = vi
      .spyOn(agentService, 'startAgent')
      .mockImplementation(async (req) => ({
        id: 'new-agent',
        workspaceId: req.workspaceId,
        environmentId: req.environmentId,
        status: 'working',
        attention: 'none',
        terminalOutput: '',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }));

    await taskQueueService.processQueue();

    expect(startSpy).toHaveBeenCalledTimes(1);
    const rows = await db
      .select({ status: tasksTable.status, assignedEnvironmentId: tasksTable.assignedEnvironmentId })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].assignedEnvironmentId).toBe('env1');
  });

  it('skips non-agent tasks', async () => {
    await insertQueuedTask(db, { type: 'manual' });
    const startSpy = vi.spyOn(agentService, 'startAgent');

    await taskQueueService.processQueue();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('does not pick up tasks when the (env, repo) slot is held', async () => {
    // Task A is already in_progress on (env1, repo1) — holds the slot.
    const holderId = await insertQueuedTask(db, {
      id: 't-holder',
      status: 'in_progress',
      assignedEnvironmentId: 'env1',
    });
    // Task B is queued, same env+repo pair.
    await insertQueuedTask(db, { id: 't-blocked' });

    const startSpy = vi.spyOn(agentService, 'startAgent');
    await taskQueueService.processQueue();
    expect(startSpy).not.toHaveBeenCalled();

    // Holder is untouched.
    const rows = await db
      .select({ status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, holderId));
    expect(rows[0].status).toBe('in_progress');
  });

  it('respects maxConcurrentAgents — declines to start when the workspace is at cap', async () => {
    await db
      .update(workspacesTable)
      .set({ settings: { autoAssignTasks: true, maxConcurrentAgents: 1 } })
      .where(eq(workspacesTable.id, 'ws1'));

    await insertQueuedTask(db, { id: 't-queued' });

    // Pretend there's already one active agent for this workspace.
    vi.spyOn(agentService, 'getAgentsByWorkspace').mockResolvedValue([
      {
        id: 'a-active',
        workspaceId: 'ws1',
        environmentId: 'env1',
        status: 'working',
        attention: 'none',
        terminalOutput: '',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ]);
    // Mark that agent active in-memory so the active-count check sees it.
    vi.spyOn(agentService, 'isAgentActive').mockReturnValue(true);

    const startSpy = vi.spyOn(agentService, 'startAgent');
    await taskQueueService.processQueue();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('rolls the task back to queued + writes lastScheduleError when startAgent throws', async () => {
    const id = await insertQueuedTask(db);
    vi.spyOn(agentService, 'startAgent').mockRejectedValue(
      new Error('env went offline')
    );

    await taskQueueService.processQueue();

    const rows = await db
      .select({
        status: tasksTable.status,
        metadata: tasksTable.metadata,
        assignedEnvironmentId: tasksTable.assignedEnvironmentId,
      })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));
    expect(rows[0].status).toBe('queued');
    expect(rows[0].assignedEnvironmentId).toBeNull();
    const meta = rows[0].metadata as {
      lastScheduleError?: { reason?: string };
    };
    expect(meta.lastScheduleError?.reason).toMatch(/env went offline/);
  });

  it('skips envs that already have an active agent (avoids double-booking)', async () => {
    await insertQueuedTask(db);
    // Simulate an existing active agent in the ws1 + env1 pair that
    // is NOT on any task (no task would otherwise be "queued") —
    // schedulers protect against double-booking via agentsByWorkspace.
    vi.spyOn(agentService, 'getAgentsByWorkspace').mockResolvedValue([
      {
        id: 'a-active',
        workspaceId: 'ws1',
        environmentId: 'env1',
        status: 'working',
        attention: 'none',
        terminalOutput: '',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ]);
    vi.spyOn(agentService, 'isAgentActive').mockReturnValue(true);

    const startSpy = vi.spyOn(agentService, 'startAgent');
    await taskQueueService.processQueue();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('respects task.assignedEnvironmentId pinning (only starts on the pinned env)', async () => {
    // Add a second connected env.
    await db.insert(environmentsTable).values({
      id: 'env2',
      ownerId: TEST_USER_ID,
      name: 'other',
      type: 'local',
      status: 'connected',
      config: {},
    });
    await insertQueuedTask(db, {
      id: 't-pinned',
      assignedEnvironmentId: 'env2',
    });

    const startSpy = vi
      .spyOn(agentService, 'startAgent')
      .mockImplementation(async (req) => ({
        id: 'agent-x',
        workspaceId: req.workspaceId,
        environmentId: req.environmentId,
        status: 'working',
        attention: 'none',
        terminalOutput: '',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }));

    await taskQueueService.processQueue();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'env2' })
    );
  });

  it('does not start agents on disconnected envs', async () => {
    await db
      .update(environmentsTable)
      .set({ status: 'disconnected' })
      .where(eq(environmentsTable.id, 'env1'));
    await insertQueuedTask(db);

    const startSpy = vi.spyOn(agentService, 'startAgent');
    await taskQueueService.processQueue();
    expect(startSpy).not.toHaveBeenCalled();
  });
});
