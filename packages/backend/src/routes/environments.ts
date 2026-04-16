import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { DB } from '../db/index.js';
import type {
  Environment,
  CreateEnvironmentRequest,
  ApiResponse,
} from '@fastowl/shared';

export function environmentRoutes(db: DB): Router {
  const router = Router();

  // List all environments
  router.get('/', (_req, res) => {
    const rows = db.prepare('SELECT * FROM environments ORDER BY name').all();
    const environments = rows.map(rowToEnvironment);
    res.json({ success: true, data: environments } as ApiResponse<Environment[]>);
  });

  // Get single environment
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM environments WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    res.json({ success: true, data: rowToEnvironment(row) } as ApiResponse<Environment>);
  });

  // Create environment
  router.post('/', (req, res) => {
    const body = req.body as CreateEnvironmentRequest;
    const id = uuid();
    const now = new Date().toISOString();

    // Local environments are always connected
    const initialStatus = body.type === 'local' ? 'connected' : 'disconnected';

    db.prepare(`
      INSERT INTO environments (id, name, type, status, config, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, body.name, body.type, initialStatus, JSON.stringify(body.config), now, now);

    const row = db.prepare('SELECT * FROM environments WHERE id = ?').get(id);
    res.status(201).json({ success: true, data: rowToEnvironment(row) } as ApiResponse<Environment>);
  });

  // Update environment
  router.patch('/:id', (req, res) => {
    const body = req.body;
    const existing = db.prepare('SELECT * FROM environments WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.config !== undefined) {
      updates.push('config = ?');
      values.push(JSON.stringify(body.config));
    }
    if (body.status !== undefined) {
      updates.push('status = ?');
      values.push(body.status);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(req.params.id);

      db.prepare(`UPDATE environments SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    const row = db.prepare('SELECT * FROM environments WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: rowToEnvironment(row) } as ApiResponse<Environment>);
  });

  // Delete environment
  router.delete('/:id', (req, res) => {
    const result = db.prepare('DELETE FROM environments WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  // Test connection
  router.post('/:id/test', async (req, res) => {
    const row = db.prepare('SELECT * FROM environments WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }

    // TODO: Implement actual connection testing
    res.json({ success: true, data: { connected: true } });
  });

  return router;
}

function rowToEnvironment(row: any): Environment {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    config: JSON.parse(row.config),
    lastConnected: row.last_connected || undefined,
    error: row.error || undefined,
  };
}
