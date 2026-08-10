import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { prMonitorService } from '../services/prMonitor.js';
import { githubService } from '../services/github.js';
import * as graphqlModule from '../services/githubGraphql.js';
import * as websocketModule from '../services/websocket.js';
import {
  setFocused,
  markRefreshed,
  setActiveView,
  _resetPrFocus,
  PR_FOCUS_CONSTANTS,
} from '../services/prFocus.js';
import type { PRSummary } from '../services/githubGraphql.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';

// ---------- Helpers ----------

function fakeSummary(over: Partial<PRSummary> = {}): PRSummary {
  return {
    owner: 'acme',
    repo: 'widgets',
    number: 42,
    title: 'Add feature',
    body: '',
    url: 'https://github.com/acme/widgets/pull/42',
    author: 'me',
    draft: false,
    state: 'open',
    mergedAt: null,
    closedAt: null,
    headBranch: 'feature/x',
    baseBranch: 'main',
    headSha: 'sha1',
    updatedAt: '2026-01-01T00:00:00Z',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    blockingReason: 'mergeable',
    checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0,
    checkDigest: 'sha1:',
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
    ...over,
  };
}

// Mock the search-driven discovery: authored PR numbers, the subset the
// user is a requested reviewer on (incl. via team), and the subset they've
// already reviewed. The monitor distinguishes the searches by the
// `author:` / `review-requested:` / `reviewed-by:` qualifier.
function mockSearch(
  authored: number[],
  reviewRequested: number[] = [],
  reviewedBy: number[] = []
) {
  return vi
    .spyOn(githubService, 'searchPullRequestNumbers')
    .mockImplementation(async (_ws: string, q: string) => {
      if (q.includes('reviewed-by:')) return reviewedBy;
      if (q.includes('review-requested:')) return reviewRequested;
      if (q.includes('author:')) return authored;
      return [];
    });
}

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({
    id: 'ws1',
    ownerId: TEST_USER_ID,
    name: 'ws',
    settings: {},
  });
  await db.insert(repositoriesTable).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: 'acme/widgets',
    url: 'https://github.com/acme/widgets',
    defaultBranch: 'main',
  });
}

describe('prMonitor — poll orchestration', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);

    // Default mocks: ws1 is connected, current user is "me".
    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue(['ws1']);
    vi.spyOn(githubService, 'getUser').mockResolvedValue({
      id: 1,
      login: 'me',
      name: 'Me',
      avatar_url: 'x',
      email: null,
    });
    // Drop any cached login from previous tests — the service is a
    // singleton so the cache survives across cases.
    prMonitorService.invalidateUserLogin('ws1');
    // Same for the focus registry — singletons across tests.
    _resetPrFocus();
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  /**
   * A renamed repo must be followed, not reported as a permissions problem.
   *
   * The search API has no redirect: `repo:acme/widgets` simply stops matching
   * once the repo is renamed, and the failure comes back as "Could not resolve
   * to a Repository" — the same string a repo the App cannot see produces. So a
   * rename was reported as "the GitHub App has no access to <repo> — grant it
   * on GitHub", asking for a permission grant that could never have fixed it.
   * Gilbert09/owl sat in production logs saying exactly that.
   */
  it('follows a renamed repo instead of reporting it as a missing grant', async () => {
    vi.spyOn(githubService, 'searchPullRequestNumbers').mockRejectedValue(
      new Error('Could not resolve to a Repository with the name acme/widgets.')
    );
    // REST redirects a rename, so the repo lookup answers with the new name.
    const repoSpy = vi.spyOn(githubService, 'getRepository').mockResolvedValue({
      id: 1,
      name: 'gadgets',
      full_name: 'acme/gadgets',
      private: false,
      html_url: 'https://github.com/acme/gadgets',
      default_branch: 'main',
      owner: { login: 'acme', avatar_url: 'x' },
    } as Awaited<ReturnType<typeof githubService.getRepository>>);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await prMonitorService.forcePoll();

    expect(repoSpy).toHaveBeenCalled();
    const rows = await db.select().from(repositoriesTable);
    const row = rows.find((r) => r.id === 'repo1');
    // Same row id: PRs already tracked against it stay attached.
    expect(row?.name).toBe('acme/gadgets');
    expect(row?.url).toBe('https://github.com/acme/gadgets');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('has no access');
  });

  it('still reports a genuinely inaccessible repo as a missing grant', async () => {
    vi.spyOn(githubService, 'searchPullRequestNumbers').mockRejectedValue(
      new Error('Resource not accessible by integration')
    );
    // The probe fails too — the repo really is out of reach.
    vi.spyOn(githubService, 'getRepository').mockRejectedValue(new Error('Not Found'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await prMonitorService.forcePoll();

    expect(warn.mock.calls.flat().join(' ')).toContain('has no access');
    const rows = await db.select().from(repositoriesTable);
    expect(rows.find((r) => r.id === 'repo1')?.name).toBe('acme/widgets');
  });

  it('does nothing when there are no connected workspaces', async () => {
    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue([]);
    const searchSpy = vi.spyOn(githubService, 'searchPullRequestNumbers');
    const graphqlSpy = vi.spyOn(graphqlModule, 'batchPullRequestsByNumber');
    await prMonitorService.forcePoll();
    expect(searchSpy).not.toHaveBeenCalled();
    expect(graphqlSpy).not.toHaveBeenCalled();
  });

  it('searches the user\'s authored PRs and batches them by number', async () => {
    mockSearch([1, 3]);
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequestsByNumber')
      .mockResolvedValue([
        { number: 1, pr: fakeSummary({ number: 1, headBranch: 'feature/a' }) },
        { number: 3, pr: fakeSummary({ number: 3, headBranch: 'feature/c' }) },
      ]);

    await prMonitorService.forcePoll();

    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    // The two authored PR numbers should be in the batch.
    const numbers = graphqlSpy.mock.calls[0][0].numbers;
    expect(numbers.sort()).toEqual([1, 3]);

    const rows = await db.select().from(pullRequestsTable);
    expect(rows.map((r) => r.number).sort()).toEqual([1, 3]);
  });

  it('also watches PRs where the user is a requested reviewer and flags them', async () => {
    // #1 authored by me; #2 someone else's PR awaiting my review.
    mockSearch([1], [2]);
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 1, pr: fakeSummary({ number: 1, headBranch: 'feature/a', author: 'me' }) },
      { number: 2, pr: fakeSummary({ number: 2, headBranch: 'feature/b', author: 'someone-else' }) },
    ]);

    await prMonitorService.forcePoll();

    const rows = await db.select().from(pullRequestsTable);
    const byNumber = Object.fromEntries(rows.map((r) => [r.number, r.reviewRequested]));
    expect(Object.keys(byNumber).map(Number).sort()).toEqual([1, 2]);
    expect(byNumber[1]).toBe(false);
    expect(byNumber[2]).toBe(true);
    // #1 is mine, #2 is someone else's awaiting my review.
    const authoredByNumber = Object.fromEntries(rows.map((r) => [r.number, r.authored]));
    expect(authoredByNumber[1]).toBe(true);
    expect(authoredByNumber[2]).toBe(false);
  });

  it('does not flag a review-requested PR I have already reviewed (e.g. approved)', async () => {
    // #2 and #3 are both review-requested (GitHub keeps a team request
    // standing), but I've already reviewed #3 — so only #2 is pending.
    mockSearch([], [2, 3], [3]);
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 2, pr: fakeSummary({ number: 2, headBranch: 'feature/b', author: 'someone-else' }) },
      { number: 3, pr: fakeSummary({ number: 3, headBranch: 'feature/c', author: 'someone-else' }) },
    ]);

    await prMonitorService.forcePoll();

    const rows = await db.select().from(pullRequestsTable);
    const byNumber = Object.fromEntries(rows.map((r) => [r.number, r.reviewRequested]));
    expect(byNumber[2]).toBe(true);
    expect(byNumber[3]).toBe(false);
  });

  it('reconciles a stale review flag once I review the PR, without a refetch', async () => {
    let reviewed: number[] = [];
    vi.spyOn(githubService, 'searchPullRequestNumbers').mockImplementation(
      async (_ws: string, q: string) => {
        if (q.includes('reviewed-by:')) return reviewed;
        if (q.includes('review-requested:')) return [5];
        if (q.includes('author:')) return [];
        return [];
      }
    );
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 5, pr: fakeSummary({ number: 5, headBranch: 'feature/e', author: 'someone-else' }) },
    ]);

    // First poll: #5 awaits my review.
    await prMonitorService.forcePoll();
    let row = (await db.select().from(pullRequestsTable)).find((r) => r.number === 5);
    expect(row?.reviewRequested).toBe(true);

    // I review it. #5 is still team-requested (still in review-requested)
    // and fresh (within TTL → no GraphQL refetch), but the reconcile pass
    // must still clear the flag off the back of reviewed-by.
    reviewed = [5];
    await prMonitorService.forcePoll();
    row = (await db.select().from(pullRequestsTable)).find((r) => r.number === 5);
    expect(row?.reviewRequested).toBe(false);
  });

  it('skips the GraphQL call entirely when every cached row is still fresh', async () => {
    // Seed an "already polled" row.
    await db.insert(pullRequestsTable).values({
      id: 'pr-fresh',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 1,
      state: 'open',
      lastPolledAt: new Date(),
      lastSummary: { headBranch: 'feature/a' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSearch([1]);
    const graphqlSpy = vi.spyOn(graphqlModule, 'batchPullRequestsByNumber');

    await prMonitorService.forcePoll();
    expect(graphqlSpy).not.toHaveBeenCalled();
  });

  it('refetches only stale rows when some are fresh and others are not', async () => {
    // Seed a fresh row for #1 and a stale row for #2.
    const fresh = new Date();
    const stale = new Date(Date.now() - 120_000); // older than DEFAULT_TTL_MS (60s)
    await db.insert(pullRequestsTable).values([
      {
        id: 'pr-fresh',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'acme',
        repo: 'widgets',
        number: 1,
        state: 'open',
        lastPolledAt: fresh,
        lastSummary: { headBranch: 'feature/a' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'pr-stale',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'acme',
        repo: 'widgets',
        number: 2,
        state: 'open',
        lastPolledAt: stale,
        lastSummary: { headBranch: 'feature/b' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockSearch([1, 2]);
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequestsByNumber')
      .mockResolvedValue([
        { number: 2, pr: fakeSummary({ number: 2, headBranch: 'feature/b' }) },
      ]);

    await prMonitorService.forcePoll();
    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    expect(graphqlSpy.mock.calls[0][0].numbers).toEqual([2]);
  });

  it('marks tracked rows that disappear from the open-list as merged when GitHub says so', async () => {
    // Seed two open rows.
    await db.insert(pullRequestsTable).values([
      {
        id: 'pr-1',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'acme',
        repo: 'widgets',
        number: 1,
        state: 'open',
        lastPolledAt: new Date(),
        lastSummary: { headBranch: 'feature/a' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'pr-2',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'acme',
        repo: 'widgets',
        number: 2,
        state: 'open',
        lastPolledAt: new Date(),
        lastSummary: { headBranch: 'feature/b' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    // The user merged #2 — it's gone from the search results.
    mockSearch([1]);
    // The sweep resolves merged/closed via the batched GraphQL lookup now.
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      {
        number: 2,
        pr: fakeSummary({
          number: 2,
          headBranch: 'feature/b',
          state: 'merged',
          mergedAt: '2026-01-02T00:00:00Z',
        }),
      },
    ]);

    await prMonitorService.forcePoll();

    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, 'pr-2'));
    expect(rows[0].state).toBe('merged');
    expect(rows[0].mergedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('emits pull_request:updated when a PR leaves open, so the list drops it live', async () => {
    await db.insert(pullRequestsTable).values({
      id: 'pr-2',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 2,
      state: 'open',
      lastPolledAt: new Date(),
      lastSummary: { headBranch: 'feature/b' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // #2 auto-merged upstream — gone from the search, GitHub reports merged.
    mockSearch([]);
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      {
        number: 2,
        pr: fakeSummary({
          number: 2,
          headBranch: 'feature/b',
          state: 'merged',
          mergedAt: '2026-01-02T00:00:00Z',
        }),
      },
    ]);
    const emitSpy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');

    await prMonitorService.forcePoll();

    const merged = emitSpy.mock.calls.find(
      ([, payload]) => payload.id === 'pr-2' && payload.state === 'merged'
    );
    expect(merged).toBeDefined();
  });

  it('marks tracked rows as closed when GitHub reports closed (not merged)', async () => {
    await db.insert(pullRequestsTable).values({
      id: 'pr-2',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 2,
      state: 'open',
      lastPolledAt: new Date(),
      lastSummary: { headBranch: 'feature/b' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSearch([]);
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 2, pr: fakeSummary({ number: 2, headBranch: 'feature/b', state: 'closed' }) },
    ]);

    await prMonitorService.forcePoll();

    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, 'pr-2'));
    expect(rows[0].state).toBe('closed');
    expect(rows[0].mergedAt).toBeNull();
  });

  // A queued PR that merges upstream must not keep its queue bookkeeping:
  // stale flags once left a merged head holding the "#1" slot while being
  // invisible to the processor's open-only select, stalling the whole group.
  it('clears merge-queue flags and rebroadcasts positions when a queued PR merges upstream', async () => {
    await db.insert(pullRequestsTable).values([
      {
        id: 'pr-2',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'acme',
        repo: 'widgets',
        number: 2,
        state: 'open',
        mergeQueued: true,
        mergeQueuedAt: new Date('2026-01-01T00:00:00Z'),
        mergeQueueState: { status: 'merging', attempts: 0, accounted: true },
        lastPolledAt: new Date(),
        lastSummary: { headBranch: 'feature/b', baseBranch: 'main' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        // The queued sibling behind pr-2 — still open, currently "#2".
        id: 'pr-3',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'acme',
        repo: 'widgets',
        number: 3,
        state: 'open',
        mergeQueued: true,
        mergeQueuedAt: new Date('2026-01-01T00:01:00Z'),
        mergeQueueState: { status: 'waiting', attempts: 0, accounted: true },
        lastPolledAt: new Date(),
        lastSummary: { headBranch: 'feature/c', baseBranch: 'main' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    // pr-2 merged upstream (gone from the search); pr-3 still open and seen.
    mockSearch([3]);
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      {
        number: 2,
        pr: fakeSummary({
          number: 2,
          headBranch: 'feature/b',
          baseBranch: 'main',
          state: 'merged',
          mergedAt: '2026-01-02T00:00:00Z',
        }),
      },
    ]);
    const emitSpy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');

    await prMonitorService.forcePoll();

    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, 'pr-2'));
    expect(rows[0].state).toBe('merged');
    expect(rows[0].mergeQueued).toBe(false);
    expect(rows[0].mergeQueuedAt).toBeNull();
    expect(rows[0].mergeQueueState).toBeNull();

    // The sweep emit tells the desktop the row left both the list AND the queue.
    const swept = emitSpy.mock.calls.find(
      ([, payload]) => payload.id === 'pr-2' && payload.state === 'merged'
    );
    expect(swept).toBeDefined();
    expect(swept?.[1].mergeQueued).toBe(false);
    expect(swept?.[1].mergeQueueState).toBeNull();

    // The surviving sibling was promoted live: #2 → #1.
    const promoted = emitSpy.mock.calls
      .filter(([, payload]) => payload.id === 'pr-3')
      .map(([, payload]) => payload.mergeQueueState as { position?: number } | null)
      .filter(Boolean)
      .pop();
    expect(promoted?.position).toBe(1);
  });

  it('leaves a still-open PR untouched when it drops off the watch list (reviewed)', async () => {
    // A review-requested PR we tracked, then the user reviewed it so it
    // fell out of requested_reviewers — but it's still OPEN on GitHub.
    await db.insert(pullRequestsTable).values({
      id: 'pr-rev',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 2,
      state: 'open',
      reviewRequested: true,
      lastPolledAt: new Date(),
      lastSummary: { headBranch: 'feature/b' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSearch([]);
    // Still OPEN on GitHub — the batched sweep lookup reports it open, so the
    // row is left untouched.
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 2, pr: fakeSummary({ number: 2, headBranch: 'feature/b', state: 'open' }) },
    ]);

    await prMonitorService.forcePoll();

    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, 'pr-rev'));
    expect(rows[0].state).toBe('open');
  });

  it('leaves a fallen-out row untouched when the sweep batch lookup fails (retries next tick, never mass-closes)', async () => {
    await db.insert(pullRequestsTable).values({
      id: 'pr-2',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 2,
      state: 'open',
      lastPolledAt: new Date(),
      lastSummary: { headBranch: 'feature/b' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSearch([]);
    // A transient failure of the single batched lookup must NOT flip the row —
    // batching means one error would otherwise mass-close every fallen-out PR.
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockRejectedValue(
      new Error('rate limit')
    );

    await prMonitorService.forcePoll();

    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, 'pr-2'));
    expect(rows[0].state).toBe('open');
  });

  it('isolates per-workspace failures (one repo throwing does not stop others)', async () => {
    await db.insert(repositoriesTable).values({
      id: 'repo2',
      workspaceId: 'ws1',
      name: 'acme/other',
      url: 'https://github.com/acme/other',
      defaultBranch: 'main',
    });
    // The search query embeds `repo:acme/widgets` etc, so we branch on it.
    vi.spyOn(githubService, 'searchPullRequestNumbers').mockImplementation(
      async (_ws: string, q: string) => {
        if (q.includes('acme/widgets')) throw new Error('rate limit');
        if (q.includes('author:')) return [1];
        return [];
      }
    );
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 1, pr: fakeSummary({ number: 1, headBranch: 'feature/a' }) },
    ]);

    await prMonitorService.forcePoll();
    // The healthy repo's PR row landed despite the other repo throwing.
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.repositoryId, 'repo2'));
    expect(rows).toHaveLength(1);
  });

  it('focused PRs refetch at 30s; unfocused stay quiet for 60s', async () => {
    // Seed a row for #1 (focused) and #2 (unfocused), both polled
    // 45 s ago — focused TTL has expired (30 s) but unfocused (60 s)
    // hasn't.
    const polledAt = new Date(Date.now() - 45_000);
    await db.insert(pullRequestsTable).values([
      {
        id: 'pr-focused',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'acme',
        repo: 'widgets',
        number: 1,
        state: 'open',
        lastPolledAt: polledAt,
        lastSummary: { headBranch: 'feature/a' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'pr-unfocused',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'acme',
        repo: 'widgets',
        number: 2,
        state: 'open',
        lastPolledAt: polledAt,
        lastSummary: { headBranch: 'feature/b' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    setFocused('ws1', 'pr-focused');

    mockSearch([1, 2]);
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequestsByNumber')
      .mockResolvedValue([
        { number: 1, pr: fakeSummary({ number: 1, headBranch: 'feature/a' }) },
      ]);

    await prMonitorService.forcePoll();

    // Only the focused PR was batched — unfocused row is still inside
    // its TTL.
    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    expect(graphqlSpy.mock.calls[0][0].numbers).toEqual([1]);
  });

  it('slack-polls the cohort the user is NOT viewing (review PR while on "mine")', async () => {
    // #1 authored, #2 review-requested. Both polled 90 s ago — past the
    // active-cohort TTL (60 s) but inside the slack TTL (5 min). With the
    // view on "mine", only the authored PR should refetch.
    const polledAt = new Date(Date.now() - 90_000);
    await db.insert(pullRequestsTable).values([
      {
        id: 'pr-mine',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'acme',
        repo: 'widgets',
        number: 1,
        state: 'open',
        authored: true,
        reviewRequested: false,
        lastPolledAt: polledAt,
        lastSummary: { headBranch: 'feature/a' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'pr-review',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'acme',
        repo: 'widgets',
        number: 2,
        state: 'open',
        authored: false,
        reviewRequested: true,
        lastPolledAt: polledAt,
        lastSummary: { headBranch: 'feature/b' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    setActiveView('ws1', 'mine');
    // #1 authored, #2 awaiting my review.
    mockSearch([1], [2]);
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequestsByNumber')
      .mockResolvedValue([
        { number: 1, pr: fakeSummary({ number: 1, headBranch: 'feature/a' }) },
      ]);

    await prMonitorService.forcePoll();

    // Only the authored PR (active cohort) was refetched; the review PR sits
    // inside its 5-min slack TTL.
    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    expect(graphqlSpy.mock.calls[0][0].numbers).toEqual([1]);
  });

  it('post-refresh cooldown skips a PR even when its TTL has expired', async () => {
    const polledAt = new Date(Date.now() - 90_000); // 90 s ago — past every TTL
    await db.insert(pullRequestsTable).values({
      id: 'pr-cooldown',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 1,
      state: 'open',
      lastPolledAt: polledAt,
      lastSummary: { headBranch: 'feature/a' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // User just hit /refresh — cooldown set.
    markRefreshed('ws1', 'pr-cooldown');

    mockSearch([1]);
    const graphqlSpy = vi.spyOn(graphqlModule, 'batchPullRequestsByNumber');

    await prMonitorService.forcePoll();
    // Cooldown overrode TTL — no GraphQL fetch despite 90 s of staleness.
    expect(graphqlSpy).not.toHaveBeenCalled();

    // Sanity: COOLDOWN_MS is 5 s; this poll should be inside the window.
    expect(PR_FOCUS_CONSTANTS.COOLDOWN_MS).toBe(5_000);
  });

  it('does not re-fetch when forcePoll runs twice with no new state', async () => {
    mockSearch([1]);
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequestsByNumber')
      .mockResolvedValue([
        {
          number: 1,
          pr: fakeSummary({
            number: 1,
            headBranch: 'feature/a',
            recentReviews: [
              { id: 'r1', author: 'alice', state: 'APPROVED', submittedAt: 'now', url: 'x' },
            ],
          }),
        },
      ]);
    await prMonitorService.forcePoll();
    // Second call — TTL still fresh, so the GraphQL summary fetch is skipped.
    await prMonitorService.forcePoll();
    expect(graphqlSpy).toHaveBeenCalledTimes(1);
  });

  // ---------- tracked-open rows that fell out of the search ----------

  it('refreshes a fallen-out tracked-open row once it ages past the untracked TTL', async () => {
    // #9: open, no current relationship (not in any search), last polled
    // 6 min ago — past the 5 min untracked TTL.
    await db.insert(pullRequestsTable).values({
      id: 'pr-untracked',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 9,
      state: 'open',
      reviewRequested: false,
      authored: false,
      lastPolledAt: new Date(Date.now() - 6 * 60_000),
      lastSummary: { headBranch: 'feature/i', title: 'Old title' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSearch([]); // dropped out of authored/review-requested/reviewed-by
    // The main poll refetches the stale fallen-out row (call 1); the closed
    // sweep then makes its own batched state-check (call 2). The mock reports it
    // still open, so sweepClosed leaves the row alone.
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequestsByNumber')
      .mockResolvedValue([
        { number: 9, pr: fakeSummary({ number: 9, headBranch: 'feature/i', title: 'New title' }) },
      ]);

    await prMonitorService.forcePoll();

    expect(graphqlSpy).toHaveBeenCalledTimes(2);
    expect(graphqlSpy.mock.calls[0][0].numbers).toEqual([9]);
    const row = (await db.select().from(pullRequestsTable)).find((r) => r.number === 9);
    expect(row?.state).toBe('open');
    expect((row?.lastSummary as { title: string }).title).toBe('New title');
  });

  it('does not refetch a fallen-out tracked-open row still within the untracked TTL', async () => {
    // 2 min old: a watched PR would refetch (unfocused TTL is 60 s), but an
    // untracked one waits the full 5 min.
    await db.insert(pullRequestsTable).values({
      id: 'pr-untracked-fresh',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 9,
      state: 'open',
      lastPolledAt: new Date(Date.now() - 2 * 60_000),
      lastSummary: { headBranch: 'feature/i' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSearch([]);
    // 2 min old → within the untracked TTL, so the main poll must NOT refetch.
    // The closed-sweep still makes its single batched state-check every tick, so
    // exactly ONE batched call (the sweep), never two.
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequestsByNumber')
      .mockResolvedValue([
        { number: 9, pr: fakeSummary({ number: 9, headBranch: 'feature/i', state: 'open' }) },
      ]);

    await prMonitorService.forcePoll();

    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    expect(graphqlSpy.mock.calls[0][0].numbers).toEqual([9]);
  });

  it('refetches a fallen-out tracked-open row early when the user focuses it', async () => {
    // 90 s old: past the focused TTL (30 s) but well within the untracked
    // TTL (5 min). Focus must win so the open detail sheet stays live.
    await db.insert(pullRequestsTable).values({
      id: 'pr-untracked-focus',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 9,
      state: 'open',
      lastPolledAt: new Date(Date.now() - 90_000),
      lastSummary: { headBranch: 'feature/i' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setFocused('ws1', 'pr-untracked-focus');
    mockSearch([]);
    // Focus forces the main poll to refetch early (call 1); the closed-sweep
    // then makes its batched state-check (call 2). Both target [9].
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequestsByNumber')
      .mockResolvedValue([
        { number: 9, pr: fakeSummary({ number: 9, headBranch: 'feature/i' }) },
      ]);

    await prMonitorService.forcePoll();

    expect(graphqlSpy).toHaveBeenCalledTimes(2);
    expect(graphqlSpy.mock.calls[0][0].numbers).toEqual([9]);
  });

  it('derives reviewRequestVia (direct + my team, excluding others) on upsert', async () => {
    mockSearch([], [5]); // #5 awaiting my review
    vi.spyOn(githubService, 'getViewerTeamSlugs').mockResolvedValue(
      new Set(['acme/frontend'])
    );
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      {
        number: 5,
        pr: fakeSummary({
          number: 5,
          author: 'someone-else',
          reviewRequests: {
            users: ['me'],
            teams: [
              { slug: 'frontend', name: 'Frontend', combinedSlug: 'acme/frontend' },
              { slug: 'platform', name: 'Platform', combinedSlug: 'acme/platform' },
            ],
          },
        }),
      },
    ]);

    await prMonitorService.forcePoll();

    const row = (await db.select().from(pullRequestsTable)).find((r) => r.number === 5);
    const via = (row?.lastSummary as { reviewRequestVia?: unknown }).reviewRequestVia;
    // Directly requested (I'm 'me'), and only my own team is kept.
    expect(via).toEqual({ direct: true, teams: ['acme/frontend'] });
  });

  // ---------- lazy mergeability (UNKNOWN) re-poll ----------

  it('re-queries an open PR with mergeable UNKNOWN until it resolves', async () => {
    vi.useFakeTimers();
    try {
      mockSearch([1]);
      const spy = vi
        .spyOn(graphqlModule, 'batchPullRequestsByNumber')
        // First poll: GitHub hasn't computed mergeability yet.
        .mockResolvedValueOnce([
          { number: 1, pr: fakeSummary({ number: 1, mergeable: 'UNKNOWN', blockingReason: 'unknown' }) },
        ])
        // Retry: it's resolved to a conflict.
        .mockResolvedValueOnce([
          { number: 1, pr: fakeSummary({ number: 1, mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' }) },
        ]);

      const poll = prMonitorService.forcePoll();
      await vi.advanceTimersByTimeAsync(10_000); // cover the backoff(s)
      await poll;

      expect(spy).toHaveBeenCalledTimes(2);
      const [row] = await db.select().from(pullRequestsTable);
      expect((row.lastSummary as { blockingReason: string }).blockingReason).toBe('merge_conflicts');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the retry budget and persists the UNKNOWN result', async () => {
    vi.useFakeTimers();
    try {
      mockSearch([1]);
      const spy = vi
        .spyOn(graphqlModule, 'batchPullRequestsByNumber')
        .mockResolvedValue([
          { number: 1, pr: fakeSummary({ number: 1, mergeable: 'UNKNOWN', blockingReason: 'unknown' }) },
        ]);

      const poll = prMonitorService.forcePoll();
      await vi.advanceTimersByTimeAsync(30_000);
      await poll;

      // 1 initial + 3 retries.
      expect(spy).toHaveBeenCalledTimes(4);
      const [row] = await db.select().from(pullRequestsTable);
      expect((row.lastSummary as { blockingReason: string }).blockingReason).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-query a closed/merged PR that reports UNKNOWN', async () => {
    // Mergeability is meaningless once a PR is merged — no retry, one call.
    mockSearch([1]);
    const spy = vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 1, pr: fakeSummary({ number: 1, state: 'merged', mergeable: 'UNKNOWN', blockingReason: 'unknown' }) },
    ]);

    await prMonitorService.forcePoll();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  // A forced poll must never hang behind a long-running background tick —
  // in prod an unbounded drain left `POST /repositories/poll` pending for the
  // client's full 300s timeout while a throttled tick crawled. The drain is
  // bounded: give up, skip the redundant poll, and let the caller read the
  // cache the in-flight tick is already refreshing.
  describe('bounded drain of an in-flight tick', () => {
    const svc = prMonitorService as unknown as {
      pollGuard: { tryBegin(): boolean; end(): void; readonly active: boolean };
    };

    afterEach(() => {
      svc.pollGuard.end();
      vi.useRealTimers();
    });

    it.each([
      ['forcePoll', () => prMonitorService.forcePoll()],
      ['forcePollWorkspaces', () => prMonitorService.forcePollWorkspaces(['ws1'])],
    ])('%s gives up when the tick outlives the drain window', async (_name, run) => {
      vi.useFakeTimers();
      const searchSpy = mockSearch([1]);
      svc.pollGuard.tryBegin(); // a background tick that never finishes

      const promise = run();
      await vi.advanceTimersByTimeAsync(20_000); // past FORCE_POLL_DRAIN_MS
      await promise;

      expect(searchSpy).not.toHaveBeenCalled();
      expect(svc.pollGuard.active).toBe(true); // we never stole the guard
    });

    it('proceeds once the in-flight tick finishes within the window', async () => {
      vi.useFakeTimers();
      const searchSpy = mockSearch([]);
      svc.pollGuard.tryBegin();

      const promise = prMonitorService.forcePollWorkspaces(['ws1']);
      await vi.advanceTimersByTimeAsync(1_000);
      svc.pollGuard.end(); // tick completes well inside the deadline
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(searchSpy).toHaveBeenCalled();
    });
  });
});
