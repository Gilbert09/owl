import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { forceFetchAndUpsert } from '../services/prCache.js';
import { batchPullRequests } from '../services/githubGraphql.js';
import { handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import type { ApiResponse } from '@fastowl/shared';

/**
 * Read-only routes for the new PR/CI surface. The desktop never writes
 * to GitHub through these — every actionable button (approve, merge,
 * comment) deep-links to github.com.
 *
 *   GET   /pull-requests                  list workspace PRs
 *   GET   /pull-requests/:id              full detail (always fresh GraphQL)
 *   POST  /pull-requests/:id/refresh      force fetch + upsert
 *   POST  /pull-requests/:id/focus        mark focused (Phase 6 wires the
 *                                         adaptive-poll signal; this
 *                                         endpoint exists now so the
 *                                         desktop can start emitting it)
 */

export function pullRequestRoutes(): Router {
  const router = Router();

  // List PRs for a workspace. Filters: state ('open' | 'closed' |
  // 'merged' | 'all', default 'open'), repo (repository_id),
  // taskOnly (true → only PRs linked to a task), search (substring
  // match on title or owner/repo).
  router.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();

    const stateFilter = (req.query.state as string | undefined) ?? 'open';
    const repoFilter = req.query.repo as string | undefined;
    const taskOnly = req.query.taskOnly === 'true';
    const search = (req.query.search as string | undefined)?.toLowerCase().trim();

    const conditions = [eq(pullRequestsTable.workspaceId, workspaceId)];
    if (stateFilter !== 'all') {
      conditions.push(eq(pullRequestsTable.state, stateFilter));
    }
    if (repoFilter) {
      conditions.push(eq(pullRequestsTable.repositoryId, repoFilter));
    }

    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(and(...conditions))
      .orderBy(desc(pullRequestsTable.lastPolledAt));

    let filtered = rows;
    if (taskOnly) {
      filtered = filtered.filter((r) => r.taskId != null);
    }
    if (search) {
      filtered = filtered.filter((r) => {
        const title =
          ((r.lastSummary as { title?: string } | null)?.title ?? '').toLowerCase();
        const fullName = `${r.owner}/${r.repo}`.toLowerCase();
        return title.includes(search) || fullName.includes(search);
      });
    }

    res.json({
      success: true,
      data: filtered.map(rowToPublicShape),
    } as ApiResponse<ReturnType<typeof rowToPublicShape>[]>);
  });

  // Single PR detail. Always returns the persisted row plus a fresh
  // recentReviews/recentReviewComments/recentComments fan-out via a
  // dedicated GraphQL fetch — the cache stores only the summary,
  // detail-view tabs need the recent* arrays + reviewBody for the
  // Reviews tab.
  router.get('/:id', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const summaryHead =
      ((row.lastSummary as { headBranch?: string } | null)?.headBranch) ?? null;
    if (!summaryHead) {
      return res.json({
        success: true,
        data: { row: rowToPublicShape(row), fresh: null },
      });
    }

    let fresh: Awaited<ReturnType<typeof batchPullRequests>>[number]['pr'] = null;
    try {
      const results = await batchPullRequests({
        workspaceId: row.workspaceId,
        owner: row.owner,
        repo: row.repo,
        branches: [summaryHead],
      });
      fresh = results[0]?.pr ?? null;
    } catch (err) {
      // Network blip, token revoked, etc — caller still gets the
      // cached row.
      console.warn(`[pull-requests] fresh detail fetch failed for ${row.id}:`, err);
    }

    res.json({
      success: true,
      data: { row: rowToPublicShape(row), fresh },
    });
  });

  // Force a fresh fetch + upsert. Bypasses the cache TTL. Returns the
  // new persisted shape.
  router.post('/:id/refresh', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const result = await forceFetchAndUpsert({
      workspaceId: row.workspaceId,
      repositoryId: row.repositoryId,
      taskId: row.taskId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
    });
    if (!result) {
      return res
        .status(404)
        .json({ success: false, error: 'PR not found on GitHub or has no head branch in cache' });
    }

    const fresh = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, result.rowId))
      .limit(1);
    res.json({ success: true, data: rowToPublicShape(fresh[0]) });
  });

  // Focus signal — Phase 6 hooks this up to the adaptive scheduler.
  // Endpoint exists now so the desktop can start emitting it without
  // a follow-up release. Body shape: `{ focused: boolean }`. Returns
  // 204.
  router.post('/:id/focus', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select({ workspaceId: pullRequestsTable.workspaceId })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    // No-op for now — Phase 6 implements the focus map. Returning 204
    // keeps the desktop's contract stable.
    res.status(204).send();
  });

  return router;
}

interface PullRequestRow {
  id: string;
  workspaceId: string;
  repositoryId: string;
  taskId: string | null;
  owner: string;
  repo: string;
  number: number;
  state: string;
  mergedAt: Date | null;
  lastPolledAt: Date;
  lastSummary: unknown;
  lastReviewId: string | null;
  lastReviewCommentId: string | null;
  lastCommentId: string | null;
  lastCheckDigest: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToPublicShape(row: PullRequestRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    repositoryId: row.repositoryId,
    taskId: row.taskId,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    state: row.state,
    mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
    lastPolledAt: row.lastPolledAt.toISOString(),
    summary: row.lastSummary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

