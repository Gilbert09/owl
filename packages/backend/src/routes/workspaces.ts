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
import {
  PROMPT_KINDS,
  validatePromptTemplate,
  type Workspace,
  type WorkspaceLogo,
  type Repository,
  type WorkspaceIntegrations,
  type CreateWorkspaceRequest,
  type UpdateWorkspaceRequest,
  type ApiResponse,
  type PromptKind,
  type PromptTemplateOverride,
  type PromptTemplateSettings,
} from '@talyn/shared';

// Uploaded logos are stored inline as data URLs on the workspace row, so cap
// them. The desktop downscales before sending, which lands well under this;
// the cap just guards against an oversized/abusive payload.
const MAX_LOGO_DATA_URL_BYTES = 512 * 1024;

/**
 * Validate + normalise an untrusted logo from the request body. Throws on a
 * bad shape so the route can 400. `identicon` carries a small seed string;
 * `image` carries a `data:image/...` URL within the size cap.
 */
function validateLogo(raw: unknown): WorkspaceLogo {
  if (!raw || typeof raw !== 'object') throw new Error('logo must be an object');
  const l = raw as { kind?: unknown; seed?: unknown; dataUrl?: unknown };
  if (l.kind === 'identicon') {
    if (typeof l.seed !== 'string' || l.seed.length === 0 || l.seed.length > 200) {
      throw new Error('logo seed must be a non-empty string under 200 chars');
    }
    return { kind: 'identicon', seed: l.seed };
  }
  if (l.kind === 'image') {
    if (typeof l.dataUrl !== 'string' || !l.dataUrl.startsWith('data:image/')) {
      throw new Error('logo image must be a data:image/ URL');
    }
    if (l.dataUrl.length > MAX_LOGO_DATA_URL_BYTES) {
      throw new Error('logo image is too large');
    }
    return { kind: 'image', dataUrl: l.dataUrl };
  }
  throw new Error('logo kind must be "identicon" or "image"');
}

/** A fresh auto-generated identicon logo. */
function generatedLogo(): WorkspaceLogo {
  return { kind: 'identicon', seed: uuid() };
}

// Prompt overrides merge one level deeper than the rest of settings so a
// client can save or reset one kind without resending the others. `null`
// resets a kind (the key is dropped, not stored).
function mergePromptSettings(
  current: PromptTemplateSettings | undefined,
  patch: unknown
): PromptTemplateSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('settings.prompts must be an object');
  }
  const next: PromptTemplateSettings = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(PROMPT_KINDS as string[]).includes(key)) {
      throw new Error(`Unknown prompt kind "${key}"`);
    }
    const kind = key as PromptKind;
    if (value === null) {
      delete next[kind];
      continue;
    }
    if (!value || typeof value !== 'object') {
      throw new Error(`settings.prompts.${kind} must be an object or null`);
    }
    const o = value as Partial<PromptTemplateOverride>;
    if (typeof o.template !== 'string') {
      throw new Error(`settings.prompts.${kind}.template must be a string`);
    }
    const validation = validatePromptTemplate(kind, o.template);
    if (!validation.ok) {
      throw new Error(`Invalid ${kind} prompt: ${validation.errors.join(' ')}`);
    }
    if (typeof o.basedOnHash !== 'string' || !/^[0-9a-f]{8}$/.test(o.basedOnHash)) {
      throw new Error(`settings.prompts.${kind}.basedOnHash must be an 8-char hex hash`);
    }
    next[kind] = { template: o.template, basedOnHash: o.basedOnHash, updatedAt: new Date().toISOString() };
  }
  return next;
}

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

    // Auto-generate an identicon logo unless the client supplied one.
    let logo: WorkspaceLogo;
    try {
      logo = body.logo ? validateLogo(body.logo) : generatedLogo();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid logo';
      return res.status(400).json({ success: false, error: msg });
    }

    await db.insert(workspacesTable).values({
      id,
      ownerId: user.id,
      name: body.name,
      description: body.description ?? null,
      logo,
      settings: {},
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
    if (body.logo !== undefined) {
      try {
        updates.logo = validateLogo(body.logo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'invalid logo';
        return res.status(400).json({ success: false, error: msg });
      }
    }
    if (body.settings !== undefined) {
      const currentSettings = (existing[0].settings as Record<string, unknown>) ?? {};
      const merged: Record<string, unknown> = { ...currentSettings, ...body.settings };
      if (body.settings.prompts !== undefined) {
        try {
          merged.prompts = mergePromptSettings(
            currentSettings.prompts as PromptTemplateSettings | undefined,
            body.settings.prompts
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'invalid prompts';
          return res.status(400).json({ success: false, error: msg });
        }
      }
      updates.settings = merged;
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
    .select({
      id: repositoriesTable.id,
      workspaceId: repositoriesTable.workspaceId,
      name: repositoriesTable.name,
      url: repositoriesTable.url,
      defaultBranch: repositoriesTable.defaultBranch,
    })
    .from(repositoriesTable)
    .where(inArray(repositoriesTable.workspaceId, workspaceIds));
  const reposByWorkspace = new Map<string, Repository[]>();
  for (const row of repoRows) {
    const arr = reposByWorkspace.get(row.workspaceId) ?? [];
    arr.push({
      id: row.id,
      name: row.name,
      url: row.url,
      defaultBranch: row.defaultBranch,
    });
    reposByWorkspace.set(row.workspaceId, arr);
  }

  const integrationRows = await db
    .select({
      workspaceId: integrationsTable.workspaceId,
      type: integrationsTable.type,
      enabled: integrationsTable.enabled,
    })
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
    logo: (row.logo as WorkspaceLogo | null) ?? undefined,
    repos: relations.reposByWorkspace.get(row.id) ?? [],
    integrations: relations.integrationsByWorkspace.get(row.id) ?? {},
    settings: (row.settings as Workspace['settings']) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
