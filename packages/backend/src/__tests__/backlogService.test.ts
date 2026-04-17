import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '../db/index.js';
import { backlogService } from '../services/backlog/service.js';
import { installFakeEnvironment, type FakeEnvironmentHandle } from './helpers/fakeEnvironment.js';
import { environmentService } from '../services/environment.js';

function seedWorkspace(db: Database.Database, id = 'ws1') {
  db.prepare(
    "INSERT INTO workspaces (id, name, settings) VALUES (?, ?, ?)"
  ).run(id, 'ws', JSON.stringify({ autoAssignTasks: true, maxConcurrentAgents: 3 }));
}

function seedLocalEnv(db: Database.Database, id = 'env-local') {
  db.prepare(
    "INSERT INTO environments (id, name, type, config) VALUES (?, ?, ?, ?)"
  ).run(id, 'Local', 'local', JSON.stringify({ type: 'local' }));
}

describe('backlogService', () => {
  let db: Database.Database;
  let fake: FakeEnvironmentHandle | null = null;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    seedWorkspace(db);
    seedLocalEnv(db);
    backlogService.init(db);
    // environmentService needs the DB to find environments for sync
    environmentService.init(db);
  });

  afterEach(() => {
    fake?.restore();
    fake = null;
    environmentService.shutdown();
    (environmentService as any).db = null;
    (backlogService as any).db = null;
    db.close();
  });

  describe('createSource / listSources / updateSource / deleteSource', () => {
    it('round-trips a markdown_file source', () => {
      const src = backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md', section: 'Priority Queue' },
      });
      expect(src.id).toBeTruthy();
      expect(src.enabled).toBe(true);

      const list = backlogService.listSources('ws1');
      expect(list).toHaveLength(1);
      expect(list[0].config).toMatchObject({ type: 'markdown_file', path: '/tmp/todo.md' });
    });

    it('updates enabled and config', () => {
      const src = backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/a.md' },
      });
      const updated = backlogService.updateSource(src.id, {
        enabled: false,
        config: { type: 'markdown_file', path: '/tmp/b.md' },
      });
      expect(updated?.enabled).toBe(false);
      expect((updated?.config as any).path).toBe('/tmp/b.md');
    });

    it('deletes a source (and cascades items)', () => {
      const src = backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/a.md' },
      });
      expect(backlogService.deleteSource(src.id)).toBe(true);
      expect(backlogService.getSource(src.id)).toBeNull();
    });
  });

  describe('syncSource', () => {
    it('parses the file and upserts items', async () => {
      fake = installFakeEnvironment({
        outputs: {
          'cat ': [
            '## Priority Queue',
            '- [ ] first',
            '- [ ] second',
            '- [x] third (done)',
          ].join('\n'),
        },
      });

      const src = backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md', section: 'Priority Queue' },
      });

      const result = await backlogService.syncSource(src.id);
      expect(result.added).toBe(3);
      expect(result.updated).toBe(0);
      expect(result.retired).toBe(0);

      const items = backlogService.listItems(src.id);
      expect(items.map((item) => item.text)).toEqual(['first', 'second', 'third (done)']);
      expect(items[2].completed).toBe(true);
    });

    it('retires items that disappear from the source', async () => {
      fake = installFakeEnvironment({
        outputs: {
          'cat ': '- [ ] keep\n- [ ] remove\n',
        },
      });

      const src = backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });

      const first = await backlogService.syncSource(src.id);
      expect(first.added).toBe(2);

      fake.restore();
      fake = installFakeEnvironment({
        outputs: {
          'cat ': '- [ ] keep\n',
        },
      });

      const second = await backlogService.syncSource(src.id);
      expect(second.retired).toBe(1);

      const items = backlogService.listItems(src.id);
      expect(items).toHaveLength(2);
      const removed = items.find((item) => item.text === 'remove')!;
      expect(removed.completed).toBe(true);
    });

    it('preserves claimed_task_id across syncs', async () => {
      fake = installFakeEnvironment({
        outputs: { 'cat ': '- [ ] keep\n' },
      });

      const src = backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });

      await backlogService.syncSource(src.id);
      const items = backlogService.listItems(src.id);

      // Seed a task row so the FK survives, then claim
      db.prepare(
        `INSERT INTO tasks (id, workspace_id, type, status, priority, title, description)
         VALUES ('task-123', 'ws1', 'code_writing', 'in_progress', 'medium', 'claim test', 'desc')`
      ).run();
      backlogService.claimItem(items[0].id, 'task-123');

      await backlogService.syncSource(src.id);
      const refreshed = backlogService.listItems(src.id);
      expect(refreshed[0].claimedTaskId).toBe('task-123');
    });
  });

  describe('nextActionableItem', () => {
    it('returns the first unblocked, unclaimed, uncompleted item in order', async () => {
      fake = installFakeEnvironment({
        outputs: {
          'cat ': [
            '- [x] already done',
            '- [ ] waiting (blocked)',
            '- [ ] ready-A',
            '- [ ] ready-B',
          ].join('\n'),
        },
      });

      const src = backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });
      await backlogService.syncSource(src.id);

      const next = backlogService.nextActionableItem(src.id);
      expect(next?.text).toBe('ready-A');
    });

    it('skips claimed items', async () => {
      fake = installFakeEnvironment({
        outputs: {
          'cat ': ['- [ ] one', '- [ ] two'].join('\n'),
        },
      });
      const src = backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });
      await backlogService.syncSource(src.id);
      const items = backlogService.listItems(src.id);

      // Seed a task and claim the first item
      db.prepare(
        `INSERT INTO tasks (id, workspace_id, type, status, priority, title, description)
         VALUES ('t1', 'ws1', 'code_writing', 'in_progress', 'medium', 'x', 'y')`
      ).run();
      backlogService.claimItem(items[0].id, 't1');

      const next = backlogService.nextActionableItem(src.id);
      expect(next?.text).toBe('two');
    });

    it('returns null when nothing is actionable', async () => {
      fake = installFakeEnvironment({
        outputs: { 'cat ': '- [x] done\n' },
      });
      const src = backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });
      await backlogService.syncSource(src.id);
      expect(backlogService.nextActionableItem(src.id)).toBeNull();
    });
  });
});
