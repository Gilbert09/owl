import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { prMonitorService } from '../services/prMonitor.js';
import { githubService } from '../services/github.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  inboxItems as inboxItemsTable,
} from '../db/schema.js';

const REPO_OWNER = 'acme';
const REPO_NAME = 'widgets';
const REPO_FULL = `${REPO_OWNER}/${REPO_NAME}`;

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({
    id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {},
  });
  await db.insert(repositoriesTable).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: REPO_FULL,
    url: `https://github.com/${REPO_FULL}`,
    defaultBranch: 'main',
  });
}

function fakePR(overrides: Partial<{
  number: number;
  title: string;
  userLogin: string;
  headSha: string;
  mergeable: boolean | null;
}> = {}) {
  return {
    id: 1,
    number: overrides.number ?? 42,
    title: overrides.title ?? 'Add login',
    state: 'open' as const,
    html_url: `https://github.com/${REPO_FULL}/pull/${overrides.number ?? 42}`,
    user: { login: overrides.userLogin ?? 'me', avatar_url: 'x' },
    created_at: 'now',
    updated_at: 'now',
    draft: false,
    mergeable: overrides.mergeable ?? null,
    mergeable_state: 'clean',
    head: { ref: 'feature', sha: overrides.headSha ?? 'sha1' },
    base: { ref: 'main' },
  };
}

function fakeReview(overrides: Partial<{
  id: number;
  userLogin: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body: string;
}> = {}) {
  return {
    id: overrides.id ?? 100,
    user: { login: overrides.userLogin ?? 'reviewer', avatar_url: 'x' },
    body: overrides.body ?? '',
    state: overrides.state ?? 'APPROVED',
    submitted_at: 'now',
    html_url: 'x',
  };
}

async function inboxCount(db: Database, filter?: { type?: string }): Promise<number> {
  const conditions = [eq(inboxItemsTable.workspaceId, 'ws1')];
  if (filter?.type) conditions.push(eq(inboxItemsTable.type, filter.type));
  const rows = await db
    .select()
    .from(inboxItemsTable)
    .where(and(...conditions));
  return rows.length;
}

describe('prMonitor — poll branches', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);

    // All tests connect workspace "ws1" to github and run as user "me".
    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue(['ws1']);
    vi.spyOn(githubService, 'getUser').mockResolvedValue({
      id: 1,
      login: 'me',
      name: 'Me',
      avatar_url: 'x',
      email: null,
    });
    // Default stubs for the sub-polls — individual tests override.
    vi.spyOn(githubService, 'getPRReviews').mockResolvedValue([]);
    vi.spyOn(githubService, 'getPRReviewComments').mockResolvedValue([]);
    vi.spyOn(githubService, 'getPRComments').mockResolvedValue([]);
    vi.spyOn(githubService, 'getCheckRuns').mockResolvedValue({
      total_count: 0,
      check_runs: [],
    } as never);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('first poll is a prime — no inbox items even when there are reviews/comments', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([fakePR()]);
    vi.spyOn(githubService, 'getPRReviews').mockResolvedValue([fakeReview({ id: 10 })]);

    await prMonitorService.forcePoll();

    expect(await inboxCount(db)).toBe(0);
  });

  it('second poll surfaces a new review as a pr_review inbox item', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([fakePR()]);
    const reviews = vi.spyOn(githubService, 'getPRReviews').mockResolvedValue([]);

    // Prime — no reviews yet.
    await prMonitorService.forcePoll();

    // Second poll has a new review.
    reviews.mockResolvedValue([
      fakeReview({ id: 200, state: 'CHANGES_REQUESTED', userLogin: 'colleague' }),
    ]);
    await prMonitorService.forcePoll();

    expect(await inboxCount(db, { type: 'pr_review' })).toBe(1);
    const rows = await db.select().from(inboxItemsTable);
    expect(rows[0].title).toMatch(/Changes requested/i);
    // Changes requested → high priority (not medium).
    expect(rows[0].priority).toBe('high');
  });

  it('repeating the same review on a third poll does not double-fire', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([fakePR()]);
    const reviews = vi.spyOn(githubService, 'getPRReviews').mockResolvedValue([]);

    await prMonitorService.forcePoll(); // prime
    reviews.mockResolvedValue([fakeReview({ id: 200 })]);
    await prMonitorService.forcePoll(); // fires inbox

    const firstCount = await inboxCount(db, { type: 'pr_review' });

    // Third poll returns the SAME review.
    await prMonitorService.forcePoll();
    const thirdCount = await inboxCount(db, { type: 'pr_review' });
    expect(thirdCount).toBe(firstCount);
  });

  it('new review comments fire a single pr_comment item with a count summary', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([fakePR()]);
    const reviewComments = vi
      .spyOn(githubService, 'getPRReviewComments')
      .mockResolvedValue([]);

    await prMonitorService.forcePoll(); // prime

    reviewComments.mockResolvedValue([
      {
        id: 301,
        user: { login: 'alice', avatar_url: 'x' },
        body: 'line 1',
        path: 'src/a.ts',
        created_at: 'now',
        updated_at: 'now',
        html_url: 'x',
        pull_request_review_id: 1,
      },
      {
        id: 302,
        user: { login: 'bob', avatar_url: 'x' },
        body: 'line 2',
        path: 'src/a.ts',
        created_at: 'now',
        updated_at: 'now',
        html_url: 'x',
        pull_request_review_id: 1,
      },
    ]);
    await prMonitorService.forcePoll();

    const rows = await db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.type, 'pr_comment'));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toMatch(/2 new review comments/);
    expect(rows[0].summary).toContain('@alice');
    expect(rows[0].summary).toContain('@bob');
  });

  it('filters out the current user own review comments (no self-pings)', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([fakePR()]);
    const reviewComments = vi
      .spyOn(githubService, 'getPRReviewComments')
      .mockResolvedValue([]);

    await prMonitorService.forcePoll();

    reviewComments.mockResolvedValue([
      {
        id: 301,
        user: { login: 'me', avatar_url: 'x' }, // self
        body: '',
        path: 'a',
        created_at: 'now',
        updated_at: 'now',
        html_url: 'x',
        pull_request_review_id: 1,
      },
    ]);
    await prMonitorService.forcePoll();

    expect(await inboxCount(db, { type: 'pr_comment' })).toBe(0);
  });

  it('CI failure on an own PR creates a ci_failure inbox item', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([fakePR()]);
    const checks = vi
      .spyOn(githubService, 'getCheckRuns')
      .mockResolvedValue({
        total_count: 0,
        check_runs: [],
      } as never);

    await prMonitorService.forcePoll(); // prime

    checks.mockResolvedValue({
      total_count: 1,
      check_runs: [
        {
          id: 1,
          name: 'lint',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'x',
        },
      ],
    } as never);
    await prMonitorService.forcePoll();

    const rows = await db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.type, 'ci_failure'));
    expect(rows).toHaveLength(1);
  });

  it('does not re-notify CI failure while status stays failure', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([fakePR()]);
    const checks = vi.spyOn(githubService, 'getCheckRuns').mockResolvedValue({
      total_count: 0, check_runs: [],
    } as never);

    await prMonitorService.forcePoll(); // prime: no failures
    checks.mockResolvedValue({
      total_count: 1,
      check_runs: [{ id: 1, name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'x' }],
    } as never);
    await prMonitorService.forcePoll(); // fires once
    await prMonitorService.forcePoll(); // still failing — should NOT fire again

    const rows = await db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.type, 'ci_failure'));
    expect(rows).toHaveLength(1);
  });

  it('mergeability transition false → true fires a pr_ready item', async () => {
    const pr = fakePR({ mergeable: false });
    const listPrs = vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([pr]);

    await prMonitorService.forcePoll(); // prime with mergeable=false

    // Flip to mergeable=true.
    listPrs.mockResolvedValue([fakePR({ mergeable: true })]);
    await prMonitorService.forcePoll();

    const rows = await db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.type, 'pr_ready'));
    expect(rows).toHaveLength(1);
  });

  it('does not fire review inbox items for someone else PR (reviews are self-scoped)', async () => {
    vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([
      fakePR({ userLogin: 'someone-else' }),
    ]);
    const reviews = vi.spyOn(githubService, 'getPRReviews').mockResolvedValue([]);

    await prMonitorService.forcePoll(); // prime
    reviews.mockResolvedValue([fakeReview({ id: 200 })]);
    await prMonitorService.forcePoll();

    // Reviews are only checked on your own PRs.
    expect(await inboxCount(db, { type: 'pr_review' })).toBe(0);
  });

  it('does nothing when no workspace is connected', async () => {
    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue([]);
    const listPrs = vi.spyOn(githubService, 'listPullRequests');

    await prMonitorService.forcePoll();
    expect(listPrs).not.toHaveBeenCalled();
    expect(await inboxCount(db)).toBe(0);
  });
});
