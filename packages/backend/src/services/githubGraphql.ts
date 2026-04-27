import { githubService } from './github.js';

/**
 * Batched GraphQL fetch for a workspace's PRs, modelled on supacode's
 * `GithubCLIClient.batchPullRequests`.
 *
 * One repo at a time, branches chunked into groups of 25 per query
 * (GitHub's GraphQL endpoint caps argument count and we want a single
 * round-trip per chunk). Up to 3 chunks fire concurrently — same number
 * supacode uses, balances throughput against secondary rate-limit risk.
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

export type CheckState =
  | 'pending'
  | 'in_progress'
  | 'success'
  | 'failure'
  | 'skipped'
  | 'neutral'
  | 'cancelled';

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export type BlockingReason =
  | 'mergeable'
  | 'merge_conflicts'
  | 'changes_requested'
  | 'checks_failed'
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
  title: string;
  body: string;
  url: string;
  author: string;
  draft: boolean;
  state: PRState;
  mergedAt: string | null;
  closedAt: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  updatedAt: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: ReviewDecision;
  blockingReason: BlockingReason;
  checks: CheckBreakdown;
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

const CHUNK_SIZE = 25;
const CONCURRENCY = 3;

export async function batchPullRequests(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  branches: string[];
}): Promise<BatchPRResult[]> {
  const { workspaceId, owner, repo, branches } = opts;
  if (branches.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < branches.length; i += CHUNK_SIZE) {
    chunks.push(branches.slice(i, i + CHUNK_SIZE));
  }

  // Bounded-concurrency runner: never more than CONCURRENCY queries in
  // flight at once. Each chunk is one GraphQL request.
  const results: BatchPRResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const chunk = chunks[idx];
      const query = makeBatchPullRequestsQuery(chunk);
      const data = await githubService.executeGraphql<BatchPullRequestsResponse>(
        workspaceId,
        query,
        { owner, repo }
      );
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

// ---------- Pure helpers (unit-tested) ----------

/**
 * Collapse GitHub's three-axis check signal (`status` / `conclusion` /
 * `state`) into one verdict. Modelled on supacode's
 * `GithubPullRequestStatusCheck.normalize`.
 *
 *   - `status != COMPLETED` → in_progress / pending
 *   - else `conclusion` wins (NEUTRAL/SKIPPED → success-ish; FAILURE →
 *     failure; etc.)
 *   - falls back to legacy `state` for `StatusContext` nodes that don't
 *     have a conclusion.
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
      case 'FAILURE':
      case 'TIMED_OUT':
      case 'STARTUP_FAILURE':
      case 'ACTION_REQUIRED':
        return 'failure';
      case 'CANCELLED':
        return 'cancelled';
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
}): BlockingReason {
  if (input.mergeable === 'CONFLICTING') return 'merge_conflicts';
  if (input.reviewDecision === 'CHANGES_REQUESTED') return 'changes_requested';
  if (input.checks.failed > 0) return 'checks_failed';
  if (input.mergeable === 'MERGEABLE') {
    // A PR can be MERGEABLE but still BLOCKED by branch-protection
    // (e.g. required reviews missing). The mergeStateStatus surfaces
    // that.
    const upper = input.mergeStateStatus.toUpperCase();
    if (upper === 'CLEAN' || upper === 'HAS_HOOKS' || upper === 'UNSTABLE') {
      return 'mergeable';
    }
    if (upper === 'BLOCKED') return 'blocked';
    return 'mergeable';
  }
  // mergeable === 'UNKNOWN' — GitHub hasn't computed it yet (background
  // job). Surface as `unknown` so the UI can show a spinner rather
  // than guessing.
  return 'unknown';
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

// ---------- GraphQL query construction ----------

/**
 * Build the per-chunk query. Each branch becomes one aliased
 * sub-selection on `repository.pullRequests` (states: [OPEN], first: 1,
 * head order). Aliases must be valid GraphQL identifiers — we hash the
 * branch name to a stable safe alias.
 */
export function makeBatchPullRequestsQuery(branches: string[]): string {
  const aliasFields = branches
    .map((branch, idx) => {
      const alias = aliasForBranch(idx);
      // Escape branch names safely as JSON strings inside the GraphQL doc.
      const head = JSON.stringify(branch);
      return `    ${alias}: pullRequests(headRefName: ${head}, first: 1, states: [OPEN]) {
      nodes { ...PRFields }
    }`;
    })
    .join('\n');

  return `query BatchPullRequests($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${aliasFields}
  }
}

fragment PRFields on PullRequest {
  number
  title
  body
  url
  isDraft
  state
  mergedAt
  closedAt
  updatedAt
  mergeable
  mergeStateStatus
  reviewDecision
  author { login }
  headRefName
  baseRefName
  headRefOid
  reviews(last: 5) {
    nodes { id author { login } state submittedAt url }
  }
  reviewThreads(last: 5) {
    nodes {
      comments(last: 1) {
        nodes { id author { login } createdAt url }
      }
    }
  }
  comments(last: 5) {
    nodes { id author { login } createdAt url }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                id
                name
                status
                conclusion
                detailsUrl
                startedAt
                completedAt
                checkSuite { app { name } }
              }
              ... on StatusContext {
                id
                context
                state
                description
                targetUrl
                createdAt
              }
            }
          }
        }
      }
    }
  }
}`;
}

export function aliasForBranch(idx: number): string {
  return `b${idx}`;
}

// ---------- GraphQL response decoding ----------

interface BatchPullRequestsResponse {
  repository: Record<string, { nodes: Array<RawPullRequest> }> | null;
}

interface RawPullRequest {
  number: number;
  title: string;
  body: string | null;
  url: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: ReviewDecision;
  author: { login: string } | null;
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
          author: { login: string } | null;
          createdAt: string;
          url: string;
        }>;
      };
    }>;
  };
  comments: {
    nodes: Array<{
      id: string;
      author: { login: string } | null;
      createdAt: string;
      url: string;
    }>;
  };
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: {
            nodes: Array<RawCheckContext>;
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
  checkSuite: { app: { name: string } | null } | null;
}

interface RawStatusContext {
  __typename: 'StatusContext';
  id: string;
  context: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
  createdAt: string | null;
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
  const contexts =
    raw.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const normalizedContexts = contexts.map((c) => ({
    name: c.__typename === 'CheckRun' ? c.name : c.context,
    state: normalizeCheckState(
      c.__typename === 'CheckRun'
        ? { status: c.status, conclusion: c.conclusion }
        : { state: c.state }
    ),
  }));
  const checks: CheckBreakdown = {
    total: normalizedContexts.length,
    passed: normalizedContexts.filter((c) => c.state === 'success').length,
    failed: normalizedContexts.filter((c) => c.state === 'failure').length,
    inProgress: normalizedContexts.filter(
      (c) => c.state === 'in_progress' || c.state === 'pending'
    ).length,
    skipped: normalizedContexts.filter((c) => c.state === 'skipped').length,
  };
  const blockingReason = computeBlockingReason({
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision,
    checks,
  });
  const state: PRState = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open';
  return {
    owner,
    repo,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    author: raw.author?.login ?? '',
    draft: raw.isDraft,
    state,
    mergedAt: raw.mergedAt,
    closedAt: raw.closedAt,
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    headSha: raw.headRefOid,
    updatedAt: raw.updatedAt,
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision,
    blockingReason,
    checks,
    checkDigest: computeCheckDigest(raw.headRefOid, normalizedContexts),
    recentReviews: raw.reviews.nodes
      .slice()
      .reverse() // GitHub returns last:N oldest-first; we want freshest first
      .map((r) => ({
        id: r.id,
        author: r.author?.login ?? '',
        state: r.state,
        submittedAt: r.submittedAt,
        url: r.url,
      })),
    recentReviewComments: raw.reviewThreads.nodes
      .flatMap((thread) => thread.comments.nodes)
      .slice()
      .reverse()
      .slice(0, 5)
      .map((c) => ({
        id: c.id,
        author: c.author?.login ?? '',
        createdAt: c.createdAt,
        url: c.url,
      })),
    recentComments: raw.comments.nodes
      .slice()
      .reverse()
      .map((c) => ({
        id: c.id,
        author: c.author?.login ?? '',
        createdAt: c.createdAt,
        url: c.url,
      })),
  };
}
