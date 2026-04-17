import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '../db/index.js';
import { taskQueueService } from '../services/taskQueue.js';

function seedWorkspace(db: Database.Database, id = 'ws1', name = 'Default') {
  db.prepare(
    "INSERT INTO workspaces (id, name, settings) VALUES (?, ?, ?)"
  ).run(id, name, JSON.stringify({ autoAssignTasks: true, maxConcurrentAgents: 3 }));
}

function seedTask(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    workspaceId: string;
    type: string;
    status: string;
    priority: string;
    title: string;
    description: string;
    assigned_agent_id: string | null;
    created_at: string;
  }> = {}
) {
  const task = {
    id: 't' + Math.random().toString(36).slice(2, 8),
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'queued',
    priority: 'medium',
    title: 'A task',
    description: 'desc',
    assigned_agent_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, type, status, priority, title, description, assigned_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    task.id,
    task.workspaceId,
    task.type,
    task.status,
    task.priority,
    task.title,
    task.description,
    task.assigned_agent_id,
    task.created_at,
    task.created_at
  );
  return task;
}

describe('taskQueueService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    seedWorkspace(db);
  });

  afterEach(() => {
    taskQueueService.shutdown();
    // Clear the db reference on the singleton so the next test gets a clean slate
    (taskQueueService as any).db = null;
    db.close();
  });

  describe('getQueuedTasks', () => {
    it('orders by priority (urgent > high > medium > low), then created_at ascending', () => {
      // taskQueueService.init starts a setInterval; we don't want that here.
      // Inject the DB directly.
      (taskQueueService as any).db = db;

      seedTask(db, { id: 'a', priority: 'low', created_at: '2026-01-01T00:00:00Z' });
      seedTask(db, { id: 'b', priority: 'urgent', created_at: '2026-01-02T00:00:00Z' });
      seedTask(db, { id: 'c', priority: 'medium', created_at: '2026-01-01T00:00:00Z' });
      seedTask(db, { id: 'd', priority: 'high', created_at: '2026-01-03T00:00:00Z' });
      seedTask(db, { id: 'e', priority: 'urgent', created_at: '2026-01-01T00:00:00Z' });

      const tasks = taskQueueService.getQueuedTasks();
      expect(tasks.map((t) => t.id)).toEqual(['e', 'b', 'd', 'c', 'a']);
    });

    it('filters by workspaceId when provided', () => {
      (taskQueueService as any).db = db;
      db.prepare("INSERT INTO workspaces (id, name, settings) VALUES (?, ?, ?)").run(
        'ws2',
        'Other',
        '{}'
      );
      seedTask(db, { id: 'a', workspaceId: 'ws1' });
      seedTask(db, { id: 'b', workspaceId: 'ws2' });

      expect(taskQueueService.getQueuedTasks('ws1').map((t) => t.id)).toEqual(['a']);
      expect(taskQueueService.getQueuedTasks('ws2').map((t) => t.id)).toEqual(['b']);
    });

    it('includes both "pending" and "queued" statuses', () => {
      (taskQueueService as any).db = db;
      seedTask(db, { id: 'a', status: 'pending' });
      seedTask(db, { id: 'b', status: 'queued' });
      seedTask(db, { id: 'c', status: 'in_progress' });
      seedTask(db, { id: 'd', status: 'completed' });

      const ids = taskQueueService.getQueuedTasks().map((t) => t.id).sort();
      expect(ids).toEqual(['a', 'b']);
    });
  });

  describe('queueTask', () => {
    it('transitions a pending task to queued', () => {
      (taskQueueService as any).db = db;
      const task = seedTask(db, { status: 'pending' });
      taskQueueService.queueTask(task.id);
      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
      expect(row.status).toBe('queued');
    });
  });

  describe('cancelTask', () => {
    it('transitions a task to cancelled and stamps completed_at', () => {
      (taskQueueService as any).db = db;
      const task = seedTask(db, { status: 'queued' });
      taskQueueService.cancelTask(task.id);
      const row = db
        .prepare('SELECT status, completed_at FROM tasks WHERE id = ?')
        .get(task.id) as { status: string; completed_at: string | null };
      expect(row.status).toBe('cancelled');
      expect(row.completed_at).not.toBeNull();
    });
  });

  describe('recoverStuckTasks', () => {
    it('resets in_progress tasks with no assigned agent back to queued', () => {
      (taskQueueService as any).db = db;
      seedTask(db, { id: 't1', status: 'in_progress', assigned_agent_id: null });

      // Call the private method directly
      (taskQueueService as any).recoverStuckTasks();

      const row = db.prepare('SELECT status, assigned_agent_id FROM tasks WHERE id = ?').get('t1') as {
        status: string;
        assigned_agent_id: string | null;
      };
      expect(row.status).toBe('queued');
      expect(row.assigned_agent_id).toBeNull();
    });

    it('resets in_progress tasks whose assigned agent no longer exists', () => {
      (taskQueueService as any).db = db;
      seedTask(db, { id: 't1', status: 'in_progress', assigned_agent_id: 'agent-gone' });
      // Note: we never insert an agent row, so the LEFT JOIN returns NULL for the agent

      (taskQueueService as any).recoverStuckTasks();

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get('t1') as { status: string };
      expect(row.status).toBe('queued');
    });

    it('leaves in_progress tasks alone when the agent is actively working', () => {
      (taskQueueService as any).db = db;
      db.prepare("INSERT INTO environments (id, name, type, config) VALUES (?, ?, ?, ?)").run(
        'env1',
        'Local',
        'local',
        '{}'
      );
      db.prepare(
        `INSERT INTO agents (id, environment_id, workspace_id, status, attention, last_activity)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('agent-alive', 'env1', 'ws1', 'working', 'none', new Date().toISOString());
      seedTask(db, { id: 't1', status: 'in_progress', assigned_agent_id: 'agent-alive' });

      (taskQueueService as any).recoverStuckTasks();

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get('t1') as { status: string };
      expect(row.status).toBe('in_progress');
    });
  });
});
