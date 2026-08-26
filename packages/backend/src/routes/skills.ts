// Skills API — platform-skill CRUD, repo-skill discovery, usage stats.
//
// Egress: `skills.content` is the table's big column. Every list read goes
// through SKILL_LIST_COLUMNS (content projected away, size via octet_length);
// only GET /:id and the mutation responses ship content.

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import {
  platformSkillKey,
  SKILL_MAX_BYTES,
  type CreatePlatformSkillRequest,
  type ListSkillsResponse,
  type PlatformSkill,
  type SkillSummary,
  type UpdatePlatformSkillRequest,
} from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import { skills as skillsTable } from '../db/schema.js';
import { handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import {
  getRepoSkillContent,
  getSkillUsage,
  listRepoSkills,
  type RepoSkillsResult,
} from '../services/skills.js';

export const SKILL_LIST_COLUMNS = {
  id: skillsTable.id,
  workspaceId: skillsTable.workspaceId,
  name: skillsTable.name,
  description: skillsTable.description,
  updatedAt: skillsTable.updatedAt,
  contentSize: sql<number>`octet_length(${skillsTable.content})`,
} as const;

type SkillListRow = Pick<typeof skillsTable.$inferSelect, 'id' | 'workspaceId' | 'name' | 'description' | 'updatedAt'> & {
  contentSize: number;
};

function listRowToSummary(row: SkillListRow): SkillSummary {
  return {
    key: platformSkillKey(row.id),
    source: 'platform',
    id: row.id,
    name: row.name,
    description: row.description,
    contentSize: row.contentSize,
  };
}

function rowToPlatformSkill(row: typeof skillsTable.$inferSelect): PlatformSkill {
  return {
    key: platformSkillKey(row.id),
    source: 'platform',
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    contentSize: Buffer.byteLength(row.content, 'utf8'),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Detect a Postgres unique violation (23505) through driver wrapping —
 * drizzle/pglite may nest the original error under `cause`, and some drivers
 * only surface the message text.
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const { code, message } = cur as { code?: string; message?: string };
    if (code === '23505') return true;
    if (message && /duplicate key|unique constraint/i.test(message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export function skillRoutes(): Router {
  const router = Router();

  // List platform skills + repo-discovered skills + usage stats in one call.
  router.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string;
    const repositoryId = (req.query.repositoryId as string) || null;
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    try {
      const db = getDbClient();
      const [platformRows, usage, repoResult] = await Promise.all([
        db
          .select(SKILL_LIST_COLUMNS)
          .from(skillsTable)
          .where(eq(skillsTable.workspaceId, workspaceId))
          .orderBy(skillsTable.name),
        getSkillUsage(workspaceId),
        repositoryId
          ? listRepoSkills(workspaceId, repositoryId, { refresh })
          : Promise.resolve<RepoSkillsResult>({ status: 'none', skills: [] }),
      ]);
      const data: ListSkillsResponse = {
        platform: platformRows.map(listRowToSummary),
        // Strip content from the repo listing — the launch flow fetches it
        // via /repo/content when actually needed.
        repo: repoResult.skills.map(({ content: _content, ...summary }) => summary),
        repoStatus: repositoryId ? repoResult.status : 'none',
        ...(repositoryId && repoResult.error ? { repoError: repoResult.error } : {}),
        usage,
      };
      res.json({ success: true, data });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  // A repo skill's full content, for the launch flow.
  router.get('/repo/content', async (req, res) => {
    const workspaceId = req.query.workspaceId as string;
    const repositoryId = req.query.repositoryId as string;
    const name = req.query.name as string;
    if (!workspaceId || !repositoryId || !name) {
      return res
        .status(400)
        .json({ success: false, error: 'workspaceId, repositoryId, and name are required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    try {
      const skill = await getRepoSkillContent(workspaceId, repositoryId, name);
      if (!skill) {
        return res.status(404).json({ success: false, error: 'Skill not found in repository' });
      }
      if (skill.content === null) {
        return res.status(413).json({
          success: false,
          error: `Skill is too large to run (${skill.contentSize} bytes; max ${SKILL_MAX_BYTES})`,
        });
      }
      res.json({ success: true, data: { content: skill.content, repoPath: skill.repoPath } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  // A platform skill with content.
  router.get('/:id', async (req, res) => {
    try {
      const db = getDbClient();
      const rows = await db
        .select()
        .from(skillsTable)
        .where(eq(skillsTable.id, req.params.id))
        .limit(1);
      const row = rows[0];
      if (!row) return res.status(404).json({ success: false, error: 'Skill not found' });
      try {
        await requireWorkspaceAccess(req, row.workspaceId);
      } catch (err) {
        return handleAccessError(err, res);
      }
      res.json({ success: true, data: rowToPlatformSkill(row) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.post('/', async (req, res) => {
    const body = req.body as CreatePlatformSkillRequest;
    if (!body.workspaceId || !body.name?.trim() || !body.content?.trim()) {
      return res
        .status(400)
        .json({ success: false, error: 'workspaceId, name, and content are required' });
    }
    if (Buffer.byteLength(body.content, 'utf8') > SKILL_MAX_BYTES) {
      return res
        .status(413)
        .json({ success: false, error: `Skill content exceeds ${SKILL_MAX_BYTES} bytes` });
    }
    try {
      await requireWorkspaceAccess(req, body.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    try {
      const db = getDbClient();
      const id = uuid();
      const now = new Date();
      await db.insert(skillsTable).values({
        id,
        workspaceId: body.workspaceId,
        name: body.name.trim(),
        description: body.description?.trim() ?? '',
        content: body.content,
        sourceInfo: body.sourceInfo ?? null,
        createdAt: now,
        updatedAt: now,
      });
      const rows = await db.select().from(skillsTable).where(eq(skillsTable.id, id)).limit(1);
      res.json({ success: true, data: rowToPlatformSkill(rows[0]) });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return res
          .status(409)
          .json({ success: false, error: 'A skill with that name already exists' });
      }
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.patch('/:id', async (req, res) => {
    const body = req.body as UpdatePlatformSkillRequest;
    if (body.content !== undefined && Buffer.byteLength(body.content, 'utf8') > SKILL_MAX_BYTES) {
      return res
        .status(413)
        .json({ success: false, error: `Skill content exceeds ${SKILL_MAX_BYTES} bytes` });
    }
    if (body.name !== undefined && !body.name.trim()) {
      return res.status(400).json({ success: false, error: 'name cannot be empty' });
    }
    try {
      const db = getDbClient();
      const rows = await db
        .select({ id: skillsTable.id, workspaceId: skillsTable.workspaceId })
        .from(skillsTable)
        .where(eq(skillsTable.id, req.params.id))
        .limit(1);
      const existing = rows[0];
      if (!existing) return res.status(404).json({ success: false, error: 'Skill not found' });
      try {
        await requireWorkspaceAccess(req, existing.workspaceId);
      } catch (err) {
        return handleAccessError(err, res);
      }
      const updates: Partial<typeof skillsTable.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name.trim();
      if (body.description !== undefined) updates.description = body.description.trim();
      if (body.content !== undefined) updates.content = body.content;
      await db
        .update(skillsTable)
        .set(updates)
        .where(and(eq(skillsTable.id, existing.id), eq(skillsTable.workspaceId, existing.workspaceId)));
      const updated = await db.select().from(skillsTable).where(eq(skillsTable.id, existing.id)).limit(1);
      res.json({ success: true, data: rowToPlatformSkill(updated[0]) });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return res
          .status(409)
          .json({ success: false, error: 'A skill with that name already exists' });
      }
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const db = getDbClient();
      const rows = await db
        .select({ id: skillsTable.id, workspaceId: skillsTable.workspaceId })
        .from(skillsTable)
        .where(eq(skillsTable.id, req.params.id))
        .limit(1);
      const existing = rows[0];
      if (!existing) return res.status(404).json({ success: false, error: 'Skill not found' });
      try {
        await requireWorkspaceAccess(req, existing.workspaceId);
      } catch (err) {
        return handleAccessError(err, res);
      }
      await db.delete(skillsTable).where(eq(skillsTable.id, existing.id));
      res.json({ success: true, data: null });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}
