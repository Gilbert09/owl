import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  computePRDeltas,
  upsertFromBatchResult,
  forceFetchAndUpsert,
  getOrFetchPRSummary,
  DEFAULT_TTL_MS,
  type CursorState,
} from '../services/prCache.js';
import * as graphqlModule from '../services/githubGraphql.js';
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

function makeSummary(over: Partial<PRSummary> = {}): PRSummary {
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

function review(id: string, state = 'APPROVED', author = 'reviewer'): PRSummary['recentReviews'][number] {
  return {
    id,
    author,
    state,
    submittedAt: '2026-01-02T00:00:00Z',
    url: `https://github.com/acme/widgets/pull/42#pullrequestreview-${id}`,
  };
}

function reviewComment(id: string, author = 'reviewer'): PRSummary['recentReviewComments'][number] {
  return {
    id,
    author,
    createdAt: '2026-01-02T00:00:00Z',
    url: `https://github.com/acme/widgets/pull/42#discussion_r-${id}`,
  };
}

function comment(id: string, author = 'reviewer'): PRSummary['recentComments'][number] {
  return {
    id,
    author,
    createdAt: '2026-01-02T00:00:00Z',
    url: `https://github.com/acme/widgets/pull/42#issuecomment-${id}`,
  };
}

const noCursor: CursorState | null = null;

// ---------- computePRDeltas (pure) ----------

describe('computePRDeltas', () => {
  it('returns empty deltas on first sight (no cursor diff to do)', () => {
    const summary = makeSummary({
      recentReviews: [review('r1')],
      recentComments: [comment('c1')],
    });
    const delta = computePRDeltas(noCursor, summary);
    expect(delta.newReviews).toHaveLength(0);
    expect(delta.newComments).toHaveLength(0);
    expect(delta.ciJustFailed).toBe(false);
    expect(delta.becameMergeReady).toBe(false);
  });

  it('emits the prefix of new reviews up to (not including) the cursor', () => {
    const summary = makeSummary({
      recentReviews: [review('r3'), review('r2'), review('r1')],
    });
    const delta = computePRDeltas(
      {
        lastReviewId: 'r1',
        lastReviewCommentId: null,
        lastCommentId: null,
        lastCheckDigest: 'sha1:',
      },
      summary
    );
    expect(delta.newReviews.map((r) => r.id)).toEqual(['r3', 'r2']);
  });

  it('emits zero new reviews when cursor matches the freshest', () => {
    const summary = makeSummary({
      recentReviews: [review('r3'), review('r2')],
    });
    const delta = computePRDeltas(
      {
        lastReviewId: 'r3',
        lastReviewCommentId: null,
        lastCommentId: null,
        lastCheckDigest: null,
      },
      summary
    );
    expect(delta.newReviews).toHaveLength(0);
  });

  it('does the same prefix walk for review-thread comments and issue comments', () => {
    const summary = makeSummary({
      recentReviewComments: [reviewComment('rc2'), reviewComment('rc1')],
      recentComments: [comment('c3'), comment('c2'), comment('c1')],
    });
    const delta = computePRDeltas(
      {
        lastReviewId: null,
        lastReviewCommentId: 'rc1',
        lastCommentId: 'c1',
        lastCheckDigest: null,
      },
      summary
    );
    expect(delta.newReviewComments.map((c) => c.id)).toEqual(['rc2']);
    expect(delta.newComments.map((c) => c.id)).toEqual(['c3', 'c2']);
  });

  it('detects ciJustFailed: previous digest had no =failure, new one does', () => {
    const summary = makeSummary({
      headSha: 'sha2',
      checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 },
      checkDigest: 'sha2:lint=success|test=failure',
    });
    const delta = computePRDeltas(
      {
        lastReviewId: null,
        lastReviewCommentId: null,
        lastCommentId: null,
        lastCheckDigest: 'sha1:lint=success|test=in_progress',
      },
      summary
    );
    expect(delta.ciJustFailed).toBe(true);
  });

  it('does NOT re-emit ciJustFailed when checks are still failing on the same digest', () => {
    const summary = makeSummary({
      checks: { total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 },
      checkDigest: 'sha1:test=failure',
    });
    const delta = computePRDeltas(
      {
        lastReviewId: null,
        lastReviewCommentId: null,
        lastCommentId: null,
        lastCheckDigest: 'sha1:test=failure',
      },
      summary
    );
    expect(delta.ciJustFailed).toBe(false);
  });

  it('does NOT emit ciJustFailed when checks are still failing but digest changed (e.g. another failure added)', () => {
    // Previously failing, now still failing but with a different digest
    // (an extra check failed). User already knows CI is failing — don't
    // spam them.
    const summary = makeSummary({
      checks: { total: 2, passed: 0, failed: 2, inProgress: 0, skipped: 0 },
      checkDigest: 'sha1:lint=failure|test=failure',
    });
    const delta = computePRDeltas(
      {
        lastReviewId: null,
        lastReviewCommentId: null,
        lastCommentId: null,
        lastCheckDigest: 'sha1:test=failure',
      },
      summary
    );
    expect(delta.ciJustFailed).toBe(false);
  });

  it('emits ciJustFailed on first sight when checks are already failing', () => {
    // First time we've seen the PR's checks (no previous digest) AND
    // the current state is failing → emit. The full first-sight
    // path is gated by `previous == null` in computePRDeltas, so this
    // tests a slightly different path: previous exists but lastCheckDigest is null.
    const summary = makeSummary({
      checks: { total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 },
      checkDigest: 'sha1:test=failure',
    });
    const delta = computePRDeltas(
      {
        lastReviewId: null,
        lastReviewCommentId: null,
        lastCommentId: null,
        lastCheckDigest: null,
      },
      summary
    );
    expect(delta.ciJustFailed).toBe(true);
  });

  it('detects becameMergeReady when blockingReason flips to mergeable on a digest change', () => {
    const summary = makeSummary({
      blockingReason: 'mergeable',
      checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
      checkDigest: 'sha1:test=success',
    });
    const delta = computePRDeltas(
      {
        lastReviewId: null,
        lastReviewCommentId: null,
        lastCommentId: null,
        lastCheckDigest: 'sha1:test=in_progress',
      },
      summary
    );
    expect(delta.becameMergeReady).toBe(true);
  });

  it('does not re-emit becameMergeReady when state was already mergeable + digest unchanged', () => {
    const summary = makeSummary({
      blockingReason: 'mergeable',
      checkDigest: 'sha1:test=success',
    });
    const delta = computePRDeltas(
      {
        lastReviewId: null,
        lastReviewCommentId: null,
        lastCommentId: null,
        lastCheckDigest: 'sha1:test=success',
      },
      summary
    );
    expect(delta.becameMergeReady).toBe(false);
  });
});

// ---------- DB-backed cache + upsert + emit ----------

describe('prCache — DB integration', () => {
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
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function readPRRow(): Promise<{
    id: string;
    state: string;
    lastReviewId: string | null;
    lastCheckDigest: string | null;
    lastSummary: unknown;
  } | null> {
    const rows = await db.select().from(pullRequestsTable);
    return (rows[0] as never) ?? null;
  }

  async function inboxCount(type?: string): Promise<number> {
    const rows = await db.select().from(inboxItemsTable);
    if (!type) return rows.length;
    return rows.filter((r) => r.type === type).length;
  }

  it('upserts a fresh PR row + does NOT emit inbox items on first sight', async () => {
    const summary = makeSummary({
      recentReviews: [review('r1', 'APPROVED')],
      checks: { total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 },
      checkDigest: 'sha1:test=failure',
    });
    const result = await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary,
    });

    expect(result.cacheMiss).toBe(true);
    const row = await readPRRow();
    expect(row).not.toBeNull();
    expect(row?.lastReviewId).toBe('r1');
    expect(row?.lastCheckDigest).toBe('sha1:test=failure');
    // First sight: cursors get baselined, no inbox spam.
    expect(await inboxCount()).toBe(0);
  });

  it('emits one pr_review inbox item when a new review arrives between polls', async () => {
    // First poll baselines on r1.
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        recentReviews: [review('r1', 'COMMENTED', 'alice')],
      }),
    });
    expect(await inboxCount('pr_review')).toBe(0);

    // Second poll: r2 lands. Should emit ONE pr_review inbox item.
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        recentReviews: [review('r2', 'CHANGES_REQUESTED', 'bob'), review('r1', 'COMMENTED', 'alice')],
      }),
    });
    expect(await inboxCount('pr_review')).toBe(1);

    const inbox = await db.select().from(inboxItemsTable);
    expect(inbox[0].priority).toBe('high');
    expect((inbox[0].data as { reviewer: string }).reviewer).toBe('bob');
  });

  it('skips PENDING reviews (in-progress drafts) — not user-visible yet', async () => {
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({ recentReviews: [review('r1')] }),
    });
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        recentReviews: [review('r2', 'PENDING'), review('r1')],
      }),
    });
    expect(await inboxCount('pr_review')).toBe(0);
  });

  it('emits pr_comment items for both review-thread and top-level comments', async () => {
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        recentReviewComments: [reviewComment('rc1')],
        recentComments: [comment('c1')],
      }),
    });
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        recentReviewComments: [reviewComment('rc2'), reviewComment('rc1')],
        recentComments: [comment('c2'), comment('c1')],
      }),
    });
    expect(await inboxCount('pr_comment')).toBe(2);
  });

  it('emits ci_failure when checks transition into failure between polls', async () => {
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        checks: { total: 2, passed: 1, failed: 0, inProgress: 1, skipped: 0 },
        checkDigest: 'sha1:lint=success|test=in_progress',
      }),
    });
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 },
        checkDigest: 'sha1:lint=success|test=failure',
      }),
    });
    expect(await inboxCount('ci_failure')).toBe(1);
  });

  it('emits pr_ready when blockingReason flips to mergeable on a digest change', async () => {
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        blockingReason: 'checks_failed',
        checks: { total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 },
        checkDigest: 'sha1:test=failure',
      }),
    });
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        headSha: 'sha2',
        blockingReason: 'mergeable',
        checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
        checkDigest: 'sha2:test=success',
      }),
    });
    expect(await inboxCount('pr_ready')).toBe(1);
  });

  it('updates an existing row instead of inserting a duplicate', async () => {
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({ title: 'Original' }),
    });
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({ title: 'Updated' }),
    });
    const rows = await db.select().from(pullRequestsTable);
    expect(rows).toHaveLength(1);
    expect((rows[0].lastSummary as { title: string }).title).toBe('Updated');
  });

  it('cursors persist on disk so deltas keep working across simulated restart', async () => {
    // First "session": baseline on r1.
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({ recentReviews: [review('r1')] }),
    });

    // "Restart" — the prCache holds no in-memory state, but the
    // pull_requests row persists. Now r2 lands.
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        recentReviews: [review('r2', 'CHANGES_REQUESTED'), review('r1')],
      }),
    });
    expect(await inboxCount('pr_review')).toBe(1);
  });
});

describe('prCache.getOrFetchPRSummary — TTL', () => {
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
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('returns the cached row without hitting GraphQL when last_polled_at is within the TTL', async () => {
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary(),
    });
    const spy = vi.spyOn(graphqlModule, 'batchPullRequests');
    const result = await getOrFetchPRSummary({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      ttlMs: DEFAULT_TTL_MS,
    });
    expect(result?.cacheMiss).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refetches via GraphQL when the row is older than the TTL', async () => {
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary(),
    });
    // Backdate the row to make it stale.
    await db
      .update(pullRequestsTable)
      .set({ lastPolledAt: new Date(Date.now() - DEFAULT_TTL_MS - 1000) })
      .where(eq(pullRequestsTable.workspaceId, 'ws1'));

    const spy = vi
      .spyOn(graphqlModule, 'batchPullRequests')
      .mockResolvedValue([{ branch: 'feature/x', pr: makeSummary({ title: 'Updated by refetch' }) }]);

    const result = await getOrFetchPRSummary({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      ttlMs: DEFAULT_TTL_MS,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result?.cacheMiss).toBe(true);
    expect(result?.summary.title).toBe('Updated by refetch');
  });

  it('returns null when the PR has never been seen and forceFetchAndUpsert has nothing to query (no cached headBranch)', async () => {
    // Fresh DB → no cached row → forceFetchAndUpsert bails out
    // because it doesn't know the head branch. The poller is supposed
    // to insert the first row before this path can be hit.
    const spy = vi.spyOn(graphqlModule, 'batchPullRequests');
    const result = await forceFetchAndUpsert({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 99,
    });
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
