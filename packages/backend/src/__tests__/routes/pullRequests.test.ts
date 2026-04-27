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
  tasks as tasksTable,
} from '../../db/schema.js';
import * as graphqlModule from '../../services/githubGraphql.js';
import type { PRSummary } from '../../services/githubGraphql.js';

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
        status: 'awaiting_review',
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
});
