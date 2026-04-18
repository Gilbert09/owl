import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskQueueService } from '../services/taskQueue.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { type Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  tasks as tasksTable,
  environments as environmentsTable,
  agents as agentsTable,
} from '../db/schema.js';

async function seedWorkspace(db: Database, id = 'ws1', name = 'Default') {
  await db.insert(workspacesTable).values({
    id,
    ownerId: TEST_USER_ID,
    name,
    settings: { autoAssignTasks: true, maxConcurrentAgents: 3 },
  });
}

async function seedTask(
  db: Database,
  overrides: Partial<{
    id: string;
    workspaceId: string;
    type: string;
    status: string;
    priority: string;
    title: string;
    description: string;
    assignedAgentId: string | null;
    createdAt: Date;
  }> = {}
) {
  const createdAt = overrides.createdAt ?? new Date();
  const task = {
    id: overrides.id ?? 't' + Math.random().toString(36).slice(2, 8),
    workspaceId: overrides.workspaceId ?? 'ws1',
    type: overrides.type ?? 'code_writing',
    status: overrides.status ?? 'queued',
    priority: overrides.priority ?? 'medium',
    title: overrides.title ?? 'A task',
    description: overrides.description ?? 'desc',
    assignedAgentId: overrides.assignedAgentId ?? null,
    createdAt,
    updatedAt: createdAt,
  };
  await db.insert(tasksTable).values(task);
  return task;
}

describe('taskQueueService', () => {
  let cleanup: (() => Promise<void>) | null = null;
  let db: Database;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db);
    await seedWorkspace(db);
  });

  afterEach(async () => {
    taskQueueService.shutdown();
    await cleanup?.();
    cleanup = null;
  });

  describe('getQueuedTasks', () => {
    it('orders by priority (urgent > high > medium > low), then created_at ascending', async () => {
      await seedTask(db, { id: 'a', priority: 'low', createdAt: new Date('2026-01-01T00:00:00Z') });
      await seedTask(db, { id: 'b', priority: 'urgent', createdAt: new Date('2026-01-02T00:00:00Z') });
      await seedTask(db, { id: 'c', priority: 'medium', createdAt: new Date('2026-01-01T00:00:00Z') });
      await seedTask(db, { id: 'd', priority: 'high', createdAt: new Date('2026-01-03T00:00:00Z') });
      await seedTask(db, { id: 'e', priority: 'urgent', createdAt: new Date('2026-01-01T00:00:00Z') });

      const tasks = await taskQueueService.getQueuedTasks();
      expect(tasks.map((t) => t.id)).toEqual(['e', 'b', 'd', 'c', 'a']);
    });

    it('filters by workspaceId when provided', async () => {
      await db.insert(workspacesTable).values({
        id: 'ws2',
        ownerId: TEST_USER_ID,
        name: 'Other',
        settings: {},
      });
      await seedTask(db, { id: 'a', workspaceId: 'ws1' });
      await seedTask(db, { id: 'b', workspaceId: 'ws2' });

      expect((await taskQueueService.getQueuedTasks('ws1')).map((t) => t.id)).toEqual(['a']);
      expect((await taskQueueService.getQueuedTasks('ws2')).map((t) => t.id)).toEqual(['b']);
    });

    it('includes both "pending" and "queued" statuses', async () => {
      await seedTask(db, { id: 'a', status: 'pending' });
      await seedTask(db, { id: 'b', status: 'queued' });
      await seedTask(db, { id: 'c', status: 'in_progress' });
      await seedTask(db, { id: 'd', status: 'completed' });

      const ids = (await taskQueueService.getQueuedTasks()).map((t) => t.id).sort();
      expect(ids).toEqual(['a', 'b']);
    });
  });

  describe('queueTask', () => {
    it('transitions a pending task to queued', async () => {
      const task = await seedTask(db, { status: 'pending' });
      await taskQueueService.queueTask(task.id);
      const rows = await db
        .select({ status: tasksTable.status })
        .from(tasksTable)
        .where(eq(tasksTable.id, task.id))
        .limit(1);
      expect(rows[0].status).toBe('queued');
    });
  });

  describe('cancelTask', () => {
    it('transitions a task to cancelled and stamps completed_at', async () => {
      const task = await seedTask(db, { status: 'queued' });
      await taskQueueService.cancelTask(task.id);
      const rows = await db
        .select({ status: tasksTable.status, completedAt: tasksTable.completedAt })
        .from(tasksTable)
        .where(eq(tasksTable.id, task.id))
        .limit(1);
      expect(rows[0].status).toBe('cancelled');
      expect(rows[0].completedAt).not.toBeNull();
    });
  });

  describe('recoverStuckTasks', () => {
    async function callRecover() {
      // recoverStuckTasks is private; invoke via the class method.
      type WithPrivate = { recoverStuckTasks: () => Promise<void> };
      await (taskQueueService as unknown as WithPrivate).recoverStuckTasks();
    }

    it('resets in_progress tasks with no assigned agent back to queued', async () => {
      await seedTask(db, { id: 't1', status: 'in_progress', assignedAgentId: null });

      await callRecover();

      const rows = await db
        .select({ status: tasksTable.status, assignedAgentId: tasksTable.assignedAgentId })
        .from(tasksTable)
        .where(eq(tasksTable.id, 't1'))
        .limit(1);
      expect(rows[0].status).toBe('queued');
      expect(rows[0].assignedAgentId).toBeNull();
    });

    it('resets in_progress tasks whose assigned agent no longer exists', async () => {
      await seedTask(db, { id: 't1', status: 'in_progress', assignedAgentId: 'agent-gone' });

      await callRecover();

      const rows = await db
        .select({ status: tasksTable.status })
        .from(tasksTable)
        .where(eq(tasksTable.id, 't1'))
        .limit(1);
      expect(rows[0].status).toBe('queued');
    });

    it('leaves in_progress tasks alone when the agent is actively working', async () => {
      await db.insert(environmentsTable).values({
        id: 'env1',
        ownerId: TEST_USER_ID,
        name: 'Local',
        type: 'local',
        config: { type: 'local' },
      });
      await db.insert(agentsTable).values({
        id: 'agent-alive',
        environmentId: 'env1',
        workspaceId: 'ws1',
        status: 'working',
        attention: 'none',
        lastActivity: new Date(),
      });
      await seedTask(db, { id: 't1', status: 'in_progress', assignedAgentId: 'agent-alive' });

      await callRecover();

      const rows = await db
        .select({ status: tasksTable.status })
        .from(tasksTable)
        .where(eq(tasksTable.id, 't1'))
        .limit(1);
      expect(rows[0].status).toBe('in_progress');
    });

    it('recovers tasks whose updatedAt is older than the staleness threshold', async () => {
      // Agent is "working" but the task hasn't moved in >20 min — the
      // daemon probably died silently. The time-based check should pick
      // this up even though the agent row still looks healthy.
      await db.insert(environmentsTable).values({
        id: 'env1',
        ownerId: TEST_USER_ID,
        name: 'Local',
        type: 'local',
        config: { type: 'local' },
      });
      await db.insert(agentsTable).values({
        id: 'agent-ghost',
        environmentId: 'env1',
        workspaceId: 'ws1',
        status: 'working',
        attention: 'none',
        lastActivity: new Date(),
      });

      const longAgo = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
      await seedTask(db, { id: 't1', status: 'in_progress', assignedAgentId: 'agent-ghost' });
      // Backdate updatedAt so the staleness check kicks in.
      await db
        .update(tasksTable)
        .set({ updatedAt: longAgo })
        .where(eq(tasksTable.id, 't1'));

      await callRecover();

      const rows = await db
        .select({ status: tasksTable.status, assignedAgentId: tasksTable.assignedAgentId })
        .from(tasksTable)
        .where(eq(tasksTable.id, 't1'))
        .limit(1);
      expect(rows[0].status).toBe('queued');
      expect(rows[0].assignedAgentId).toBeNull();
    });
  });
});
