import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { DB } from '../db/index.js';
import type {
  InboxItem,
  ApiResponse,
} from '@fastowl/shared';

export function inboxRoutes(db: DB): Router {
  const router = Router();

  // List inbox items (with optional filters)
  router.get('/', (req, res) => {
    const { workspaceId, status, type } = req.query;

    let query = 'SELECT * FROM inbox_items WHERE 1=1';
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

    // Filter out snoozed items that aren't ready
    query += ` AND (snoozed_until IS NULL OR snoozed_until <= datetime('now'))`;

    query += ` ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, created_at DESC`;

    const rows = db.prepare(query).all(...params);
    const items = rows.map(rowToInboxItem);
    res.json({ success: true, data: items } as ApiResponse<InboxItem[]>);
  });

  // Get single inbox item
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Inbox item not found' });
    }
    res.json({ success: true, data: rowToInboxItem(row) } as ApiResponse<InboxItem>);
  });

  // Create inbox item (usually done internally, but exposed for testing)
  router.post('/', (req, res) => {
    const body = req.body;
    const id = uuid();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO inbox_items (id, workspace_id, type, priority, title, summary, source, actions, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.workspaceId,
      body.type,
      body.priority || 'medium',
      body.title,
      body.summary,
      JSON.stringify(body.source),
      JSON.stringify(body.actions || []),
      body.data ? JSON.stringify(body.data) : null,
      now
    );

    const row = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(id);
    res.status(201).json({ success: true, data: rowToInboxItem(row) } as ApiResponse<InboxItem>);
  });

  // Mark as read
  router.post('/:id/read', (req, res) => {
    const row = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Inbox item not found' });
    }

    db.prepare('UPDATE inbox_items SET status = ?, read_at = ? WHERE id = ?')
      .run('read', new Date().toISOString(), req.params.id);

    const updated = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: rowToInboxItem(updated) } as ApiResponse<InboxItem>);
  });

  // Mark as actioned
  router.post('/:id/action', (req, res) => {
    const row = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Inbox item not found' });
    }

    db.prepare('UPDATE inbox_items SET status = ?, actioned_at = ? WHERE id = ?')
      .run('actioned', new Date().toISOString(), req.params.id);

    const updated = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: rowToInboxItem(updated) } as ApiResponse<InboxItem>);
  });

  // Snooze item
  router.post('/:id/snooze', (req, res) => {
    const row = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Inbox item not found' });
    }

    const { until } = req.body; // ISO string
    db.prepare('UPDATE inbox_items SET status = ?, snoozed_until = ? WHERE id = ?')
      .run('snoozed', until, req.params.id);

    const updated = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: rowToInboxItem(updated) } as ApiResponse<InboxItem>);
  });

  // Delete inbox item
  router.delete('/:id', (req, res) => {
    const result = db.prepare('DELETE FROM inbox_items WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Inbox item not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  // Bulk actions
  router.post('/bulk/read', (req, res) => {
    const { ids } = req.body as { ids: string[] };
    const now = new Date().toISOString();

    const stmt = db.prepare('UPDATE inbox_items SET status = ?, read_at = ? WHERE id = ?');
    for (const id of ids) {
      stmt.run('read', now, id);
    }

    res.json({ success: true, data: { updated: ids.length } });
  });

  router.post('/bulk/action', (req, res) => {
    const { ids } = req.body as { ids: string[] };
    const now = new Date().toISOString();

    const stmt = db.prepare('UPDATE inbox_items SET status = ?, actioned_at = ? WHERE id = ?');
    for (const id of ids) {
      stmt.run('actioned', now, id);
    }

    res.json({ success: true, data: { updated: ids.length } });
  });

  return router;
}

function rowToInboxItem(row: any): InboxItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    status: row.status,
    priority: row.priority,
    title: row.title,
    summary: row.summary,
    source: JSON.parse(row.source),
    actions: JSON.parse(row.actions),
    data: row.data ? JSON.parse(row.data) : undefined,
    snoozedUntil: row.snoozed_until || undefined,
    createdAt: row.created_at,
    readAt: row.read_at || undefined,
    actionedAt: row.actioned_at || undefined,
  };
}
