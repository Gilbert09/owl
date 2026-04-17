import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '../db/index.js';
import { backlogService } from '../services/backlog/service.js';
import { environmentService } from '../services/environment.js';
import { continuousBuildScheduler } from '../services/continuousBuild.js';
import { installFakeEnvironment, type FakeEnvironmentHandle } from './helpers/fakeEnvironment.js';

function seedWorkspace(
  db: Database.Database,
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
  db.prepare('INSERT INTO workspaces (id, name, settings) VALUES (?, ?, ?)').run(
    id,
    'ws',
    JSON.stringify(settings)
  );
}

function seedLocalEnv(db: Database.Database, id = 'env-local') {
  db.prepare('INSERT INTO environments (id, name, type, config) VALUES (?, ?, ?, ?)').run(
    id,
    'Local',
    'local',
    JSON.stringify({ type: 'local' })
  );
}

async function seedBacklog(fileContent: string): Promise<{ sourceId: string }> {
  const src = backlogService.createSource({
    workspaceId: 'ws1',
    environmentId: 'env-local',
    type: 'markdown_file',
    config: { type: 'markdown_file', path: '/tmp/todo.md' },
  });
  // Replace fake outputs to return this content
  const _ = fileContent; // used by the outer closure via installFakeEnvironment
  return { sourceId: src.id };
}

function countQueuedTasks(db: Database.Database, workspaceId: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status = 'queued'"
      )
      .get(workspaceId) as { c: number }
  ).c;
}

describe('continuousBuildScheduler', () => {
  let db: Database.Database;
  let fake: FakeEnvironmentHandle | null = null;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    seedLocalEnv(db);
    backlogService.init(db);
    environmentService.init(db);
    continuousBuildScheduler.init(db);
  });

  afterEach(() => {
    continuousBuildScheduler.shutdown();
    fake?.restore();
    fake = null;
    environmentService.shutdown();
    (environmentService as any).db = null;
    (backlogService as any).db = null;
    db.close();
  });

  it('does nothing when continuous build is disabled', async () => {
    seedWorkspace(db, 'ws1');
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] first\n' } });
    const { sourceId } = await seedBacklog('');
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(countQueuedTasks(db, 'ws1')).toBe(0);
  });

  it('spawns a task when enabled and queue is empty', async () => {
    seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] ship it\n' } });
    const { sourceId } = await seedBacklog('');
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');

    expect(countQueuedTasks(db, 'ws1')).toBe(1);
    const task = db
      .prepare("SELECT * FROM tasks WHERE workspace_id = 'ws1'")
      .get() as any;
    expect(task.title).toBe('ship it');
    expect(task.status).toBe('queued');
    expect(task.type).toBe('code_writing');
    expect(task.prompt).toContain('ship it');

    // Item should now be claimed
    const items = backlogService.listItems(sourceId);
    expect(items[0].claimedTaskId).toBe(task.id);
  });

  it('respects maxConcurrent cap', async () => {
    seedWorkspace(db, 'ws1', { enabled: true, maxConcurrent: 1, requireApproval: false });
    fake = installFakeEnvironment({
      outputs: { 'cat ': '- [ ] item A\n- [ ] item B\n' },
    });
    const { sourceId } = await seedBacklog('');
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(countQueuedTasks(db, 'ws1')).toBe(1);

    // Second call shouldn't add another — cap is 1
    await continuousBuildScheduler.scheduleNext('ws1');
    expect(countQueuedTasks(db, 'ws1')).toBe(1);
  });

  it('holds when requireApproval=true and a task is awaiting_review', async () => {
    seedWorkspace(db, 'ws1', { enabled: true, maxConcurrent: 5, requireApproval: true });
    fake = installFakeEnvironment({
      outputs: { 'cat ': '- [ ] a\n- [ ] b\n' },
    });
    const { sourceId } = await seedBacklog('');
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(countQueuedTasks(db, 'ws1')).toBe(1);

    // Move the task to awaiting_review
    db.prepare(
      "UPDATE tasks SET status = 'awaiting_review' WHERE workspace_id = 'ws1'"
    ).run();

    await continuousBuildScheduler.scheduleNext('ws1');
    // Nothing new — still just the one
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = 'ws1'")
          .get() as { c: number }
      ).c
    ).toBe(1);
  });

  it('proceeds past awaiting_review when requireApproval=false', async () => {
    seedWorkspace(db, 'ws1', { enabled: true, maxConcurrent: 5, requireApproval: false });
    fake = installFakeEnvironment({
      outputs: { 'cat ': '- [ ] a\n- [ ] b\n' },
    });
    const { sourceId } = await seedBacklog('');
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    db.prepare(
      "UPDATE tasks SET status = 'awaiting_review' WHERE workspace_id = 'ws1'"
    ).run();

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = 'ws1'")
          .get() as { c: number }
      ).c
    ).toBe(2);
  });

  it('marks backlog item completed when its task completes', async () => {
    seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] only\n' } });
    const { sourceId } = await seedBacklog('');
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    const task = db
      .prepare("SELECT * FROM tasks WHERE workspace_id = 'ws1'")
      .get() as any;

    const { emitTaskStatus } = await import('../services/websocket.js');
    emitTaskStatus('ws1', task.id, 'completed');

    // Give the async onTaskStatus listener a tick to run
    await new Promise((resolve) => setImmediate(resolve));

    const items = backlogService.listItems(sourceId);
    expect(items[0].completed).toBe(true);
  });

  it('releases the claim when its task fails', async () => {
    seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] one\n' } });
    const { sourceId } = await seedBacklog('');
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');
    const task = db
      .prepare("SELECT * FROM tasks WHERE workspace_id = 'ws1'")
      .get() as any;

    const { emitTaskStatus } = await import('../services/websocket.js');
    emitTaskStatus('ws1', task.id, 'failed');

    await new Promise((resolve) => setImmediate(resolve));

    const items = backlogService.listItems(sourceId);
    expect(items[0].completed).toBe(false);
    expect(items[0].claimedTaskId).toBeUndefined();
  });

  it('skips sources that are disabled', async () => {
    seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] one\n' } });

    const src = backlogService.createSource({
      workspaceId: 'ws1',
      environmentId: 'env-local',
      enabled: false,
      type: 'markdown_file',
      config: { type: 'markdown_file', path: '/tmp/todo.md' },
    });
    await backlogService.syncSource(src.id);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(countQueuedTasks(db, 'ws1')).toBe(0);
  });

  it('skips sources whose SSH environment is not connected', async () => {
    seedWorkspace(db, 'ws1', { enabled: true });
    // Disconnected SSH env
    db.prepare(
      "INSERT INTO environments (id, name, type, status, config) VALUES (?, ?, ?, ?, ?)"
    ).run(
      'env-ssh',
      'Remote',
      'ssh',
      'disconnected',
      JSON.stringify({ type: 'ssh', host: 'vm1', port: 22, username: 'me', authMethod: 'agent' })
    );
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] on the vm\n' } });

    const src = backlogService.createSource({
      workspaceId: 'ws1',
      environmentId: 'env-ssh',
      type: 'markdown_file',
      config: { type: 'markdown_file', path: '/home/me/TODO.md' },
    });
    // Seed the source's items manually — we can't sync without an exec path
    db.prepare(
      `INSERT INTO backlog_items (id, source_id, workspace_id, external_id, text, completed, blocked, order_index)
       VALUES ('bi1', ?, 'ws1', 'e1', 'on the vm', 0, 0, 0)`
    ).run(src.id);

    await continuousBuildScheduler.scheduleNext('ws1');
    expect(countQueuedTasks(db, 'ws1')).toBe(0);

    // Now flip it connected and retry
    db.prepare("UPDATE environments SET status = 'connected' WHERE id = 'env-ssh'").run();
    await continuousBuildScheduler.scheduleNext('ws1');
    expect(countQueuedTasks(db, 'ws1')).toBe(1);
  });

  it('writes backlogItemId into spawned task metadata (powers autonomous mode)', async () => {
    seedWorkspace(db, 'ws1', { enabled: true });
    fake = installFakeEnvironment({ outputs: { 'cat ': '- [ ] do the thing\n' } });
    const { sourceId } = await seedBacklog('');
    await backlogService.syncSource(sourceId);

    await continuousBuildScheduler.scheduleNext('ws1');

    const task = db
      .prepare("SELECT metadata FROM tasks WHERE workspace_id = 'ws1'")
      .get() as { metadata: string };
    const meta = JSON.parse(task.metadata);
    expect(meta.backlogItemId).toBeTruthy();
    expect(meta.backlogSourceId).toBe(sourceId);
  });
});
