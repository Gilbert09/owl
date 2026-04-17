import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { backlogService } from '../services/backlog/service.js';
import { environmentService } from '../services/environment.js';
import { continuousBuildScheduler } from '../services/continuousBuild.js';
import { installFakeEnvironment, type FakeEnvironmentHandle } from './helpers/fakeEnvironment.js';
import { createTestDb } from './helpers/testDb.js';
import { type Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  tasks as tasksTable,
} from '../db/schema.js';

async function seedWorkspace(
  db: Database,
  id = 'ws1',
  continuousBuild?: { enabled: boolean; maxConcurrent?: number; requireApproval?: boolean }
) {
  const settings: Record<string, unknown> = {
    autoAssignTasks: true,
    maxConcurrentAgents: 3,
  };
  if (continuousBuild) {
    settings.continuousBuild = {
      enabled: continuousBuild.enabled,
      maxConcurrent: continuousBuild.maxConcurrent ?? 1,
      requireApproval: continuousBuild.requireApproval ?? true,
    };
  }
  await db.insert(workspacesTable).values({
    id,
    name: 'ws',
    settings,
  });
}

async function seedLocalEnv(db: Database, id = 'env-local') {
  await db.insert(environmentsTable).values({
    id,
    name: 'Local',
    type: 'local',
    config: { type: 'local' },
  });
}

async function seedBacklog(): Promise<{ sourceId: string }> {
  const src = await backlogService.createSource({
    workspaceId: 'ws1',
    environmentId: 'env-local',
    type: 'markdown_file',
    config: { type: 'markdown_file', path: '/tmp/todo.md' },
  });
  return { sourceId: src.id };
}

async function countQueuedTasks(db: Database, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(tasksTable)
    .where(eq(tasksTable.workspaceId, workspaceId));
  return rows[0]?.c ?? 0;
}

async function countTasks(db: Database, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(tasksTable)
    .where(eq(tasksTable.workspaceId, workspaceId));
  return rows[0]?.c ?? 0;
}

describe('continuousBuildScheduler', () => {
  let db: Database;
  let cleanup: (() => Promise<void>) | null = null;
  let fake: FakeEnvironmentHandle | null = null;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedLocalEnv(db);
    // Init services that read from DB. Our `init()` methods are idempotent
    // and all use `getDbClient()` lazily, which now points at the pglite
    // client thanks to `createTestDb()`.
    await environmentService.init();
    await continuousBuildScheduler.init();
  });

  afterEach(async () => {
    continuousBuildScheduler.shutdown();
    fake?.restore();
    fake = null;
    environmentService.shutdown();
    await cleanup?.();
    cleanup = null;
  });

  it('does nothing when continuous build is disabled', async () => {
    await seedWorkspace(db, 'ws1');
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] first\n' } });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(await countQueuedTasks(db, 'ws1')).toBe(0);
  });

  it('spawns a task when enabled and queue is empty', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] ship it\n' } });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');

    const tasks = await db.select().from(tasksTable).where(eq(tasksTable.workspaceId, 'ws1'));
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.title).toBe('ship it');
    expect(task.status).toBe('queued');
    expect(task.type).toBe('code_writing');
    expect(task.prompt).toContain('ship it');

    // Item should now be claimed
    const items = await backlogService.listItems(sourceId);
    expect(items[0].claimedTaskId).toBe(task.id);
  });

  it('respects maxConcurrent cap', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true, maxConcurrent: 1, requireApproval: false });
    fake = installFakeEnvironment({
      outputs: { 'cat ': '- [ ] item A\n- [ ] item B\n' },
    });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(await countQueuedTasks(db, 'ws1')).toBe(1);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(await countQueuedTasks(db, 'ws1')).toBe(1);
  });

  it('holds when requireApproval=true and a task is awaiting_review', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true, maxConcurrent: 5, requireApproval: true });
    fake = installFakeEnvironment({
      outputs: { 'cat ': '- [ ] a\n- [ ] b\n' },
    });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(await countQueuedTasks(db, 'ws1')).toBe(1);

    await db
      .update(tasksTable)
      .set({ status: 'awaiting_review' })
      .where(eq(tasksTable.workspaceId, 'ws1'));

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(await countTasks(db, 'ws1')).toBe(1);
  });

  it('proceeds past awaiting_review when requireApproval=false', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true, maxConcurrent: 5, requireApproval: false });
    fake = installFakeEnvironment({
      outputs: { 'cat ': '- [ ] a\n- [ ] b\n' },
    });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    await db
      .update(tasksTable)
      .set({ status: 'awaiting_review' })
      .where(eq(tasksTable.workspaceId, 'ws1'));

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(await countTasks(db, 'ws1')).toBe(2);
  });

  it('marks backlog item completed when its task completes', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] only\n' } });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    const tasks = await db.select().from(tasksTable).where(eq(tasksTable.workspaceId, 'ws1'));
    const task = tasks[0];

    const { emitTaskStatus } = await import('../services/websocket.js');
    emitTaskStatus('ws1', task.id, 'completed');

    // Give the async onTaskStatus listener a tick to run
    await new Promise((resolve) => setImmediate(resolve));

    const items = await backlogService.listItems(sourceId);
    expect(items[0].completed).toBe(true);
  });

  it('releases the claim when its task fails', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] one\n' } });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    const tasks = await db.select().from(tasksTable).where(eq(tasksTable.workspaceId, 'ws1'));
    const task = tasks[0];

    const { emitTaskStatus } = await import('../services/websocket.js');
    emitTaskStatus('ws1', task.id, 'failed');

    await new Promise((resolve) => setImmediate(resolve));

    const items = await backlogService.listItems(sourceId);
    expect(items[0].completed).toBe(false);
    expect(items[0].claimedTaskId).toBeUndefined();
  });

  it('skips sources that are disabled', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] one\n' } });

    const src = await backlogService.createSource({
      workspaceId: 'ws1',
      environmentId: 'env-local',
      enabled: false,
      type: 'markdown_file',
      config: { type: 'markdown_file', path: '/tmp/todo.md' },
    });
    await backlogService.syncSource(src.id);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(await countQueuedTasks(db, 'ws1')).toBe(0);
  });

  it('skips sources whose SSH environment is not connected', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true });
    // Disconnected SSH env
    await db.insert(environmentsTable).values({
      id: 'env-ssh',
      name: 'Remote',
      type: 'ssh',
      status: 'disconnected',
      config: { type: 'ssh', host: 'vm1', port: 22, username: 'me', authMethod: 'agent' },
    });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] on the vm\n' } });

    const src = await backlogService.createSource({
      workspaceId: 'ws1',
      environmentId: 'env-ssh',
      type: 'markdown_file',
      config: { type: 'markdown_file', path: '/home/me/TODO.md' },
    });
    // Seed the source's item manually — we don't want to sync from an SSH host.
    await db.execute(sql`
      INSERT INTO backlog_items (id, source_id, workspace_id, external_id, text, completed, blocked, order_index)
      VALUES ('bi1', ${src.id}, 'ws1', 'e1', 'on the vm', false, false, 0)
    `);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(await countQueuedTasks(db, 'ws1')).toBe(0);

    // Now flip it connected and retry
    await db
      .update(environmentsTable)
      .set({ status: 'connected' })
      .where(eq(environmentsTable.id, 'env-ssh'));
    await continuousBuildScheduler.scheduleNext('ws1');
    expect(await countQueuedTasks(db, 'ws1')).toBe(1);
  });

  it('writes backlogItemId into spawned task metadata (powers autonomous mode)', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] do the thing\n' } });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');

    const rows = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.workspaceId, 'ws1'));
    const meta = rows[0].metadata as { backlogItemId?: string; backlogSourceId?: string };
    expect(meta.backlogItemId).toBeTruthy();
    expect(meta.backlogSourceId).toBe(sourceId);
  });
});
