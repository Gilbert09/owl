import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { pullRequestRoutes } from '../../routes/pullRequests.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  mergeQueueEntries as mergeQueueEntriesTable,
  tasks as tasksTable,
} from '../../db/schema.js';
import * as graphqlModule from '../../services/githubGraphql.js';
import * as prCacheModule from '../../services/prCache.js';
import * as prCloudFixModule from '../../services/prCloudFix.js';
import type { PRSummary } from '../../services/githubGraphql.js';
import { githubService } from '../../services/github.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/pull-requests', requireAuth, pullRequestRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await seedUser(db, { id: OTHER_USER_ID });
  await db.insert(workspacesTable).values([
    { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
    { id: 'ws-other', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
  ]);
  await db.insert(repositoriesTable).values([
    {
      id: 'repo-mine',
      workspaceId: 'ws-mine',
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      defaultBranch: 'main',
    },
    {
      id: 'repo-other',
      workspaceId: 'ws-other',
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      defaultBranch: 'main',
    },
  ]);
}

let prNumberCounter = 0;
async function insertPR(
  db: Database,
  over: Partial<{
    id: string;
    workspaceId: string;
    repositoryId: string;
    taskId: string | null;
    number: number;
    state: string;
    headBranch: string;
    title: string;
    lastPolledAt: Date;
  }> = {}
): Promise<string> {
  const id = over.id ?? `pr-${Math.random().toString(36).slice(2, 8)}`;
  // Auto-pick a unique number when the caller doesn't care — the
  // pull_requests unique constraint is (workspace, repo, number) so
  // tests inserting multiple PRs in the same repo would otherwise
  // collide.
  const number = over.number ?? ++prNumberCounter;
  await db.insert(pullRequestsTable).values({
    id,
    workspaceId: over.workspaceId ?? 'ws-mine',
    repositoryId: over.repositoryId ?? 'repo-mine',
    taskId: over.taskId ?? null,
    owner: 'acme',
    repo: 'widgets',
    number,
    state: over.state ?? 'open',
    lastPolledAt: over.lastPolledAt ?? new Date(),
    lastSummary: {
      title: over.title ?? 'Add feature',
      headBranch: over.headBranch ?? 'feature/x',
      author: 'me',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
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
    unresolvedReviewThreads: 0,
    checkDigest: 'sha1:',
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
    ...over,
  };
}

const authMine = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/pullRequests', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
    vi.restoreAllMocks();
  });

  // -------- GET / --------

  describe('GET /pull-requests', () => {
    it('requires workspaceId', async () => {
      const res = await fetch(`${serverUrl}/pull-requests`, { headers: authMine });
      expect(res.status).toBe(400);
    });

    it('returns 403 for a workspace the caller does not own', async () => {
      const res = await fetch(`${serverUrl}/pull-requests?workspaceId=ws-other`, {
        headers: authMine,
      });
      // requireWorkspaceAccess returns 404 (not 403) to avoid leaking
      // workspace existence to outsiders.
      expect(res.status).toBe(404);
    });

    it('returns only own-workspace PRs by default (state=open)', async () => {
      await insertPR(db, { id: 'p1', workspaceId: 'ws-mine', state: 'open' });
      await insertPR(db, { id: 'p2', workspaceId: 'ws-mine', state: 'merged' });
      // PR in another workspace should never leak.
      await insertPR(db, {
        id: 'p3',
        workspaceId: 'ws-other',
        repositoryId: 'repo-other',
        state: 'open',
      });
      const res = await fetch(`${serverUrl}/pull-requests?workspaceId=ws-mine`, {
        headers: authMine,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((r) => r.id).sort()).toEqual(['p1']);
    });

    it('honours state=all to include closed + merged', async () => {
      await insertPR(db, { id: 'p1', state: 'open' });
      await insertPR(db, { id: 'p2', state: 'merged' });
      await insertPR(db, { id: 'p3', state: 'closed' });
      const res = await fetch(
        `${serverUrl}/pull-requests?workspaceId=ws-mine&state=all`,
        { headers: authMine }
      );
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((r) => r.id).sort()).toEqual(['p1', 'p2', 'p3']);
    });

    it('filters by repo', async () => {
      await db.insert(repositoriesTable).values({
        id: 'repo-mine-2',
        workspaceId: 'ws-mine',
        name: 'acme/other',
        url: 'https://github.com/acme/other',
        defaultBranch: 'main',
      });
      await insertPR(db, { id: 'p1', repositoryId: 'repo-mine' });
      await insertPR(db, { id: 'p2', repositoryId: 'repo-mine-2' });
      const res = await fetch(
        `${serverUrl}/pull-requests?workspaceId=ws-mine&repo=repo-mine-2`,
        { headers: authMine }
      );
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((r) => r.id)).toEqual(['p2']);
    });

    it('filters by taskOnly=true to only show task-linked PRs', async () => {
      await db.insert(tasksTable).values({
        id: 'task-1',
        workspaceId: 'ws-mine',
        type: 'code_writing',
        status: 'in_progress',
        priority: 'medium',
        title: 'a',
        description: 'b',
      });
      await insertPR(db, { id: 'p1', taskId: 'task-1' });
      await insertPR(db, { id: 'p2', taskId: null });
      const res = await fetch(
        `${serverUrl}/pull-requests?workspaceId=ws-mine&taskOnly=true`,
        { headers: authMine }
      );
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((r) => r.id)).toEqual(['p1']);
    });

    it('filters by title or owner/repo substring (case-insensitive)', async () => {
      await insertPR(db, { id: 'p1', title: 'Add login flow' });
      await insertPR(db, { id: 'p2', title: 'Refactor styles' });
      const res = await fetch(
        `${serverUrl}/pull-requests?workspaceId=ws-mine&search=LOGIN`,
        { headers: authMine }
      );
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((r) => r.id)).toEqual(['p1']);
    });

    it('matches search against owner/repo, not only the title', async () => {
      // Every inserted PR is acme/widgets; the title here deliberately misses.
      await insertPR(db, { id: 'p1', title: 'Unrelated change' });
      const res = await fetch(
        `${serverUrl}/pull-requests?workspaceId=ws-mine&search=WIDGETS`,
        { headers: authMine }
      );
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((r) => r.id)).toEqual(['p1']);
    });

    it('treats LIKE metacharacters in the search term literally', async () => {
      await insertPR(db, { id: 'p1', title: '50% off sale' });
      await insertPR(db, { id: 'p2', title: 'no discount' });
      // Unescaped, the "%" would act as a wildcard and match everything;
      // "50%" must hit only p1.
      const res = await fetch(
        `${serverUrl}/pull-requests?workspaceId=ws-mine&search=${encodeURIComponent('50%')}`,
        { headers: authMine }
      );
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((r) => r.id)).toEqual(['p1']);
    });
  });

  // -------- GET /:id --------

  describe('GET /pull-requests/:id', () => {
    it('returns 404 for a missing id', async () => {
      const res = await fetch(`${serverUrl}/pull-requests/none`, { headers: authMine });
      expect(res.status).toBe(404);
    });

    it('returns 403 for a PR in a workspace the caller does not own', async () => {
      const id = await insertPR(db, {
        workspaceId: 'ws-other',
        repositoryId: 'repo-other',
      });
      const res = await fetch(`${serverUrl}/pull-requests/${id}`, { headers: authMine });
      // requireWorkspaceAccess returns 404 (not 403) to avoid leaking
      // workspace existence to outsiders.
      expect(res.status).toBe(404);
    });

    it('returns the persisted row + a fresh GraphQL fetch', async () => {
      const id = await insertPR(db, { headBranch: 'feature/x' });
      const spy = vi
        .spyOn(graphqlModule, 'batchPullRequests')
        .mockResolvedValue([
          {
            branch: 'feature/x',
            pr: fakeSummary({
              recentReviews: [
                {
                  id: 'r1',
                  author: 'alice',
                  state: 'COMMENTED',
                  submittedAt: 'now',
                  url: 'x',
                },
              ],
            }),
          },
        ]);
      const res = await fetch(`${serverUrl}/pull-requests/${id}`, { headers: authMine });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { row: { id: string }; fresh: PRSummary | null };
      };
      expect(body.data.row.id).toBe(id);
      expect(body.data.fresh?.recentReviews?.[0]?.id).toBe('r1');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('still returns the cached row when the GraphQL fetch fails', async () => {
      const id = await insertPR(db);
      vi.spyOn(graphqlModule, 'batchPullRequests').mockRejectedValue(
        new Error('rate limit')
      );
      const res = await fetch(`${serverUrl}/pull-requests/${id}`, { headers: authMine });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { row: { id: string }; fresh: unknown };
      };
      expect(body.data.row.id).toBe(id);
      expect(body.data.fresh).toBeNull();
    });

    it('persists the fresh fetch into the cache when it materially differs', async () => {
      // Mirrors the base-retarget bug: the cached row has a stale base + no
      // blocking verdict; the live fetch resolves the new base + a real
      // failure. Opening the PR should self-heal the cache, not just display.
      const id = await insertPR(db, { headBranch: 'feature/x' });
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
        {
          branch: 'feature/x',
          pr: fakeSummary({
            baseBranch: 'master',
            blockingReason: 'checks_failed',
            mergeStateStatus: 'BLOCKED',
            checks: { total: 4, passed: 1, failed: 3, inProgress: 0, skipped: 0 },
            checkDigest: 'sha1:Frontend=failure',
          }),
        },
      ]);
      const res = await fetch(`${serverUrl}/pull-requests/${id}`, { headers: authMine });
      expect(res.status).toBe(200);

      const [persisted] = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, id));
      const summary = persisted.lastSummary as Record<string, unknown>;
      expect(summary.baseBranch).toBe('master');
      expect(summary.blockingReason).toBe('checks_failed');
      expect(persisted.lastCheckDigest).toBe('sha1:Frontend=failure');
    });

    // The desktop sheet paints the seeded list row and then REPLACES it with
    // this response. The list row carries `mergeQueue` (the v2 entry); a
    // detail response that drops it reads as "never queued", which took the
    // Requeue button off a blocked PR the moment the description loaded.
    it('carries the merge-queue v2 entry, like the list endpoint does', async () => {
      const id = await insertPR(db, { headBranch: 'feature/x' });
      await db.insert(mergeQueueEntriesTable).values({
        id: 'entry-1',
        pullRequestId: id,
        workspaceId: 'ws-mine',
        repositoryId: 'repo-mine',
        baseBranch: 'main',
        status: 'blocked',
        blockedCode: 'checks_failed',
        blockedReason: 'Required checks failed',
        headSha: 'abcdef1234567890',
        fixAttempts: 2,
      });
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
        { branch: 'feature/x', pr: fakeSummary() },
      ]);

      const res = await fetch(`${serverUrl}/pull-requests/${id}`, { headers: authMine });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          row: {
            mergeQueue: {
              status: string;
              position: number;
              reason?: string;
              headShaShort?: string;
              budgets: { fixRuns: [number, number] };
            } | null;
          };
        };
      };
      expect(body.data.row.mergeQueue?.status).toBe('blocked');
      expect(body.data.row.mergeQueue?.position).toBe(1);
      expect(body.data.row.mergeQueue?.reason).toBe('Required checks failed');
      expect(body.data.row.mergeQueue?.headShaShort).toBe('abcdef1');
      expect(body.data.row.mergeQueue?.budgets.fixRuns[0]).toBe(2);
    });

    it('positions the entry within its own (repo, base) group', async () => {
      const first = await insertPR(db, { headBranch: 'feature/a' });
      const second = await insertPR(db, { headBranch: 'feature/b' });
      await db.insert(mergeQueueEntriesTable).values([
        {
          id: 'entry-a',
          pullRequestId: first,
          workspaceId: 'ws-mine',
          repositoryId: 'repo-mine',
          baseBranch: 'main',
          status: 'queued',
          enqueuedAt: new Date('2026-08-01T00:00:00Z'),
        },
        {
          id: 'entry-b',
          pullRequestId: second,
          workspaceId: 'ws-mine',
          repositoryId: 'repo-mine',
          baseBranch: 'main',
          status: 'queued',
          enqueuedAt: new Date('2026-08-01T01:00:00Z'),
        },
      ]);
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
        { branch: 'feature/b', pr: fakeSummary() },
      ]);

      const res = await fetch(`${serverUrl}/pull-requests/${second}`, { headers: authMine });
      const body = (await res.json()) as {
        data: { row: { mergeQueue: { position: number } | null } };
      };
      expect(body.data.row.mergeQueue?.position).toBe(2);
    });

    it('reports null for a PR that was never queued', async () => {
      const id = await insertPR(db, { headBranch: 'feature/x' });
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
        { branch: 'feature/x', pr: fakeSummary() },
      ]);
      const res = await fetch(`${serverUrl}/pull-requests/${id}`, { headers: authMine });
      const body = (await res.json()) as { data: { row: { mergeQueue: unknown } } };
      expect(body.data.row.mergeQueue).toBeNull();
    });

    it('does NOT re-persist on a subsequent open when nothing material changed', async () => {
      const id = await insertPR(db, { headBranch: 'feature/x' });
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
        { branch: 'feature/x', pr: fakeSummary({ baseBranch: 'master' }) },
      ]);
      // First open persists the fresh summary into the cache.
      await fetch(`${serverUrl}/pull-requests/${id}`, { headers: authMine });

      // Second open with the identical fresh summary must be a pure read.
      const upsertSpy = vi.spyOn(prCacheModule, 'upsertFromBatchResult');
      const res = await fetch(`${serverUrl}/pull-requests/${id}`, { headers: authMine });
      expect(res.status).toBe(200);
      expect(upsertSpy).not.toHaveBeenCalled();
    });
  });

  // -------- POST /:id/fix --------

  describe('POST /pull-requests/:id/fix', () => {
    function fakeTaskRow(over: Record<string, unknown> = {}) {
      const now = new Date();
      return {
        id: 'task-fix-1',
        workspaceId: 'ws-mine',
        type: 'pr_response',
        status: 'queued',
        priority: 'medium',
        title: 'Get acme/widgets#1 mergeable',
        description: '',
        prompt: 'standard prompt',
        repositoryId: 'repo-mine',
        branch: null,
        assignedEnvironmentId: 'env-1',
        result: null,
        metadata: null,
        transcript: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        ...over,
      };
    }

    it('404 for a missing PR', async () => {
      const res = await fetch(`${serverUrl}/pull-requests/none/fix`, {
        method: 'POST',
        headers: authMine,
      });
      expect(res.status).toBe(404);
    });

    it('fires the standard mergeable run and returns the created task', async () => {
      const id = await insertPR(db);
      const spy = vi
        .spyOn(prCloudFixModule, 'startPrMergeableRun')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue({ ok: true, task: fakeTaskRow() as any });
      const res = await fetch(`${serverUrl}/pull-requests/${id}/fix`, {
        method: 'POST',
        headers: authMine,
        body: JSON.stringify({ model: 'claude-opus-4-8' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string; type: string } };
      expect(body.data.id).toBe('task-fix-1');
      expect(body.data.type).toBe('pr_response');
      // The route forwards the PR row + model to the canonical action. This
      // caller sends no client-version header, and the gate is fail-closed —
      // headerless means enforce, not exempt.
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        { model: 'claude-opus-4-8', bypassTaskLimit: false }
      );
    });

    it('bypasses the task limit for pre-paywall builds only', async () => {
      const id = await insertPR(db);
      const spy = vi
        .spyOn(prCloudFixModule, 'startPrMergeableRun')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue({ ok: true, task: fakeTaskRow() as any });
      const res = await fetch(`${serverUrl}/pull-requests/${id}/fix`, {
        method: 'POST',
        headers: { ...authMine, 'x-talyn-client-version': '0.2.2' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        expect.objectContaining({ bypassTaskLimit: true })
      );
    });

    it('does not bypass the task limit for billing-aware clients (header present)', async () => {
      const id = await insertPR(db);
      const spy = vi
        .spyOn(prCloudFixModule, 'startPrMergeableRun')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue({ ok: true, task: fakeTaskRow() as any });
      const res = await fetch(`${serverUrl}/pull-requests/${id}/fix`, {
        method: 'POST',
        headers: { ...authMine, 'x-talyn-client-version': '0.3.0-test' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        expect.objectContaining({ bypassTaskLimit: false })
      );
    });

    it('400 when the workspace has no connected cloud provider', async () => {
      const id = await insertPR(db);
      vi.spyOn(prCloudFixModule, 'startPrMergeableRun').mockResolvedValue({
        ok: false,
        reason: 'no_cloud_provider',
      });
      const res = await fetch(`${serverUrl}/pull-requests/${id}/fix`, {
        method: 'POST',
        headers: authMine,
      });
      expect(res.status).toBe(400);
    });
  });

  // -------- GET /:id/files --------

  describe('GET /pull-requests/:id/files', () => {
    it('returns the file list (with patches) from githubService', async () => {
      const id = await insertPR(db);
      const spy = vi.spyOn(githubService, 'getPRFiles').mockResolvedValue([
        {
          sha: 'abc',
          filename: 'src/app.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: '@@ -1,2 +1,4 @@\n a\n+b\n+c\n-d',
        },
      ]);
      const res = await fetch(`${serverUrl}/pull-requests/${id}/files`, {
        headers: authMine,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ filename: string; patch: string }> };
      expect(body.data[0].filename).toBe('src/app.ts');
      expect(body.data[0].patch).toContain('@@');
      expect(spy).toHaveBeenCalledWith('ws-mine', 'acme', 'widgets', expect.any(Number));
    });

    it('returns 404 for a missing PR', async () => {
      const res = await fetch(`${serverUrl}/pull-requests/missing/files`, {
        headers: authMine,
      });
      expect(res.status).toBe(404);
    });

    it('refuses cross-workspace file access', async () => {
      const id = await insertPR(db, {
        workspaceId: 'ws-other',
        repositoryId: 'repo-other',
      });
      const res = await fetch(`${serverUrl}/pull-requests/${id}/files`, {
        headers: authMine,
      });
      expect(res.status).toBe(404);
    });

    it('surfaces a 400 when the GitHub fetch throws (e.g. token revoked)', async () => {
      const id = await insertPR(db);
      vi.spyOn(githubService, 'getPRFiles').mockRejectedValue(new Error('bad credentials'));
      const res = await fetch(`${serverUrl}/pull-requests/${id}/files`, {
        headers: authMine,
      });
      expect(res.status).toBe(400);
    });
  });

  // -------- POST /:id/refresh --------

  describe('POST /pull-requests/:id/refresh', () => {
    it('forces a GraphQL fetch + upsert and returns the new shape', async () => {
      const id = await insertPR(db, { title: 'Old' });
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
        {
          branch: 'feature/x',
          pr: fakeSummary({ title: 'Refreshed' }),
        },
      ]);
      const res = await fetch(`${serverUrl}/pull-requests/${id}/refresh`, {
        method: 'POST',
        headers: authMine,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { id: string; summary: { title: string } };
      };
      expect(body.data.id).toBe(id);
      expect(body.data.summary.title).toBe('Refreshed');

      // DB row was updated.
      const row = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, id))
        .limit(1);
      expect((row[0].lastSummary as { title: string }).title).toBe('Refreshed');
    });

    it('carries the merge-queue v2 entry too', async () => {
      const id = await insertPR(db, { headBranch: 'feature/x' });
      await db.insert(mergeQueueEntriesTable).values({
        id: 'entry-refresh',
        pullRequestId: id,
        workspaceId: 'ws-mine',
        repositoryId: 'repo-mine',
        baseBranch: 'main',
        status: 'blocked_manual',
        blockedReason: 'Needs a manual merge',
      });
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
        { branch: 'feature/x', pr: fakeSummary() },
      ]);
      const res = await fetch(`${serverUrl}/pull-requests/${id}/refresh`, {
        method: 'POST',
        headers: authMine,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { mergeQueue: { status: string } | null } };
      expect(body.data.mergeQueue?.status).toBe('blocked_manual');
    });

    it('refuses cross-workspace refresh', async () => {
      const id = await insertPR(db, {
        workspaceId: 'ws-other',
        repositoryId: 'repo-other',
      });
      const res = await fetch(`${serverUrl}/pull-requests/${id}/refresh`, {
        method: 'POST',
        headers: authMine,
      });
      // requireWorkspaceAccess returns 404 (not 403) to avoid leaking
      // workspace existence to outsiders.
      expect(res.status).toBe(404);
    });

    it('returns 404 when the PR is missing', async () => {
      const res = await fetch(`${serverUrl}/pull-requests/missing/refresh`, {
        method: 'POST',
        headers: authMine,
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 when GraphQL has nothing for the head branch (e.g. PR closed remotely)', async () => {
      const id = await insertPR(db);
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
        { branch: 'feature/x', pr: null },
      ]);
      const res = await fetch(`${serverUrl}/pull-requests/${id}/refresh`, {
        method: 'POST',
        headers: authMine,
      });
      expect(res.status).toBe(404);
    });
  });

  // -------- POST /:id/focus --------

  describe('POST /pull-requests/:id/focus', () => {
    it('returns 204 for an authorized PR (Phase 6 will wire the side effect)', async () => {
      const id = await insertPR(db);
      const res = await fetch(`${serverUrl}/pull-requests/${id}/focus`, {
        method: 'POST',
        headers: authMine,
      });
      expect(res.status).toBe(204);
    });

    it('returns 404 for a missing PR', async () => {
      const res = await fetch(`${serverUrl}/pull-requests/missing/focus`, {
        method: 'POST',
        headers: authMine,
      });
      expect(res.status).toBe(404);
    });

    it('refuses cross-workspace focus', async () => {
      const id = await insertPR(db, {
        workspaceId: 'ws-other',
        repositoryId: 'repo-other',
      });
      const res = await fetch(`${serverUrl}/pull-requests/${id}/focus`, {
        method: 'POST',
        headers: authMine,
      });
      // requireWorkspaceAccess returns 404 (not 403) to avoid leaking
      // workspace existence to outsiders.
      expect(res.status).toBe(404);
    });
  });

  // GitHub REST single-PR shape for getPullRequest mocks.
  function fakeRESTPR(over: Partial<{ state: string; merged: boolean; mergedAt: string | null }> = {}) {
    return {
      id: 1,
      number: 42,
      title: 't',
      state: over.state ?? 'closed',
      html_url: 'https://github.com/acme/widgets/pull/42',
      user: { login: 'me', avatar_url: 'x' },
      created_at: 'now',
      updated_at: 'now',
      draft: false,
      mergeable: null,
      mergeable_state: 'clean',
      head: { ref: 'feature/x', sha: 'sha1' },
      base: { ref: 'main' },
      merged: over.merged ?? false,
      merged_at: over.mergedAt ?? null,
    };
  }

  describe('POST /pull-requests/:id/merge', () => {
    it('marks the row merged directly (not via a GraphQL refetch)', async () => {
      const id = await insertPR(db, { state: 'open' });
      const mergeSpy = vi
        .spyOn(githubService, 'mergePullRequest')
        .mockResolvedValue({ sha: 'abc', merged: true, message: 'Merged' });
      // GraphQL must NOT be relied on — a merged PR returns empty there.
      const graphqlSpy = vi.spyOn(graphqlModule, 'batchPullRequests');

      const res = await fetch(`${serverUrl}/pull-requests/${id}/merge`, {
        method: 'POST',
        headers: authMine,
        body: JSON.stringify({ method: 'squash' }),
      });
      expect(res.status).toBe(200);
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(graphqlSpy).not.toHaveBeenCalled();

      const row = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, id))
        .limit(1);
      expect(row[0].state).toBe('merged');
      expect(row[0].mergedAt).not.toBeNull();
    });

    it('surfaces GitHub\'s reason as a 400 when the merge is rejected', async () => {
      const id = await insertPR(db, { state: 'open' });
      vi.spyOn(githubService, 'mergePullRequest').mockRejectedValue(
        new Error('GitHub API error 405 Method Not Allowed: Pull Request is not mergeable')
      );

      const res = await fetch(`${serverUrl}/pull-requests/${id}/merge`, {
        method: 'POST',
        headers: authMine,
        body: JSON.stringify({ method: 'squash' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Pull Request is not mergeable');

      // The row must NOT have been flipped to merged.
      const row = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, id))
        .limit(1);
      expect(row[0].state).toBe('open');
      expect(row[0].mergedAt).toBeNull();
    });

    // Clicking Merge on a PR that had already merged is the SYMPTOM of a stale
    // row, so the click is the last chance to correct it. REST is authoritative
    // here, and it draws on a different budget from the GraphQL the poll
    // couldn't get — which is exactly why the row was stale.
    it('reconciles an already-merged PR instead of reporting a merge failure', async () => {
      const id = await insertPR(db, { state: 'open' });
      vi.spyOn(githubService, 'mergePullRequest').mockRejectedValue(
        new Error('GitHub API error 405 Method Not Allowed: Pull Request is not mergeable')
      );
      vi.spyOn(githubService, 'getPullRequest').mockResolvedValue(
        fakeRESTPR({ state: 'closed', merged: true, mergedAt: '2026-08-24T11:36:14Z' }) as never
      );

      const res = await fetch(`${serverUrl}/pull-requests/${id}/merge`, {
        method: 'POST',
        headers: authMine,
        body: JSON.stringify({ method: 'squash' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { merged: boolean; alreadyTerminal: boolean; message: string };
      };
      expect(body.data.alreadyTerminal).toBe(true);
      expect(body.data.merged).toBe(true);

      const row = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, id))
        .limit(1);
      expect(row[0].state).toBe('merged');
      expect(row[0].mergedAt?.toISOString()).toBe('2026-08-24T11:36:14.000Z');
    });

    it('reports a genuine merge failure as a 400 when the PR really is still open', async () => {
      const id = await insertPR(db, { state: 'open' });
      vi.spyOn(githubService, 'mergePullRequest').mockRejectedValue(
        new Error('GitHub API error 405 Method Not Allowed: Pull Request is not mergeable')
      );
      vi.spyOn(githubService, 'getPullRequest').mockResolvedValue(
        fakeRESTPR({ state: 'open' }) as never
      );

      const res = await fetch(`${serverUrl}/pull-requests/${id}/merge`, {
        method: 'POST',
        headers: authMine,
        body: JSON.stringify({ method: 'squash' }),
      });
      expect(res.status).toBe(400);
      const row = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, id))
        .limit(1);
      expect(row[0].state).toBe('open');
    });

    it('does not mark the row merged when GitHub returns merged:false', async () => {
      const id = await insertPR(db, { state: 'open' });
      vi.spyOn(githubService, 'mergePullRequest').mockResolvedValue({
        sha: '',
        merged: false,
        message: 'Base branch was modified. Review and try the merge again.',
      });

      const res = await fetch(`${serverUrl}/pull-requests/${id}/merge`, {
        method: 'POST',
        headers: authMine,
        body: JSON.stringify({ method: 'squash' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Base branch was modified');

      const row = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, id))
        .limit(1);
      expect(row[0].state).toBe('open');
    });
  });

  describe('POST /pull-requests/view', () => {
    it('accepts a valid view for an owned workspace', async () => {
      const res = await fetch(`${serverUrl}/pull-requests/view`, {
        method: 'POST',
        headers: authMine,
        body: JSON.stringify({ workspaceId: 'ws-mine', view: 'review' }),
      });
      expect(res.status).toBe(204);
    });

    it('rejects an unknown view value', async () => {
      const res = await fetch(`${serverUrl}/pull-requests/view`, {
        method: 'POST',
        headers: authMine,
        body: JSON.stringify({ workspaceId: 'ws-mine', view: 'everything' }),
      });
      expect(res.status).toBe(400);
    });

    it('refuses a workspace the caller does not own', async () => {
      const res = await fetch(`${serverUrl}/pull-requests/view`, {
        method: 'POST',
        headers: authMine,
        body: JSON.stringify({ workspaceId: 'ws-other', view: 'mine' }),
      });
      // requireWorkspaceAccess returns 404 (not 403) so it can't be used to
      // probe which workspaces exist.
      expect(res.status).toBe(404);
    });
  });

  describe('terminal-state reconciliation', () => {
    it('refresh recovers a stuck closed row that is actually merged', async () => {
      // Row mis-classified as closed (e.g. a transient sweep failure).
      const id = await insertPR(db, { state: 'closed' });
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
        { branch: 'feature/x', pr: null },
      ]);
      vi.spyOn(githubService, 'getPullRequest').mockResolvedValue(
        fakeRESTPR({ state: 'closed', merged: true, mergedAt: '2026-04-30T00:00:00Z' }) as never
      );

      const res = await fetch(`${serverUrl}/pull-requests/${id}/refresh`, {
        method: 'POST',
        headers: authMine,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { state: string } };
      expect(body.data.state).toBe('merged');

      const row = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, id))
        .limit(1);
      expect(row[0].state).toBe('merged');
      expect(row[0].mergedAt).not.toBeNull();
    });

    it('GET /:id reconciles an open row that merged upstream', async () => {
      const id = await insertPR(db, { state: 'open' });
      // GraphQL only returns OPEN PRs → empty for a merged one.
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([]);
      vi.spyOn(githubService, 'getPullRequest').mockResolvedValue(
        fakeRESTPR({ state: 'closed', merged: true, mergedAt: '2026-04-30T00:00:00Z' }) as never
      );

      const res = await fetch(`${serverUrl}/pull-requests/${id}`, { headers: authMine });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { row: { state: string } } };
      expect(body.data.row.state).toBe('merged');
    });
  });

  describe('GET /pull-requests relationship filter', () => {
    async function insertWithRelationship(
      id: string,
      flags: { authored?: boolean; reviewRequested?: boolean }
    ) {
      await db.insert(pullRequestsTable).values({
        id,
        workspaceId: 'ws-mine',
        repositoryId: 'repo-mine',
        owner: 'acme',
        repo: 'widgets',
        number: ++prNumberCounter,
        state: 'open',
        authored: flags.authored ?? false,
        reviewRequested: flags.reviewRequested ?? false,
        lastPolledAt: new Date(),
        lastSummary: { title: 't', headBranch: 'h', author: 'a', url: `u-${id}` },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    it('filters to authored vs review_requested, and returns the flags', async () => {
      await insertWithRelationship('p-mine', { authored: true });
      await insertWithRelationship('p-review', { reviewRequested: true });
      // A PR I've already reviewed: neither tab, but still under "All".
      await insertWithRelationship('p-reviewed', {});

      const authored = await fetch(
        `${serverUrl}/pull-requests?workspaceId=ws-mine&relationship=authored`,
        { headers: authMine }
      );
      const aBody = (await authored.json()) as {
        data: Array<{ id: string; authored: boolean }>;
      };
      expect(aBody.data.map((r) => r.id)).toEqual(['p-mine']);
      expect(aBody.data[0].authored).toBe(true);

      const review = await fetch(
        `${serverUrl}/pull-requests?workspaceId=ws-mine&relationship=review_requested`,
        { headers: authMine }
      );
      const rBody = (await review.json()) as {
        data: Array<{ id: string; reviewRequested: boolean }>;
      };
      expect(rBody.data.map((r) => r.id)).toEqual(['p-review']);
      expect(rBody.data[0].reviewRequested).toBe(true);

      const all = await fetch(`${serverUrl}/pull-requests?workspaceId=ws-mine`, {
        headers: authMine,
      });
      const allBody = (await all.json()) as { data: Array<{ id: string }> };
      expect(allBody.data.map((r) => r.id).sort()).toEqual([
        'p-mine',
        'p-review',
        'p-reviewed',
      ]);
    });
  });

});
