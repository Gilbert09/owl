import { Router } from 'express';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { getDbClient, runWithoutScope } from '../db/client.js';
import {
  pullRequests as pullRequestsTable,
  mergeQueueEntries as mergeQueueEntriesTable,
  mergeQueueEvents as mergeQueueEventsTable,
} from '../db/schema.js';
import { forceFetchAndUpsert, upsertFromBatchResult } from '../services/prCache.js';
import { startPrMergeableRun } from '../services/prCloudFix.js';
import { rowToTask } from '../services/taskSerialize.js';
import {
  batchPullRequests,
  fetchPRReviewDetail,
  type PRSummary,
} from '../services/githubGraphql.js';
import { githubService, MergeNotPermittedForAppError } from '../services/github.js';
import {
  setFocused,
  clearFocused,
  markRefreshed,
  setActiveView,
  type ActiveView,
} from '../services/prFocus.js';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { withMergeQueueLimitGate } from '../services/billing/entitlements.js';
import { bypassesPaywall } from '../services/billing/clientGate.js';
import { emitPullRequestUpdated } from '../services/websocket.js';
import { mergeQueueProcessor } from '../services/mergeQueueProcessor.js';
import {
  closeActiveEntry,
  computeEntryPositions,
  ensureActiveEntry,
  getActiveEntryForPr,
  loadActiveEntriesForWorkspace,
  loadActiveGroup,
  rowToEntrySnapshot,
} from '../services/mergeQueue/store.js';
import { toPublicMergeQueue } from '../services/mergeQueue/legacy.js';
import {
  classifyAutoMergeActor,
  disableAutoMerge,
  markReadyForReview,
} from '../services/githubAutoMerge.js';
import { getExternalMergeGate, markExternalMergeGate } from '../services/repoMergeGate.js';
import { submitToExternalQueue } from '../services/externalQueueSubmit.js';
import { isExternalMergeGateError } from '../services/mergeQueue/decide.js';
import { prMonitorService } from '../services/prMonitor.js';
import { onQueueMembershipChanged } from '../services/mergeQueue/triggers.js';
import type { MergeMethod } from '../services/mergeQueue/types.js';
import {
  computeQueuePositions,
  broadcastMergeQueuePositions,
  QUEUE_RESET_COLUMNS,
} from '../services/mergeQueueBroadcast.js';
import {
  ancestorsOf,
  descendantsOf,
  StackCycleError,
  type StackNode,
} from '@talyn/shared';
import type { ApiResponse } from '@talyn/shared';

/**
 * Routes for the PR/CI surface. Mostly read-only — the one write path is
 * merge (gated in the UI to mergeable PRs and behind an explicit
 * confirm). Review/comment composition still deep-links to github.com.
 *
 *   GET   /pull-requests                  list workspace PRs
 *   GET   /pull-requests/:id              full detail (always fresh GraphQL)
 *   GET   /pull-requests/:id/files        file-by-file diff (live REST)
 *   POST  /pull-requests/:id/refresh      force fetch + upsert
 *   POST  /pull-requests/:id/auto-keep-mergeable  toggle the watcher
 *   POST  /pull-requests/:id/merge-queue  add/remove from the merge queue
 *   POST  /pull-requests/:id/focus        mark focused (adaptive-poll TTL)
 *   POST  /pull-requests/:id/merge        merge the PR (merge|squash|rebase)
 */

/**
 * The four columns the GraphQL/REST detail fetches (`/files`, `/reviews`)
 * need to address GitHub — they never touch `lastSummary` or any flag/jsonb
 * column, so we project to avoid shipping the whole row just to read 4 scalars.
 */
const PR_LOOKUP_COLUMNS = {
  workspaceId: pullRequestsTable.workspaceId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
} as const;

/**
 * Columns the flag-toggle endpoints read + echo back. They emit `lastSummary`
 * (so it stays), but never read the watcher/queue bookkeeping blobs, cursors,
 * or timestamps — those are dropped from the read.
 */
const PR_FLAG_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  taskId: pullRequestsTable.taskId,
  repositoryId: pullRequestsTable.repositoryId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  lastSummary: pullRequestsTable.lastSummary,
  mergeMethod: pullRequestsTable.mergeMethod,
  mergeQueuedAt: pullRequestsTable.mergeQueuedAt,
} as const;

/** A row read through {@link PR_FLAG_COLUMNS}. The `Pick` is the egress guard. */
type PRFlagRow = Pick<typeof pullRequestsTable.$inferSelect, keyof typeof PR_FLAG_COLUMNS>;

/**
 * Exactly the columns the list endpoint serializes (`rowToPublicShape`) plus
 * what `computeQueuePositions` reads — and nothing else. Projecting keeps the
 * review/comment/check cursor columns in the DB instead of shipping them on
 * every list fetch; the big `lastSummary` jsonb still ships (the pill needs it).
 * Typed as a `Pick` so tsc fails if a consumer later reads a dropped column.
 */
const LIST_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  repositoryId: pullRequestsTable.repositoryId,
  taskId: pullRequestsTable.taskId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  reviewRequested: pullRequestsTable.reviewRequested,
  authored: pullRequestsTable.authored,
  mergedAt: pullRequestsTable.mergedAt,
  lastPolledAt: pullRequestsTable.lastPolledAt,
  lastSummary: pullRequestsTable.lastSummary,
  autoKeepMergeable: pullRequestsTable.autoKeepMergeable,
  autoMergeState: pullRequestsTable.autoMergeState,
  mergeQueued: pullRequestsTable.mergeQueued,
  mergeQueuedAt: pullRequestsTable.mergeQueuedAt,
  mergeMethod: pullRequestsTable.mergeMethod,
  mergeQueueState: pullRequestsTable.mergeQueueState,
  createdAt: pullRequestsTable.createdAt,
  updatedAt: pullRequestsTable.updatedAt,
} as const;

export function pullRequestRoutes(): Router {
  const router = Router();

  // List PRs for a workspace. Filters: state ('open' | 'closed' |
  // 'merged' | 'all', default 'open'), repo (repository_id),
  // taskOnly (true → only PRs linked to a task), search (substring
  // match on title or owner/repo), relationship ('authored' |
  // 'review_requested' | 'all', default 'all').
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
    // 'authored' (PRs the user opened) | 'review_requested' (PRs
    // awaiting the user's review) | 'all' (default).
    const relationship = req.query.relationship as string | undefined;

    const conditions = [eq(pullRequestsTable.workspaceId, workspaceId)];
    if (stateFilter !== 'all') {
      conditions.push(eq(pullRequestsTable.state, stateFilter));
    }
    if (repoFilter) {
      conditions.push(eq(pullRequestsTable.repositoryId, repoFilter));
    }
    if (relationship === 'authored') {
      conditions.push(eq(pullRequestsTable.authored, true));
    } else if (relationship === 'review_requested') {
      // `reviewRequested` already means "awaiting my review" — the monitor
      // clears it once the user reviews the PR, so an approved PR is gone.
      conditions.push(eq(pullRequestsTable.reviewRequested, true));
    }
    // `taskOnly` + `search` used to filter in JS after loading every open PR;
    // do it in SQL so a workspace with hundreds of PRs neither ships nor walks
    // the non-matching rows on the request hot path. `search` is already
    // lower-cased + trimmed above — escape LIKE metacharacters so it stays a
    // plain substring match (the old `.includes()` semantics).
    if (taskOnly) {
      conditions.push(isNotNull(pullRequestsTable.taskId));
    }
    if (search) {
      const term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const searchCondition = or(
        sql`lower(${pullRequestsTable.owner} || '/' || ${pullRequestsTable.repo}) like ${term}`,
        sql`lower(coalesce(${pullRequestsTable.lastSummary} ->> 'title', '')) like ${term}`
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    const rows = await db
      .select(LIST_COLUMNS)
      .from(pullRequestsTable)
      .where(and(...conditions))
      .orderBy(desc(pullRequestsTable.lastPolledAt));

    // 1-based merge-queue position per (repo, base branch) group, FIFO by
    // `mergeQueuedAt`. Computed locally over the rows we already have.
    const queuePositionById = computeQueuePositions(rows);

    // Merge queue v2 payloads for the initial paint (the WS echoes keep them
    // live afterwards): one indexed query over the workspace's active entries.
    const v2ByPrId = new Map<string, Record<string, unknown>>();
    try {
      const entries = await loadActiveEntriesForWorkspace(workspaceId, db);
      const v2Positions = computeEntryPositions(entries);
      for (const entry of entries) {
        v2ByPrId.set(
          entry.pullRequestId,
          toPublicMergeQueue(rowToEntrySnapshot(entry), v2Positions.get(entry.id) ?? 0)
        );
      }
    } catch (err) {
      console.warn(
        '[pullRequests] merge-queue v2 list decoration failed:',
        err instanceof Error ? err.message : err
      );
    }

    res.json({
      success: true,
      data: rows.map((r) => ({
        ...rowToPublicShape(r, queuePositionById.get(r.id) ?? 0),
        mergeQueue: v2ByPrId.get(r.id) ?? null,
      })),
    } as ApiResponse<Array<ReturnType<typeof rowToPublicShape> & { mergeQueue: unknown }>>);
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
      const queue = await mergeQueueForPr(row.id, db);
      return res.json({
        success: true,
        data: {
          row: { ...rowToPublicShape(row, queue.position), mergeQueue: queue.payload },
          fresh: null,
        },
      });
    }

    let fresh: Awaited<ReturnType<typeof batchPullRequests>>[number]['pr'] = null;
    try {
      const results = await batchPullRequests({
        workspaceId: row.workspaceId,
        owner: row.owner,
        repo: row.repo,
        branches: [summaryHead],
        // Carry the PR number so the fetch resolves `isRequired` per check —
        // lets the detail pill + Checks tab tell required from non-required
        // failures instead of guessing from mergeStateStatus.
        numbers: [row.number],
      });
      fresh = results[0]?.pr ?? null;
    } catch (err) {
      // Network blip, token revoked, etc — caller still gets the
      // cached row.
      console.warn(`[pull-requests] fresh detail fetch failed for ${row.id}:`, err);
    }

    let outRow = row;
    if (!fresh && row.state === 'open') {
      // GraphQL only returns OPEN PRs. A null result on a row still marked
      // 'open' means it merged/closed upstream — reconcile so the row (and
      // its tab) stops claiming it's open.
      const reconciled = await reconcileTerminalState(row);
      if (reconciled) outRow = reconciled;
    } else if (fresh && freshDiffersMaterially(row, fresh)) {
      // Persist the authoritative live fetch when it materially differs from
      // the cache. Otherwise the cached summary only updates on the next
      // background poll — so a base-branch retarget (which flips a check's
      // required-ness) or a stale-check correction can show wrong until then,
      // even though we just fetched the truth to render `fresh`. The upsert
      // also broadcasts pull_request:updated, fixing the list rows too. Guarded
      // so an unchanged open is a pure read (no write, no broadcast, flat egress).
      const result = await upsertFromBatchResult({
        workspaceId: row.workspaceId,
        repositoryId: row.repositoryId,
        taskId: row.taskId,
        summary: fresh,
        existingId: row.id,
      });
      const refreshed = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, result.rowId))
        .limit(1);
      if (refreshed[0]) outRow = refreshed[0];
    }

    const queue = await mergeQueueForPr(outRow.id, db);
    res.json({
      success: true,
      data: {
        row: { ...rowToPublicShape(outRow, queue.position), mergeQueue: queue.payload },
        fresh,
      },
    });
  });

  // File-by-file diff for a PR. Returns each changed file's status,
  // per-file +/- stats, and the unified-diff `patch` so the desktop can
  // render it inline via the same PatchDiff viewer the task Files tab
  // uses — no more "view on GitHub" hand-off. This is a live REST hit
  // (not cached): the files list is only fetched when the user opens the
  // Files tab, so it's low-frequency.
  router.get('/:id/files', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select(PR_LOOKUP_COLUMNS)
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
    try {
      const files = await githubService.getPRFiles(
        row.workspaceId,
        row.owner,
        row.repo,
        row.number
      );
      res.json({ success: true, data: files });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // Full review/comment detail for the Reviews tab — every submitted
  // review (with body), every inline review thread (grouped, with diff
  // hunk + resolved state), and the top-level conversation comments.
  // Live GraphQL fetch, only when the user opens the tab.
  router.get('/:id/reviews', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select(PR_LOOKUP_COLUMNS)
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
    try {
      const detail = await fetchPRReviewDetail({
        workspaceId: row.workspaceId,
        owner: row.owner,
        repo: row.repo,
        number: row.number,
      });
      res.json({ success: true, data: detail });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
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
      // GraphQL returned nothing → the PR isn't open. Reconcile its
      // terminal state via REST so a manual refresh can recover a row
      // that's stuck (e.g. a merged PR still showing as closed/open).
      const reconciled = await reconcileTerminalState(row);
      if (reconciled) {
        const queue = await mergeQueueForPr(reconciled.id, db);
        return res.json({
          success: true,
          data: { ...rowToPublicShape(reconciled, queue.position), mergeQueue: queue.payload },
        });
      }
      return res
        .status(404)
        .json({ success: false, error: 'PR not found on GitHub or has no head branch in cache' });
    }
    // Cooldown: the next 5 s of poll-driven refetches skip this PR
    // so a manual refresh doesn't get stomped by a racing tick.
    markRefreshed(row.workspaceId, result.rowId);

    const fresh = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, result.rowId))
      .limit(1);
    const queue = await mergeQueueForPr(fresh[0].id, db);
    res.json({
      success: true,
      data: { ...rowToPublicShape(fresh[0], queue.position), mergeQueue: queue.payload },
    });
  });

  // Fire the standard "get this PR mergeable" cloud run — the same action as
  // the desktop fix button and the merge-queue / auto-keep watchers, using
  // FastOwl's canonical buildMergeablePrompt and the workspace's configured
  // provider. Body is optional `{ model? }`. Returns the created task.
  router.post('/:id/fix', async (req, res) => {
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
    const model =
      typeof req.body?.model === 'string' && req.body.model.trim()
        ? req.body.model.trim()
        : undefined;
    const result = await startPrMergeableRun(row, {
      model,
      // Transitional billing rollout — see services/billing/clientGate.ts.
      bypassTaskLimit: bypassesPaywall(req, 'task'),
    });
    if (!result.ok) {
      return res.status(400).json({
        success: false,
        error: 'No connected cloud provider for this workspace',
      });
    }
    res.status(201).json({ success: true, data: rowToTask(result.task) });
  });

  // Auto-keep-mergeable toggle. Body `{ enabled: boolean }`. When on, the
  // background watcher repeatedly fires a "take this PR to a clean, mergeable
  // state" cloud run whenever the PR has a blocker and nothing's already
  // working it — indefinitely, including conflicts that appear days later.
  router.post('/:id/auto-keep-mergeable', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select(PR_FLAG_COLUMNS)
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

    const enabled = (req.body as { enabled?: boolean }).enabled === true;
    // Enabling: arm a fresh guard so the next watcher tick fires immediately if
    // the PR already needs work. Disabling: clear all watcher bookkeeping.
    const nextState = enabled ? { attempts: 0, accounted: true } : null;
    await db
      .update(pullRequestsTable)
      .set({
        autoKeepMergeable: enabled,
        autoMergeState: nextState,
        updatedAt: new Date(),
      })
      .where(eq(pullRequestsTable.id, row.id));

    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      autoKeepMergeable: enabled,
      autoMergeState: publicAutoMergeState(nextState),
    });

    res.json({ success: true, data: null } as ApiResponse<null>);
  });

  // Merge-queue toggle. Body `{ enabled: boolean, method?: 'merge'|'squash'|'rebase' }`.
  // When on, the PR joins the FastOwl merge queue: the background processor
  // merges it (per `method`, default squash) as soon as it's clean, serialized
  // per (repo, base branch). On conflict / behind / blocked it fires the same
  // cloud "fix every blocker" run the watcher uses, then merges. The PR drops
  // off the queue once merged.
  /**
   * Apply queue membership to ONE PR: the pull_requests bookkeeping plus the
   * merge_queue_entries dual-write. Extracted so the single-PR toggle and the
   * stack batch can't drift — the batch is exactly N of these, and a member
   * that skipped the disarm or the entry write would be a silent hole.
   *
   * Deliberately does NOT gate on billing, publish drafts, broadcast, or kick
   * the pipeline: those are per-CALL, not per-PR, and doing them here would
   * mean N advisory locks and N broadcasts for one user action.
   */
  async function applyQueueMembership(
    row: PRFlagRow,
    opts: { enabled: boolean; method: string; trigger: string }
  ): Promise<void> {
    const db = getDbClient();
    const { enabled, method } = opts;
    // Enabling: arm a fresh guard so the next processor tick acts immediately,
    // and preserve the queue place on a fast off/on toggle. Disabling: clear
    // all queue bookkeeping.
    const nextState = enabled ? { status: 'waiting' as const, attempts: 0, accounted: true } : null;
    await db
      .update(pullRequestsTable)
      .set({
        mergeQueued: enabled,
        mergeQueuedAt: enabled ? (row.mergeQueuedAt ?? new Date()) : null,
        mergeMethod: method,
        mergeQueueState: nextState,
        updatedAt: new Date(),
      })
      .where(eq(pullRequestsTable.id, row.id));

    // Dual-write membership into merge_queue_entries (the v2 queue). While
    // the v1 engine drives, this only tracks membership — v1's own
    // transitions don't touch entries, and the cutover migration re-syncs
    // any drift before the v2 pipeline takes over. Best-effort: a failure
    // here must never break the toggle.
    try {
      const summary = row.lastSummary as { baseBranch?: string; headSha?: string } | null;
      if (enabled) {
        await ensureActiveEntry({
          pullRequestId: row.id,
          workspaceId: row.workspaceId,
          repositoryId: row.repositoryId,
          baseBranch: summary?.baseBranch ?? '',
          mergeMethod: method as MergeMethod,
          headSha: summary?.headSha ?? '',
          trigger: opts.trigger,
        });
      } else {
        const closed = await closeActiveEntry(row.id, 'removed', {
          trigger: opts.trigger,
          message: 'Removed from the merge queue by the user.',
        });
        // A dequeued PR must NOT keep a Talyn-armed auto-merge on GitHub —
        // GitHub would merge it after the user explicitly pulled it. Disarm
        // synchronously; on failure flag pendingDisarm so the reconciler
        // retries (never leave it dangling). User-armed auto-merges are left
        // alone — we never disarm what we didn't arm.
        if (closed?.automergeArmedBy === 'talyn') {
          const nodeId = (row.lastSummary as { nodeId?: string } | null)?.nodeId;
          const disarmed = nodeId
            ? await disableAutoMerge({
                workspaceId: row.workspaceId,
                owner: row.owner,
                repo: row.repo,
                nodeId,
              })
            : false;
          if (!disarmed) {
            await db
              .update(mergeQueueEntriesTable)
              .set({ pendingDisarm: true, updatedAt: new Date() })
              .where(eq(mergeQueueEntriesTable.id, closed.id));
          }
        }
      }
    } catch (err) {
      console.warn(
        `[pullRequests] merge-queue entry dual-write failed for ${row.owner}/${row.repo}#${row.number}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Queuing a draft PR: GitHub 405s a draft merge, so a queued draft would just
   * sit blocked waiting on the author. Since queuing IS the intent to merge,
   * mark it ready for review now. Best-effort — on success we refresh the
   * cached summary so the kick merges without waiting for the ready_for_review
   * webhook; on failure decide()'s draft block still surfaces the manual action.
   */
  async function publishDraftForQueue(row: PRFlagRow): Promise<void> {
    const summary = row.lastSummary as
      | { draft?: boolean; nodeId?: string; mergeStateStatus?: string }
      | null;
    const isDraftPr = summary?.draft === true || summary?.mergeStateStatus === 'DRAFT';
    if (!isDraftPr || !summary?.nodeId) return;
    const ready = await markReadyForReview({
      workspaceId: row.workspaceId,
      owner: row.owner,
      repo: row.repo,
      nodeId: summary.nodeId,
    });
    if (!ready) return;
    await prMonitorService
      .refreshPr(row.workspaceId, row.owner, row.repo, row.number, {
        resolveMergeable: true,
        repositoryId: row.repositoryId,
      })
      .catch((err) => {
        console.warn(
          `[pullRequests] post-ready refresh failed for ${row.owner}/${row.repo}#${row.number}:`,
          err instanceof Error ? err.message : err
        );
      });
  }

  /** The cleared-badge broadcast a dequeued row needs (it is out of the group). */
  function emitDequeued(row: PRFlagRow): void {
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: false,
      mergeQueueState: null,
    });
  }

  function resolveMergeMethod(body: unknown, fallback: string): string {
    const m = (body as { method?: string } | undefined)?.method;
    return m === 'merge' || m === 'rebase' || m === 'squash' ? m : fallback;
  }

  router.post('/:id/merge-queue', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select(PR_FLAG_COLUMNS)
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

    const body = req.body as { enabled?: boolean } | undefined;
    const enabled = body?.enabled === true;
    // keep the existing method when omitted
    const method = resolveMergeMethod(req.body, row.mergeMethod);
    const apply = () =>
      applyQueueMembership(row, {
        enabled,
        method,
        trigger: enabled ? 'user:enqueue' : 'user:dequeue',
      });

    if (enabled && !bypassesPaywall(req, 'merge_queue')) {
      // Free-plan queue cap — MergeQueueLimitError → 402 via the error
      // middleware. The PR itself is excluded from the count so re-arming an
      // already-queued PR never self-blocks. Pre-paywall builds skip the gate
      // (they can't render the upgrade flow) — see billing/clientGate.ts.
      await withMergeQueueLimitGate(assertUser(req).id, { excludePrId: row.id }, apply);
    } else {
      await apply();
    }

    if (enabled) await publishDraftForQueue(row);
    // When disabling, the row is no longer in the queue so the group rebroadcast
    // below will not touch it — emit its cleared badge explicitly here.
    else emitDequeued(row);

    // Recompute "#N" for the whole queue so the toggled PR gets its real
    // position and every sibling shifts to match — not just after a refresh.
    await broadcastMergeQueuePositions(row.workspaceId);

    // Kick a tick so an already-clean PR merges without waiting for the poll.
    // Both engines: the v1 runOnce no-ops when the flag reads 'v2', and the
    // v2 trigger no-ops while v1 drives. Scope-escaped — fire-and-forget work
    // must never inherit this request's transaction handle (it is dead by the
    // time the kick runs; see runWithoutScope).
    if (enabled) {
      runWithoutScope(() => {
        void mergeQueueProcessor.runOnce();
        void onQueueMembershipChanged(row.id, 'user:enqueue');
      });
    }

    res.json({ success: true, data: null } as ApiResponse<null>);
  });

  /**
   * Every open PR in one repo, as the structural nodes @talyn/shared links on.
   * Projected: `number` and the two branch names off the summary jsonb, never
   * the blob itself — a repo with hundreds of open PRs would otherwise ship
   * hundreds of multi-KB summaries to resolve one chain.
   */
  async function stackCandidates(
    workspaceId: string,
    repositoryId: string
  ): Promise<Array<StackNode & { number: number }>> {
    const rows = await getDbClient()
      .select({
        id: pullRequestsTable.id,
        number: pullRequestsTable.number,
        state: pullRequestsTable.state,
        headBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'headBranch'`,
        baseBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'baseBranch'`,
      })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId),
          eq(pullRequestsTable.state, 'open')
        )
      );
    return rows.map((r) => ({
      id: r.id,
      repositoryId,
      state: 'open' as const,
      headBranch: r.headBranch ?? '',
      baseBranch: r.baseBranch ?? '',
      number: r.number,
    }));
  }

  /**
   * Enqueue (or dequeue) a whole stack of dependent PRs in one call.
   *
   * `:id` may be ANY member — the server resolves the chain itself rather than
   * trusting a client list, so a stale UI can never enqueue an unrelated PR.
   * Enabling always takes the ANCESTORS of `:id` (root-first): you cannot land
   * `:id` without everything it is based on. `includeDescendants` adds the PRs
   * stacked on top of it.
   *
   * Disabling is the mirror and always CASCADES UPWARD: every descendant is
   * parked on this PR and would wait forever if we dropped only this one. That
   * asymmetry is deliberate — see the tooltip copy in the desktop table.
   *
   * The free-plan gate is ALL-OR-NOTHING and wraps every write, so a 402
   * leaves nothing enqueued. Enqueuing only the bottom of a stack is not a
   * degraded success: the retarget of rung 4 only happens because rung 4 is in
   * the queue, so a partial stack silently stops halfway with nothing to say why.
   */
  router.post('/:id/merge-queue/stack', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select(PR_FLAG_COLUMNS)
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const anchor = rows[0];
    if (!anchor) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, anchor.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const body = req.body as { enabled?: boolean; includeDescendants?: boolean } | undefined;
    const enabled = body?.enabled === true;
    const method = resolveMergeMethod(req.body, anchor.mergeMethod);

    const candidates = await stackCandidates(anchor.workspaceId, anchor.repositoryId);
    let chainIds: string[];
    try {
      const up = enabled ? ancestorsOf(candidates, anchor.id) : [anchor];
      const down =
        enabled && body?.includeDescendants !== true
          ? []
          : descendantsOf(candidates, anchor.id);
      chainIds = [...up.map((n) => n.id), ...down.map((n) => n.id)];
    } catch (err) {
      if (err instanceof StackCycleError) {
        return res.status(409).json({
          success: false,
          error:
            'These PRs form a base/head cycle, so none of them can merge first. ' +
            'Retarget one of them to break the loop.',
          code: 'stack_cycle',
        });
      }
      throw err;
    }
    // De-duplicate while keeping order: with includeDescendants the anchor is
    // in both halves, and a diamond can surface a PR twice.
    const orderedIds = [...new Set(chainIds)];
    if (orderedIds.length === 0) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }

    // Re-read the full flag rows for the chain, then restore the resolved
    // order — root-first enqueue gives sensible enqueuedAt FIFO within any
    // group the members happen to share.
    const memberRows = await db
      .select(PR_FLAG_COLUMNS)
      .from(pullRequestsTable)
      .where(inArray(pullRequestsTable.id, orderedIds));
    const byId = new Map(memberRows.map((r) => [r.id, r]));
    const members = orderedIds.map((id) => byId.get(id)).filter((r): r is PRFlagRow => !!r);

    const applyAll = async () => {
      for (const member of members) {
        await applyQueueMembership(member, {
          enabled,
          method,
          trigger: enabled ? 'user:enqueue-stack' : 'user:dequeue-stack',
        });
      }
    };

    if (enabled && !bypassesPaywall(req, 'merge_queue')) {
      // One advisory lock spanning the count AND every insert, so a stack that
      // does not fit is refused whole. Every member is excluded from the count
      // — an already-queued member must not make its own stack unaffordable.
      await withMergeQueueLimitGate(
        assertUser(req).id,
        { excludePrId: orderedIds, adding: members.length },
        applyAll
      );
    } else {
      await applyAll();
    }

    // Per-call work, once for the batch rather than once per member.
    for (const member of members) {
      if (enabled) await publishDraftForQueue(member);
      else emitDequeued(member);
    }
    await broadcastMergeQueuePositions(anchor.workspaceId);
    if (enabled) {
      runWithoutScope(() => {
        void mergeQueueProcessor.runOnce();
        // The evaluator coalesces these into one walk per group.
        for (const member of members) {
          void onQueueMembershipChanged(member.id, 'user:enqueue-stack');
        }
      });
    }

    res.json({
      success: true,
      data: {
        pullRequestIds: members.map((m) => m.id),
        // A resolved member whose row vanished between the two reads. Surfaced
        // rather than silently dropped: the client's own derivation may show a
        // different size, and it must not be the authority on what happened.
        skipped: orderedIds
          .filter((id) => !byId.has(id))
          .map((id) => ({ pullRequestId: id, reason: 'No longer tracked' })),
      },
    } as ApiResponse<{
      pullRequestIds: string[];
      skipped: Array<{ pullRequestId: string; reason: string }>;
    }>);
  });

  // Merge-queue timeline: the entry's audit log (transitions, remediations,
  // arms/disarms, merge attempts, with reasons), newest first. Covers the
  // ACTIVE entry when one exists, else the most recent terminal one — so a
  // just-merged PR's timeline is still inspectable. Explicit projections,
  // capped at 100 events (the `detail` column is small by construction).
  router.get('/:id/merge-queue/timeline', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select({ workspaceId: pullRequestsTable.workspaceId })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, rows[0].workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const entryRows = await db
      .select({
        id: mergeQueueEntriesTable.id,
        status: mergeQueueEntriesTable.status,
        enqueuedAt: mergeQueueEntriesTable.enqueuedAt,
      })
      .from(mergeQueueEntriesTable)
      .where(eq(mergeQueueEntriesTable.pullRequestId, req.params.id))
      .orderBy(desc(mergeQueueEntriesTable.enqueuedAt))
      .limit(5);
    const entry =
      entryRows.find((e) => e.status !== 'merged' && e.status !== 'removed') ?? entryRows[0];
    if (!entry) {
      return res.json({ success: true, data: { events: [] } });
    }
    const events = await db
      .select({
        at: mergeQueueEventsTable.at,
        fromStatus: mergeQueueEventsTable.fromStatus,
        toStatus: mergeQueueEventsTable.toStatus,
        trigger: mergeQueueEventsTable.trigger,
        code: mergeQueueEventsTable.code,
        message: mergeQueueEventsTable.message,
        detail: mergeQueueEventsTable.detail,
      })
      .from(mergeQueueEventsTable)
      .where(eq(mergeQueueEventsTable.entryId, entry.id))
      .orderBy(desc(mergeQueueEventsTable.at))
      .limit(100);
    res.json({
      success: true,
      data: {
        events: events.map((e) => ({
          at: e.at.toISOString(),
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          trigger: e.trigger,
          code: e.code,
          message: e.message,
          detail: e.detail ?? null,
        })),
      },
    });
  });

  // Focus signal. Body `{ focused: true }` (default) tightens this
  // PR's poll TTL to 30 s; `{ focused: false }` reverts to 60 s.
  // Idempotent — duplicate calls are no-ops.
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
    const focused = (req.body as { focused?: boolean } | undefined)?.focused !== false;
    if (focused) {
      setFocused(row.workspaceId, req.params.id);
    } else {
      clearFocused(row.workspaceId, req.params.id);
    }
    res.status(204).send();
  });

  // Active-view signal. Body `{ workspaceId, view }` records which list the
  // desktop is showing ('mine' | 'review' | 'all' | 'none') so the poller can
  // hard-poll the cohort you're looking at and slack-poll the other one.
  // In-memory + idempotent, same spirit as /focus.
  const ALLOWED_VIEWS: ActiveView[] = ['mine', 'review', 'all', 'none'];
  router.post('/view', async (req, res) => {
    const body = req.body as { workspaceId?: string; view?: string } | undefined;
    const workspaceId = body?.workspaceId;
    const view = body?.view;
    if (!workspaceId || !view || !ALLOWED_VIEWS.includes(view as ActiveView)) {
      return res
        .status(400)
        .json({ success: false, error: 'workspaceId and a valid view are required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    setActiveView(workspaceId, view as ActiveView);
    res.status(204).send();
  });

  // Merge a PR. The only write path in this router — the desktop gates
  // the button to mergeable PRs and shows a confirm first, but we
  // re-validate nothing here beyond ownership: GitHub itself rejects the
  // merge (405) if the PR isn't actually mergeable, and we surface that
  // as a 400. On success we force a refetch so the row flips to `merged`
  // immediately instead of waiting for the next poll tick.
  //
  // When the base branch is behind an external merge queue (trunk.io, GitHub's
  // native queue) the merge can't succeed for ANYONE but that system, so this
  // route SUBMITS to it instead and answers `{ merged: false, submitted: true }`
  // — which the desktop renders as "Submitted to the merge queue". The gate is
  // detected up front when known, and learned from the 405 otherwise, so the
  // first click on a newly-gated repo still ends in a submission rather than an
  // error toast.
  router.post('/:id/merge', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select({
        id: pullRequestsTable.id,
        workspaceId: pullRequestsTable.workspaceId,
        owner: pullRequestsTable.owner,
        repo: pullRequestsTable.repo,
        number: pullRequestsTable.number,
        lastSummary: pullRequestsTable.lastSummary,
      })
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

    const method = (req.body as { method?: string } | undefined)?.method;
    const mergeMethod =
      method === 'squash' || method === 'rebase' || method === 'merge'
        ? method
        : 'squash';
    const summary = (row.lastSummary ?? {}) as {
      nodeId?: string;
      headSha?: string;
      baseBranch?: string;
      autoMergeBy?: string | null;
    };
    const baseBranch = summary.baseBranch ?? '';

    // Hand the PR to the external queue and answer with what happened. Returns
    // false (never throws) when it couldn't answer, so the caller falls through
    // to the ordinary merge / error path.
    //
    // `allowAutoMerge` is the confidence dial. On a merely SUSPECTED gate we
    // only submit through a door the provider itself put on the PR (its
    // instruction comment) or on the repo (a submit label) — arming auto-merge
    // there would turn a merge Talyn could actually do into an open-ended wait.
    // Once the gate is CONFIRMED (or GitHub has just refused the merge), every
    // door is fair game.
    const submitInstead = async (opts: {
      allowAutoMerge: boolean;
      /** Answer with the block reason when no door exists, instead of falling through. */
      reportNoMechanism: boolean;
    }): Promise<'submitted' | 'reported' | 'none'> => {
      let attempt: Awaited<ReturnType<typeof submitToExternalQueue>>;
      try {
        attempt = await submitToExternalQueue({
          workspaceId: row.workspaceId,
          owner: row.owner,
          repo: row.repo,
          number: row.number,
          nodeId: summary.nodeId ?? null,
          headSha: summary.headSha ?? '',
          mergeMethod,
          autoMergeArmedBy: classifyAutoMergeActor(summary.autoMergeBy),
          labelFallback: true,
          allowAutoMerge: opts.allowAutoMerge,
        });
      } catch (err) {
        console.warn(
          `[pullRequests] external-queue submit failed for ${row.owner}/${row.repo}#${row.number}:`,
          err instanceof Error ? err.message : err
        );
        return 'none';
      }
      if (attempt.kind === 'submitted') {
        res.json({
          success: true,
          data: {
            merged: false,
            submitted: true,
            via: attempt.via,
            message:
              attempt.via === 'comment'
                ? `Submitted to the merge queue (posted \`${attempt.command}\`) — it merges the PR when its tests pass.`
                : attempt.via === 'label'
                  ? `Submitted to the merge queue (applied "${attempt.label}") — it merges the PR when its tests pass.`
                  : 'Submitted to the merge queue (auto-merge armed) — it merges the PR when its tests pass.',
          },
        });
        return 'submitted';
      }
      if (attempt.kind === 'no_mechanism' && opts.reportNoMechanism) {
        res.status(400).json({ success: false, error: attempt.message });
        return 'reported';
      }
      return 'none'; // no door / clean_status / retry → fall through
    };

    const gate = await getExternalMergeGate(row.workspaceId, row.owner, row.repo, baseBranch);
    if (gate !== null) {
      const confirmed = gate === 'confirmed';
      const outcome = await submitInstead({
        allowAutoMerge: confirmed,
        reportNoMechanism: confirmed,
      });
      if (outcome !== 'none') return;
    }

    try {
      const result = await githubService.mergePullRequest(
        row.workspaceId,
        row.owner,
        row.repo,
        row.number,
        { merge_method: mergeMethod }
      );
      // GitHub can return 200 with `merged: false` (it accepted the request
      // but didn't merge). Don't flip the row to merged or report success in
      // that case — surface its message so the UI can explain why.
      if (!result.merged) {
        return res.status(400).json({
          success: false,
          error: result.message || 'GitHub did not merge the pull request',
        });
      }
      // Mark the row merged directly. We can't rely on a GraphQL refetch
      // here — `batchPullRequests` filters to `states: [OPEN]`, so a
      // just-merged PR comes back empty and the row would stay stuck on
      // its last open state ("Ready"). The merge succeeded, so set it.
      await db
        .update(pullRequestsTable)
        .set({ state: 'merged', mergedAt: new Date(), updatedAt: new Date() })
        .where(eq(pullRequestsTable.id, row.id));
      res.json({ success: true, data: result } as ApiResponse<typeof result>);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Merge failed';
      // The branch is behind an external merge queue we hadn't recorded yet.
      // GitHub says so in one of two ways, and BOTH have been seen on
      // posthog/posthog: a 405 "Cannot update this protected ref", or — the
      // actual response there — a 403 refusing every App token, because the
      // ruleset exempts only trunk's App. On a suspected gate the 403 is
      // decisive; without one it stays what it always was (a failing check the
      // App won't merge past). Either way: learn the gate, then submit.
      const refused =
        isExternalMergeGateError(message) || err instanceof MergeNotPermittedForAppError;
      if (refused) {
        // Doors 1 and 2 need explicit provider evidence (its instruction comment
        // on THIS PR, or a submit label the repo defines), so trying them is
        // safe even when the branch-rules probe saw nothing — which is the case
        // whenever the App can't read the repo's rulesets. Only a refusal we can
        // positively attribute to a gate opens the auto-merge door as well.
        const attributable = isExternalMergeGateError(message) || gate !== null;
        const outcome = await submitInstead({
          allowAutoMerge: attributable,
          reportNoMechanism: attributable,
        });
        if (outcome === 'submitted') {
          // Only now is the gate proven: something else owns merging this branch.
          markExternalMergeGate(row.workspaceId, row.owner, row.repo, baseBranch);
          return;
        }
        if (outcome === 'reported') return;
      }
      res.status(400).json({ success: false, error: message });
    }
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
  reviewRequested: boolean;
  authored: boolean;
  mergedAt: Date | null;
  lastPolledAt: Date;
  lastSummary: unknown;
  autoKeepMergeable: boolean;
  autoMergeState: unknown;
  mergeQueued: boolean;
  mergeQueuedAt: Date | null;
  mergeMethod: string;
  mergeQueueState: unknown;
  lastReviewId: string | null;
  lastReviewCommentId: string | null;
  lastCommentId: string | null;
  lastCheckDigest: string | null;
  lastSummaryDigest: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Reconcile a PR's lifecycle state against GitHub via REST. The GraphQL
 * batch query only returns OPEN PRs, so once a PR is merged/closed our
 * normal fetch paths can't tell merged from closed — and a row that was
 * mis-classified (e.g. a transient sweep failure marking a merged PR
 * "closed") never gets re-checked. This hits the authoritative per-PR
 * REST endpoint and corrects state + mergedAt. Returns the updated row,
 * or null if nothing changed / the lookup failed.
 */
async function reconcileTerminalState(
  row: PullRequestRow
): Promise<PullRequestRow | null> {
  let pr: Awaited<ReturnType<typeof githubService.getPullRequest>>;
  try {
    pr = await githubService.getPullRequest(row.workspaceId, row.owner, row.repo, row.number);
  } catch (err) {
    console.warn(`[pull-requests] terminal reconcile failed for ${row.id}:`, err);
    return null;
  }
  let nextState: 'open' | 'closed' | 'merged';
  let mergedAt: Date | null = null;
  if (pr.merged_at || pr.merged) {
    nextState = 'merged';
    mergedAt = pr.merged_at ? new Date(pr.merged_at) : new Date();
  } else if (pr.state === 'closed') {
    nextState = 'closed';
  } else {
    nextState = 'open';
  }
  if (nextState === row.state) return null;

  const db = getDbClient();
  // A PR that left 'open' can't be merged by the queue — drop it off so it
  // never blocks its (repo, base) group.
  const queueReset = nextState !== 'open' && row.mergeQueued ? QUEUE_RESET_COLUMNS : {};
  await db
    .update(pullRequestsTable)
    .set({ state: nextState, mergedAt, updatedAt: new Date(), ...queueReset })
    .where(eq(pullRequestsTable.id, row.id));
  const fresh = await db
    .select()
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, row.id))
    .limit(1);
  return (fresh[0] as PullRequestRow | undefined) ?? null;
}

/** The compact watcher state the desktop renders (toggle + badge). */
function publicAutoMergeState(
  raw: unknown
): { attempts: number; paused: boolean } | null {
  const s = raw as { attempts?: number; pausedAt?: string } | null;
  if (!s) return null;
  return { attempts: s.attempts ?? 0, paused: !!s.pausedAt };
}

/** The compact merge-queue state the desktop renders (toggle + badge). */
function publicMergeQueueState(
  raw: unknown,
  position: number
): {
  status: 'waiting' | 'fixing' | 'merging' | 'blocked';
  attempts: number;
  position: number;
  reason?: string;
} | null {
  const s = raw as
    | {
        status?: 'waiting' | 'fixing' | 'merging' | 'blocked';
        attempts?: number;
        blockReason?: string;
      }
    | null;
  if (!s) return null;
  const status = s.status ?? 'waiting';
  return {
    status,
    attempts: s.attempts ?? 0,
    position,
    // Surface the blocked reason so a PR loaded fresh (not via a live echo)
    // still explains itself in the badge tooltip.
    ...(status === 'blocked' && s.blockReason ? { reason: s.blockReason } : {}),
  };
}

/**
 * Whether a freshly-fetched summary differs from the cached row in a way worth
 * persisting on a detail open. Covers the fields the UI's status pill + header
 * read off the cache: base branch (changes when a PR is retargeted, flipping
 * required-ness), the merge-readiness verdict, GitHub's merge state/mergeability,
 * and the check rollup (via its digest). Everything else (titles, timestamps)
 * rides the next background poll. Keeping this tight avoids a write + broadcast
 * on every open when nothing material moved.
 */
export function freshDiffersMaterially(
  row: Pick<PullRequestRow, 'lastSummary' | 'lastCheckDigest' | 'state'>,
  fresh: PRSummary
): boolean {
  const cached = (row.lastSummary as Partial<PRSummary> | null) ?? {};
  return (
    cached.baseBranch !== fresh.baseBranch ||
    cached.blockingReason !== fresh.blockingReason ||
    cached.mergeable !== fresh.mergeable ||
    cached.mergeStateStatus !== fresh.mergeStateStatus ||
    (row.lastCheckDigest ?? '') !== fresh.checkDigest ||
    row.state !== fresh.state
  );
}

/**
 * The subset of columns {@link rowToPublicShape} actually serializes. Both the
 * full {@link PullRequestRow} (detail paths) and the projected `LIST_COLUMNS`
 * row satisfy it, so the list endpoint can hand over projected rows directly.
 */
type PublicShapeRow = Pick<
  PullRequestRow,
  | 'id'
  | 'workspaceId'
  | 'repositoryId'
  | 'taskId'
  | 'owner'
  | 'repo'
  | 'number'
  | 'state'
  | 'reviewRequested'
  | 'authored'
  | 'mergedAt'
  | 'lastPolledAt'
  | 'lastSummary'
  | 'autoKeepMergeable'
  | 'autoMergeState'
  | 'mergeQueued'
  | 'mergeQueuedAt'
  | 'mergeMethod'
  | 'mergeQueueState'
  | 'createdAt'
  | 'updatedAt'
>;

/**
 * The merge-queue v2 payload for ONE pull request, in the shape the list
 * endpoint decorates every row with (`mergeQueue`), plus its 1-based position
 * in its (repo, base) group.
 *
 * Every response that carries a whole PR row has to include this. The desktop
 * sheet paints the seeded list row instantly and then REPLACES it with the
 * detail response, so a response that omits `mergeQueue` reads as "never
 * queued" — the status line falls back to the v1 blob, the budgets vanish, and
 * the Requeue button on a blocked entry disappears the moment the detail lands.
 *
 * Degrades like the list decoration: a failure logs and returns null rather
 * than failing the read.
 */
async function mergeQueueForPr(
  prId: string,
  db: ReturnType<typeof getDbClient>
): Promise<{ payload: Record<string, unknown> | null; position: number }> {
  try {
    const entry = await getActiveEntryForPr(prId, db);
    if (!entry) return { payload: null, position: 0 };
    const group = await loadActiveGroup(entry.repositoryId, entry.baseBranch, db);
    const position = computeEntryPositions(group).get(entry.id) ?? 0;
    return { payload: toPublicMergeQueue(rowToEntrySnapshot(entry), position), position };
  } catch (err) {
    console.warn(
      '[pullRequests] merge-queue v2 detail decoration failed:',
      err instanceof Error ? err.message : err
    );
    return { payload: null, position: 0 };
  }
}

function rowToPublicShape(row: PublicShapeRow, queuePosition = 0) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    repositoryId: row.repositoryId,
    taskId: row.taskId,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    state: row.state,
    reviewRequested: row.reviewRequested,
    authored: row.authored,
    mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
    lastPolledAt: row.lastPolledAt.toISOString(),
    summary: row.lastSummary,
    autoKeepMergeable: row.autoKeepMergeable,
    autoMergeState: publicAutoMergeState(row.autoMergeState),
    mergeQueued: row.mergeQueued,
    mergeMethod: row.mergeMethod,
    mergeQueueState: publicMergeQueueState(row.mergeQueueState, queuePosition),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

