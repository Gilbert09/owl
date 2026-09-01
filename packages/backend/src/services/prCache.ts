import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import { getDbClient, type Database } from '../db/client.js';
import {
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../db/schema.js';
import { readWorkspaceSettings } from './workspaceSettings.js';
import { emitPullRequestUpdated } from './websocket.js';
import { domainEvents } from './events.js';
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
 *      freshly-fetched summary to detect new review / review-comment /
 *      issue-comment / CI-failure / ready-to-merge events, then persist
 *      the new cursors so the next poll knows where to pick up.
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
 * Insert a minimal pull_requests row for a freshly-opened task PR
 * before the next poll has a chance to upsert it. Sets task_id so
 * the task screen pill can render off the row, and so prMonitor
 * (which preserves existing task_id) doesn't strip the linkage on
 * its first refresh.
 *
 * Race-safe against a concurrent monitor tick that beats us to the
 * insert: if (workspace, repo, number) already exists we UPDATE
 * task_id on that row instead of inserting. Returns the row id.
 *
 * Summary fields are placeholders ('UNKNOWN' / zeroed checks) — the
 * first prMonitor refresh fills in real data within seconds.
 */
/** Parse `owner`/`repo` from a stored repository URL (https or git@ form). */
function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

export async function linkTaskToPullRequest(opts: {
  workspaceId: string;
  repositoryId: string;
  taskId: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
}): Promise<string> {
  const db = getDbClient();

  // A pull_requests row's repositoryId and its (owner, repo) must describe the
  // SAME repo. A cloud run reports a /pull/N URL for the *base* repo it opened
  // the PR against; if that doesn't match the task's repository (the agent
  // opened the PR on a fork or a sibling repo, or returned an unexpected URL),
  // linking it under task.repositoryId files a foreign — usually low — number
  // against this repo. The poller keys tracked numbers off repositoryId and
  // re-queries them against this repo's owner/name, so the mismatch resurfaces
  // as "Could not resolve to a PullRequest with the number of N". Refuse it.
  const repoRow = (
    await db
      .select({ url: repositoriesTable.url })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, opts.repositoryId))
      .limit(1)
  )[0];
  const repoCoords = repoRow ? parseOwnerRepo(repoRow.url) : null;
  if (
    repoCoords &&
    (repoCoords.owner.toLowerCase() !== opts.owner.toLowerCase() ||
      repoCoords.repo.toLowerCase() !== opts.repo.toLowerCase())
  ) {
    throw new Error(
      `PR ${opts.owner}/${opts.repo}#${opts.number} does not belong to ` +
        `${repoCoords.owner}/${repoCoords.repo} (repositoryId ${opts.repositoryId}) — ` +
        `refusing to link a cross-repo PR.`
    );
  }

  const now = new Date();
  const placeholderSummary = {
    title: opts.title,
    author: opts.author,
    draft: false,
    headBranch: opts.headBranch,
    baseBranch: opts.baseBranch,
    headSha: opts.headSha,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    url: opts.url,
    mergeable: 'UNKNOWN' as const,
    mergeStateStatus: 'UNKNOWN',
    reviewDecision: null,
    effectiveReviewDecision: null,
    blockingReason: 'unknown' as const,
    checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0,
  };
  const existing = await readRow(db, opts.workspaceId, opts.repositoryId, opts.number);
  if (existing) {
    // Beat to the insert by the monitor — patch task_id in place,
    // leaving the cached summary alone (it's freshest from GraphQL
    // anyway).
    if (!existing.taskId) {
      await db
        .update(pullRequestsTable)
        .set({ taskId: opts.taskId, updatedAt: now })
        .where(eq(pullRequestsTable.id, existing.id));
    }
    // Unconditional, unlike the forward pointer above: this task DID open this
    // PR, whether or not the row already names an earlier one.
    await db
      .update(tasksTable)
      .set({ pullRequestId: existing.id, updatedAt: now })
      .where(eq(tasksTable.id, opts.taskId));
    return existing.id;
  }
  const id = uuid();
  await db.insert(pullRequestsTable).values({
    id,
    workspaceId: opts.workspaceId,
    repositoryId: opts.repositoryId,
    taskId: opts.taskId,
    owner: opts.owner,
    repo: opts.repo,
    number: opts.number,
    state: 'open',
    lastPolledAt: now,
    lastSummary: placeholderSummary,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(tasksTable)
    .set({ pullRequestId: id, updatedAt: now })
    .where(eq(tasksTable.id, opts.taskId));
  return id;
}

/**
 * Point an existing pull_requests row at a task. Used when a task is
 * started *from* a PR row (e.g. "Get PR mergeable") — the reverse of
 * linkTaskToPullRequest, where the task opens a brand-new PR.
 *
 * Unlike linkTaskToPullRequest this OVERWRITES any prior task_id: the
 * row should track whatever task is currently working it, so the
 * GitHub screen's live indicator deep-links to the active run.
 *
 * Best-effort and workspace-scoped: an unknown row id, or one in a
 * different workspace than `workspaceId`, is a no-op (returns false).
 * Emits `pull_request:updated` so the GitHub page patches the row's
 * taskId without a refetch.
 */
export async function attachTaskToPullRequestRow(opts: {
  workspaceId: string;
  pullRequestId: string;
  taskId: string;
}): Promise<boolean> {
  const db = getDbClient();
  const rows = await db
    .select(PR_CACHE_COLUMNS)
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, opts.pullRequestId))
    .limit(1);
  const row = rows[0];
  if (!row || row.workspaceId !== opts.workspaceId) return false;

  const now = new Date();
  await db
    .update(pullRequestsTable)
    .set({ taskId: opts.taskId, updatedAt: now })
    .where(eq(pullRequestsTable.id, opts.pullRequestId));
  // The reverse link is the one the in-flight guards read. createCloudTask
  // already writes it with the row; repeating it here keeps any other caller
  // of this function correct, and repairs a row whose column is still null.
  await db
    .update(tasksTable)
    .set({ pullRequestId: opts.pullRequestId, updatedAt: now })
    .where(eq(tasksTable.id, opts.taskId));

  emitPullRequestUpdated(opts.workspaceId, {
    id: row.id,
    taskId: opts.taskId,
    repositoryId: row.repositoryId,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    state: row.state,
    lastSummary: (row.lastSummary as Record<string, unknown> | null) ?? {},
    reviewRequested: row.reviewRequested,
    authored: row.authored,
  });
  return true;
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
    // Resolve per-check `isRequired` so the cached blockingReason can tell
    // required from non-required failing checks.
    numbers: [opts.number],
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
  return { summary, delta, cacheMiss: true, rowId };
}

/**
 * Upsert a PR row from a freshly-fetched summary. This is the path the
 * bulk-poll loop uses — `batchPullRequests` already returned a summary,
 * no point fetching it again.
 */
export async function upsertFromBatchResult(opts: {
  workspaceId: string;
  repositoryId: string;
  taskId?: string | null;
  summary: PRSummary;
  reviewRequested?: boolean;
  authored?: boolean;
  /**
   * The user explicitly asked to watch THIS pull request (the paste-a-URL
   * flow), rather than the poller having discovered it. Treated the same as
   * `authored` when deciding whether to arm auto-keep-mergeable — see
   * {@link upsertRow}.
   */
  explicitWatch?: boolean;
  /**
   * Update this known row id instead of matching by (workspace, repo, number).
   * Callers that already hold the row (e.g. the detail route persisting a fresh
   * fetch) pass it so a number mismatch can't spawn a duplicate row.
   */
  existingId?: string;
}): Promise<UpsertResult> {
  const db = getDbClient();
  const existing = opts.existingId
    ? await readRowById(db, opts.existingId)
    : await readRow(db, opts.workspaceId, opts.repositoryId, opts.summary.number);
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
    reviewRequested: opts.reviewRequested,
    authored: opts.authored,
    explicitWatch: opts.explicitWatch,
    existingId: existing?.id,
  });
  return { summary: opts.summary, delta, cacheMiss: true, rowId };
}

// ---------- Pure delta logic ----------

/**
 * Compare a fresh `summary` against the previous cursor state. Returns
 * a per-event-type delta describing what changed since the last poll.
 *
 * Edge cases:
 *   - `previous == null` (first time we've seen the PR): no deltas
 *     emitted; the cursors are just baselined. Historical
 *     reviews/comments aren't new, so surfacing them on first sight
 *     would be noise.
 *   - The recent* arrays are bounded at 5 by the GraphQL query, so
 *     we may miss events when more than 5 fire between polls. That's
 *     acceptable; the cursor still moves forward to whichever id is
 *     freshest.
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
  // Non-required checks failing don't block the merge — don't flag them
  // as a CI failure (matches the de-emphasised UI treatment).
  if (summary.blockingReason === 'checks_failed_optional') return false;
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
  // Optional (non-required) checks failing still leaves the PR mergeable,
  // so it counts as merge-ready too.
  if (
    summary.blockingReason !== 'mergeable' &&
    summary.blockingReason !== 'checks_failed_optional'
  )
    return false;
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

/**
 * Exactly the `pull_requests` columns the cache reads/emits. Projected (not
 * `.select()`) so `readRow` — on the hot upsert/getOrFetch path — never ships
 * the unread blobs (`autoMergeState`, `mergeQueueState`) or the merge-queue/
 * auto-merge flag columns. The `Pick` type below makes `tsc` fail if a
 * consumer ever reads a column not listed here.
 */
const PR_CACHE_COLUMNS = {
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
  lastReviewId: pullRequestsTable.lastReviewId,
  lastReviewCommentId: pullRequestsTable.lastReviewCommentId,
  lastCommentId: pullRequestsTable.lastCommentId,
  lastCheckDigest: pullRequestsTable.lastCheckDigest,
} as const;

type PullRequestRow = Pick<
  typeof pullRequestsTable.$inferSelect,
  keyof typeof PR_CACHE_COLUMNS
>;

async function readRow(
  db: Database,
  workspaceId: string,
  repositoryId: string,
  number: number
): Promise<PullRequestRow | null> {
  const rows = await db
    .select(PR_CACHE_COLUMNS)
    .from(pullRequestsTable)
    .where(
      and(
        eq(pullRequestsTable.workspaceId, workspaceId),
        eq(pullRequestsTable.repositoryId, repositoryId),
        eq(pullRequestsTable.number, number)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

async function readRowById(db: Database, id: string): Promise<PullRequestRow | null> {
  const rows = await db
    .select(PR_CACHE_COLUMNS)
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function isFresh(lastPolledAt: Date, ttlMs: number): boolean {
  return Date.now() - lastPolledAt.getTime() < ttlMs;
}

/**
 * The workspace's "auto-keep mergeable by default" setting. Read only when a
 * brand-new authored PR is being inserted (a rare event — never the hot update
 * path), and projected to the small `settings` jsonb so the large `logo` column
 * never ships.
 */
async function workspaceDefaultAutoKeepMergeable(
  db: Database,
  workspaceId: string
): Promise<boolean> {
  return (await readWorkspaceSettings(db, workspaceId)).defaultAutoKeepMergeable === true;
}

async function upsertRow(
  db: Database,
  opts: {
    workspaceId: string;
    repositoryId: string;
    taskId: string | null;
    summary: PRSummary;
    reviewRequested?: boolean;
    authored?: boolean;
    explicitWatch?: boolean;
    existingId?: string;
  }
): Promise<string> {
  const now = new Date();
  const id = opts.existingId ?? uuid();
  // GitHub resets `mergeable` to UNKNOWN on any base-branch advance and
  // recomputes it lazily; a webhook refresh (resolveMergeable:false) catches it
  // mid-recompute and `computeBlockingReason` then yields 'unknown' — a "?" pill.
  // Don't downgrade a known state: when the fresh summary is 'unknown' but we
  // already have a known blocking-reason, keep the prior mergeable +
  // blockingReason (the sweep, which resolves UNKNOWN, writes the real value
  // within a tick). Reads two small scalars, never the blob. NB: blockingReason
  // is only 'unknown' when nothing else blocks — a failing check yields
  // 'checks_failed', not 'unknown' — so this can't mask a check regression.
  let summary = opts.summary;
  if (opts.existingId && summary.blockingReason === 'unknown') {
    const prev = (
      await db
        .select({
          mergeable: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'mergeable'`,
          blockingReason: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'blockingReason'`,
        })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, opts.existingId))
        .limit(1)
    )[0];
    if (prev?.blockingReason && prev.blockingReason !== 'unknown') {
      summary = {
        ...summary,
        mergeable: (prev.mergeable as PRSummary['mergeable']) ?? summary.mergeable,
        blockingReason: prev.blockingReason as PRSummary['blockingReason'],
      };
    }
  }
  const lastSummary = summaryToJsonb(summary);
  const cursors = nextCursors(summary);
  // A newly-tracked open PR inherits the workspace's "auto-keep mergeable by
  // default" setting when the user has, one way or another, ASKED for this
  // specific PR: they authored it, or they pasted its URL to watch it.
  //
  // Arming dispatches cloud fix runs that PUSH COMMITS, so the line is drawn at
  // intent rather than at ownership. An explicitly-watched PR is one the user
  // named — pushing to it is most of the reason to watch it — and that is a
  // different act from the poller sweeping up every PR you happen to be a
  // requested reviewer on. `reviewRequested` therefore stays excluded: those
  // arrive unbidden and in bulk, and pushing to a stranger's branch because
  // they asked you for a review would be a genuine surprise.
  //
  // Whether the push SUCCEEDS is the provider's business and not ours to
  // predict: a same-repo branch usually takes one, a fork only with "allow
  // edits by maintainers" on. A refused push surfaces as a failed run, which
  // is a better answer than the silence of never trying.
  const armEligible = opts.authored === true || opts.explicitWatch === true;
  let autoKeepMergeable = false;
  let autoMergeState: { attempts: number; accounted: boolean } | null = null;
  if (!opts.existingId && armEligible && summary.state === 'open') {
    if (await workspaceDefaultAutoKeepMergeable(db, opts.workspaceId)) {
      autoKeepMergeable = true;
      autoMergeState = { attempts: 0, accounted: true };
    }
  }
  if (opts.existingId) {
    // Update path — leave taskId alone (set on first insert only).
    // Disk-IO guard: most polls yield byte-identical content. Compare a cheap
    // stored digest (one small text column) and skip rewriting the ~2 KB
    // TOASTed `last_summary` + its cursor columns when nothing changed — the
    // poll then bumps only the TTL timestamp, saving the WAL + TOAST churn.
    const digest = summaryDigest(lastSummary, cursors);
    const prevDigest = (
      await db
        .select({ digest: pullRequestsTable.lastSummaryDigest })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, opts.existingId))
        .limit(1)
    )[0]?.digest;
    const summaryChanged = prevDigest !== digest;
    await db
      .update(pullRequestsTable)
      .set({
        owner: opts.summary.owner,
        repo: opts.summary.repo,
        state: opts.summary.state,
        mergedAt: opts.summary.mergedAt ? new Date(opts.summary.mergedAt) : null,
        lastPolledAt: now,
        ...(summaryChanged
          ? {
              lastSummary,
              lastReviewId: cursors.lastReviewId,
              lastReviewCommentId: cursors.lastReviewCommentId,
              lastCommentId: cursors.lastCommentId,
              lastCheckDigest: cursors.lastCheckDigest,
              lastSummaryDigest: digest,
            }
          : {}),
        // Only the monitor knows the relationship — leave it untouched on
        // refresh paths (detail refresh, merge) that don't pass it.
        ...(opts.reviewRequested === undefined
          ? {}
          : { reviewRequested: opts.reviewRequested }),
        ...(opts.authored === undefined ? {} : { authored: opts.authored }),
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
      reviewRequested: opts.reviewRequested ?? false,
      authored: opts.authored ?? false,
      mergedAt: opts.summary.mergedAt ? new Date(opts.summary.mergedAt) : null,
      lastPolledAt: now,
      lastSummary,
      lastReviewId: cursors.lastReviewId,
      lastReviewCommentId: cursors.lastReviewCommentId,
      lastCommentId: cursors.lastCommentId,
      lastCheckDigest: cursors.lastCheckDigest,
      lastSummaryDigest: summaryDigest(lastSummary, cursors),
      autoKeepMergeable,
      autoMergeState,
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
    ...(opts.reviewRequested === undefined ? {} : { reviewRequested: opts.reviewRequested }),
    ...(opts.authored === undefined ? {} : { authored: opts.authored }),
    // Surface the auto-armed state on first insert so the toggle reflects it
    // without waiting for a full fetch (matches the toggle route's emit shape).
    ...(autoKeepMergeable
      ? { autoKeepMergeable: true, autoMergeState: { attempts: 0, paused: false } }
      : {}),
  });
  // Merge-queue v2 trigger: a fresh snapshot just landed — evaluate any queue
  // group it affects (this PR's own entry, or a group advance when a same-base
  // sibling merged). Fire-and-forget on the leaf event bus; no-op unless the
  // v2 engine is active.
  domainEvents.emit('pr:snapshot', {
    workspaceId: opts.workspaceId,
    repositoryId: opts.repositoryId,
    prId: id,
    baseBranch: summary.baseBranch ?? '',
    headBranch: summary.headBranch ?? '',
    state: opts.summary.state,
    trigger: 'prcache:upsert',
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

/**
 * Stable digest of the fields whose write is expensive — the TOASTed
 * `last_summary` blob plus its four derived cursor columns. `upsertRow` stores
 * it alongside the row and compares against it on the next poll, so a poll that
 * yields byte-identical content can skip rewriting the blob (and re-TOASTing
 * ~2 KB) and bump only the TTL timestamp. Order is fixed so the hash is stable.
 */
export function summaryDigest(
  lastSummary: Record<string, unknown>,
  cursors: CursorState
): string {
  return createHash('sha1')
    .update(
      JSON.stringify([
        lastSummary,
        cursors.lastReviewId,
        cursors.lastReviewCommentId,
        cursors.lastCommentId,
        cursors.lastCheckDigest,
      ])
    )
    .digest('hex');
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
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    url: s.url,
    mergeable: s.mergeable,
    mergeStateStatus: s.mergeStateStatus,
    reviewDecision: s.reviewDecision,
    effectiveReviewDecision: s.effectiveReviewDecision,
    blockingReason: s.blockingReason,
    checks: s.checks,
    unresolvedReviewThreads: s.unresolvedReviewThreads,
    reviewRequestVia: s.reviewRequestVia ?? null,
    // Merge-queue auto-merge hybrid: the PR node id (mutation handle) and who
    // (if anyone) has GitHub native auto-merge armed.
    nodeId: s.nodeId ?? null,
    autoMergeBy: s.autoMergeBy ?? null,
    // Labels — small (names only) and the ONLY channel an external merge queue
    // (trunk.io) reports a submitted PR's state on. The `labeled`/`unlabeled`
    // webhook patches this in place without a GitHub fetch.
    labels: s.labels ?? [],
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
    nodeId: (meta.nodeId as string | undefined) ?? undefined,
    autoMergeBy: (meta.autoMergeBy as string | null | undefined) ?? null,
    labels: (meta.labels as string[] | undefined) ?? [],
    createdAt: (meta.createdAt as string) ?? '',
    updatedAt: (meta.updatedAt as string) ?? '',
    mergeable: (meta.mergeable as PRSummary['mergeable']) ?? 'UNKNOWN',
    mergeStateStatus: (meta.mergeStateStatus as string) ?? 'UNKNOWN',
    reviewDecision: (meta.reviewDecision as PRSummary['reviewDecision']) ?? null,
    // Older cached rows predate this field — fall back to the raw decision.
    effectiveReviewDecision:
      (meta.effectiveReviewDecision as PRSummary['effectiveReviewDecision']) ??
      (meta.reviewDecision as PRSummary['reviewDecision']) ??
      null,
    blockingReason: (meta.blockingReason as PRSummary['blockingReason']) ?? 'unknown',
    checks: (meta.checks as CheckBreakdown) ?? {
      total: 0,
      passed: 0,
      failed: 0,
      inProgress: 0,
      skipped: 0,
    },
    unresolvedReviewThreads: (meta.unresolvedReviewThreads as number) ?? 0,
    reviewRequestVia: meta.reviewRequestVia as PRSummary['reviewRequestVia'],
    // Left undefined (not '') on rows cached before it shipped: the merge
    // queue reads absent as "unknown", and '' would claim "nothing failing".
    failingChecksDigest: meta.failingChecksDigest as string | undefined,
    checkContexts: [], // not cached — only the live detail fetch carries per-check rows
    checkDigest: row.lastCheckDigest ?? '',
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
  };
}
