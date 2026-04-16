import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { DB } from '../db/index.js';
import { agentService } from '../services/agent.js';
import type {
  Agent,
  StartAgentRequest,
  ApiResponse,
} from '@fastowl/shared';

export function agentRoutes(db: DB): Router {
  const router = Router();

  // List agents (with optional filters)
  router.get('/', (req, res) => {
    const { workspaceId, environmentId, status } = req.query;

    let query = 'SELECT * FROM agents WHERE 1=1';
    const params: any[] = [];

    if (workspaceId) {
      query += ' AND workspace_id = ?';
      params.push(workspaceId);
    }
    if (environmentId) {
      query += ' AND environment_id = ?';
      params.push(environmentId);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const rows = db.prepare(query).all(...params);
    const agents = rows.map(rowToAgent);
    res.json({ success: true, data: agents } as ApiResponse<Agent[]>);
  });

  // Get single agent
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    res.json({ success: true, data: rowToAgent(row) } as ApiResponse<Agent>);
  });

  // Start new agent
  router.post('/start', (req, res) => {
    const body = req.body as StartAgentRequest;
    const id = uuid();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO agents (id, environment_id, workspace_id, status, attention, current_task_id, terminal_output, last_activity, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.environmentId,
      body.workspaceId,
      'idle',
      'none',
      body.taskId || null,
      '',
      now,
      now
    );

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);

    // TODO: Actually spawn the Claude process on the environment

    res.status(201).json({ success: true, data: rowToAgent(row) } as ApiResponse<Agent>);
  });

  // Send input to agent
  router.post('/:id/input', (req, res) => {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    const { input } = req.body as { input: string };

    // Send input to the Claude process via agent service
    agentService.sendInput(req.params.id, input);

    // Update last activity
    db.prepare('UPDATE agents SET last_activity = ? WHERE id = ?')
      .run(new Date().toISOString(), req.params.id);

    res.json({ success: true } as ApiResponse<void>);
  });

  // Stop agent
  router.post('/:id/stop', (req, res) => {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    // TODO: Actually stop the Claude process

    db.prepare('UPDATE agents SET status = ?, last_activity = ? WHERE id = ?')
      .run('idle', new Date().toISOString(), req.params.id);

    const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: rowToAgent(updated) } as ApiResponse<Agent>);
  });

  // Delete agent
  router.delete('/:id', (req, res) => {
    // TODO: Ensure process is stopped first

    const result = db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}

function rowToAgent(row: any): Agent {
  return {
    id: row.id,
    environmentId: row.environment_id,
    workspaceId: row.workspace_id,
    status: row.status,
    attention: row.attention,
    currentTaskId: row.current_task_id || undefined,
    terminalOutput: row.terminal_output,
    lastActivity: row.last_activity,
    createdAt: row.created_at,
  };
}
