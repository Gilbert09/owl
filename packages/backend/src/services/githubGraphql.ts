import { githubService } from './github.js';

/**
 * Batched GraphQL fetch for a workspace's PRs, modelled on supacode's
 * `GithubCLIClient.batchPullRequests`.
 *
 * One repo at a time, PRs chunked into small groups per query. Each PR
 * pulls a full `statusCheckRollup.contexts(first: 100)` + reviews +
 * comments, which is expensive server-side — large repos (e.g. ones
 * with big CI matrices) make a 25-wide query time out (504). Keep the
 * chunk small so each request stays within GitHub's GraphQL budget. Up
 * to 3 chunks fire concurrently.
 *
 * Each query aliases per-branch sub-queries inside one `repository`
 * node and pulls everything the cache layer needs in one shot:
 * pull-request summary, last 5 reviews (full history is paginated on
 * demand by the detail panel), `statusCheckRollup.contexts(first: 100)`
 * as a `CheckRun | StatusContext` union, plus `mergeable`,
 * `mergeStateStatus`, and `reviewDecision`.
 *
 * Pure-functional response decoders + state-collapse logic live below
 * so they can be unit-tested without a live token.
 */

// ---------- Public types ----------

export type PRState = 'open' | 'closed' | 'merged';

// Deliberately identical to the wire type `PRCheckState` in `@talyn/client`:
// every state here is rendered, counted, and filtered by both front ends. It
// used to carry two extra members — `neutral` (never produced) and `cancelled`
// (produced, but counted by nothing) — and a state no bucket counts is a check
// GitHub blocks the merge on that Talyn reads as green. See
// `normalizeCheckState` on why CANCELLED is a failure.
export type CheckState =
  | 'pending'
  | 'in_progress'
  | 'success'
  | 'failure'
  | 'skipped';

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export type BlockingReason =
  | 'mergeable'
  | 'merge_conflicts'
  | 'changes_requested'
  | 'checks_failed'
  // Mergeable, but one or more *non-required* checks are failing. GitHub
  // doesn't block the merge on these, so we surface them as a distinct,
  // de-emphasised state rather than the hard red 'checks_failed'.
  | 'checks_failed_optional'
  | 'blocked'
  | 'unknown';

export interface CheckBreakdown {
  total: number;
  passed: number;
  failed: number;
  inProgress: number;
  skipped: number;
}

export interface PRSummary {
  owner: string;
  repo: string;
  number: number;
  /** PR GraphQL node id — needed by the auto-merge mutations. Absent on rows
   *  cached before the field shipped (REST node_id is the fallback). */
  nodeId?: string;
  title: string;
  body: string;
  url: string;
  author: string;
  /**
   * The PR's labels. Load-bearing for external merge queues: trunk.io publishes
   * a submitted PR's queue state ONLY as labels (`trunk-queued`,
   * `trunk-testing`, `trunk-failed`, …) — see `externalQueueStatusFromLabels`.
   */
  labels: string[];
  draft: boolean;
  state: PRState;
  mergedAt: string | null;
  closedAt: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: ReviewDecision;
  /** Login that has GitHub native auto-merge armed on the PR (null = not
   *  armed). The merge queue compares it against the App's bot login to tell
   *  Talyn-armed from user-armed — we never disarm what we didn't arm. */
  autoMergeBy?: string | null;
  /** GitHub's composite "can auto-merge be enabled here" (repo allows it AND
   *  the PR is in an armable state). */
  viewerCanEnableAutoMerge?: boolean;
  /**
   * Review state for the UI's approval badge. Equals {@link reviewDecision}
   * when GitHub provides it (the base branch enforces required reviews), and
   * otherwise is derived from the actual review nodes + outstanding review
   * requests — so repos without branch protection (e.g. posthog.com) still
   * show "Approved" / "Awaiting review" instead of nothing. Kept separate from
   * `reviewDecision` so it never feeds merge-gating (`blockingReason`).
   */
  effectiveReviewDecision: ReviewDecision;
  blockingReason: BlockingReason;
  checks: CheckBreakdown;
  /** Identity of the SET of failing checks — see {@link computeFailingChecksDigest}. */
  failingChecksDigest?: string;
  /** Count of unresolved review threads (capped at the first 100 threads). */
  unresolvedReviewThreads: number;
  /**
   * {@link unresolvedReviewThreads} split by who opened each thread. Optional:
   * a live fetch always sets both, but a summary read back from a row cached
   * before the split shipped has neither — and absence must read as "we don't
   * know", never as zero.
   */
  unresolvedHumanReviewThreads?: number;
  unresolvedBotReviewThreads?: number;
  /**
   * Currently-requested reviewers, split into users and teams. Transient
   * (not persisted) — the monitor uses it to derive `reviewRequestVia`
   * against the viewer's identity + teams before storing.
   */
  reviewRequests?: {
    users: string[];
    teams: Array<{ slug: string; name: string; combinedSlug: string }>;
  };
  /**
   * Whether the *viewer* was asked to review directly, via a team, or both.
   * `direct` true when the viewer is an individually-requested reviewer;
   * `teams` lists the viewer's own teams (combinedSlug `org/team`) that were
   * requested. Derived + persisted by the monitor; drives the Review tab's
   * "Requested" column.
   */
  reviewRequestVia?: { direct: boolean; teams: string[] };
  /**
   * Per-check rows behind the `checks` rollup — name, normalized state,
   * and a link to the run/target. Not persisted (summaryToJsonb keeps
   * only the counts); flows through the live detail fetch so the
   * desktop Checks tab can render individual rows instead of a rollup +
   * "view on GitHub".
   */
  checkContexts: Array<{
    name: string;
    state: CheckState;
    url: string | null;
    /** Whether GitHub marks this check required for the PR. null when the
     *  fetch didn't carry per-check required-ness (by-branch path). */
    required: boolean | null;
  }>;
  /** Rolling hash of `headSha + sorted(check.state per name)` — used by
   *  the cursor logic to detect "checks changed" without diffing the
   *  whole rollup payload. */
  checkDigest: string;
  /** Last 5 reviews, freshest first. Detail-view paginates more on demand. */
  recentReviews: Array<{
    id: string;
    author: string;
    state: string;
    submittedAt: string | null;
    url: string;
  }>;
  /**
   * Last 5 review-thread comments (inline-on-diff comments), freshest
   * first. Used by the prCache to detect new pr_comment events; the
   * detail-view review tab fetches the full thread on demand.
   */
  recentReviewComments: Array<{
    id: string;
    author: string;
    /** True when the author is a GitHub App / bot (e.g. `foo[bot]`). */
    authorIsBot: boolean;
    /** Plain-text comment body — used to detect @-mentions of the viewer. */
    bodyText: string;
    createdAt: string;
    url: string;
  }>;
  /**
   * Last 5 issue-style PR comments (top-level conversation), freshest
   * first. Same delta-detection role as recentReviewComments.
   */
  recentComments: Array<{
    id: string;
    author: string;
    authorIsBot: boolean;
    bodyText: string;
    createdAt: string;
    url: string;
  }>;
}

export interface BatchPRResult {
  /** The branch we asked about. */
  branch: string;
  /** Null when the branch has no PR (or only closed/merged PRs we didn't
   *  ask for — query is `states: [OPEN]`). */
  pr: PRSummary | null;
}

// ---------- Public API ----------

// Small chunk: each PR's statusCheckRollup is heavy to resolve, so a
// wide query times out on big repos. 5 keeps requests fast at the cost
// of a few more round-trips.
const CHUNK_SIZE = 5;
const CONCURRENCY = 3;

export async function batchPullRequests(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  branches: string[];
  /**
   * Optional PR numbers parallel to `branches`. When supplied, the query
   * asks GitHub whether each check `isRequired` for that PR — letting the
   * blocking-reason logic tell required from non-required failures
   * authoritatively instead of guessing from `mergeStateStatus`. The
   * single-PR callers (detail panel, cache refresh) know the number; the
   * bulk monitor uses `batchPullRequestsByNumber` instead.
   */
  numbers?: number[];
}): Promise<BatchPRResult[]> {
  const { workspaceId, owner, repo, branches, numbers } = opts;
  if (branches.length === 0) return [];

  const chunks: Array<{ branches: string[]; numbers?: number[] }> = [];
  for (let i = 0; i < branches.length; i += CHUNK_SIZE) {
    chunks.push({
      branches: branches.slice(i, i + CHUNK_SIZE),
      numbers: numbers ? numbers.slice(i, i + CHUNK_SIZE) : undefined,
    });
  }

  // Bounded-concurrency runner: never more than CONCURRENCY queries in
  // flight at once. Each chunk is one GraphQL request.
  const results: BatchPRResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const { branches: chunkBranches, numbers: chunkNumbers } = chunks[idx];
      const chunk = chunkBranches;
      const query = makeBatchPullRequestsQuery(chunk, chunkNumbers);
      const data = await githubService.executeGraphql<BatchPullRequestsResponse>(
        workspaceId,
        query,
        { owner, repo }
      );
      await topUpCheckContexts(extractBranchPRs(data, chunk.length), {
        workspaceId,
        owner,
        repo,
      });
      results.push(...decodeBatchResponse(chunk, data, owner, repo));
    }
  }
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, chunks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export interface BatchPRByNumberResult {
  number: number;
  pr: PRSummary | null;
}

// ---------- by-number fetch de-dup (poll amplification) ----------
//
// A PR's GraphQL summary is byte-identical for every workspace on the same
// GitHub App installation — the PR is the same object on GitHub. When many
// workspaces track one big shared org (16 track PostHog/posthog here), each
// workspace's poll re-fetches the SAME PRs against the ONE shared GraphQL point
// budget — pure amplification (the webhook fan-out already de-dups this; the
// poll/sweep never did). This short-TTL cache, keyed by the PR's identity
// (owner/repo#number, not the workspace), lets N workspaces polling the same PR
// within one window share a single fetch. Opt-in via `dedupeWindowMs`: only the
// per-workspace poll passes it — the merge queue / detail refresh stay uncached
// and always fresh. Window is deliberately short (≤ the poll's own freshness
// tolerance), so no workspace ever sees data staler than it already accepts.
interface ByNumberCacheEntry {
  at: number;
  pr: PRSummary | null;
}
const byNumberCache = new Map<string, ByNumberCacheEntry>();
const BY_NUMBER_CACHE_MAX = 5000; // ~5k tracked PRs — prune expired once past this.

function byNumberCacheKey(owner: string, repo: string, n: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${n}`;
}

/** Test helper — clear the by-number fetch cache between cases. */
export function _resetByNumberCache(): void {
  byNumberCache.clear();
}

/**
 * Fetch PR summaries by number (chunked + bounded-concurrency, same as
 * batchPullRequests). Unlike the branch variant this returns
 * merged/closed PRs too — `pullRequest(number:)` has no `states` filter.
 *
 * Pass `dedupeWindowMs` to serve PRs fetched within that window from the shared
 * {@link byNumberCache} instead of re-fetching — used by the per-workspace poll
 * so N workspaces tracking the same repo don't each spend a GraphQL point on the
 * same PR (see the cache note above). Omit it (the default) for fresh fetches.
 */
export async function batchPullRequestsByNumber(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  numbers: number[];
  dedupeWindowMs?: number;
}): Promise<BatchPRByNumberResult[]> {
  const { workspaceId, owner, repo, numbers, dedupeWindowMs } = opts;
  if (numbers.length === 0) return [];

  // Split into cache hits (within the window) and the numbers we must fetch.
  const now = Date.now();
  const hits = new Map<number, PRSummary | null>();
  const toFetch: number[] = [];
  if (dedupeWindowMs) {
    for (const n of numbers) {
      const entry = byNumberCache.get(byNumberCacheKey(owner, repo, n));
      if (entry && now - entry.at < dedupeWindowMs) hits.set(n, entry.pr);
      else toFetch.push(n);
    }
  } else {
    toFetch.push(...numbers);
  }

  const fetched: BatchPRByNumberResult[] = [];
  if (toFetch.length > 0) {
    const chunks: number[][] = [];
    for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
      chunks.push(toFetch.slice(i, i + CHUNK_SIZE));
    }
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < chunks.length) {
        const idx = cursor++;
        const chunk = chunks[idx];
        const query = makeBatchPullRequestsByNumberQuery(chunk);
        const data = await githubService.executeGraphql<BatchByNumberResponse>(
          workspaceId,
          query,
          { owner, repo }
        );
        await topUpCheckContexts(extractByNumberPRs(data, chunk.length), {
          workspaceId,
          owner,
          repo,
        });
        fetched.push(...decodeBatchByNumberResponse(chunk, data, owner, repo));
      }
    };
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, chunks.length) },
      () => worker()
    );
    await Promise.all(workers);
    if (dedupeWindowMs) {
      if (byNumberCache.size > BY_NUMBER_CACHE_MAX) {
        for (const [k, v] of byNumberCache) {
          if (now - v.at >= dedupeWindowMs) byNumberCache.delete(k);
        }
      }
      for (const r of fetched) {
        byNumberCache.set(byNumberCacheKey(owner, repo, r.number), { at: now, pr: r.pr });
      }
    }
  }

  if (hits.size === 0) return fetched;
  // Merge cache hits + freshly fetched, preserving the caller's `numbers` order.
  const fetchedByNumber = new Map(fetched.map((r) => [r.number, r.pr]));
  return numbers.map((n) => ({
    number: n,
    pr: hits.has(n) ? (hits.get(n) ?? null) : (fetchedByNumber.get(n) ?? null),
  }));
}

// ---------- statusCheckRollup pagination ----------
//
// GraphQL caps a connection's `first` at 100, so a PR with >100 check
// contexts comes back truncated — wrong counts AND a wrong blocking
// reason (a failure beyond #100 would read as green). For any PR whose
// `contexts` page reports `hasNextPage`, we walk the remaining pages and
// splice them into the raw nodes before `rawToSummary` counts them.
// Cheap in practice: only PRs with 100+ checks pay for extra round-trips.

const MAX_CONTEXT_PAGES = 50; // 50 * 100 = 5000 checks — a sane ceiling.

interface ContextsPageResponse {
  repository: {
    pullRequest: {
      commits: {
        nodes: Array<{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: Array<RawCheckContext>;
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            } | null;
          };
        }>;
      };
    } | null;
  } | null;
}

function makeContextsPageQuery(): string {
  return `query ContextsPage($owner: String!, $repo: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                nodes {
                  ${contextNodeFields('$number')}
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
    }
  }
${RATE_LIMIT_FIELD}
}`;
}

async function fetchRemainingCheckContexts(
  workspaceId: string,
  owner: string,
  repo: string,
  number: number,
  startCursor: string
): Promise<RawCheckContext[]> {
  const out: RawCheckContext[] = [];
  const query = makeContextsPageQuery();
  let after: string | null = startCursor;
  let page = 0;
  while (after && page < MAX_CONTEXT_PAGES) {
    page++;
    const data: ContextsPageResponse =
      await githubService.executeGraphql<ContextsPageResponse>(workspaceId, query, {
        owner,
        repo,
        number,
        after,
      });
    const conn =
      data.repository?.pullRequest?.commits.nodes[0]?.commit.statusCheckRollup
        ?.contexts;
    if (!conn) break;
    out.push(...conn.nodes);
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  }
  return out;
}

/**
 * For each PR whose first contexts page reports more pages, fetch the
 * rest and append them in place. Mutates the raw nodes so the existing
 * `rawToSummary` path sees the complete list. Runs sequentially — the
 * surrounding batch worker is already concurrency-bounded, and >100-check
 * PRs are rare enough that serial top-ups don't meaningfully add latency.
 */
// Repos we've already warned about a failing check-context tail for — keeps the
// (recurring, non-fatal) warning to one line per repo per process.
const loggedContextTailIssues = new Set<string>();

async function topUpCheckContexts(
  prs: RawPullRequest[],
  ctx: { workspaceId: string; owner: string; repo: string }
): Promise<void> {
  for (const pr of prs) {
    const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
    const pageInfo = rollup?.contexts.pageInfo;
    if (!rollup || !pageInfo?.hasNextPage || !pageInfo.endCursor) continue;
    try {
      const remaining = await fetchRemainingCheckContexts(
        ctx.workspaceId,
        ctx.owner,
        ctx.repo,
        pr.number,
        pageInfo.endCursor
      );
      rollup.contexts.nodes.push(...remaining);
    } catch (err) {
      // The first 100 contexts already fetched fine; only the tail failed —
      // most often "Resource not accessible by integration" when the App lacks
      // (or hasn't had approved) Commit-statuses/Checks read for a later
      // StatusContext, but also any transient. Don't fail the whole PR refresh
      // over the check-context tail: keep what we have and move on. Log once per
      // repo (with the error's field path) — these recur on every >100-check PR.
      const repoKey = `${ctx.owner}/${ctx.repo}`;
      if (!loggedContextTailIssues.has(repoKey)) {
        loggedContextTailIssues.add(repoKey);
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[githubGraphql] ${repoKey}: check-context tail (>100) not fetched (${msg}); using the first 100. Further occurrences suppressed.`
        );
      }
    }
    // Either way, stop advertising more pages so downstream treats it as complete.
    rollup.contexts.pageInfo = { hasNextPage: false, endCursor: null };
  }
}

function extractBranchPRs(
  data: BatchPullRequestsResponse,
  count: number
): RawPullRequest[] {
  const prs: RawPullRequest[] = [];
  for (let idx = 0; idx < count; idx++) {
    const node = data.repository?.[aliasForBranch(idx)]?.nodes?.[0];
    if (node) prs.push(node);
  }
  return prs;
}

function extractByNumberPRs(
  data: BatchByNumberResponse,
  count: number
): RawPullRequest[] {
  const prs: RawPullRequest[] = [];
  for (let idx = 0; idx < count; idx++) {
    const node = data.repository?.[aliasForBranch(idx)];
    if (node) prs.push(node);
  }
  return prs;
}

// ---------- Pure helpers (unit-tested) ----------

/**
 * Collapse GitHub's three-axis check signal (`status` / `conclusion` /
 * `state`) into one verdict. Modelled on supacode's
 * `GithubPullRequestStatusCheck.normalize`.
 *
 *   - `status != COMPLETED` → in_progress / pending
 *   - else `conclusion` wins (NEUTRAL/SKIPPED → success-ish; FAILURE and
 *     CANCELLED → failure; etc.)
 *   - falls back to legacy `state` for `StatusContext` nodes that don't
 *     have a conclusion.
 *
 * Every branch lands on one of the five {@link CheckState} members the front
 * ends count and filter. Adding a sixth is how a blocking check becomes
 * invisible — a state outside the {passed, failed, inProgress, skipped}
 * buckets is in `checks.total` and nothing else.
 */
export function normalizeCheckState(input: {
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}): CheckState {
  const status = input.status?.toUpperCase();
  const conclusion = input.conclusion?.toUpperCase();
  const state = input.state?.toUpperCase();

  if (status && status !== 'COMPLETED') {
    if (status === 'QUEUED' || status === 'WAITING' || status === 'PENDING') return 'pending';
    return 'in_progress';
  }
  if (conclusion) {
    switch (conclusion) {
      case 'SUCCESS':
      case 'NEUTRAL':
        return 'success';
      case 'SKIPPED':
        return 'skipped';
      case 'STALE':
        // A superseded run GitHub drops from its `statusCheckRollup.state`
        // (e.g. a job re-run replaced it). It's neither a pass nor a real
        // failure — treat as skipped so it can't surface as a phantom failure
        // on a PR GitHub considers green.
        return 'skipped';
      case 'FAILURE':
      case 'TIMED_OUT':
      case 'STARTUP_FAILURE':
      case 'ACTION_REQUIRED':
        return 'failure';
      case 'CANCELLED':
        // A cancelled run is a FAILURE, not a state of its own. GitHub rolls
        // CANCELLED into `statusCheckRollup.state = FAILURE` and lists it under
        // "N failing checks", and branch protection is never satisfied by one —
        // a cancelled REQUIRED check blocks the merge exactly like a red one
        // (PostHog/posthog#84477: `shellcheck` cancelled + required, GitHub
        // rollup FAILURE, zero contexts we called `failure`, so the PR read as
        // green and sat in the merge queue). Cancellation is common on a repo
        // with concurrency groups; the ones cancelled by a NEW push land on a
        // new head sha and never reach this rollup, so counting these as
        // failures doesn't manufacture noise.
        return 'failure';
      default:
        // Unknown conclusion — be conservative.
        return 'failure';
    }
  }
  if (state) {
    switch (state) {
      case 'SUCCESS':
        return 'success';
      case 'FAILURE':
      case 'ERROR':
        return 'failure';
      case 'PENDING':
        return 'pending';
      case 'EXPECTED':
        return 'pending';
      default:
        return 'pending';
    }
  }
  return 'pending';
}

/**
 * Compute the merge-readiness verdict from the rolled-up signals.
 * Modelled on supacode's `PullRequestMergeReadiness`.
 *
 * Order matters: a PR can be CONFLICTING AND have failed checks AND
 * have changes requested — we surface the most actionable single
 * reason. Conflicts are first because the PR can't be merged at all
 * until they're resolved; reviews are next because they need a human;
 * checks are last because they often re-run on push.
 */
export function computeBlockingReason(input: {
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: ReviewDecision;
  checks: CheckBreakdown;
  /** Count of *failing* checks GitHub marks required for this PR. Only
   *  consulted when {@link requiredDataAvailable} is true. */
  requiredFailing?: number;
  /** True when we fetched per-check `isRequired` and know the required-ness
   *  of every failing check — lets us decide authoritatively whether a
   *  failure blocks, rather than inferring it from `mergeStateStatus`. */
  requiredDataAvailable?: boolean;
}): BlockingReason {
  if (input.mergeable === 'CONFLICTING') return 'merge_conflicts';
  if (input.reviewDecision === 'CHANGES_REQUESTED') return 'changes_requested';

  const upper = input.mergeStateStatus.toUpperCase();
  // Does a failing check actually *block* the merge?
  //   - Authoritative path: we know each failing check's `isRequired`, so a
  //     failure blocks iff at least one failing check is required. This is
  //     correct even when the PR is *also* blocked for another reason — a
  //     required review masks the rollup as BLOCKED (not UNSTABLE) while the
  //     only failing check is non-required, and that must NOT read as a red
  //     'checks_failed'.
  //   - Fallback heuristic (no per-check data, e.g. the by-branch path):
  //     GitHub surfaces "mergeable but with non-passing checks" as UNSTABLE,
  //     so those failures aren't required; any other state with failures is
  //     conservatively treated as a red required check.
  const failuresBlock = input.requiredDataAvailable
    ? (input.requiredFailing ?? 0) > 0
    : input.checks.failed > 0 &&
      !(input.mergeable === 'MERGEABLE' && upper === 'UNSTABLE');
  if (failuresBlock) return 'checks_failed';

  // A required review that hasn't landed yet → "Review". Checked before
  // the mergeable branch because GitHub computes `mergeable` lazily and
  // returns UNKNOWN on first fetch — reviewDecision is computed
  // independently, so this keeps a waiting-on-review PR from flashing as
  // an unknown "—" until mergeability resolves.
  if (input.reviewDecision === 'REVIEW_REQUIRED') return 'blocked';
  if (input.mergeable === 'MERGEABLE') {
    // A PR can be MERGEABLE but still BLOCKED by branch-protection
    // (e.g. required reviews missing). The mergeStateStatus surfaces
    // that.
    if (upper === 'BLOCKED') return 'blocked';
    // Mergeable, but non-required checks are failing (we only reach here
    // with failures when the state is UNSTABLE) — de-emphasised, not red.
    if (input.checks.failed > 0) return 'checks_failed_optional';
    return 'mergeable';
  }
  // mergeable === 'UNKNOWN' — GitHub hasn't computed it yet (background
  // job). Surface as `unknown` so the UI can show a spinner rather
  // than guessing.
  return 'unknown';
}

/**
 * Reconcile a previously-derived {@link computeBlockingReason} verdict against a
 * *fresher* check breakdown when the two were computed at different times.
 *
 * The incremental check-count path ({@link file://./checkCounts.ts}) advances
 * `checks` on each `check_run` webhook WITHOUT re-running the full verdict, so a
 * held `blockingReason` can contradict the live counts — the bug where a PR
 * shows a green "Ready" pill while 26 checks are failing (`mergeable` is stale,
 * `checks.failed` is fresh). `computeBlockingReason` provably never returns
 * `mergeable` with failures, nor `checks_failed[_optional]` with zero failures,
 * so ONLY those two combinations are stale and get corrected; an authoritative
 * verdict (e.g. a required `checks_failed` that knows each check's
 * `isRequired`) is left untouched, so there's no precision loss. UNSTABLE ⇒ the
 * failing checks aren't required, mirroring the no-per-check-data heuristic.
 */
export function reconcileBlockingReason(
  blockingReason: BlockingReason,
  checks: Pick<CheckBreakdown, 'failed'>,
  mergeStateStatus: string | null | undefined,
): BlockingReason {
  if (blockingReason === 'mergeable' && checks.failed > 0) {
    return mergeStateStatus?.toUpperCase() === 'UNSTABLE'
      ? 'checks_failed_optional'
      : 'checks_failed';
  }
  if (
    (blockingReason === 'checks_failed' || blockingReason === 'checks_failed_optional') &&
    checks.failed === 0
  ) {
    return 'mergeable';
  }
  return blockingReason;
}

/**
 * Review state for the approval badge. When GitHub gives us a `reviewDecision`
 * (the base branch enforces required reviews) we trust it. Otherwise — repos
 * without branch protection return `null` — we derive the state ourselves from
 * the actual reviews and outstanding review requests, mirroring how GitHub's
 * own PR list reasons:
 *
 *   - latest decision-bearing review per author wins (COMMENTED/PENDING/
 *     DISMISSED reviews don't change a user's standing);
 *   - any latest CHANGES_REQUESTED → CHANGES_REQUESTED (most actionable);
 *   - else an outstanding review request → REVIEW_REQUIRED ("Awaiting review"),
 *     since a (re-)request supersedes a stale approval;
 *   - else any approval → APPROVED;
 *   - else null (no reviewers involved — stay blank).
 */
export function deriveEffectiveReviewDecision(input: {
  reviewDecision: ReviewDecision;
  recentReviews: Array<{ author: string; state: string }>;
  reviewRequests?: { users: string[]; teams: unknown[] };
}): ReviewDecision {
  if (input.reviewDecision) return input.reviewDecision;

  // recentReviews is freshest-first, so the first decision-bearing review we
  // see per author is their latest standing.
  const latestByAuthor = new Map<string, 'APPROVED' | 'CHANGES_REQUESTED'>();
  for (const r of input.recentReviews) {
    if (!r.author || latestByAuthor.has(r.author)) continue;
    const st = r.state?.toUpperCase();
    if (st === 'APPROVED' || st === 'CHANGES_REQUESTED') latestByAuthor.set(r.author, st);
  }
  const states = [...latestByAuthor.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';

  const hasOutstandingRequest =
    (input.reviewRequests?.users.length ?? 0) > 0 ||
    (input.reviewRequests?.teams.length ?? 0) > 0;
  if (hasOutstandingRequest) return 'REVIEW_REQUIRED';

  if (states.includes('APPROVED')) return 'APPROVED';
  return null;
}

/**
 * Hash of `headSha + sorted "name=state" pairs`. Used by the cursor
 * logic to detect "checks changed" without diffing the whole rollup.
 *
 * Stable: same input always produces the same string. Cheap: scan +
 * sort + concat, no crypto. Length-bounded: ~32 chars per check times
 * a few hundred checks max.
 */
export function computeCheckDigest(
  headSha: string,
  contexts: Array<{ name: string; state: CheckState }>
): string {
  const sorted = contexts
    .map((c) => `${c.name}=${c.state}`)
    .sort()
    .join('|');
  return `${headSha}:${sorted}`;
}

/**
 * Stable identity of the SET of failing checks, independent of the commit they
 * ran on. Head-independent ON PURPOSE: the merge queue compares it ACROSS a
 * remediation, and a fix run pushes a commit, so anything keyed on headSha
 * (like {@link computeCheckDigest}) would read every comparison as "changed".
 *
 * Failures only. A pending check going green is not a change in what BLOCKS
 * the PR, and folding it in would make an unrelated CI finish look like
 * progress.
 *
 * FNV-1a over the sorted names — not crypto, just a compact stable equality
 * token. Empty string means "nothing is failing", which is a real answer;
 * callers distinguish it from `undefined` ("we don't know").
 */
export function computeFailingChecksDigest(
  contexts: Array<{ name: string; state: CheckState }>
): string {
  const failing = contexts
    .filter((c) => c.state === 'failure')
    .map((c) => c.name)
    .sort();
  if (failing.length === 0) return '';
  const joined = failing.join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${failing.length}:${hash.toString(36)}`;
}

/** Latest of a set of ISO timestamps as epoch ms; 0 when none are parseable. */
function latestTimestamp(values: Array<string | null | undefined>): number {
  let max = 0;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/**
 * Collapse check contexts that share a name down to the single most recent
 * run.
 *
 * GitHub's `statusCheckRollup` returns EVERY check run on the head commit,
 * including stale ones a re-run superseded — e.g. an old "Frontend Tests Pass
 * = FAILURE" (ran at 21:16) sitting alongside the fresh "Frontend Tests Pass =
 * QUEUED" (re-triggered at 21:24) that replaced it. Counting both made the PR
 * pill show phantom failures while GitHub's own merge view — which keeps only
 * the latest run per name — showed the check as pending. So we match GitHub:
 * within a name, the run with the newest timestamp (max of started / completed
 * / created) wins.
 *
 * Safe for matrix jobs: GitHub expands a matrix into concrete per-leg names
 * ("Jest test (chromium - 1)"), so genuine parallel legs keep distinct names
 * and their own entries — only same-name re-runs collapse.
 */
export function dedupeLatestCheckByName<T extends { name: string; ts: number }>(
  items: T[]
): T[] {
  const byName = new Map<string, T>();
  for (const item of items) {
    const existing = byName.get(item.name);
    // `>=` so a later-in-array run wins an exact-timestamp tie.
    if (!existing || item.ts >= existing.ts) byName.set(item.name, item);
  }
  return [...byName.values()];
}

interface NormalizedCheck {
  name: string;
  state: CheckState;
  url: string | null;
  required: boolean | null;
}

/**
 * Collapse the raw head-commit check contexts to one entry per name and a
 * {total,passed,failed,…} breakdown — reconciled against GitHub's own
 * `statusCheckRollup.state`.
 *
 * We normally keep only the latest run per name (see {@link dedupeLatestCheckByName})
 * to drop stale re-runs. But that heuristic can erase a failure GitHub still
 * counts: a gate check that runs twice on the head commit, where "latest per
 * name" keeps a non-failing run while GitHub's rollup stays FAILURE, would leave
 * us showing 0 failing and the PR "Ready" on a PR GitHub considers broken
 * (PostHog/posthog#64614).
 *
 * The catch: `statusCheckRollup.state` is NOT itself de-duped — it keeps counting
 * a gate's early FAILURE even after a later same-name SUCCESS re-run resolves it,
 * so the rollup reads FAILURE on a PR GitHub's own merge box renders green
 * (PostHog/posthog#65362: every *Tests Pass gate failed early then passed on a
 * re-run, yet the rollup stayed FAILURE). GitHub's UI shows the latest run per
 * name, so a failure is only live if nothing later resolved it.
 *
 * So we defer to GitHub's rollup, but only restore failures it hasn't superseded:
 *   - Rollup FAILURE but our latest-per-name view found no failure → restore a
 *     name to `failure` only when it has a failing raw run with NO strictly-later
 *     same-name SUCCESS. A failure followed by a same-name success is a resolved
 *     re-run GitHub renders green, so we leave it alone (PostHog#65362); a
 *     failure with no superseding success is one GitHub still counts, so it comes
 *     back with its failing detailsUrl (PostHog#64614).
 *   - Rollup SUCCESS but our view still holds a failure → that run is one
 *     GitHub excludes from its green rollup (a superseded/STALE re-run, or a
 *     conclusion we map conservatively to `failure`), so we demote it to
 *     skipped — a green PR must not show a phantom "N failing" (PostHog#65121).
 *   - Rollup PENDING (the original stale-re-run case — an old FAILURE behind an
 *     in-flight QUEUED re-run) → we keep the de-noised latest-per-name view
 *     untouched, which is what GitHub's own merge box shows.
 * Either way our verdict matches the single field GitHub's UI is derived from.
 */
export function summarizeCheckContexts(
  contexts: Array<NormalizedCheck & { ts: number }>,
  rollupState: string | null | undefined
): { normalized: NormalizedCheck[]; checks: CheckBreakdown } {
  let normalized: NormalizedCheck[] = dedupeLatestCheckByName(contexts).map(
    ({ name, state, url, required }) => ({ name, state, url, required })
  );
  const rollupFailed = rollupState === 'FAILURE' || rollupState === 'ERROR';
  const dedupedFailed = normalized.some((c) => c.state === 'failure');
  if (rollupFailed && !dedupedFailed) {
    // The latest-per-name view erased a failure the rollup still reports. Only
    // restore failures GitHub hasn't superseded: a gate that failed then passed
    // on a same-name re-run is green in GitHub's merge box (the rollup just keeps
    // counting the dead run — PostHog#65362), so we skip any failing run that has
    // a strictly-later same-name SUCCESS. What's left is a genuinely-live failure
    // (PostHog#64614); restore it with its failing detailsUrl so the pill links
    // to the failure, not a re-run.
    const latestSuccessTsByName = new Map<string, number>();
    for (const c of contexts) {
      if (c.state !== 'success') continue;
      const prev = latestSuccessTsByName.get(c.name);
      if (prev === undefined || c.ts > prev) latestSuccessTsByName.set(c.name, c.ts);
    }
    const failingUrlByName = new Map<string, string | null>();
    for (const c of contexts) {
      if (c.state !== 'failure' || failingUrlByName.has(c.name)) continue;
      const supersededAt = latestSuccessTsByName.get(c.name);
      if (supersededAt !== undefined && supersededAt > c.ts) continue;
      failingUrlByName.set(c.name, c.url);
    }
    if (failingUrlByName.size > 0) {
      normalized = normalized.map((c) =>
        failingUrlByName.has(c.name)
          ? { ...c, state: 'failure', url: failingUrlByName.get(c.name) ?? c.url }
          : c
      );
    }
  } else if (rollupState === 'SUCCESS' && dedupedFailed) {
    // Mirror image: GitHub's rollup is green, yet latest-per-name still holds a
    // failure. GitHub's SUCCESS rollup counts zero failing contexts, so that
    // run is one it excludes — a superseded/STALE re-run, or a conclusion we
    // map conservatively to `failure` — not a real failure. Demote it to
    // skipped so a green PR can't show a phantom "N failing"
    // (PostHog/posthog#65121).
    normalized = normalized.map((c) =>
      c.state === 'failure' ? { ...c, state: 'skipped' } : c
    );
  }
  const checks: CheckBreakdown = {
    total: normalized.length,
    passed: normalized.filter((c) => c.state === 'success').length,
    failed: normalized.filter((c) => c.state === 'failure').length,
    inProgress: normalized.filter(
      (c) => c.state === 'in_progress' || c.state === 'pending'
    ).length,
    skipped: normalized.filter((c) => c.state === 'skipped').length,
  };
  return { normalized, checks };
}

// ---------- GraphQL query construction ----------

// Root-level `rateLimit` block, spliced alongside `repository` in every query.
// Asking for it costs 0 points and lets `executeGraphql` track the per-account
// points budget off the response (see graphqlBudget). Indented two spaces to
// sit as a sibling of `repository` inside the query body.
const RATE_LIMIT_FIELD = '  rateLimit { limit cost remaining resetAt }';

/**
 * Build the per-chunk query. Each branch becomes one aliased
 * sub-selection on `repository.pullRequests` (states: [OPEN], first: 1,
 * head order). Aliases must be valid GraphQL identifiers — we hash the
 * branch name to a stable safe alias.
 */
// Selection for one statusCheckRollup context node. A function (not a
// constant) so callers that know the PR number can ask GitHub whether
// each context `isRequired` for that PR — the authoritative signal for
// "does this failing check actually block the merge". `numberExpr` is
// spliced verbatim into the query (a literal int from a by-number query,
// or the `$number` variable from the contexts-pagination query); pass
// null when the number isn't known (the by-branch batch path), and we
// fall back to inferring required-ness from mergeStateStatus.
function contextNodeFields(numberExpr: string | null): string {
  const required = numberExpr
    ? `\n                isRequired(pullRequestNumber: ${numberExpr})`
    : '';
  return `__typename
              ... on CheckRun {
                id
                name
                status
                conclusion
                detailsUrl
                startedAt
                completedAt${required}
              }
              ... on StatusContext {
                id
                context
                state
                description
                targetUrl
                createdAt${required}
              }`;
}

// The PullRequest field selection, inlined per query alias. Was a shared
// `fragment PRFields`, but `isRequired` needs a per-alias PR number, which
// a single fragment can't carry — so the contexts selection is
// parameterised on `numberExpr` and the whole body is inlined instead.
function prFieldsSelection(numberExpr: string | null): string {
  return `number
  id
  title
  body
  url
  isDraft
  state
  mergedAt
  closedAt
  createdAt
  updatedAt
  mergeable
  mergeStateStatus
  reviewDecision
  viewerCanEnableAutoMerge
  autoMergeRequest { enabledAt enabledBy { login } mergeMethod }
  author { login }
  labels(first: 30) { nodes { name } }
  reviewRequests(first: 50) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        ... on Team { slug name combinedSlug }
      }
    }
  }
  headRefName
  baseRefName
  headRefOid
  reviews(last: 5) {
    nodes { id author { login } state submittedAt url }
  }
  reviewThreads(last: 5) {
    nodes {
      comments(last: 1) {
        nodes { id author { login __typename } createdAt url bodyText }
      }
    }
  }
  unresolvedThreads: reviewThreads(first: 100) {
    nodes {
      isResolved
      # The thread's OPENING comment names who started it. Deliberately paid
      # for on every poll: without it an unresolved thread is just a count, and
      # a bot's nit and a human reviewer's question are indistinguishable — so
      # the watcher could not tell a PR that needs an agent from a conversation
      # between people. See prNeedsFollowup.
      comments(first: 1) { nodes { author { login __typename } } }
    }
  }
  comments(last: 5) {
    nodes { id author { login __typename } createdAt url bodyText }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 100) {
            nodes {
              ${contextNodeFields(numberExpr)}
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }`;
}

export function makeBatchPullRequestsQuery(
  branches: string[],
  numbers?: number[]
): string {
  const aliasFields = branches
    .map((branch, idx) => {
      const alias = aliasForBranch(idx);
      // Escape branch names safely as JSON strings inside the GraphQL doc.
      const head = JSON.stringify(branch);
      // When the caller knows each branch's PR number (single-PR detail /
      // cache fetches), inline it so the contexts carry `isRequired`.
      const numberExpr =
        numbers && numbers[idx] != null ? String(numbers[idx]) : null;
      return `    ${alias}: pullRequests(headRefName: ${head}, first: 1, states: [OPEN]) {
      nodes { ${prFieldsSelection(numberExpr)} }
    }`;
    })
    .join('\n');

  return `query BatchPullRequests($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${aliasFields}
  }
${RATE_LIMIT_FIELD}
}`;
}

/**
 * Same as makeBatchPullRequestsQuery but keyed by PR number instead of
 * branch — `pullRequest(number:)` resolves to a single node (no
 * `states` filter, so it also returns merged/closed PRs). Used by the
 * search-driven monitor, where we know numbers but not head refs.
 */
export function makeBatchPullRequestsByNumberQuery(numbers: number[]): string {
  const aliasFields = numbers
    .map((number, idx) => {
      const alias = aliasForBranch(idx);
      return `    ${alias}: pullRequest(number: ${number}) {
      ${prFieldsSelection(String(number))}
    }`;
    })
    .join('\n');

  return `query BatchPullRequestsByNumber($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${aliasFields}
  }
${RATE_LIMIT_FIELD}
}`;
}

export function aliasForBranch(idx: number): string {
  return `b${idx}`;
}

// ---------- GraphQL response decoding ----------

interface BatchPullRequestsResponse {
  repository: Record<string, { nodes: Array<RawPullRequest> }> | null;
}

interface BatchByNumberResponse {
  repository: Record<string, RawPullRequest | null> | null;
}

export function decodeBatchByNumberResponse(
  numbers: number[],
  data: BatchByNumberResponse,
  owner: string,
  repo: string
): BatchPRByNumberResult[] {
  if (!data.repository) {
    return numbers.map((number) => ({ number, pr: null }));
  }
  return numbers.map((number, idx) => {
    const alias = aliasForBranch(idx);
    const node = data.repository?.[alias];
    if (!node) return { number, pr: null };
    return { number, pr: rawToSummary(node, owner, repo) };
  });
}

interface RawPullRequest {
  number: number;
  /** PR GraphQL node id — required by the auto-merge mutations. */
  id?: string;
  title: string;
  body: string | null;
  url: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: ReviewDecision;
  viewerCanEnableAutoMerge?: boolean;
  autoMergeRequest?: {
    enabledAt: string | null;
    enabledBy: { login: string } | null;
    mergeMethod: string | null;
  } | null;
  author: { login: string } | null;
  labels?: { nodes: Array<{ name: string }> } | null;
  reviewRequests: {
    nodes: Array<{
      requestedReviewer:
        | { __typename: 'User'; login: string }
        | { __typename: 'Team'; slug: string; name: string; combinedSlug: string }
        | { __typename: string }
        | null;
    }>;
  };
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  reviews: {
    nodes: Array<{
      id: string;
      author: { login: string } | null;
      state: string;
      submittedAt: string | null;
      url: string;
    }>;
  };
  reviewThreads: {
    nodes: Array<{
      comments: {
        nodes: Array<{
          id: string;
          author: { login: string; __typename?: string } | null;
          createdAt: string;
          url: string;
          bodyText?: string | null;
        }>;
      };
    }>;
  };
  unresolvedThreads: {
    nodes: Array<{
      isResolved: boolean;
      comments?: {
        nodes: Array<{ author: { login: string; __typename?: string } | null }>;
      };
    }>;
  };
  comments: {
    nodes: Array<{
      id: string;
      author: { login: string; __typename?: string } | null;
      createdAt: string;
      url: string;
      bodyText?: string | null;
    }>;
  };
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: {
            nodes: Array<RawCheckContext>;
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      };
    }>;
  };
}

interface RawCheckRun {
  __typename: 'CheckRun';
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Whether GitHub marks this check required for the PR. Present only
   *  when the query was built with a PR number; absent (undefined) on the
   *  by-branch path. */
  isRequired?: boolean | null;
}

interface RawStatusContext {
  __typename: 'StatusContext';
  id: string;
  context: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
  createdAt: string | null;
  isRequired?: boolean | null;
}

type RawCheckContext = RawCheckRun | RawStatusContext;

export function decodeBatchResponse(
  branches: string[],
  data: BatchPullRequestsResponse,
  owner: string,
  repo: string
): BatchPRResult[] {
  if (!data.repository) {
    // Repo deleted, renamed, or visibility changed. Map every branch
    // to "no PR found" rather than crashing the whole batch.
    return branches.map((branch) => ({ branch, pr: null }));
  }
  return branches.map((branch, idx) => {
    const alias = aliasForBranch(idx);
    const node = data.repository?.[alias]?.nodes?.[0];
    if (!node) return { branch, pr: null };
    return { branch, pr: rawToSummary(node, owner, repo) };
  });
}

function rawToSummary(raw: RawPullRequest, owner: string, repo: string): PRSummary {
  const rollup = raw.commits.nodes[0]?.commit.statusCheckRollup;
  const contexts = rollup?.contexts.nodes ?? [];
  const contextsWithTs = contexts.map((c) => {
    const isCheckRun = c.__typename === 'CheckRun';
    return {
      name: isCheckRun ? c.name : c.context,
      state: normalizeCheckState(
        isCheckRun ? { status: c.status, conclusion: c.conclusion } : { state: c.state }
      ),
      url: (isCheckRun ? c.detailsUrl : c.targetUrl) ?? null,
      // `isRequired` is only in the response when the query carried a PR
      // number; normalise missing → null ("unknown").
      required: typeof c.isRequired === 'boolean' ? c.isRequired : null,
      // Newest event on the run — lets us keep the latest of same-name runs.
      ts: isCheckRun
        ? latestTimestamp([c.startedAt, c.completedAt])
        : latestTimestamp([c.createdAt]),
    };
  });
  // Collapse same-name re-runs to GitHub's latest-per-name view, but defer to
  // GitHub's authoritative rollup state so a superseded-but-still-counted
  // failure can't read as "Ready" (see summarizeCheckContexts).
  const { normalized: normalizedContexts, checks } = summarizeCheckContexts(
    contextsWithTs,
    rollup?.state
  );
  // Required-ness is authoritative only if we know it for every failing
  // check (a partially-paginated by-branch fetch could mix known + null);
  // otherwise fall back to the mergeStateStatus heuristic.
  const failingContexts = normalizedContexts.filter((c) => c.state === 'failure');
  const requiredDataAvailable =
    failingContexts.length === 0 || failingContexts.every((c) => c.required !== null);
  const requiredFailing = failingContexts.filter((c) => c.required === true).length;
  const blockingReason = computeBlockingReason({
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision,
    checks,
    requiredFailing,
    requiredDataAvailable,
  });
  // Split by who OPENED the thread. The distinction is load-bearing, not
  // decorative: a bot's nit is work an agent should pick up unattended, while a
  // human reviewer's question is a conversation an agent should not be starting
  // a paid run over. `prNeedsFollowup` acts on the bot count alone.
  //
  // An author we cannot read (a deleted account, or a thread whose opening
  // comment did not come back) counts as HUMAN. That is the conservative
  // direction: the failure mode is a thread the agent leaves alone, not one it
  // wades into uninvited.
  const unresolved = (raw.unresolvedThreads?.nodes ?? []).filter((t) => !t.isResolved);
  const unresolvedReviewThreads = unresolved.length;
  const unresolvedBotReviewThreads = unresolved.filter((t) => {
    const author = t.comments?.nodes?.[0]?.author;
    return author ? isBotActor(author) : false;
  }).length;
  const unresolvedHumanReviewThreads = unresolvedReviewThreads - unresolvedBotReviewThreads;
  const reviewRequests = {
    users: [] as string[],
    teams: [] as Array<{ slug: string; name: string; combinedSlug: string }>,
  };
  for (const node of raw.reviewRequests?.nodes ?? []) {
    const rr = node.requestedReviewer;
    if (!rr) continue;
    if (rr.__typename === 'User') {
      reviewRequests.users.push((rr as { login: string }).login);
    } else if (rr.__typename === 'Team') {
      const t = rr as { slug: string; name: string; combinedSlug: string };
      reviewRequests.teams.push({ slug: t.slug, name: t.name, combinedSlug: t.combinedSlug });
    }
  }
  const state: PRState = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open';
  const recentReviews = raw.reviews.nodes
    .slice()
    .reverse() // GitHub returns last:N oldest-first; we want freshest first
    .map((r) => ({
      id: r.id,
      author: r.author?.login ?? '',
      state: r.state,
      submittedAt: r.submittedAt,
      url: r.url,
    }));
  const effectiveReviewDecision = deriveEffectiveReviewDecision({
    reviewDecision: raw.reviewDecision,
    recentReviews,
    reviewRequests,
  });
  return {
    owner,
    repo,
    number: raw.number,
    nodeId: raw.id,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    author: raw.author?.login ?? '',
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
    draft: raw.isDraft,
    state,
    mergedAt: raw.mergedAt,
    closedAt: raw.closedAt,
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    headSha: raw.headRefOid,
    autoMergeBy: raw.autoMergeRequest?.enabledBy?.login ?? null,
    viewerCanEnableAutoMerge: raw.viewerCanEnableAutoMerge,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision,
    effectiveReviewDecision,
    blockingReason,
    checks,
    unresolvedReviewThreads,
    unresolvedHumanReviewThreads,
    unresolvedBotReviewThreads,
    reviewRequests,
    checkContexts: normalizedContexts,
    checkDigest: computeCheckDigest(raw.headRefOid, normalizedContexts),
    failingChecksDigest: computeFailingChecksDigest(normalizedContexts),
    recentReviews,
    recentReviewComments: raw.reviewThreads.nodes
      .flatMap((thread) => thread.comments.nodes)
      .slice()
      .reverse()
      .slice(0, 5)
      .map((c) => ({
        id: c.id,
        author: c.author?.login ?? '',
        authorIsBot: isBotActor(c.author),
        bodyText: c.bodyText ?? '',
        createdAt: c.createdAt,
        url: c.url,
      })),
    recentComments: raw.comments.nodes
      .slice()
      .reverse()
      .map((c) => ({
        id: c.id,
        author: c.author?.login ?? '',
        authorIsBot: isBotActor(c.author),
        bodyText: c.bodyText ?? '',
        createdAt: c.createdAt,
        url: c.url,
      })),
  };
}

/**
 * Whether a comment author is a GitHub App / bot rather than a person.
 * GitHub marks App actors with `__typename: 'Bot'`; the `[bot]` login
 * suffix is the canonical fallback for cases where typename is absent.
 */
function isBotActor(
  author: { login: string; __typename?: string } | null | undefined
): boolean {
  if (!author) return false;
  if (author.__typename === 'Bot') return true;
  return author.login.endsWith('[bot]');
}

// ---------- Full review detail (Reviews tab) ----------
//
// The summary path keeps only the last 5 of each kind (delta detection).
// The detail panel's Reviews tab wants the full, GitHub-like picture:
// every submitted review with its body, every inline review thread
// (grouped, with the diff hunk + resolved state), and the top-level
// conversation comments — all with author avatars and markdown bodies.

export interface PRReviewDetailReview {
  id: string;
  author: string;
  avatarUrl: string | null;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED. */
  state: string;
  body: string;
  submittedAt: string | null;
  url: string;
}

export interface PRReviewThreadComment {
  id: string;
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface PRReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  /** Diff context for the thread (from its first comment). */
  diffHunk: string | null;
  comments: PRReviewThreadComment[];
}

export interface PRConversationComment {
  id: string;
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface PRReviewDetail {
  reviews: PRReviewDetailReview[];
  threads: PRReviewThread[];
  comments: PRConversationComment[];
}

interface RawReviewDetailResponse {
  repository: {
    pullRequest: {
      reviews: {
        nodes: Array<{
          id: string;
          author: { login: string; avatarUrl: string | null } | null;
          state: string;
          body: string | null;
          submittedAt: string | null;
          url: string;
        }>;
      };
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          path: string | null;
          line: number | null;
          comments: {
            nodes: Array<{
              id: string;
              author: { login: string; avatarUrl: string | null } | null;
              body: string | null;
              diffHunk: string | null;
              createdAt: string;
              url: string;
            }>;
          };
        }>;
      };
      comments: {
        nodes: Array<{
          id: string;
          author: { login: string; avatarUrl: string | null } | null;
          body: string | null;
          createdAt: string;
          url: string;
        }>;
      };
    } | null;
  } | null;
}

const REVIEW_DETAIL_QUERY = `query PRReviewDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 50) {
        nodes { id author { login avatarUrl } state body submittedAt url }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes { id author { login avatarUrl } body diffHunk createdAt url }
          }
        }
      }
      comments(first: 100) {
        nodes { id author { login avatarUrl } body createdAt url }
      }
    }
  }
${RATE_LIMIT_FIELD}
}`;

/**
 * Fetch the full review/comment thread for a PR for the detail panel's
 * Reviews tab. One GraphQL round-trip; decoded into a GitHub-like shape
 * (reviews timeline + grouped inline threads + conversation comments).
 */
export async function fetchPRReviewDetail(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<PRReviewDetail> {
  const data = await githubService.executeGraphql<RawReviewDetailResponse>(
    opts.workspaceId,
    REVIEW_DETAIL_QUERY,
    { owner: opts.owner, repo: opts.repo, number: opts.number }
  );
  return decodeReviewDetail(data);
}

export function decodeReviewDetail(data: RawReviewDetailResponse): PRReviewDetail {
  const pr = data.repository?.pullRequest;
  if (!pr) return { reviews: [], threads: [], comments: [] };

  const reviews: PRReviewDetailReview[] = pr.reviews.nodes
    // A COMMENTED review with no body is just a container for inline
    // comments (rendered as threads below) — drop it to cut noise.
    .filter((r) => {
      const state = (r.state || '').toUpperCase();
      if (state === 'PENDING') return false;
      if (state === 'COMMENTED') return Boolean(r.body && r.body.trim());
      return true;
    })
    .map((r) => ({
      id: r.id,
      author: r.author?.login ?? 'unknown',
      avatarUrl: r.author?.avatarUrl ?? null,
      state: (r.state || '').toUpperCase(),
      body: r.body ?? '',
      submittedAt: r.submittedAt,
      url: r.url,
    }))
    .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));

  const threads: PRReviewThread[] = pr.reviewThreads.nodes
    .map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line,
      diffHunk: t.comments.nodes[0]?.diffHunk ?? null,
      comments: t.comments.nodes.map((c) => ({
        id: c.id,
        author: c.author?.login ?? 'unknown',
        avatarUrl: c.author?.avatarUrl ?? null,
        body: c.body ?? '',
        createdAt: c.createdAt,
        url: c.url,
      })),
    }))
    .filter((t) => t.comments.length > 0)
    // Unresolved threads first; within each group, oldest first.
    .sort((a, b) => {
      if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1;
      return (a.comments[0]?.createdAt ?? '').localeCompare(
        b.comments[0]?.createdAt ?? ''
      );
    });

  const comments: PRConversationComment[] = pr.comments.nodes
    .map((c) => ({
      id: c.id,
      author: c.author?.login ?? 'unknown',
      avatarUrl: c.author?.avatarUrl ?? null,
      body: c.body ?? '',
      createdAt: c.createdAt,
      url: c.url,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return { reviews, threads, comments };
}

// ---------- commit signatures (merge-queue signing gate) ----------

interface UnsignedCommitsResponse {
  repository: {
    pullRequest: {
      commits: {
        totalCount: number;
        nodes: Array<{ commit: { signature: { isValid: boolean } | null } }>;
      };
    } | null;
  } | null;
}

const UNSIGNED_COMMITS_QUERY = `query PRCommitSignatures($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(first: 100) {
        totalCount
        nodes { commit { signature { isValid } } }
      }
    }
  }
${RATE_LIMIT_FIELD}
}`;

/**
 * How many of the PR's commits are unsigned or carry an invalid signature —
 * the signal the merge-queue signing gate acts on. Only the first 100 commits
 * are inspected (agent PRs are far smaller; a >100-commit PR whose tail is
 * unsigned is caught by the queue's 403 safety net). Called ONLY for repos that
 * require signed commits, so most PRs never trigger this query.
 */
export async function fetchUnsignedCommitCount(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<number> {
  const data = await githubService.executeGraphql<UnsignedCommitsResponse>(
    opts.workspaceId,
    UNSIGNED_COMMITS_QUERY,
    { owner: opts.owner, repo: opts.repo, number: opts.number }
  );
  const nodes = data.repository?.pullRequest?.commits.nodes ?? [];
  // A missing/invalid signature both count as "not signed" for the ruleset.
  return nodes.filter((n) => !n.commit.signature?.isValid).length;
}
