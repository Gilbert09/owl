import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { DB } from '../db/index.js';
import type {
  Workspace,
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  ApiResponse,
} from '@fastowl/shared';

export function workspaceRoutes(db: DB): Router {
  const router = Router();

  // List all workspaces
  router.get('/', (_req, res) => {
    const rows = db.prepare('SELECT * FROM workspaces ORDER BY name').all();
    const workspaces = rows.map(rowToWorkspace);
    res.json({ success: true, data: workspaces } as ApiResponse<Workspace[]>);
  });

  // Get single workspace
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Workspace not found' });
    }
    res.json({ success: true, data: rowToWorkspace(row) } as ApiResponse<Workspace>);
  });

  // Create workspace
  router.post('/', (req, res) => {
    const body = req.body as CreateWorkspaceRequest;
    const id = uuid();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO workspaces (id, name, description, settings, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, body.name, body.description || null, '{"autoAssignTasks":true,"maxConcurrentAgents":3}', now, now);

    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    res.status(201).json({ success: true, data: rowToWorkspace(row) } as ApiResponse<Workspace>);
  });

  // Update workspace
  router.patch('/:id', (req, res) => {
    const body = req.body as UpdateWorkspaceRequest;
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Workspace not found' });
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description);
    }
    if (body.settings !== undefined) {
      const currentSettings = JSON.parse((existing as any).settings);
      const newSettings = { ...currentSettings, ...body.settings };
      updates.push('settings = ?');
      values.push(JSON.stringify(newSettings));
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(req.params.id);

      db.prepare(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: rowToWorkspace(row) } as ApiResponse<Workspace>);
  });

  // Delete workspace
  router.delete('/:id', (req, res) => {
    const result = db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Workspace not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}

function rowToWorkspace(row: any): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    repos: [], // TODO: Load from repositories table
    integrations: {}, // TODO: Load from integrations table
    settings: JSON.parse(row.settings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
