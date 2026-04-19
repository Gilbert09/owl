import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { and, eq, inArray } from 'drizzle-orm';
import { getDbClient, type Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  integrations as integrationsTable,
} from '../db/schema.js';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import type {
  Workspace,
  Repository,
  WorkspaceIntegrations,
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
    const relations = await loadWorkspaceRelations(db, rows.map((r) => r.id));
    res.json({
      success: true,
      data: rows.map((r) => rowToWorkspace(r, relations)),
    } as ApiResponse<Workspace[]>);
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
    const relations = await loadWorkspaceRelations(db, [rows[0].id]);
    res.json({
      success: true,
      data: rowToWorkspace(rows[0], relations),
    } as ApiResponse<Workspace>);
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
    // Fresh workspace has no repos or integrations yet — skip the load.
    res.status(201).json({
      success: true,
      data: rowToWorkspace(rows[0], { reposByWorkspace: new Map(), integrationsByWorkspace: new Map() }),
    } as ApiResponse<Workspace>);
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
    const relations = await loadWorkspaceRelations(db, [rows[0].id]);
    res.json({
      success: true,
      data: rowToWorkspace(rows[0], relations),
    } as ApiResponse<Workspace>);
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

interface WorkspaceRelations {
  reposByWorkspace: Map<string, Repository[]>;
  integrationsByWorkspace: Map<string, WorkspaceIntegrations>;
}

/**
 * Batch-load repos + integrations for a set of workspaces. One query per
 * table, grouped by workspaceId. Keeps `GET /workspaces` at O(1) queries
 * rather than N+1 as the list grows.
 */
async function loadWorkspaceRelations(
  db: Database,
  workspaceIds: string[]
): Promise<WorkspaceRelations> {
  if (workspaceIds.length === 0) {
    return { reposByWorkspace: new Map(), integrationsByWorkspace: new Map() };
  }

  const repoRows = await db
    .select()
    .from(repositoriesTable)
    .where(inArray(repositoriesTable.workspaceId, workspaceIds));
  const reposByWorkspace = new Map<string, Repository[]>();
  for (const row of repoRows) {
    const arr = reposByWorkspace.get(row.workspaceId) ?? [];
    arr.push({
      id: row.id,
      name: row.name,
      url: row.url,
      localPath: row.localPath ?? undefined,
      defaultBranch: row.defaultBranch,
    });
    reposByWorkspace.set(row.workspaceId, arr);
  }

  const integrationRows = await db
    .select()
    .from(integrationsTable)
    .where(inArray(integrationsTable.workspaceId, workspaceIds));
  const integrationsByWorkspace = new Map<string, WorkspaceIntegrations>();
  for (const row of integrationRows) {
    const existing = integrationsByWorkspace.get(row.workspaceId) ?? {};
    // Expose presence + enabled flag only — never leak the token blob
    // out of the API. Frontend reads connection state via the dedicated
    // `/github` (etc.) endpoints when it needs more detail.
    if (row.type === 'github') {
      existing.github = { enabled: row.enabled, watchedRepos: [] };
    } else if (row.type === 'slack') {
      existing.slack = { enabled: row.enabled, watchedChannels: [] };
    } else if (row.type === 'posthog') {
      existing.posthog = { enabled: row.enabled };
    }
    integrationsByWorkspace.set(row.workspaceId, existing);
  }

  return { reposByWorkspace, integrationsByWorkspace };
}

function rowToWorkspace(
  row: typeof workspacesTable.$inferSelect,
  relations: WorkspaceRelations
): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    repos: relations.reposByWorkspace.get(row.id) ?? [],
    integrations: relations.integrationsByWorkspace.get(row.id) ?? {},
    settings: (row.settings as Workspace['settings']) ?? {
      autoAssignTasks: true,
      maxConcurrentAgents: 3,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
