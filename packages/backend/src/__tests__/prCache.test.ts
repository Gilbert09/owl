import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  computePRDeltas,
  upsertFromBatchResult,
  forceFetchAndUpsert,
  getOrFetchPRSummary,
  linkTaskToPullRequest,
  attachTaskToPullRequestRow,
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
  tasks as tasksTable,
} from '../db/schema.js';
import * as websocketModule from '../services/websocket.js';

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
    createdAt: '2026-01-01T00:00:00Z',
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

function review(id: string, state = 'APPROVED', author = 'reviewer'): PRSummary['recentReviews'][number] {
  return {
    id,
    author,
    state,
    submittedAt: '2026-01-02T00:00:00Z',
    url: `https://github.com/acme/widgets/pull/42#pullrequestreview-${id}`,
  };
}

function reviewComment(
  id: string,
  author = 'reviewer',
  opts: { authorIsBot?: boolean; bodyText?: string } = {}
): PRSummary['recentReviewComments'][number] {
  return {
    id,
    author,
    authorIsBot: opts.authorIsBot ?? false,
    bodyText: opts.bodyText ?? '',
    createdAt: '2026-01-02T00:00:00Z',
    url: `https://github.com/acme/widgets/pull/42#discussion_r-${id}`,
  };
}

function comment(
  id: string,
  author = 'reviewer',
  opts: { authorIsBot?: boolean; bodyText?: string } = {}
): PRSummary['recentComments'][number] {
  return {
    id,
    author,
    authorIsBot: opts.authorIsBot ?? false,
    bodyText: opts.bodyText ?? '',
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

  it('does NOT emit ciJustFailed for non-required (optional) check failures', () => {
    // A mergeable PR whose only failing checks aren't required shouldn't
    // be flagged as a CI failure — it isn't blocked.
    const summary = makeSummary({
      blockingReason: 'checks_failed_optional',
      checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 },
      checkDigest: 'sha2:lint=success|flaky=failure',
    });
    const delta = computePRDeltas(
      {
        lastReviewId: null,
        lastReviewCommentId: null,
        lastCommentId: null,
        lastCheckDigest: 'sha1:lint=success|flaky=success',
      },
      summary
    );
    expect(delta.ciJustFailed).toBe(false);
  });

  it('treats an optional-failing (mergeable) PR as becameMergeReady', () => {
    const summary = makeSummary({
      blockingReason: 'checks_failed_optional',
      checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 },
      checkDigest: 'sha1:lint=success|flaky=failure',
    });
    const delta = computePRDeltas(
      {
        lastReviewId: null,
        lastReviewCommentId: null,
        lastCommentId: null,
        lastCheckDigest: 'sha1:lint=in_progress|flaky=in_progress',
      },
      summary
    );
    expect(delta.becameMergeReady).toBe(true);
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

  it('upserts a fresh PR row + baselines cursors on first sight', async () => {
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

  it('fires pull_request:updated on every upsert (insert AND update path)', async () => {
    const spy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary(),
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('ws1');
    expect(spy.mock.calls[0][1].number).toBe(42);

    // Second upsert exercises the update branch.
    await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({ title: 'Renamed' }),
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(
      (spy.mock.calls[1][1].lastSummary as { title: string }).title
    ).toBe('Renamed');
  });

  describe('last_summary write guard (disk-IO)', () => {
    async function readFullRow(): Promise<
      typeof pullRequestsTable.$inferSelect
    > {
      return (await db.select().from(pullRequestsTable))[0];
    }

    it('populates last_summary_digest on the insert path', async () => {
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary(),
      });
      const row = await readFullRow();
      expect(row.lastSummaryDigest).toBeTruthy();
    });

    it('skips rewriting last_summary when content is unchanged, but still advances last_polled_at', async () => {
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary(),
      });
      const before = await readFullRow();
      // Poison the stored blob + backdate the TTL. If the guard holds, an
      // identical re-upsert must NOT rewrite last_summary (sentinel survives)
      // yet must still bump last_polled_at.
      await db
        .update(pullRequestsTable)
        .set({ lastSummary: { sentinel: true }, lastPolledAt: new Date(0) })
        .where(eq(pullRequestsTable.id, before.id));
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary(),
      });
      const after = await readFullRow();
      expect((after.lastSummary as { sentinel?: boolean }).sentinel).toBe(true);
      expect(after.lastPolledAt.getTime()).toBeGreaterThan(0);
      expect(after.lastSummaryDigest).toBe(before.lastSummaryDigest);
    });

    it('rewrites last_summary + digest when content changes', async () => {
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary(),
      });
      const before = await readFullRow();
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ title: 'Changed' }),
      });
      const after = await readFullRow();
      expect(after.lastSummaryDigest).not.toBe(before.lastSummaryDigest);
      expect((after.lastSummary as { title: string }).title).toBe('Changed');
    });

    it('detects a check-only transition (digest covers the check cursor)', async () => {
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ checkDigest: 'sha1:a=pending' }),
      });
      const before = await readFullRow();
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ checkDigest: 'sha1:a=success' }),
      });
      const after = await readFullRow();
      expect(after.lastSummaryDigest).not.toBe(before.lastSummaryDigest);
      expect(after.lastCheckDigest).toBe('sha1:a=success');
    });
  });

  describe('auto-keep mergeable default', () => {
    async function setDefault(on: boolean): Promise<void> {
      await db
        .update(workspacesTable)
        .set({ settings: { defaultAutoKeepMergeable: on } })
        .where(eq(workspacesTable.id, 'ws1'));
    }
    async function flags(number: number) {
      const rows = await db
        .select({
          autoKeepMergeable: pullRequestsTable.autoKeepMergeable,
          autoMergeState: pullRequestsTable.autoMergeState,
        })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.number, number));
      return rows[0];
    }

    it('arms a new AUTHORED open PR when the workspace default is on', async () => {
      await setDefault(true);
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 10 }),
        authored: true,
      });
      const f = await flags(10);
      expect(f.autoKeepMergeable).toBe(true);
      expect(f.autoMergeState).toEqual({ attempts: 0, accounted: true });
    });

    it('does NOT arm a PR the viewer only reviews (not authored), even with the default on', async () => {
      await setDefault(true);
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 11 }),
        authored: false,
        reviewRequested: true,
      });
      const f = await flags(11);
      expect(f.autoKeepMergeable).toBe(false);
      expect(f.autoMergeState).toBeNull();
    });

    it('arms an explicitly WATCHED PR the viewer did not author', async () => {
      // Pasting a PR's URL is an ask for that specific PR — pushing to it is
      // most of the point of watching it — so it inherits the default the same
      // way an authored PR does, even though the branch is someone else's.
      await setDefault(true);
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 12 }),
        authored: false,
        explicitWatch: true,
      });
      const f = await flags(12);
      expect(f.autoKeepMergeable).toBe(true);
      expect(f.autoMergeState).toEqual({ attempts: 0, accounted: true });
    });

    it('still respects a workspace default of off for an explicitly watched PR', async () => {
      await setDefault(false);
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 13 }),
        authored: false,
        explicitWatch: true,
      });
      const f = await flags(13);
      expect(f.autoKeepMergeable).toBe(false);
      expect(f.autoMergeState).toBeNull();
    });

    it('leaves a new authored PR off when the workspace default is off', async () => {
      await setDefault(false);
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 12 }),
        authored: true,
      });
      const f = await flags(12);
      expect(f.autoKeepMergeable).toBe(false);
      expect(f.autoMergeState).toBeNull();
    });

    it('never arms retroactively on the update path — only on first insert', async () => {
      await setDefault(false);
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 13 }),
        authored: true,
      });
      // Flip the default on, then re-upsert the SAME PR (update path).
      await setDefault(true);
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 13, title: 'Updated' }),
        authored: true,
      });
      expect((await flags(13)).autoKeepMergeable).toBe(false);
    });
  });

  describe('linkTaskToPullRequest', () => {
    async function seedTask(): Promise<string> {
      const id = `task-${Math.random().toString(36).slice(2, 8)}`;
      await db.insert(tasksTable).values({
        id,
        workspaceId: 'ws1',
        type: 'code_writing',
        status: 'in_progress',
        priority: 'medium',
        title: 't',
        description: 'd',
      });
      return id;
    }

    it('inserts a placeholder row with task_id when no row exists yet', async () => {
      const taskId = await seedTask();
      const id = await linkTaskToPullRequest({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        taskId,
        owner: 'acme',
        repo: 'widgets',
        number: 99,
        url: 'https://github.com/acme/widgets/pull/99',
        title: 'Add login',
        author: 'me',
        headBranch: 'fastowl/abc-add-login',
        baseBranch: 'main',
        headSha: 'sha-x',
      });
      const rows = await db.select().from(pullRequestsTable);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].taskId).toBe(taskId);
      expect(rows[0].number).toBe(99);
      expect((rows[0].lastSummary as { headBranch: string }).headBranch).toBe(
        'fastowl/abc-add-login'
      );
      // Placeholder fields default to UNKNOWN — the next prMonitor
      // tick fills in real values.
      expect((rows[0].lastSummary as { mergeable: string }).mergeable).toBe('UNKNOWN');
    });

    it('patches task_id on an existing row when the monitor beat us to the insert', async () => {
      // Simulate the race: a prMonitor tick inserts a row first.
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 99 }),
      });
      const beforeRows = await db.select().from(pullRequestsTable);
      expect(beforeRows[0].taskId).toBeNull();

      // Now the approve flow tries to link the task.
      const taskId = await seedTask();
      const id = await linkTaskToPullRequest({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        taskId,
        owner: 'acme',
        repo: 'widgets',
        number: 99,
        url: 'https://github.com/acme/widgets/pull/99',
        title: 'Add login',
        author: 'me',
        headBranch: 'feature/x',
        baseBranch: 'main',
        headSha: 'sha1',
      });

      const rows = await db.select().from(pullRequestsTable);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].taskId).toBe(taskId);
      // The cached summary stays as-is — the monitor's GraphQL data is
      // freshest, we don't overwrite it with the placeholder.
      expect((rows[0].lastSummary as { mergeable: string }).mergeable).toBe('MERGEABLE');
    });

    it('refuses to link a PR whose owner/repo does not match the repository', async () => {
      // repo1 is github.com/acme/widgets; a cloud run reporting a PR on a
      // different repo (e.g. a fork or sibling) must not file its low number
      // against repo1 — that poisons the poller (NOT_FOUND on re-query).
      const taskId = await seedTask();
      await expect(
        linkTaskToPullRequest({
          workspaceId: 'ws1',
          repositoryId: 'repo1',
          taskId,
          owner: 'someone-else',
          repo: 'fork',
          number: 21,
          url: 'https://github.com/someone-else/fork/pull/21',
          title: 'x',
          author: 'me',
          headBranch: 'feature/x',
          baseBranch: 'main',
          headSha: 'sha1',
        })
      ).rejects.toThrow(/does not belong to acme\/widgets/);
      // No poisoned row was written.
      const rows = await db.select().from(pullRequestsTable);
      expect(rows).toHaveLength(0);
    });

    it('does NOT overwrite an existing task_id (linkage stays sticky once set)', async () => {
      const taskA = await seedTask();
      await linkTaskToPullRequest({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        taskId: taskA,
        owner: 'acme',
        repo: 'widgets',
        number: 99,
        url: 'https://github.com/acme/widgets/pull/99',
        title: 'a',
        author: 'me',
        headBranch: 'feature/x',
        baseBranch: 'main',
        headSha: 'sha1',
      });
      // A second link with a different taskId is a no-op on task_id.
      const taskB = await seedTask();
      await linkTaskToPullRequest({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        taskId: taskB,
        owner: 'acme',
        repo: 'widgets',
        number: 99,
        url: 'https://github.com/acme/widgets/pull/99',
        title: 'b',
        author: 'me',
        headBranch: 'feature/x',
        baseBranch: 'main',
        headSha: 'sha1',
      });
      const rows = await db.select().from(pullRequestsTable);
      expect(rows[0].taskId).toBe(taskA);
    });
  });

  describe('upsertFromBatchResult — mergeable UNKNOWN preserve', () => {
    async function summaryOf(number: number) {
      const rows = await db
        .select({ ls: pullRequestsTable.lastSummary })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.number, number));
      return rows[0].ls as { mergeable: string; blockingReason: string };
    }

    it('keeps a known mergeable/blockingReason when a refresh comes back unknown', async () => {
      // First: a known-mergeable PR.
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 5, mergeable: 'MERGEABLE', blockingReason: 'mergeable' }),
      });
      // A webhook refresh catches GitHub mid-recompute → UNKNOWN → blockingReason 'unknown'.
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 5, mergeable: 'UNKNOWN', blockingReason: 'unknown' }),
      });
      expect(await summaryOf(5)).toMatchObject({ mergeable: 'MERGEABLE', blockingReason: 'mergeable' });
    });

    it('writes a known new blocking-reason as-is (no preserve)', async () => {
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 6, mergeable: 'MERGEABLE', blockingReason: 'mergeable' }),
      });
      // A real conflict — not 'unknown' — must overwrite.
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 6, mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' }),
      });
      expect(await summaryOf(6)).toMatchObject({
        mergeable: 'CONFLICTING',
        blockingReason: 'merge_conflicts',
      });
    });

    it('writes unknown on first insert (no prior to preserve)', async () => {
      await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 7, mergeable: 'UNKNOWN', blockingReason: 'unknown' }),
      });
      expect(await summaryOf(7)).toMatchObject({ blockingReason: 'unknown' });
    });
  });

  describe('attachTaskToPullRequestRow', () => {
    async function seedTask(status = 'queued'): Promise<string> {
      const id = `task-${Math.random().toString(36).slice(2, 8)}`;
      await db.insert(tasksTable).values({
        id,
        workspaceId: 'ws1',
        type: 'pr_response',
        status,
        priority: 'medium',
        title: 't',
        description: 'd',
      });
      return id;
    }

    async function seedRow(): Promise<string> {
      const { rowId } = await upsertFromBatchResult({
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        summary: makeSummary({ number: 99 }),
      });
      return rowId;
    }

    it('sets task_id on an existing row and emits pull_request:updated', async () => {
      const rowId = await seedRow();
      const taskId = await seedTask();
      const spy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');

      const ok = await attachTaskToPullRequestRow({
        workspaceId: 'ws1',
        pullRequestId: rowId,
        taskId,
      });

      expect(ok).toBe(true);
      const rows = await db.select().from(pullRequestsTable);
      expect(rows[0].taskId).toBe(taskId);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toMatchObject({ id: rowId, taskId, number: 99 });
    });

    it('OVERWRITES an existing task_id (row tracks the active fix task)', async () => {
      const rowId = await seedRow();
      const taskA = await seedTask();
      await attachTaskToPullRequestRow({ workspaceId: 'ws1', pullRequestId: rowId, taskId: taskA });
      const taskB = await seedTask();
      await attachTaskToPullRequestRow({ workspaceId: 'ws1', pullRequestId: rowId, taskId: taskB });

      const rows = await db.select().from(pullRequestsTable);
      expect(rows[0].taskId).toBe(taskB);
    });

    it('is a no-op for an unknown row id (returns false, no emit)', async () => {
      const taskId = await seedTask();
      const spy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');

      const ok = await attachTaskToPullRequestRow({
        workspaceId: 'ws1',
        pullRequestId: 'does-not-exist',
        taskId,
      });

      expect(ok).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it('refuses to link across workspaces', async () => {
      const rowId = await seedRow();
      const taskId = await seedTask();

      const ok = await attachTaskToPullRequestRow({
        workspaceId: 'ws2',
        pullRequestId: rowId,
        taskId,
      });

      expect(ok).toBe(false);
      const rows = await db.select().from(pullRequestsTable);
      expect(rows[0].taskId).toBeNull();
    });
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
    const result = await upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary({
        recentReviews: [review('r2', 'CHANGES_REQUESTED'), review('r1')],
      }),
    });
    // The cursor diffed against the persisted row (not in-memory state),
    // so r2 is detected as new and the cursor advances on disk.
    expect(result.delta.newReviews.map((r) => r.id)).toEqual(['r2']);
    const row = await readPRRow();
    expect(row?.lastReviewId).toBe('r2');
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

/**
 * `watching` is written by the upsert itself, off `explicitWatch`.
 *
 * It used to be a follow-up `UPDATE` issued by the watch route through the PR
 * monitor's `this.db` — the POOL handle, which is right for the background poll
 * and wrong inside a request. The upsert runs on the request's owner-scoped
 * transaction, so the two statements raced the same row on two connections: an
 * already-tracked PR deadlocked undetectably (the pool waited on a row lock only
 * the request transaction could release; that transaction waited on the pool
 * statement to return) and died at the 2min `statement_timeout` with 57014,
 * while a brand-new PR failed silently, its uncommitted row being invisible to
 * the pool so the update matched nothing.
 *
 * Folding it into the upsert removes the second handle. The invariant that
 * replaces it, and the reason these tests exist: only `explicitWatch` may write
 * this column. The poller must never touch it — writing `false` on a refresh
 * would un-watch a PR one tick after the user watched it.
 */
describe('prCache — the watching column', () => {
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

  const upsert = (over: Record<string, unknown> = {}) =>
    upsertFromBatchResult({
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      summary: makeSummary(),
      ...over,
    });

  async function watching(): Promise<boolean | null> {
    const rows = await db
      .select({ watching: pullRequestsTable.watching })
      .from(pullRequestsTable);
    return rows[0]?.watching ?? null;
  }

  it('sets watching on a PR the user explicitly watched — the INSERT path', async () => {
    // The silent half of the old bug: the row was created and `watching` was
    // never set, so the PR was added but behaved as if it had not been.
    await upsert({ explicitWatch: true });
    expect(await watching()).toBe(true);
  });

  it('sets watching on a PR the poller had ALREADY tracked — the UPDATE path', async () => {
    // The half that hung: this row is committed and visible, so the follow-up
    // update blocked on it rather than no-oping.
    await upsert();
    expect(await watching()).toBe(false);

    await upsert({ explicitWatch: true });
    expect(await watching()).toBe(true);
  });

  it('leaves watching alone on an ordinary poll — never writes false', async () => {
    // The invariant guarding the fix. A poll passes no `explicitWatch`, so it
    // must not clear a watch the user just set.
    await upsert({ explicitWatch: true });
    await upsert({ summary: makeSummary({ title: 'Changed upstream' }) });
    expect(await watching()).toBe(true);
  });

  it('does not watch a PR the poller merely discovered', async () => {
    await upsert({ authored: true });
    expect(await watching()).toBe(false);
  });
});
