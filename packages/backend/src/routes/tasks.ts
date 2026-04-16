import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { DB } from '../db/index.js';
import { agentService, type ActiveAgent } from '../services/agent.js';
import { environmentService } from '../services/environment.js';
import { emitTaskStatus } from '../services/websocket.js';
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

    query += ` ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, created_at DESC`;

    const rows = db.prepare(query).all(...params);
    const tasks = rows.map(rowToTask);
    res.json({ success: true, data: tasks } as ApiResponse<Task[]>);
  });

  // Get single task (includes agent status if running)
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const task = rowToTask(row);

    // If task is in_progress, get agent status
    if (task.status === 'in_progress') {
      const activeAgent = agentService.getAgentByTaskId(task.id);
      if (activeAgent) {
        task.agentStatus = activeAgent.status;
        task.agentAttention = activeAgent.attention;
        task.terminalOutput = activeAgent.outputBuffer;
      }
    }

    res.json({ success: true, data: task } as ApiResponse<Task>);
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

  // Retry/reset a task back to queued
  router.post('/:id/retry', (req, res) => {
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks
      SET status = 'queued', assigned_agent_id = NULL, result = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, req.params.id);

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: rowToTask(row) } as ApiResponse<Task>);
  });

  // Start executing a task (spawns an agent)
  router.post('/:id/start', async (req, res) => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const task = rowToTask(row);

    // Check if task is already running
    if (task.status === 'in_progress') {
      return res.status(400).json({ success: false, error: 'Task is already running' });
    }

    // Only automated tasks can be started
    if (task.type !== 'automated') {
      return res.status(400).json({ success: false, error: 'Only automated tasks can be started' });
    }

    // Find environment to use
    let environmentId = task.assignedEnvironmentId;
    if (!environmentId) {
      // Find first connected environment
      const environments = environmentService.getAllEnvironments();
      const connected = environments.find(e => e.status === 'connected');
      if (!connected) {
        return res.status(400).json({ success: false, error: 'No connected environments available' });
      }
      environmentId = connected.id;
    }

    // Check if environment is connected
    const envStatus = environmentService.getStatus(environmentId);
    if (envStatus !== 'connected') {
      try {
        await environmentService.connect(environmentId);
      } catch (err) {
        return res.status(400).json({ success: false, error: 'Failed to connect to environment' });
      }
    }

    // Check if environment already has an active task
    const existingAgent = agentService.getAgentByTaskId(task.id);
    if (existingAgent) {
      return res.status(400).json({ success: false, error: 'Task already has an active agent' });
    }

    // Start the agent for this task
    try {
      const agent = await agentService.startAgent({
        environmentId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        prompt: task.prompt || task.description,
      });

      // Update task status
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, assigned_environment_id = ?, updated_at = ? WHERE id = ?
      `).run(agent.id, environmentId, now, task.id);

      emitTaskStatus(task.workspaceId, task.id, 'in_progress');

      const updatedRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
      const updatedTask = rowToTask(updatedRow);
      updatedTask.agentStatus = 'working';
      updatedTask.agentAttention = 'none';
      updatedTask.terminalOutput = '';

      res.json({ success: true, data: updatedTask } as ApiResponse<Task>);
    } catch (err: any) {
      console.error('Failed to start task:', err);
      res.status(500).json({ success: false, error: err.message || 'Failed to start task' });
    }
  });

  // Send input to a running task
  router.post('/:id/input', (req, res) => {
    const { input } = req.body;
    if (!input) {
      return res.status(400).json({ success: false, error: 'Input is required' });
    }

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const task = rowToTask(row);

    if (task.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: 'Task is not running' });
    }

    // Find the agent for this task
    const activeAgent = agentService.getAgentByTaskId(task.id);
    if (!activeAgent) {
      return res.status(400).json({ success: false, error: 'No active agent for this task' });
    }

    try {
      agentService.sendInput(activeAgent.id, input);
      res.json({ success: true } as ApiResponse<void>);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to send input' });
    }
  });

  // Stop a running task
  router.post('/:id/stop', (req, res) => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const task = rowToTask(row);

    if (task.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: 'Task is not running' });
    }

    // Find and stop the agent
    const activeAgent = agentService.getAgentByTaskId(task.id);
    if (activeAgent) {
      agentService.stopAgent(activeAgent.id);
    }

    // Update task status to failed (stopped by user)
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks SET status = 'failed', result = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify({ success: false, error: 'Stopped by user' }), now, now, task.id);

    emitTaskStatus(task.workspaceId, task.id, 'failed', { success: false, error: 'Stopped by user' });

    const updatedRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
    res.json({ success: true, data: rowToTask(updatedRow) } as ApiResponse<Task>);
  });

  // Get terminal output for a task
  router.get('/:id/terminal', (req, res) => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const task = rowToTask(row);

    // Get terminal output from active agent if running
    let terminalOutput = '';
    if (task.status === 'in_progress') {
      const activeAgent = agentService.getAgentByTaskId(task.id);
      if (activeAgent) {
        terminalOutput = activeAgent.outputBuffer;
      }
    }

    res.json({ success: true, data: { terminalOutput } } as ApiResponse<{ terminalOutput: string }>);
  });

  // Delete task
  router.delete('/:id', (req, res) => {
    // First stop any running agent
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (row) {
      const task = rowToTask(row);
      if (task.status === 'in_progress') {
        const activeAgent = agentService.getAgentByTaskId(task.id);
        if (activeAgent) {
          agentService.stopAgent(activeAgent.id);
        }
      }
    }

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
