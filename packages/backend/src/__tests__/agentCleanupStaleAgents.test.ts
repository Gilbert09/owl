import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentService } from '../services/agent.js';
import { agentStructuredService } from '../services/agentStructured.js';
import { daemonRegistry } from '../services/daemonRegistry.js';
import { environmentService } from '../services/environment.js';
import { permissionService } from '../services/permissionService.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
  agents as agentsTable,
} from '../db/schema.js';

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
    autonomousBypassPermissions: true,
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

async function insertAgentRow(
  db: Database,
  overrides: Partial<{
    id: string;
    status: 'idle' | 'working' | 'tool_use' | 'awaiting_input' | 'stopped';
    currentTaskId: string | null;
    permissionToken: string | null;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? `agent-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date();
  await db.insert(agentsTable).values({
    id,
    workspaceId: 'ws1',
    environmentId: 'env1',
    status: overrides.status ?? 'working',
    attention: 'none',
    terminalOutput: '',
    currentTaskId: overrides.currentTaskId ?? null,
    permissionToken: overrides.permissionToken ?? null,
    lastActivity: now,
    createdAt: now,
  });
  return id;
}

async function insertTaskRow(
  db: Database,
  id: string,
  status: 'in_progress' | 'awaiting_review' | 'queued' = 'in_progress'
): Promise<void> {
  const now = new Date();
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'code_writing',
    status,
    priority: 'medium',
    title: 't',
    description: 'd',
    prompt: 'p',
    repositoryId: 'repo1',
    assignedEnvironmentId: 'env1',
    createdAt: now,
    updatedAt: now,
  });
}

describe('agentService.init — cleanupStaleAgents reconciliation', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);

    // connectedEnvironmentIds must cover every agent's env for the
    // fast-path sweep to fire immediately. Without this, sweep waits
    // the 60s grace timer — overkill for tests.
    vi.spyOn(daemonRegistry, 'connectedEnvironmentIds').mockReturnValue(
      new Set(['env1'])
    );
  });

  afterEach(async () => {
    agentService.shutdown();
    // agentService.init subscribes to agentStructuredService events;
    // clean them so the next test starts fresh.
    agentStructuredService.removeAllListeners('turn_complete');
    agentStructuredService.removeAllListeners('session_id_captured');
    daemonRegistry.removeAllListeners('daemon:connected');
    await cleanup();
    vi.restoreAllMocks();
  });

  it('no-ops cleanly when no in-flight agents exist', async () => {
    const isLive = vi.spyOn(daemonRegistry, 'isSessionLive');
    await agentService.init();
    await new Promise((r) => setTimeout(r, 10));
    expect(isLive).not.toHaveBeenCalled();
  });

  it('fails orphaned agents (daemon does not claim their session) and flips tasks to failed', async () => {
    await insertTaskRow(db, 't-orphan');
    await insertAgentRow(db, { id: 'a-orphan', currentTaskId: 't-orphan' });

    // Daemon doesn't recognise this session — orphan.
    vi.spyOn(daemonRegistry, 'isSessionLive').mockReturnValue(false);

    await agentService.init();
    // Sweep is scheduled via `void sweep()`; give it a tick.
    await new Promise((r) => setTimeout(r, 20));

    // Agent row removed.
    const agentRows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, 'a-orphan'));
    expect(agentRows).toHaveLength(0);

    // Task flipped to `failed` with the orphaned reason.
    const taskRows = await db
      .select({ status: tasksTable.status, result: tasksTable.result })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't-orphan'));
    expect(taskRows[0].status).toBe('failed');
    expect((taskRows[0].result as { error: string }).error).toMatch(/orphaned/);
  });

  it('keeps orphan-agent rows when there is no current task (just deletes the agent)', async () => {
    await insertAgentRow(db, { id: 'a-loose', currentTaskId: null });
    vi.spyOn(daemonRegistry, 'isSessionLive').mockReturnValue(false);

    await agentService.init();
    await new Promise((r) => setTimeout(r, 15));

    const rows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, 'a-loose'));
    expect(rows).toHaveLength(0);
  });

  it('resumes surviving agents via agentStructuredService.resumeRun + keeps the DB row intact', async () => {
    await insertTaskRow(db, 't-alive');
    await insertAgentRow(db, {
      id: 'a-alive',
      currentTaskId: 't-alive',
      permissionToken: 'tok-alive',
    });

    // Session IS live on the daemon — survivor.
    vi.spyOn(daemonRegistry, 'isSessionLive').mockReturnValue(true);

    let resolveCompletion!: (code: number) => void;
    const completion = new Promise<number>((resolve) => {
      resolveCompletion = resolve;
    });
    const resumeSpy = vi
      .spyOn(agentStructuredService, 'resumeRun')
      .mockResolvedValue({
        sessionKey: 'agent:a-alive',
        agentId: 'a-alive',
        environmentId: 'env1',
        workspaceId: 'ws1',
        taskId: 't-alive',
        interactive: true,
        transcript: [],
        startedAt: new Date(),
        permissionToken: 'tok-alive',
        completion,
      } as Awaited<ReturnType<typeof agentStructuredService.resumeRun>>);

    const rehydrateSpy = vi.spyOn(permissionService, 'rehydrateRun');

    await agentService.init();
    await new Promise((r) => setTimeout(r, 20));

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'agent:a-alive',
        agentId: 'a-alive',
        taskId: 't-alive',
        permissionToken: 'tok-alive',
      })
    );
    // Strict-mode token rehydrated so in-flight hooks can auth back.
    expect(rehydrateSpy).toHaveBeenCalledWith(
      'tok-alive',
      expect.objectContaining({ agentId: 'a-alive' })
    );

    // Agent row still there — survivor path doesn't delete.
    const agentRows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, 'a-alive'));
    expect(agentRows).toHaveLength(1);
    // Task still in_progress.
    const taskRows = await db
      .select({ status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't-alive'));
    expect(taskRows[0].status).toBe('in_progress');

    // Pretend the child eventually exits cleanly so the resumed-run
    // completion.then() wiring has something to chew on and doesn't
    // leak a pending promise past test teardown.
    resolveCompletion(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('the sweep reconciles survivors AND orphans in one pass', async () => {
    // Two agents on the same env — one survives, one orphaned.
    await insertTaskRow(db, 't-live');
    await insertTaskRow(db, 't-dead');
    await insertAgentRow(db, { id: 'a-live', currentTaskId: 't-live' });
    await insertAgentRow(db, { id: 'a-dead', currentTaskId: 't-dead' });

    vi.spyOn(daemonRegistry, 'isSessionLive').mockImplementation(
      (sid: string) => sid === 'agent:a-live'
    );

    let resolveLive!: (code: number) => void;
    const liveCompletion = new Promise<number>((resolve) => {
      resolveLive = resolve;
    });
    vi.spyOn(agentStructuredService, 'resumeRun').mockResolvedValue({
      sessionKey: 'agent:a-live',
      agentId: 'a-live',
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId: 't-live',
      interactive: true,
      transcript: [],
      startedAt: new Date(),
      completion: liveCompletion,
    } as Awaited<ReturnType<typeof agentStructuredService.resumeRun>>);

    await agentService.init();
    await new Promise((r) => setTimeout(r, 20));

    // Survivor is intact.
    const aliveRows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, 'a-live'));
    expect(aliveRows).toHaveLength(1);

    // Orphan is gone; its task is failed.
    const deadRows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, 'a-dead'));
    expect(deadRows).toHaveLength(0);
    const deadTask = await db
      .select({ status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't-dead'));
    expect(deadTask[0].status).toBe('failed');

    resolveLive(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('does not clobber tasks that were already moved off in_progress during the restart', async () => {
    // Orphaned agent whose task was already flipped to `awaiting_review`
    // before the sweep ran (rare but possible — someone hit /ready-for-review
    // via a different backend). Cleanup must NOT flip it back to `failed`.
    await insertTaskRow(db, 't-late', 'awaiting_review');
    await insertAgentRow(db, { id: 'a-late', currentTaskId: 't-late' });

    vi.spyOn(daemonRegistry, 'isSessionLive').mockReturnValue(false);

    await agentService.init();
    await new Promise((r) => setTimeout(r, 20));

    const taskRows = await db
      .select({ status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't-late'));
    expect(taskRows[0].status).toBe('awaiting_review');
  });
});
