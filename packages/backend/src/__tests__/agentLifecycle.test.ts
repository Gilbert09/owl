import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentService } from '../services/agent.js';
import { agentStructuredService } from '../services/agentStructured.js';
import { environmentService } from '../services/environment.js';
import * as permissionHook from '../services/permissionHook.js';
import * as taskCommitSnapshot from '../services/taskCommitSnapshot.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
  agents as agentsTable,
} from '../db/schema.js';

/**
 * Build a fake `ActiveStructuredRun` the tests can resolve on demand.
 * `resolveCompletion(code)` simulates the child exiting; the agent
 * service's `.then(handleStructuredExit)` wiring then fires and runs
 * its DB writes.
 */
function makeFakeRun(overrides: {
  sessionKey: string;
  agentId: string;
  environmentId: string;
  workspaceId: string;
  taskId?: string;
  permissionToken?: string;
}): {
  run: Parameters<typeof agentStructuredService.start>[0] extends never
    ? never
    : Awaited<ReturnType<typeof agentStructuredService.start>>;
  resolveCompletion: (code: number) => void;
} {
  let resolveCompletion!: (code: number) => void;
  const completion = new Promise<number>((resolve) => {
    resolveCompletion = resolve;
  });
  const run = {
    sessionKey: overrides.sessionKey,
    agentId: overrides.agentId,
    environmentId: overrides.environmentId,
    taskId: overrides.taskId,
    workspaceId: overrides.workspaceId,
    interactive: false,
    transcript: [],
    startedAt: new Date(),
    completion,
    permissionToken: overrides.permissionToken,
  } as Awaited<ReturnType<typeof agentStructuredService.start>>;
  return { run, resolveCompletion };
}

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({
    id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {},
  });
  await db.insert(environmentsTable).values({
    id: 'env1',
    ownerId: TEST_USER_ID,
    name: 'e',
    type: 'local',
    status: 'connected',
    config: {},
    autonomousBypassPermissions: true, // default to bypass to avoid the hook write
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

async function insertTask(
  db: Database,
  overrides: Partial<{
    id: string;
    status: string;
    assignedEnvironmentId: string;
    metadata: Record<string, unknown>;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? 't-agent';
  const now = new Date();
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'code_writing',
    status: overrides.status ?? 'queued',
    priority: 'medium',
    title: 't',
    description: 'd',
    prompt: 'do it',
    repositoryId: 'repo1',
    assignedEnvironmentId:
      overrides.assignedEnvironmentId === undefined ? 'env1' : overrides.assignedEnvironmentId,
    metadata: overrides.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('agentService — startAgent + handleStructuredExit', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);

    // Short-circuit all I/O-bound helpers.
    vi.spyOn(environmentService, 'getStatus').mockResolvedValue('connected');
    vi.spyOn(environmentService, 'connect').mockResolvedValue(undefined);
    vi.spyOn(permissionHook, 'ensurePermissionHook').mockResolvedValue('/tmp/permission.cjs');
    vi.spyOn(taskCommitSnapshot, 'autoCommitAndSnapshot').mockResolvedValue({
      committed: false,
      reason: 'no-changes',
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('inserts an agent row, flips task to in_progress, persists permission token', async () => {
    const taskId = await insertTask(db);

    let captured: Parameters<typeof agentStructuredService.start>[0] | null = null;
    const { run, resolveCompletion } = makeFakeRun({
      sessionKey: 'agent:placeholder',
      agentId: 'placeholder',
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId,
      permissionToken: 'tok-xyz',
    });
    vi.spyOn(agentStructuredService, 'start').mockImplementation(async (opts) => {
      captured = opts;
      run.agentId = opts.agentId;
      run.sessionKey = opts.sessionKey;
      run.taskId = opts.taskId;
      return run;
    });
    vi.spyOn(agentStructuredService, 'flush').mockResolvedValue();

    const agent = await agentService.startAgent({
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId,
      prompt: 'do the thing',
    });

    // Agent row persisted.
    const agentRows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agent.id));
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0].workspaceId).toBe('ws1');
    expect(agentRows[0].permissionToken).toBe('tok-xyz');

    // Task flipped.
    const taskRows = await db
      .select({ status: tasksTable.status, assignedAgentId: tasksTable.assignedAgentId })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId));
    expect(taskRows[0].status).toBe('in_progress');
    expect(taskRows[0].assignedAgentId).toBe(agent.id);

    // Structured service called with the right args.
    expect(captured).toBeTruthy();
    expect(captured?.workspaceId).toBe('ws1');
    expect(captured?.environmentId).toBe('env1');
    expect(captured?.prompt).toBe('do the thing');

    // Resolve the fake completion so no dangling .then chain outlives
    // the test — vitest treats that as a "task not done" signal.
    resolveCompletion(0);
    await new Promise((r) => setTimeout(r, 30));
  });

  it('rolls back on spawn failure (agent row deleted, task back to queued)', async () => {
    const taskId = await insertTask(db);
    vi.spyOn(agentStructuredService, 'start').mockRejectedValue(new Error('claude missing'));

    await expect(
      agentService.startAgent({
        environmentId: 'env1',
        workspaceId: 'ws1',
        taskId,
        prompt: 'x',
      })
    ).rejects.toThrow(/claude missing/);

    const agentRows = await db.select().from(agentsTable);
    expect(agentRows).toHaveLength(0);
    const taskRows = await db
      .select({ status: tasksTable.status, assignedAgentId: tasksTable.assignedAgentId })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId));
    expect(taskRows[0].status).toBe('queued');
    expect(taskRows[0].assignedAgentId).toBeNull();
  });

  it('handleStructuredExit on code=0 flips task to awaiting_review and deletes agent row', async () => {
    const taskId = await insertTask(db);

    const { run, resolveCompletion } = makeFakeRun({
      sessionKey: 'x',
      agentId: 'x',
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId,
    });
    vi.spyOn(agentStructuredService, 'start').mockImplementation(async (opts) => {
      run.agentId = opts.agentId;
      run.sessionKey = opts.sessionKey;
      run.taskId = opts.taskId;
      return run;
    });
    vi.spyOn(agentStructuredService, 'flush').mockResolvedValue();

    const agent = await agentService.startAgent({
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId,
      prompt: 'do it',
    });

    resolveCompletion(0);
    // Wait for the microtask chain inside `run.completion.then(...)`.
    await new Promise((r) => setTimeout(r, 50));

    const taskRows = await db
      .select({ status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId));
    expect(taskRows[0].status).toBe('awaiting_review');

    const agentRows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agent.id));
    expect(agentRows).toHaveLength(0);
  });

  it('handleStructuredExit on code!=0 flips task to failed with a result message', async () => {
    const taskId = await insertTask(db);

    const { run, resolveCompletion } = makeFakeRun({
      sessionKey: 'x',
      agentId: 'x',
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId,
    });
    vi.spyOn(agentStructuredService, 'start').mockImplementation(async (opts) => {
      run.agentId = opts.agentId;
      run.sessionKey = opts.sessionKey;
      run.taskId = opts.taskId;
      return run;
    });
    vi.spyOn(agentStructuredService, 'flush').mockResolvedValue();

    await agentService.startAgent({
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId,
      prompt: 'boom',
    });

    resolveCompletion(1);
    await new Promise((r) => setTimeout(r, 50));

    const taskRows = await db
      .select({
        status: tasksTable.status,
        result: tasksTable.result,
        completedAt: tasksTable.completedAt,
      })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId));
    expect(taskRows[0].status).toBe('failed');
    expect((taskRows[0].result as { error?: string })?.error).toMatch(/exited with code 1/);
    expect(taskRows[0].completedAt).not.toBeNull();
  });
});

describe('agentService — continueTask', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);

    vi.spyOn(environmentService, 'getStatus').mockResolvedValue('connected');
    vi.spyOn(environmentService, 'connect').mockResolvedValue(undefined);
    vi.spyOn(permissionHook, 'ensurePermissionHook').mockResolvedValue('/tmp/permission.cjs');
    vi.spyOn(taskCommitSnapshot, 'autoCommitAndSnapshot').mockResolvedValue({
      committed: false,
      reason: 'no-changes',
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('throws when the task has no saved claudeSessionId', async () => {
    const taskId = await insertTask(db, {
      status: 'awaiting_review',
      metadata: {},
    });
    await expect(
      agentService.continueTask({ taskId, workspaceId: 'ws1', prompt: 'again' })
    ).rejects.toThrow(/Claude session to resume/i);
  });

  it('throws when the task has no assignedEnvironmentId', async () => {
    const taskId = await insertTask(db, {
      status: 'awaiting_review',
      assignedEnvironmentId: null,
      metadata: { claudeSessionId: 'sess-123' },
    });
    await expect(
      agentService.continueTask({ taskId, workspaceId: 'ws1', prompt: 'again' })
    ).rejects.toThrow(/no assigned environment/i);
  });

  it('passes --resume via resumeSessionId on the happy path', async () => {
    const taskId = await insertTask(db, {
      status: 'awaiting_review',
      metadata: { claudeSessionId: 'sess-claude-9' },
    });

    let captured: Parameters<typeof agentStructuredService.start>[0] | null = null;
    const { run, resolveCompletion } = makeFakeRun({
      sessionKey: 'x',
      agentId: 'x',
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId,
    });
    vi.spyOn(agentStructuredService, 'start').mockImplementation(async (opts) => {
      captured = opts;
      run.agentId = opts.agentId;
      run.sessionKey = opts.sessionKey;
      run.taskId = opts.taskId;
      return run;
    });
    vi.spyOn(agentStructuredService, 'flush').mockResolvedValue();

    await agentService.continueTask({
      taskId,
      workspaceId: 'ws1',
      prompt: 'one more thing',
    });

    expect(captured?.resumeSessionId).toBe('sess-claude-9');
    expect(captured?.prompt).toBe('one more thing');

    // Task flipped back to in_progress.
    const rows = await db
      .select({ status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId));
    expect(rows[0].status).toBe('in_progress');

    resolveCompletion(0);
    await new Promise((r) => setTimeout(r, 30));
  });
});
