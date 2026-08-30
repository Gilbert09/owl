import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { parsePrRef, pullRequestRoutes } from '../../routes/pullRequests.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import * as githubGraphql from '../../services/githubGraphql.js';
import type { PRSummary } from '../../services/githubGraphql.js';
import { githubService } from '../../services/github.js';
import { prMonitorService } from '../../services/prMonitor.js';
import { GitHubRateLimitError } from '../../services/githubRateGate.js';
import * as repoDefaultBranch from '../../services/repoDefaultBranch.js';

/**
 * POST /pull-requests/watch + DELETE /pull-requests/:id/watch.
 *
 * The two contracts worth pinning, beyond the happy path:
 *   - the unconfirmed-repo refusal spends ZERO GitHub budget (that is the whole
 *     reason there is no separate preflight endpoint), and
 *   - un-watching a QUEUED PR keeps the row, because merge_queue_entries
 *     cascades on it.
 */

const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
  'x-talyn-client-version': '0.3.0-test',
};

function summary(over: Partial<PRSummary> = {}): PRSummary {
  return {
    owner: 'a',
    repo: 'b',
    number: 7,
    title: 'Someone else’s PR',
    body: '',
    url: 'https://github.com/a/b/pull/7',
    author: 'other-person',
    labels: [],
    draft: false,
    state: 'open',
    mergedAt: null,
    closedAt: null,
    headBranch: 'feature',
    baseBranch: 'main',
    headSha: 'deadbeef',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    effectiveReviewDecision: null,
    blockingReason: 'mergeable',
    checks: { total: 3, passed: 2, failed: 0, inProgress: 1, skipped: 0 },
    unresolvedReviewThreads: 0,
    checkContexts: [],
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
    checkDigest: 'digest-0',
    ...over,
  } as PRSummary;
}

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/pull-requests', requireAuth, wrapAsyncRoutes(pullRequestRoutes()));
  app.use(apiErrorHandler);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}

describe('parsePrRef', () => {
  it.each([
    ['https://github.com/a/b/pull/7', 'a', 'b', 7],
    ['http://github.com/a/b/pull/7', 'a', 'b', 7],
    ['github.com/a/b/pull/7', 'a', 'b', 7],
    ['https://github.com/a/b/pull/7/files', 'a', 'b', 7],
    ['https://github.com/a/b/pull/7?diff=split', 'a', 'b', 7],
    ['https://github.com/a/b/pull/7#issuecomment-99', 'a', 'b', 7],
    ['  https://github.com/a/b/pull/7/  ', 'a', 'b', 7],
    ['a/b#7', 'a', 'b', 7],
    ['a/b/pull/7', 'a', 'b', 7],
    // A dot is legal in both an org name and a repo name.
    ['https://github.com/pos.thog/post.hog.com/pull/7', 'pos.thog', 'post.hog.com', 7],
  ])('parses %s', (input, owner, repo, number) => {
    expect(parsePrRef(input)).toEqual({ owner, repo, number });
  });

  it.each([
    // No repo to hang it on — guessing is worse than asking.
    ['#7'],
    ['7'],
    ['https://github.com/a/b'],
    ['https://github.com/a/b/issues/7'],
    ['https://gitlab.com/a/b/pull/7'],
    ['not a url at all'],
    [''],
  ])('refuses %s', (input) => {
    expect(parsePrRef(input)).toBeNull();
  });
});

describe('POST /pull-requests/watch', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let batchSpy: ReturnType<typeof vi.spyOn>;

  function watch(body: Record<string, unknown>) {
    return fetch(`${url}/pull-requests/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws1',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'a/b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    batchSpy = vi
      .spyOn(githubGraphql, 'batchPullRequestsByNumber')
      .mockResolvedValue([{ number: 7, pr: summary() }]);
    vi.spyOn(githubService, 'getUser').mockResolvedValue({
      login: 'me',
    } as Awaited<ReturnType<typeof githubService.getUser>>);
    // resolveCurrentUser memoizes per workspace across tests in this process.
    prMonitorService.invalidateUserLogin('ws1');
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await close();
    await cleanup();
  });

  it('tracks a PR in an already-watched repo', async () => {
    const res = await watch({ workspaceId: 'ws1', url: 'https://github.com/a/b/pull/7' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.watching).toBe(true);
    expect(body.data.authored).toBe(false);
    expect(body.data.repoAdded).toBe(false);
    expect(body.data.alreadyTracked).toBe(false);

    const [row] = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.number, 7));
    expect(row.watching).toBe(true);
    expect(row.state).toBe('open');
    // A real summary, not a placeholder — /refresh needs headBranch.
    expect((row.lastSummary as { headBranch: string }).headBranch).toBe('feature');
  });

  it('sets authored when the pasted PR turns out to be the viewer’s own', async () => {
    batchSpy.mockResolvedValue([{ number: 7, pr: summary({ author: 'me' }) }]);
    const res = await watch({ workspaceId: 'ws1', url: 'a/b#7' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.authored).toBe(true);
    expect(body.data.watching).toBe(true);
  });

  it('refuses an unwatched repo with 409 and spends no GitHub budget', async () => {
    const res = await watch({ workspaceId: 'ws1', url: 'https://github.com/x/y/pull/1' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('repo_not_watched');
    expect(body.owner).toBe('x');
    expect(body.repo).toBe('y');
    // The whole reason there is no separate preflight endpoint.
    expect(batchSpy).not.toHaveBeenCalled();
    const repos = await db.select().from(repositoriesTable);
    expect(repos).toHaveLength(1);
  });

  it('adds the repo when confirmed, with GitHub’s real default branch', async () => {
    vi.spyOn(repoDefaultBranch, 'fetchDefaultBranch').mockResolvedValue('trunk');
    batchSpy.mockResolvedValue([
      { number: 1, pr: summary({ owner: 'x', repo: 'y', number: 1 }) },
    ]);
    const res = await watch({
      workspaceId: 'ws1',
      url: 'https://github.com/x/y/pull/1',
      confirmAddRepo: true,
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.repoAdded).toBe(true);

    const [repo] = await db
      .select()
      .from(repositoriesTable)
      .where(eq(repositoriesTable.name, 'x/y'));
    expect(repo.defaultBranch).toBe('trunk');
  });

  it('is idempotent — re-adding reports alreadyTracked without a duplicate row', async () => {
    await watch({ workspaceId: 'ws1', url: 'https://github.com/a/b/pull/7' });
    const res = await watch({ workspaceId: 'ws1', url: 'https://github.com/a/b/pull/7' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.alreadyTracked).toBe(true);
    const rows = await db.select().from(pullRequestsTable);
    expect(rows).toHaveLength(1);
  });

  it('flips an already-discovered row to watching without inserting a second one', async () => {
    await db.insert(pullRequestsTable).values({
      id: 'pr-existing',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'a',
      repo: 'b',
      number: 7,
      state: 'open',
      reviewRequested: true,
      lastPolledAt: new Date(),
      lastSummary: {},
    });
    const res = await watch({ workspaceId: 'ws1', url: 'https://github.com/a/b/pull/7' });
    expect(res.status).toBe(200);
    const rows = await db.select().from(pullRequestsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('pr-existing');
    expect(rows[0].watching).toBe(true);
  });

  it('404s a PR GitHub cannot resolve', async () => {
    batchSpy.mockResolvedValue([{ number: 7, pr: null }]);
    const res = await watch({ workspaceId: 'ws1', url: 'https://github.com/a/b/pull/7' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('pr_not_found');
    expect(await db.select().from(pullRequestsTable)).toHaveLength(0);
  });

  it('409s a merged PR — the list holds open rows only', async () => {
    batchSpy.mockResolvedValue([
      { number: 7, pr: summary({ state: 'merged', mergedAt: new Date().toISOString() }) },
    ]);
    const res = await watch({ workspaceId: 'ws1', url: 'https://github.com/a/b/pull/7' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('pr_not_open');
    expect(body.error).toContain('merged');
  });

  it('400s an unparseable url before touching GitHub', async () => {
    const res = await watch({ workspaceId: 'ws1', url: 'nonsense' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_url');
    expect(batchSpy).not.toHaveBeenCalled();
  });

  it('400s a missing url', async () => {
    expect((await watch({ workspaceId: 'ws1' })).status).toBe(400);
  });

  it('404s a workspace the caller does not own', async () => {
    await seedUser(db, { id: 'someone-else' });
    await db.insert(workspacesTable).values({
      id: 'ws-other',
      ownerId: 'someone-else',
      name: 'other',
      settings: {},
    });
    const res = await watch({
      workspaceId: 'ws-other',
      url: 'https://github.com/a/b/pull/7',
    });
    expect(res.status).toBe(404);
  });

  it('503s a rate-limited GitHub rather than 500ing it', async () => {
    batchSpy.mockRejectedValue(new GitHubRateLimitError('gated', 30_000));
    const res = await watch({ workspaceId: 'ws1', url: 'https://github.com/a/b/pull/7' });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('rate_limited');
    expect(res.headers.get('retry-after')).toBe('30');
  });
});

describe('DELETE /pull-requests/:id/watch', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;

  async function insertPr(over: Record<string, unknown> = {}): Promise<string> {
    const id = `pr-${Math.random().toString(36).slice(2, 9)}`;
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'a',
      repo: 'b',
      number: 7,
      state: 'open',
      watching: true,
      lastPolledAt: new Date(),
      lastSummary: {},
      ...over,
    });
    return id;
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws1',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'a/b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await close();
    await cleanup();
  });

  function unwatch(id: string) {
    return fetch(`${url}/pull-requests/${id}/watch`, { method: 'DELETE', headers });
  }

  it('deletes a row nothing else references', async () => {
    const id = await insertPr();
    const res = await unwatch(id);
    expect(res.status).toBe(200);
    expect((await res.json()).data.deleted).toBe(true);
    expect(await db.select().from(pullRequestsTable)).toHaveLength(0);
  });

  it.each([
    ['queued', { mergeQueued: true, mergeQueuedAt: new Date() }],
    ['auto-keep-mergeable armed', { autoKeepMergeable: true }],
    ['authored', { authored: true }],
    ['review-requested', { reviewRequested: true }],
  ])('keeps a %s row and only clears the flag', async (_label, over) => {
    const id = await insertPr(over);
    const res = await unwatch(id);
    expect(res.status).toBe(200);
    expect((await res.json()).data.deleted).toBe(false);
    const [row] = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, id));
    expect(row.watching).toBe(false);
    // Un-watching must not cancel a merge the user queued.
    expect(row.mergeQueued).toBe(over.mergeQueued ?? false);
  });

  it('404s an unknown row', async () => {
    expect((await unwatch('nope')).status).toBe(404);
  });

  it('404s a row in a workspace the caller does not own', async () => {
    await seedUser(db, { id: 'someone-else' });
    await db.insert(workspacesTable).values({
      id: 'ws-other',
      ownerId: 'someone-else',
      name: 'other',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo-other',
      workspaceId: 'ws-other',
      name: 'a/b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    const id = await insertPr({ workspaceId: 'ws-other', repositoryId: 'repo-other' });
    expect((await unwatch(id)).status).toBe(404);
    expect(await db.select().from(pullRequestsTable)).toHaveLength(1);
  });
});
