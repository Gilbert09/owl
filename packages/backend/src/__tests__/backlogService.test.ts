import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { backlogService } from '../services/backlog/service.js';
import { environmentService } from '../services/environment.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { installFakeEnvironment, type FakeEnvironmentHandle } from './helpers/fakeEnvironment.js';
import { type Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  tasks as tasksTable,
} from '../db/schema.js';

async function seedWorkspace(db: Database, id = 'ws1') {
  await db.insert(workspacesTable).values({
    id,
    ownerId: TEST_USER_ID,
    name: 'ws',
    settings: { autoAssignTasks: true, maxConcurrentAgents: 3 },
  });
}

async function seedLocalEnv(db: Database, id = 'env-local') {
  await db.insert(environmentsTable).values({
    id,
    ownerId: TEST_USER_ID,
    name: 'Local',
    type: 'local',
    config: { type: 'local' },
  });
}

describe('backlogService', () => {
  let db: Database;
  let cleanup: (() => Promise<void>) | null = null;
  let fake: FakeEnvironmentHandle | null = null;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db);
    await seedWorkspace(db);
    await seedLocalEnv(db);
  });

  afterEach(async () => {
    fake?.restore();
    fake = null;
    environmentService.shutdown();
    await cleanup?.();
    cleanup = null;
  });

  describe('createSource / listSources / updateSource / deleteSource', () => {
    it('round-trips a markdown_file source', async () => {
      const src = await backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md', section: 'Priority Queue' },
      });
      expect(src.id).toBeTruthy();
      expect(src.enabled).toBe(true);

      const list = await backlogService.listSources('ws1');
      expect(list).toHaveLength(1);
      expect(list[0].config).toMatchObject({ type: 'markdown_file', path: '/tmp/todo.md' });
    });

    it('updates enabled and config', async () => {
      const src = await backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/a.md' },
      });
      const updated = await backlogService.updateSource(src.id, {
        enabled: false,
        config: { type: 'markdown_file', path: '/tmp/b.md' },
      });
      expect(updated?.enabled).toBe(false);
      expect((updated?.config as { path: string }).path).toBe('/tmp/b.md');
    });

    it('deletes a source (and cascades items)', async () => {
      const src = await backlogService.createSource({
        workspaceId: 'ws1',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/a.md' },
      });
      expect(await backlogService.deleteSource(src.id)).toBe(true);
      expect(await backlogService.getSource(src.id)).toBeNull();
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

      const src = await backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md', section: 'Priority Queue' },
      });

      const result = await backlogService.syncSource(src.id);
      expect(result.added).toBe(3);
      expect(result.updated).toBe(0);
      expect(result.retired).toBe(0);

      const items = await backlogService.listItems(src.id);
      expect(items.map((item) => item.text)).toEqual(['first', 'second', 'third (done)']);
      expect(items[2].completed).toBe(true);
    });

    it('retires items that disappear from the source', async () => {
      fake = installFakeEnvironment({
        outputs: { 'cat ': '- [ ] keep\n- [ ] remove\n' },
      });

      const src = await backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });

      const first = await backlogService.syncSource(src.id);
      expect(first.added).toBe(2);

      fake.restore();
      fake = installFakeEnvironment({
        outputs: { 'cat ': '- [ ] keep\n' },
      });

      const second = await backlogService.syncSource(src.id);
      expect(second.retired).toBe(1);

      const items = await backlogService.listItems(src.id);
      expect(items).toHaveLength(2);
      const removed = items.find((item) => item.text === 'remove')!;
      expect(removed.completed).toBe(true);
    });

    it('does NOT auto-complete an item that has disappeared but is still claimed', async () => {
      fake = installFakeEnvironment({
        outputs: { 'cat ': '- [ ] mid-flight\n' },
      });

      const src = await backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });
      await backlogService.syncSource(src.id);
      const items = await backlogService.listItems(src.id);

      // Seed a task + claim the item as if a Continuous Build task is
      // currently running against it.
      await db.insert(tasksTable).values({
        id: 'task-live',
        workspaceId: 'ws1',
        type: 'code_writing',
        status: 'in_progress',
        priority: 'medium',
        title: 'live',
        description: 'desc',
      });
      await backlogService.claimItem(items[0].id, 'task-live');

      // User edits the markdown mid-flight and removes the line.
      fake.restore();
      fake = installFakeEnvironment({
        outputs: { 'cat ': '' },
      });
      const result = await backlogService.syncSource(src.id);

      // Item should stay incomplete + still claimed — the running task
      // is the source of truth, not the mutated markdown.
      expect(result.retired).toBe(0);
      const after = (await backlogService.listItems(src.id))[0];
      expect(after.completed).toBe(false);
      expect(after.claimedTaskId).toBe('task-live');
    });

    it('preserves claimed_task_id across syncs', async () => {
      fake = installFakeEnvironment({
        outputs: { 'cat ': '- [ ] keep\n' },
      });

      const src = await backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });

      await backlogService.syncSource(src.id);
      const items = await backlogService.listItems(src.id);

      // Seed a task so the FK survives, then claim.
      await db.insert(tasksTable).values({
        id: 'task-123',
        workspaceId: 'ws1',
        type: 'code_writing',
        status: 'in_progress',
        priority: 'medium',
        title: 'claim test',
        description: 'desc',
      });
      await backlogService.claimItem(items[0].id, 'task-123');

      await backlogService.syncSource(src.id);
      const refreshed = await backlogService.listItems(src.id);
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

      const src = await backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });
      await backlogService.syncSource(src.id);

      const next = await backlogService.nextActionableItem(src.id);
      expect(next?.text).toBe('ready-A');
    });

    it('skips claimed items', async () => {
      fake = installFakeEnvironment({
        outputs: { 'cat ': ['- [ ] one', '- [ ] two'].join('\n') },
      });
      const src = await backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });
      await backlogService.syncSource(src.id);
      const items = await backlogService.listItems(src.id);

      await db.insert(tasksTable).values({
        id: 't1',
        workspaceId: 'ws1',
        type: 'code_writing',
        status: 'in_progress',
        priority: 'medium',
        title: 'x',
        description: 'y',
      });
      await backlogService.claimItem(items[0].id, 't1');

      const next = await backlogService.nextActionableItem(src.id);
      expect(next?.text).toBe('two');
    });

    it('returns null when nothing is actionable', async () => {
      fake = installFakeEnvironment({
        outputs: { 'cat ': '- [x] done\n' },
      });
      const src = await backlogService.createSource({
        workspaceId: 'ws1',
        environmentId: 'env-local',
        type: 'markdown_file',
        config: { type: 'markdown_file', path: '/tmp/todo.md' },
      });
      await backlogService.syncSource(src.id);
      expect(await backlogService.nextActionableItem(src.id)).toBeNull();
    });
  });
});
