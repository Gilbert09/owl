import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { getDbClient, type Database } from '../db/client.js';
import {
  pullRequests as pullRequestsTable,
  inboxItems as inboxItemsTable,
} from '../db/schema.js';
import { broadcastToWorkspace, emitPullRequestUpdated } from './websocket.js';
import {
  batchPullRequests,
  type CheckBreakdown,
  type PRSummary,
  type PRState,
} from './githubGraphql.js';

/**
 * DB-as-cache layer for pull-request state.
 *
 * Replaces the in-memory state map the old prMonitor kept across ticks
 * — that map was lost on every backend restart, which is how unread
 * reviews/comments would silently re-fire (or, worse, never fire at
 * all if the boot-time baseline already absorbed them).
 *
 * Two responsibilities:
 *   1. Cache: TTL-based "fresh row → use it / stale → fetch + upsert".
 *   2. Cursors: diff the previous row's cursor columns against the
 *      freshly-fetched summary, emit inbox items for any new
 *      review / review-comment / issue-comment / CI-failure /
 *      ready-to-merge events, then persist the new cursors so the
 *      next poll knows where to pick up.
 *
 * Pure delta-detection logic lives in `computePRDeltas` so it can be
 * unit-tested without touching DB or network.
 */

// ---------- Public types ----------

export interface CursorState {
  lastReviewId: string | null;
  lastReviewCommentId: string | null;
  lastCommentId: string | null;
  lastCheckDigest: string | null;
}

export interface PRDelta {
  /** Reviews submitted since the last cursor, freshest first. */
  newReviews: PRSummary['recentReviews'];
  /** Inline review-thread comments since the last cursor. */
  newReviewComments: PRSummary['recentReviewComments'];
  /** Top-level issue comments since the last cursor. */
  newComments: PRSummary['recentComments'];
  /** Did the rollup transition INTO failure since the last poll? */
  ciJustFailed: boolean;
  /** Did the PR transition INTO ready-to-merge since the last poll? */
  becameMergeReady: boolean;
}

export interface UpsertResult {
  /** The freshly-fetched (or cached) summary. */
  summary: PRSummary;
  /** Delta computed against the previous row's cursors — empty arrays
   *  when this is the first time we've seen the PR (no cursor diff to
   *  do). */
  delta: PRDelta;
  /** True iff this run hit the GraphQL endpoint vs returning cached. */
  cacheMiss: boolean;
  /** The pull_requests.id of the persisted row. */
  rowId: string;
}

// ---------- Defaults ----------

/** TTL for unfocused PRs — the safety-net poll cadence. Phase 6 will
 *  override per-PR via the focus signal (30 s for the focused PR). */
export const DEFAULT_TTL_MS = 60_000;

// ---------- Public API ----------

/**
 * Fetch a PR's summary, returning cache when fresh and refreshing
 * via GraphQL when stale.
 *
 * `taskId` is set on first insert when the PR was opened by a FastOwl
 * task; subsequent calls leave it alone (you can't change the task
 * a PR belongs to). `ttlMs` defaults to `DEFAULT_TTL_MS` and is
 * overridden by the focus signaller in Phase 6.
 */
export async function getOrFetchPRSummary(opts: {
  workspaceId: string;
  repositoryId: string;
  taskId?: string | null;
  owner: string;
  repo: string;
  number: number;
  ttlMs?: number;
}): Promise<UpsertResult | null> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const db = getDbClient();
  const existing = await readRow(db, opts.workspaceId, opts.repositoryId, opts.number);
  if (existing && isFresh(existing.lastPolledAt, ttl)) {
    return {
      summary: rowToSummary(existing, opts.owner, opts.repo),
      delta: emptyDelta(),
      cacheMiss: false,
      rowId: existing.id,
    };
  }
  return forceFetchAndUpsert(opts);
}

/**
 * Force-fetch a single PR and upsert it. Used by the focused-poll
 * path and the `/refresh` endpoint. Always hits GraphQL.
 */
export async function forceFetchAndUpsert(opts: {
  workspaceId: string;
  repositoryId: string;
  taskId?: string | null;
  owner: string;
  repo: string;
  number: number;
}): Promise<UpsertResult | null> {
  const db = getDbClient();
  const existing = await readRow(db, opts.workspaceId, opts.repositoryId, opts.number);
  // We don't know the head branch up-front, so use the cached
  // headBranch when we have it; otherwise fall back to a numbered
  // ref-style fetch (a single-PR variant of batchPullRequests).
  const head = existing
    ? (existing.lastSummary as { headBranch?: string } | null)?.headBranch
    : undefined;
  const branches = head ? [head] : [];
  if (!head) {
    // First time we're seeing this PR; no head branch in cache. The
    // monitor should have populated the row first via the per-repo
    // listing path. Bail out rather than firing a useless empty
    // batch query.
    return null;
  }
  const results = await batchPullRequests({
    workspaceId: opts.workspaceId,
    owner: opts.owner,
    repo: opts.repo,
    branches,
  });
  const summary = results[0]?.pr ?? null;
  if (!summary) return null;
  const previous: CursorState | null = existing
    ? {
        lastReviewId: existing.lastReviewId,
        lastReviewCommentId: existing.lastReviewCommentId,
        lastCommentId: existing.lastCommentId,
        lastCheckDigest: existing.lastCheckDigest,
      }
    : null;
  const delta = computePRDeltas(previous, summary);
  const rowId = await upsertRow(db, {
    workspaceId: opts.workspaceId,
    repositoryId: opts.repositoryId,
    taskId: opts.taskId ?? null,
    summary,
    existingId: existing?.id,
  });
  await emitDeltaInboxItems(opts.workspaceId, summary, delta);
  return { summary, delta, cacheMiss: true, rowId };
}

/**
 * Upsert a PR row from a freshly-fetched summary AND emit any inbox
 * items the cursor diff produces. This is the path the bulk-poll
 * loop uses — `batchPullRequests` already returned a summary, no
 * point fetching it again.
 */
export async function upsertFromBatchResult(opts: {
  workspaceId: string;
  repositoryId: string;
  taskId?: string | null;
  summary: PRSummary;
}): Promise<UpsertResult> {
  const db = getDbClient();
  const existing = await readRow(
    db,
    opts.workspaceId,
    opts.repositoryId,
    opts.summary.number
  );
  const previous: CursorState | null = existing
    ? {
        lastReviewId: existing.lastReviewId,
        lastReviewCommentId: existing.lastReviewCommentId,
        lastCommentId: existing.lastCommentId,
        lastCheckDigest: existing.lastCheckDigest,
      }
    : null;
  const delta = computePRDeltas(previous, opts.summary);
  const rowId = await upsertRow(db, {
    workspaceId: opts.workspaceId,
    repositoryId: opts.repositoryId,
    taskId: opts.taskId ?? null,
    summary: opts.summary,
    existingId: existing?.id,
  });
  await emitDeltaInboxItems(opts.workspaceId, opts.summary, delta);
  return { summary: opts.summary, delta, cacheMiss: true, rowId };
}

// ---------- Pure delta logic ----------

/**
 * Compare a fresh `summary` against the previous cursor state. Returns
 * a per-event-type delta the caller turns into inbox items.
 *
 * Edge cases:
 *   - `previous == null` (first time we've seen the PR): no deltas
 *     emitted; the cursors are just baselined. The user already
 *     knows about historical reviews/comments — emitting them on
 *     first sight would be noise.
 *   - The recent* arrays are bounded at 5 by the GraphQL query, so
 *     we may miss events when more than 5 fire between polls. That's
 *     acceptable for the user-facing inbox; the cursor still moves
 *     forward to whichever id is freshest.
 */
export function computePRDeltas(
  previous: CursorState | null,
  summary: PRSummary
): PRDelta {
  if (!previous) {
    return emptyDelta();
  }
  return {
    newReviews: takeUntilCursor(summary.recentReviews, previous.lastReviewId),
    newReviewComments: takeUntilCursor(
      summary.recentReviewComments,
      previous.lastReviewCommentId
    ),
    newComments: takeUntilCursor(summary.recentComments, previous.lastCommentId),
    ciJustFailed: detectCiJustFailed(previous, summary),
    becameMergeReady: detectBecameMergeReady(previous, summary),
  };
}

/**
 * Walk the freshest-first array stopping at `cursorId`. Returns the
 * prefix of items that landed since we last polled.
 */
function takeUntilCursor<T extends { id: string }>(
  recent: T[],
  cursorId: string | null
): T[] {
  if (!cursorId) return [];
  const out: T[] = [];
  for (const item of recent) {
    if (item.id === cursorId) break;
    out.push(item);
  }
  return out;
}

/**
 * Returns true iff:
 *   - the previous digest was non-failure (or null) AND
 *   - the new digest matches a failure rollup (`checks.failed > 0`).
 *
 * We also require digest CHANGE so a PR that's been failing for hours
 * doesn't re-emit on every poll.
 */
function detectCiJustFailed(previous: CursorState, summary: PRSummary): boolean {
  if (summary.checks.failed === 0) return false;
  if (previous.lastCheckDigest === summary.checkDigest) return false;
  if (!previous.lastCheckDigest) {
    // First time we're seeing checks for this PR; emit only if it's
    // failing right now. (If we'd been polling a passing PR before,
    // the cursor would be set and this branch wouldn't run.)
    return true;
  }
  // Was the previous digest a failure-state digest? We don't store the
  // breakdown, but we can read it off the digest's structure: the
  // digest is `headSha:name=state|name=state|...`. Quick scan for
  // `=failure` token. Cheap, no parsing.
  const wasAlreadyFailing = previous.lastCheckDigest.includes('=failure');
  return !wasAlreadyFailing;
}

function detectBecameMergeReady(previous: CursorState, summary: PRSummary): boolean {
  if (summary.blockingReason !== 'mergeable') return false;
  // We don't persist the previous blocking_reason, but we can infer
  // "transitioned into mergeable" by digest change + the current
  // verdict. If the digest was identical AND we already emitted, we'd
  // skip — but on a fresh transition the digest will have moved
  // (a check transitioned, or head_sha changed) so the digest test
  // suffices.
  return previous.lastCheckDigest !== summary.checkDigest;
}

function emptyDelta(): PRDelta {
  return {
    newReviews: [],
    newReviewComments: [],
    newComments: [],
    ciJustFailed: false,
    becameMergeReady: false,
  };
}

// ---------- Persistence ----------

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
}

async function readRow(
  db: Database,
  workspaceId: string,
  repositoryId: string,
  number: number
): Promise<PullRequestRow | null> {
  const rows = await db
    .select()
    .from(pullRequestsTable)
    .where(
      and(
        eq(pullRequestsTable.workspaceId, workspaceId),
        eq(pullRequestsTable.repositoryId, repositoryId),
        eq(pullRequestsTable.number, number)
      )
    )
    .limit(1);
  return (rows[0] as PullRequestRow | undefined) ?? null;
}

function isFresh(lastPolledAt: Date, ttlMs: number): boolean {
  return Date.now() - lastPolledAt.getTime() < ttlMs;
}

async function upsertRow(
  db: Database,
  opts: {
    workspaceId: string;
    repositoryId: string;
    taskId: string | null;
    summary: PRSummary;
    existingId?: string;
  }
): Promise<string> {
  const now = new Date();
  const id = opts.existingId ?? uuid();
  const lastSummary = summaryToJsonb(opts.summary);
  const cursors = nextCursors(opts.summary);
  if (opts.existingId) {
    // Update path — leave taskId alone (set on first insert only).
    await db
      .update(pullRequestsTable)
      .set({
        owner: opts.summary.owner,
        repo: opts.summary.repo,
        state: opts.summary.state,
        mergedAt: opts.summary.mergedAt ? new Date(opts.summary.mergedAt) : null,
        lastPolledAt: now,
        lastSummary,
        lastReviewId: cursors.lastReviewId,
        lastReviewCommentId: cursors.lastReviewCommentId,
        lastCommentId: cursors.lastCommentId,
        lastCheckDigest: cursors.lastCheckDigest,
        updatedAt: now,
      })
      .where(eq(pullRequestsTable.id, opts.existingId));
  } else {
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: opts.workspaceId,
      repositoryId: opts.repositoryId,
      taskId: opts.taskId,
      owner: opts.summary.owner,
      repo: opts.summary.repo,
      number: opts.summary.number,
      state: opts.summary.state,
      mergedAt: opts.summary.mergedAt ? new Date(opts.summary.mergedAt) : null,
      lastPolledAt: now,
      lastSummary,
      lastReviewId: cursors.lastReviewId,
      lastReviewCommentId: cursors.lastReviewCommentId,
      lastCommentId: cursors.lastCommentId,
      lastCheckDigest: cursors.lastCheckDigest,
      createdAt: now,
      updatedAt: now,
    });
  }
  // Read back the taskId — set on first insert and never modified after.
  const taskId = await readRowTaskId(db, id);
  emitPullRequestUpdated(opts.workspaceId, {
    id,
    taskId,
    repositoryId: opts.repositoryId,
    owner: opts.summary.owner,
    repo: opts.summary.repo,
    number: opts.summary.number,
    state: opts.summary.state,
    lastSummary,
  });
  return id;
}

async function readRowTaskId(db: Database, id: string): Promise<string | null> {
  const rows = await db
    .select({ taskId: pullRequestsTable.taskId })
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, id))
    .limit(1);
  return rows[0]?.taskId ?? null;
}

function nextCursors(summary: PRSummary): CursorState {
  return {
    lastReviewId: summary.recentReviews[0]?.id ?? null,
    lastReviewCommentId: summary.recentReviewComments[0]?.id ?? null,
    lastCommentId: summary.recentComments[0]?.id ?? null,
    lastCheckDigest: summary.checkDigest,
  };
}

/**
 * The minimal jsonb the GitHub-page table + task pill render off.
 * Stored once, mutated on every poll. Don't include the recent*
 * arrays — those are throwaway delta-detection inputs and bloating
 * the row buys nothing.
 */
function summaryToJsonb(s: PRSummary): Record<string, unknown> {
  return {
    title: s.title,
    author: s.author,
    draft: s.draft,
    headBranch: s.headBranch,
    baseBranch: s.baseBranch,
    headSha: s.headSha,
    updatedAt: s.updatedAt,
    url: s.url,
    mergeable: s.mergeable,
    mergeStateStatus: s.mergeStateStatus,
    reviewDecision: s.reviewDecision,
    blockingReason: s.blockingReason,
    checks: s.checks,
  };
}

function rowToSummary(row: PullRequestRow, owner: string, repo: string): PRSummary {
  const meta = (row.lastSummary as Partial<PRSummary> | null) ?? {};
  return {
    owner,
    repo,
    number: row.number,
    title: (meta.title as string) ?? '',
    body: '', // not cached; detail panel fetches on open
    url: (meta.url as string) ?? '',
    author: (meta.author as string) ?? '',
    draft: Boolean(meta.draft),
    state: row.state as PRState,
    mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
    closedAt: null,
    headBranch: (meta.headBranch as string) ?? '',
    baseBranch: (meta.baseBranch as string) ?? '',
    headSha: (meta.headSha as string) ?? '',
    updatedAt: (meta.updatedAt as string) ?? '',
    mergeable: (meta.mergeable as PRSummary['mergeable']) ?? 'UNKNOWN',
    mergeStateStatus: (meta.mergeStateStatus as string) ?? 'UNKNOWN',
    reviewDecision: (meta.reviewDecision as PRSummary['reviewDecision']) ?? null,
    blockingReason: (meta.blockingReason as PRSummary['blockingReason']) ?? 'unknown',
    checks: (meta.checks as CheckBreakdown) ?? {
      total: 0,
      passed: 0,
      failed: 0,
      inProgress: 0,
      skipped: 0,
    },
    checkDigest: row.lastCheckDigest ?? '',
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
  };
}

// ---------- Inbox event emission ----------

async function emitDeltaInboxItems(
  workspaceId: string,
  summary: PRSummary,
  delta: PRDelta
): Promise<void> {
  for (const review of delta.newReviews) {
    if (review.state === 'PENDING') continue;
    await createInboxItem(workspaceId, summary, {
      type: 'pr_review',
      priority: review.state === 'CHANGES_REQUESTED' ? 'high' : 'medium',
      title: `${reviewTitleVerb(review.state)}: ${summary.title}`,
      summaryText: `@${review.author} ${review.state.toLowerCase().replace('_', ' ')} on ${summary.owner}/${summary.repo}#${summary.number}`,
      actions: [
        { label: 'View Review', action: 'open_url', data: review.url },
        { label: 'View PR', action: 'open_url', data: summary.url },
      ],
      data: {
        reviewId: review.id,
        reviewState: review.state,
        reviewer: review.author,
      },
    });
  }
  for (const comment of delta.newReviewComments) {
    await createInboxItem(workspaceId, summary, {
      type: 'pr_comment',
      priority: 'medium',
      title: `New review comment on ${summary.title}`,
      summaryText: `@${comment.author} commented on ${summary.owner}/${summary.repo}#${summary.number}`,
      actions: [
        { label: 'View Comment', action: 'open_url', data: comment.url },
        { label: 'View PR', action: 'open_url', data: summary.url },
      ],
      data: {
        commentId: comment.id,
        commenter: comment.author,
        kind: 'review_comment',
      },
    });
  }
  for (const comment of delta.newComments) {
    await createInboxItem(workspaceId, summary, {
      type: 'pr_comment',
      priority: 'low',
      title: `New comment on ${summary.title}`,
      summaryText: `@${comment.author} commented on ${summary.owner}/${summary.repo}#${summary.number}`,
      actions: [
        { label: 'View Comment', action: 'open_url', data: comment.url },
        { label: 'View PR', action: 'open_url', data: summary.url },
      ],
      data: {
        commentId: comment.id,
        commenter: comment.author,
        kind: 'issue_comment',
      },
    });
  }
  if (delta.ciJustFailed) {
    await createInboxItem(workspaceId, summary, {
      type: 'ci_failure',
      priority: 'high',
      title: `CI failed: ${summary.title}`,
      summaryText: `${summary.checks.failed}/${summary.checks.total} checks failed on ${summary.owner}/${summary.repo}#${summary.number}`,
      actions: [
        { label: 'View Checks', action: 'open_url', data: `${summary.url}/checks` },
        { label: 'View PR', action: 'open_url', data: summary.url },
      ],
      data: {
        checks: summary.checks,
      },
    });
  }
  if (delta.becameMergeReady) {
    await createInboxItem(workspaceId, summary, {
      type: 'pr_ready',
      priority: 'medium',
      title: `Ready to merge: ${summary.title}`,
      summaryText: `${summary.owner}/${summary.repo}#${summary.number} has all checks passing and is ready to merge`,
      actions: [{ label: 'View PR', action: 'open_url', data: summary.url }],
      data: {},
    });
  }
}

function reviewTitleVerb(state: string): string {
  switch (state) {
    case 'APPROVED':
      return 'Approved';
    case 'CHANGES_REQUESTED':
      return 'Changes requested';
    case 'COMMENTED':
      return 'Review comment';
    default:
      return 'Review';
  }
}

async function createInboxItem(
  workspaceId: string,
  summary: PRSummary,
  spec: {
    type: 'pr_review' | 'pr_comment' | 'ci_failure' | 'pr_ready';
    priority: 'high' | 'medium' | 'low';
    title: string;
    summaryText: string;
    actions: Array<{ label: string; action: string; data: string }>;
    data: Record<string, unknown>;
  }
): Promise<void> {
  const db = getDbClient();
  const id = uuid();
  const now = new Date();
  const source = {
    type: 'github',
    id: summary.url,
    name: `${summary.owner}/${summary.repo}#${summary.number}`,
  };
  const data = {
    repo: `${summary.owner}/${summary.repo}`,
    prNumber: summary.number,
    prTitle: summary.title,
    prUrl: summary.url,
    ...spec.data,
  };
  await db.insert(inboxItemsTable).values({
    id,
    workspaceId,
    type: spec.type,
    status: 'unread',
    priority: spec.priority,
    title: spec.title,
    summary: spec.summaryText,
    source,
    actions: spec.actions,
    data,
    createdAt: now,
  });
  broadcastToWorkspace(workspaceId, {
    type: 'inbox:new',
    payload: {
      item: {
        id,
        workspaceId,
        type: spec.type,
        status: 'unread',
        priority: spec.priority,
        title: spec.title,
        summary: spec.summaryText,
        source,
        actions: spec.actions,
        data,
        createdAt: now.toISOString(),
      },
    },
    timestamp: now.toISOString(),
  });
}
