import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { prMonitorService } from '../services/prMonitor.js';
import { githubService } from '../services/github.js';
import * as graphqlModule from '../services/githubGraphql.js';
import {
  setFocused,
  markRefreshed,
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
  inboxItems as inboxItemsTable,
} from '../db/schema.js';

// ---------- Helpers ----------

function fakeRESTPullRequest(over: Partial<{
  number: number;
  title: string;
  userLogin: string;
  headRef: string;
  headSha: string;
}> = {}) {
  return {
    id: 1,
    number: over.number ?? 42,
    title: over.title ?? 'Add feature',
    state: 'open' as const,
    html_url: `https://github.com/acme/widgets/pull/${over.number ?? 42}`,
    user: { login: over.userLogin ?? 'me', avatar_url: 'x' },
    created_at: 'now',
    updated_at: 'now',
    draft: false,
    mergeable: null,
    mergeable_state: 'clean',
    head: { ref: over.headRef ?? 'feature/x', sha: over.headSha ?? 'sha1' },
    base: { ref: 'main' },
  };
}

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
    checkDigest: 'sha1:',
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
    ...over,
  };
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

  it('does nothing when there are no connected workspaces', async () => {
    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue([]);
    const restSpy = vi.spyOn(githubService, 'listPullRequests');
    const graphqlSpy = vi.spyOn(graphqlModule, 'batchPullRequests');
    await prMonitorService.forcePoll();
    expect(restSpy).not.toHaveBeenCalled();
    expect(graphqlSpy).not.toHaveBeenCalled();
  });

  it('filters the open PR list to user-authored only and batches them via GraphQL', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([
      fakeRESTPullRequest({ number: 1, headRef: 'feature/a', userLogin: 'me' }),
      fakeRESTPullRequest({ number: 2, headRef: 'feature/b', userLogin: 'someone-else' }),
      fakeRESTPullRequest({ number: 3, headRef: 'feature/c', userLogin: 'me' }),
    ] as never);
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequests')
      .mockResolvedValue([
        { branch: 'feature/a', pr: fakeSummary({ number: 1, headBranch: 'feature/a' }) },
        { branch: 'feature/c', pr: fakeSummary({ number: 3, headBranch: 'feature/c' }) },
      ]);

    await prMonitorService.forcePoll();

    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    // Only the two user-authored branches should be in the batch.
    const branches = graphqlSpy.mock.calls[0][0].branches;
    expect(branches).toEqual(['feature/a', 'feature/c']);

    const rows = await db.select().from(pullRequestsTable);
    expect(rows.map((r) => r.number).sort()).toEqual([1, 3]);
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
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([
      fakeRESTPullRequest({ number: 1, headRef: 'feature/a', userLogin: 'me' }),
    ] as never);
    const graphqlSpy = vi.spyOn(graphqlModule, 'batchPullRequests');

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
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([
      fakeRESTPullRequest({ number: 1, headRef: 'feature/a', userLogin: 'me' }),
      fakeRESTPullRequest({ number: 2, headRef: 'feature/b', userLogin: 'me' }),
    ] as never);
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequests')
      .mockResolvedValue([
        { branch: 'feature/b', pr: fakeSummary({ number: 2, headBranch: 'feature/b' }) },
      ]);

    await prMonitorService.forcePoll();
    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    expect(graphqlSpy.mock.calls[0][0].branches).toEqual(['feature/b']);
  });

  it('marks tracked rows that disappear from the open-list as closed', async () => {
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
    // The user merged #2 — it's gone from the open list.
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([
      fakeRESTPullRequest({ number: 1, headRef: 'feature/a', userLogin: 'me' }),
    ] as never);
    vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([]);

    await prMonitorService.forcePoll();

    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, 'pr-2'));
    expect(rows[0].state).toBe('closed');
  });

  it('isolates per-workspace failures (one repo throwing does not stop others)', async () => {
    await db.insert(repositoriesTable).values({
      id: 'repo2',
      workspaceId: 'ws1',
      name: 'acme/other',
      url: 'https://github.com/acme/other',
      defaultBranch: 'main',
    });
    vi.spyOn(githubService, 'listPullRequests').mockImplementation(async (_ws, _owner, repo) => {
      if (repo === 'widgets') throw new Error('rate limit');
      return [fakeRESTPullRequest({ number: 1, headRef: 'feature/a', userLogin: 'me' })] as never;
    });
    vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
      { branch: 'feature/a', pr: fakeSummary({ number: 1, headBranch: 'feature/a' }) },
    ]);

    await prMonitorService.forcePoll();
    // The healthy repo's PR row landed despite the other repo throwing.
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.repositoryId, 'repo2'));
    expect(rows).toHaveLength(1);
  });

  it('emits inbox items only for deltas (cursor-based, no double-fire)', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([
      fakeRESTPullRequest({ number: 1, headRef: 'feature/a', userLogin: 'me' }),
    ] as never);
    const graphqlSpy = vi.spyOn(graphqlModule, 'batchPullRequests');

    // Tick 1: baseline. No inbox items.
    graphqlSpy.mockResolvedValueOnce([
      {
        branch: 'feature/a',
        pr: fakeSummary({
          number: 1,
          headBranch: 'feature/a',
          recentReviews: [
            {
              id: 'r1',
              author: 'alice',
              state: 'APPROVED',
              submittedAt: 'now',
              url: 'x',
            },
          ],
        }),
      },
    ]);
    await prMonitorService.forcePoll();
    expect((await db.select().from(inboxItemsTable)).length).toBe(0);

    // Backdate so the second tick refetches.
    await db
      .update(pullRequestsTable)
      .set({ lastPolledAt: new Date(Date.now() - 120_000) });

    // Tick 2: r2 lands. Should emit one pr_review item.
    graphqlSpy.mockResolvedValueOnce([
      {
        branch: 'feature/a',
        pr: fakeSummary({
          number: 1,
          headBranch: 'feature/a',
          recentReviews: [
            {
              id: 'r2',
              author: 'bob',
              state: 'CHANGES_REQUESTED',
              submittedAt: 'now',
              url: 'x',
            },
            {
              id: 'r1',
              author: 'alice',
              state: 'APPROVED',
              submittedAt: 'now',
              url: 'x',
            },
          ],
        }),
      },
    ]);
    await prMonitorService.forcePoll();
    const inbox = await db.select().from(inboxItemsTable);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe('pr_review');
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

    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([
      fakeRESTPullRequest({ number: 1, headRef: 'feature/a', userLogin: 'me' }),
      fakeRESTPullRequest({ number: 2, headRef: 'feature/b', userLogin: 'me' }),
    ] as never);
    const graphqlSpy = vi
      .spyOn(graphqlModule, 'batchPullRequests')
      .mockResolvedValue([
        { branch: 'feature/a', pr: fakeSummary({ number: 1, headBranch: 'feature/a' }) },
      ]);

    await prMonitorService.forcePoll();

    // Only the focused PR's branch was batched — unfocused row is
    // still inside its TTL.
    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    expect(graphqlSpy.mock.calls[0][0].branches).toEqual(['feature/a']);
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

    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([
      fakeRESTPullRequest({ number: 1, headRef: 'feature/a', userLogin: 'me' }),
    ] as never);
    const graphqlSpy = vi.spyOn(graphqlModule, 'batchPullRequests');

    await prMonitorService.forcePoll();
    // Cooldown overrode TTL — no GraphQL fetch despite 90 s of staleness.
    expect(graphqlSpy).not.toHaveBeenCalled();

    // Sanity: COOLDOWN_MS is 5 s; this poll should be inside the window.
    expect(PR_FOCUS_CONSTANTS.COOLDOWN_MS).toBe(5_000);
  });

  it('does not double-fire when forcePoll runs twice with no new state', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([
      fakeRESTPullRequest({ number: 1, headRef: 'feature/a', userLogin: 'me' }),
    ] as never);
    vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
      {
        branch: 'feature/a',
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
    // Second call — TTL still fresh, GraphQL skipped, no inbox spam.
    await prMonitorService.forcePoll();
    expect((await db.select().from(inboxItemsTable)).length).toBe(0);
  });
});
