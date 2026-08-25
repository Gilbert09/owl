import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { githubService } from '../services/github.js';
import { graphqlBudget } from '../services/graphqlBudget.js';
import * as graphqlModule from '../services/githubGraphql.js';
import { prMonitorService } from '../services/prMonitor.js';
import {
  initMergeableSettler,
  scheduleMergeableSettle,
  mergeableSettleStats,
  _resetMergeableSettler,
  _drainMergeableSettlerNow,
  type MergeableSettleTarget,
} from '../services/mergeableSettle.js';
import type { PRSummary } from '../services/githubGraphql.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';

/**
 * GitHub computes `mergeable` lazily, so the webhook refresh path (which does
 * not block on it) routinely writes UNKNOWN over a known value. Nothing asked
 * again until the 5-6 min reconcile sweep, and `blockingReason: 'unknown'` is
 * in no list bucket — the PR left both "Needs attention" and "Ready to merge"
 * and lost its merge button, while the detail sheet (which fetches live and
 * writes back) showed the truth. These cover the deferred re-ask that closes
 * that window without putting the wait back on the hot path.
 */

const target: MergeableSettleTarget = {
  workspaceId: 'ws1',
  repositoryId: 'repo1',
  owner: 'acme',
  repo: 'widgets',
  number: 42,
};

describe('mergeableSettle — the queue', () => {
  beforeEach(() => {
    _resetMergeableSettler();
    vi.spyOn(githubService, 'accountKeyFor').mockReturnValue('acct');
    vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(false);
  });
  afterEach(() => {
    _resetMergeableSettler();
    vi.restoreAllMocks();
  });

  it('does nothing when no resolver is registered — the sweep still covers it', async () => {
    const resolve = vi.fn();
    scheduleMergeableSettle(target);
    await _drainMergeableSettlerNow();
    expect(resolve).not.toHaveBeenCalled();
    expect(mergeableSettleStats().settled).toBe(0);
  });

  it('coalesces a burst for one PR into a single settle', async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    initMergeableSettler(resolve);
    scheduleMergeableSettle(target);
    scheduleMergeableSettle(target);
    scheduleMergeableSettle(target);
    await _drainMergeableSettlerNow();
    expect(resolve).toHaveBeenCalledTimes(1);
    // Every observation still counts — that's the rate worth measuring.
    expect(mergeableSettleStats().observed).toBe(3);
    expect(mergeableSettleStats().settled).toBe(1);
  });

  it('settles distinct PRs separately', async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    initMergeableSettler(resolve);
    scheduleMergeableSettle(target);
    scheduleMergeableSettle({ ...target, number: 43 });
    await _drainMergeableSettlerNow();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('skips an account whose GraphQL points are in the reserve', async () => {
    vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(true);
    const resolve = vi.fn().mockResolvedValue(undefined);
    initMergeableSettler(resolve);
    scheduleMergeableSettle(target);
    await _drainMergeableSettlerNow();
    expect(resolve).not.toHaveBeenCalled();
    expect(mergeableSettleStats().deferred).toBe(1);
    expect(mergeableSettleStats().settled).toBe(0);
  });

  it('counts a throwing resolver and keeps draining the rest', async () => {
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValue(undefined);
    initMergeableSettler(resolve);
    scheduleMergeableSettle(target);
    scheduleMergeableSettle({ ...target, number: 43 });
    await _drainMergeableSettlerNow();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(mergeableSettleStats().failed).toBe(1);
    expect(mergeableSettleStats().settled).toBe(1);
  });

  it('reports the live queue depth and the mean settle time', async () => {
    initMergeableSettler(async () => {});
    scheduleMergeableSettle(target);
    scheduleMergeableSettle({ ...target, number: 43 });
    expect(mergeableSettleStats().pending).toBe(2);
    await _drainMergeableSettlerNow();
    const after = mergeableSettleStats();
    expect(after.pending).toBe(0);
    expect(after.settled).toBe(2);
    expect(after.avgSettleMs).toBeGreaterThanOrEqual(0);
  });

  it('re-queues a PR that lands UNKNOWN again after an earlier settle', async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    initMergeableSettler(resolve);
    scheduleMergeableSettle(target);
    await _drainMergeableSettlerNow();
    scheduleMergeableSettle(target);
    await _drainMergeableSettlerNow();
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------

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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN',
    reviewDecision: null,
    effectiveReviewDecision: null,
    blockingReason: 'unknown',
    checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0,
    checkDigest: 'sha1:',
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
    ...over,
  } as PRSummary;
}

describe('prMonitor — queueing the settle', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
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
    _resetMergeableSettler();
    prMonitorService.invalidateUserLogin('ws1');
    vi.spyOn(githubService, 'getUser').mockResolvedValue({
      id: 1,
      login: 'me',
      name: 'Me',
      avatar_url: 'x',
      email: null,
    });
    vi.spyOn(githubService, 'graphqlAccountKeyForOwner').mockReturnValue('acct');
    vi.spyOn(githubService, 'accountKeyFor').mockReturnValue('acct');
    vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(false);
  });

  afterEach(async () => {
    _resetMergeableSettler();
    await cleanup();
    vi.restoreAllMocks();
  });

  const targets = [
    { workspaceId: 'ws1', owner: 'acme', repo: 'widgets', repositoryId: 'repo1' },
  ];

  it('queues a settle when the webhook path leaves the row on UNKNOWN', async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    initMergeableSettler(resolve);
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 42, pr: fakeSummary() },
    ]);

    await prMonitorService.refreshPrAcrossWorkspaces(targets, 42);

    expect(mergeableSettleStats().observed).toBe(1);
    await _drainMergeableSettlerNow();
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws1', repositoryId: 'repo1', number: 42 })
    );
  });

  it('does not queue when GitHub answered with a real verdict', async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    initMergeableSettler(resolve);
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 42, pr: fakeSummary({ mergeable: 'MERGEABLE', blockingReason: 'mergeable' }) },
    ]);

    await prMonitorService.refreshPrAcrossWorkspaces(targets, 42);
    await _drainMergeableSettlerNow();
    expect(mergeableSettleStats().observed).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not queue for a PR that is no longer open', async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    initMergeableSettler(resolve);
    await db.insert(pullRequestsTable).values({
      id: 'pr1',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      state: 'open',
      authored: true,
      reviewRequested: false,
      lastPolledAt: new Date(),
      lastSummary: {},
    });
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 42, pr: fakeSummary({ state: 'closed' }) },
    ]);

    await prMonitorService.refreshPrAcrossWorkspaces(targets, 42);
    await _drainMergeableSettlerNow();
    expect(mergeableSettleStats().observed).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not re-queue from the settle\'s own re-apply', async () => {
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 42, pr: fakeSummary() },
    ]);
    // The real resolver: resolveMergeable + settleUnknown:false. Even though
    // GitHub is still answering UNKNOWN, this must not queue itself again.
    initMergeableSettler((t) =>
      prMonitorService.refreshPrNumbers('ws1', t.owner, t.repo, [t.number], {
        resolveMergeable: true,
        repositoryId: t.repositoryId,
        settleUnknown: false,
      })
    );

    scheduleMergeableSettle(target);
    await _drainMergeableSettlerNow();
    expect(mergeableSettleStats().observed).toBe(1);
    expect(mergeableSettleStats().settled).toBe(1);
  }, 20_000);
});
