import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { DB } from '../db/index.js';
import type {
  Task,
  CreateTaskRequest,
  ApiResponse,
} from '@fastowl/shared';

export function taskRoutes(db: DB): Router {
  const router = Router();

  // List tasks (with optional filters)
  router.get('/', (req, res) => {
    const { workspaceId, status, type } = req.query;

    let query = 'SELECT * FROM tasks WHERE 1=1';
    const params: any[] = [];

    if (workspaceId) {
      query += ' AND workspace_id = ?';
      params.push(workspaceId);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }

    query += ' ORDER BY CASE priority WHEN "urgent" THEN 1 WHEN "high" THEN 2 WHEN "medium" THEN 3 ELSE 4 END, created_at DESC';

    const rows = db.prepare(query).all(...params);
    const tasks = rows.map(rowToTask);
    res.json({ success: true, data: tasks } as ApiResponse<Task[]>);
  });

  // Get single task
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    res.json({ success: true, data: rowToTask(row) } as ApiResponse<Task>);
  });

  // Create task
  router.post('/', (req, res) => {
    const body = req.body as CreateTaskRequest;
    const id = uuid();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO tasks (id, workspace_id, type, title, description, prompt, priority, assigned_environment_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.workspaceId,
      body.type,
      body.title,
      body.description,
      body.prompt || null,
      body.priority || 'medium',
      body.assignedEnvironmentId || null,
      now,
      now
    );

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    res.status(201).json({ success: true, data: rowToTask(row) } as ApiResponse<Task>);
  });

  // Update task
  router.patch('/:id', (req, res) => {
    const body = req.body;
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const updates: string[] = [];
    const values: any[] = [];

    const allowedFields = ['status', 'priority', 'title', 'description', 'prompt', 'assignedAgentId', 'assignedEnvironmentId', 'result', 'metadata'];
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        const dbField = field.replace(/([A-Z])/g, '_$1').toLowerCase();
        updates.push(`${dbField} = ?`);
        values.push(typeof body[field] === 'object' ? JSON.stringify(body[field]) : body[field]);
      }
    }

    if (body.status === 'completed' || body.status === 'failed' || body.status === 'cancelled') {
      updates.push('completed_at = ?');
      values.push(new Date().toISOString());
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(req.params.id);

      db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: rowToTask(row) } as ApiResponse<Task>);
  });

  // Delete task
  router.delete('/:id', (req, res) => {
    const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    status: row.status,
    priority: row.priority,
    title: row.title,
    description: row.description,
    prompt: row.prompt || undefined,
    assignedAgentId: row.assigned_agent_id || undefined,
    assignedEnvironmentId: row.assigned_environment_id || undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || undefined,
  };
}
