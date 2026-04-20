import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { backlogService } from '../services/backlog/service.js';
import { environmentService } from '../services/environment.js';
import { continuousBuildScheduler } from '../services/continuousBuild.js';
import { installFakeEnvironment, type FakeEnvironmentHandle } from './helpers/fakeEnvironment.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { type Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  tasks as tasksTable,
  backlogItems as backlogItemsTable,
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
    ownerId: TEST_USER_ID,
    name: 'ws',
    settings,
  });
}

async function seedLocalEnv(db: Database, id = 'env-local') {
  await db.insert(environmentsTable).values({
    id,
    ownerId: TEST_USER_ID,
    name: 'Local',
    type: 'local',
    // Post-"daemon everywhere", a local env only serves tasks when its
    // daemon is actually dialled in. Tests pretend the daemon is up so
    // `firstAvailableEnvironmentId` picks this env as eligible.
    status: 'connected',
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
    await seedUser(db);
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

  it('skips sources whose remote environment is not connected', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true });
    // Disconnected remote env (daemon hasn't dialled in).
    await db.insert(environmentsTable).values({
      id: 'env-remote',
      ownerId: TEST_USER_ID,
      name: 'Remote',
      type: 'remote',
      status: 'disconnected',
      config: { type: 'remote', hostname: 'vm1' },
    });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] on the vm\n' } });

    const src = await backlogService.createSource({
      workspaceId: 'ws1',
      environmentId: 'env-remote',
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
      .where(eq(environmentsTable.id, 'env-remote'));
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

  it('failed tasks bump consecutiveFailures + backoff blocks immediate retry', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true, maxConcurrent: 5, requireApproval: false });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] flaky item\n' } });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    const firstTask = (await db.select().from(tasksTable))[0];

    const { emitTaskStatus } = await import('../services/websocket.js');
    emitTaskStatus('ws1', firstTask.id, 'failed');
    await new Promise((resolve) => setImmediate(resolve));

    const items = await backlogService.listItems(sourceId);
    expect(items[0].consecutiveFailures).toBe(1);
    expect(items[0].lastFailureAt).toBeDefined();
    expect(items[0].claimedTaskId).toBeUndefined();

    // Scheduler should NOT spawn a second task because the item is
    // still in its backoff window.
    await continuousBuildScheduler.scheduleNext('ws1');
    expect(await countTasks(db, 'ws1')).toBe(1);
  });

  it('blocks an item after 5 consecutive failures', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true, maxConcurrent: 5, requireApproval: false });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] broken item\n' } });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);
    const item = (await backlogService.listItems(sourceId))[0];

    // Fast-forward the failure counter directly. The scheduler treats
    // any "5th consecutive failure" signal as the trigger to block.
    await db
      .update(backlogItemsTable)
      .set({ consecutiveFailures: 4 })
      .where(eq(backlogItemsTable.id, item.id));

    await continuousBuildScheduler.scheduleNext('ws1');
    const task = (await db.select().from(tasksTable))[0];

    const { emitTaskStatus } = await import('../services/websocket.js');
    emitTaskStatus('ws1', task.id, 'failed');
    await new Promise((resolve) => setImmediate(resolve));

    const after = (await backlogService.listItems(sourceId))[0];
    expect(after.consecutiveFailures).toBe(5);
    expect(after.blocked).toBe(true);
  });

  it('a cancelled task does not bump the failure counter', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] user-cancelled\n' } });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    const task = (await db.select().from(tasksTable))[0];

    const { emitTaskStatus } = await import('../services/websocket.js');
    emitTaskStatus('ws1', task.id, 'cancelled');
    await new Promise((resolve) => setImmediate(resolve));

    const after = (await backlogService.listItems(sourceId))[0];
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastFailureAt).toBeUndefined();
    expect(after.claimedTaskId).toBeUndefined();
  });

  it('completing an item wipes its failure counter', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] recovered\n' } });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);
    const item = (await backlogService.listItems(sourceId))[0];

    // Simulate some prior failures then a successful run.
    await db
      .update(backlogItemsTable)
      .set({ consecutiveFailures: 3, lastFailureAt: new Date() })
      .where(eq(backlogItemsTable.id, item.id));

    await backlogService.completeItem(item.id);

    const after = (await backlogService.listItems(sourceId))[0];
    expect(after.completed).toBe(true);
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastFailureAt).toBeUndefined();
  });

  it('syncSource does not auto-complete an item with an active claim', async () => {
    await seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] keep me\n' } });
    const { sourceId } = await seedBacklog();
    await backlogService.syncSource(sourceId);

    // Spawn a task for the item — this claims it.
    await continuousBuildScheduler.scheduleNext('ws1');
    const item = (await backlogService.listItems(sourceId))[0];
    expect(item.claimedTaskId).toBeTruthy();

    // User edits the markdown and removes the line while the task
    // is still running. The sync should NOT mark it completed while
    // the claim is live.
    fake.restore();
    fake = installFakeEnvironment({ outputs: { 'cat ': '' } });
    await backlogService.syncSource(sourceId);

    const after = (await backlogService.listItems(sourceId))[0];
    expect(after.completed).toBe(false);
    expect(after.claimedTaskId).toBe(item.claimedTaskId);
  });
});
