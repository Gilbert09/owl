import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import type {
  Workspace,
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  ApiResponse,
} from '@fastowl/shared';

export function workspaceRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const rows = await db
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.ownerId, user.id))
      .orderBy(workspacesTable.name);
    res.json({ success: true, data: rows.map(rowToWorkspace) } as ApiResponse<Workspace[]>);
  });

  router.get('/:id', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const rows = await db
      .select()
      .from(workspacesTable)
      .where(and(eq(workspacesTable.id, req.params.id), eq(workspacesTable.ownerId, user.id)))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Workspace not found' });
    }
    res.json({ success: true, data: rowToWorkspace(rows[0]) } as ApiResponse<Workspace>);
  });

  router.post('/', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const body = req.body as CreateWorkspaceRequest;
    const id = uuid();
    const now = new Date();

    await db.insert(workspacesTable).values({
      id,
      ownerId: user.id,
      name: body.name,
      description: body.description ?? null,
      settings: { autoAssignTasks: true, maxConcurrentAgents: 3 },
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.id, id))
      .limit(1);
    res.status(201).json({ success: true, data: rowToWorkspace(rows[0]) } as ApiResponse<Workspace>);
  });

  router.patch('/:id', async (req, res) => {
    try {
      await requireWorkspaceAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const body = req.body as UpdateWorkspaceRequest;
    const existing = await db
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.id, req.params.id))
      .limit(1);
    if (!existing[0]) {
      return res.status(404).json({ success: false, error: 'Workspace not found' });
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.settings !== undefined) {
      const currentSettings = (existing[0].settings as Record<string, unknown>) ?? {};
      updates.settings = { ...currentSettings, ...body.settings };
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await db
        .update(workspacesTable)
        .set(updates)
        .where(eq(workspacesTable.id, req.params.id));
    }

    const rows = await db
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToWorkspace(rows[0]) } as ApiResponse<Workspace>);
  });

  router.delete('/:id', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const result = await db
      .delete(workspacesTable)
      .where(and(eq(workspacesTable.id, req.params.id), eq(workspacesTable.ownerId, user.id)))
      .returning({ id: workspacesTable.id });
    if (result.length === 0) {
      return res.status(404).json({ success: false, error: 'Workspace not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}

function rowToWorkspace(row: typeof workspacesTable.$inferSelect): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    repos: [], // TODO: Load from repositories table
    integrations: {}, // TODO: Load from integrations table
    settings: (row.settings as Workspace['settings']) ?? {
      autoAssignTasks: true,
      maxConcurrentAgents: 3,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
