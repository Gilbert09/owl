import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { FREE_PLAN_MERGE_QUEUE_LIMIT, MERGE_QUEUE_LIMIT_ERROR_CODE } from '@talyn/shared';
import { pullRequestRoutes } from '../../routes/pullRequests.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { mergeQueueProcessor } from '../../services/mergeQueueProcessor.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  mergeQueueEntries,
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  users as usersTable,
  workspaces as workspacesTable,
  settings as settingsTable,
} from '../../db/schema.js';
import { eq, inArray } from 'drizzle-orm';

/**
 * POST /:id/merge-queue/stack — enqueue a whole chain of dependent PRs at once.
 *
 * The two properties that matter, and neither is obvious from the handler:
 * the server resolves the chain itself (so a stale client can never enqueue an
 * unrelated PR), and the free-plan gate is ALL-OR-NOTHING (a partial stack
 * silently stops halfway, because the retarget of rung 4 only happens if rung 4
 * is in the queue). Uses the REAL apiErrorHandler so the status/code contract
 * is the one production serves.
 */

const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
  'x-talyn-client-version': '0.3.0-test',
};
const savedPolarToken = process.env.POLAR_ACCESS_TOKEN;

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

describe('merge-queue stack enqueue', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let prSeq = 0;

  async function insertPr(opts: {
    head: string;
    base: string;
    queued?: boolean;
    state?: string;
    workspaceId?: string;
    repositoryId?: string;
  }): Promise<string> {
    const id = `pr-${++prSeq}`;
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: opts.workspaceId ?? 'ws1',
      repositoryId: opts.repositoryId ?? 'repo1',
      taskId: null,
      owner: 'a',
      repo: 'b',
      number: prSeq,
      state: opts.state ?? 'open',
      mergeQueued: opts.queued ?? false,
      mergeQueuedAt: opts.queued ? new Date() : null,
      mergeMethod: 'squash',
      mergeQueueState: opts.queued ? { status: 'waiting', attempts: 0, accounted: true } : null,
      lastPolledAt: new Date(),
      lastSummary: { headBranch: opts.head, baseBranch: opts.base, headSha: `sha-${id}` },
    });
    return id;
  }

  /** main <- A <- B <- C. Returns the ids in stack order. */
  async function seedStack(): Promise<{ a: string; b: string; c: string }> {
    return {
      a: await insertPr({ head: 'feat-a', base: 'main' }),
      b: await insertPr({ head: 'feat-b', base: 'feat-a' }),
      c: await insertPr({ head: 'feat-c', base: 'feat-b' }),
    };
  }

  function post(prId: string, body: Record<string, unknown>) {
    return fetch(`${url}/pull-requests/${prId}/merge-queue/stack`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  async function queuedIds(): Promise<string[]> {
    const rows = await db
      .select({ id: pullRequestsTable.id, queued: pullRequestsTable.mergeQueued })
      .from(pullRequestsTable);
    return rows.filter((r) => r.queued).map((r) => r.id).sort();
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    // Pin the legacy engine: the subject here is the route, and v2 triggers
    // firing background evaluations against the torn-down test DB is noise.
    await db
      .update(settingsTable)
      .set({ value: 'v1' })
      .where(eq(settingsTable.key, 'merge_queue_engine'));
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
      name: 'b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    vi.spyOn(mergeQueueProcessor, 'runOnce').mockResolvedValue(undefined);
    prSeq = 0;
    const s = await makeServer();
    url = s.url;
    close = s.close;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedPolarToken === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolarToken;
    await close();
    await cleanup();
  });

  describe('chain resolution', () => {
    it('anchored on the top PR, enqueues everything it depends on', async () => {
      const { a, b, c } = await seedStack();

      const res = await post(c, { enabled: true });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { pullRequestIds: string[] } };
      // Root-first: enqueuedAt order has to match merge order.
      expect(body.data.pullRequestIds).toEqual([a, b, c]);
      expect(await queuedIds()).toEqual([a, b, c].sort());
    });

    it('anchored on the root, enqueues only the root by default', async () => {
      // "Merge this PR and everything it depends on" — not everything built on
      // top of it, which the user may not be ready to land.
      const { a } = await seedStack();

      const res = await post(a, { enabled: true });

      expect((await res.json()).data.pullRequestIds).toEqual([a]);
      expect(await queuedIds()).toEqual([a]);
    });

    it('includeDescendants pulls in the PRs stacked on top', async () => {
      const { a, b, c } = await seedStack();

      const res = await post(a, { enabled: true, includeDescendants: true });

      expect((await res.json()).data.pullRequestIds.sort()).toEqual([a, b, c].sort());
    });

    it('writes a merge_queue_entries row per member', async () => {
      const { a, b, c } = await seedStack();

      await post(c, { enabled: true });

      const entries = await db
        .select({ prId: mergeQueueEntries.pullRequestId, base: mergeQueueEntries.baseBranch })
        .from(mergeQueueEntries)
        .where(inArray(mergeQueueEntries.pullRequestId, [a, b, c]));
      expect(entries).toHaveLength(3);
      // Each member keeps its OWN base — that is what makes them separate
      // groups, and what the stack gate then serializes.
      expect(entries.find((e) => e.prId === b)?.base).toBe('feat-a');
    });

    it('never crosses into another repository', async () => {
      await db.insert(repositoriesTable).values({
        id: 'repo2',
        workspaceId: 'ws1',
        name: 'c',
        url: 'https://github.com/a/c',
        defaultBranch: 'main',
      });
      const a = await insertPr({ head: 'feat-a', base: 'main' });
      const other = await insertPr({ head: 'feat-b', base: 'feat-a', repositoryId: 'repo2' });

      await post(other, { enabled: true });

      expect(await queuedIds()).toEqual([other]);
      expect(await queuedIds()).not.toContain(a);
    });

    it('stops at a gap rather than inventing a parent', async () => {
      // Talyn only tracks PRs the user authored or was asked to review, so a
      // stack can legitimately have a middle PR we cannot see.
      const b = await insertPr({ head: 'feat-b', base: 'feat-a' });
      const c = await insertPr({ head: 'feat-c', base: 'feat-b' });

      await post(c, { enabled: true });

      expect(await queuedIds()).toEqual([b, c].sort());
    });

    it('409s on a base/head cycle instead of looping', async () => {
      const x = await insertPr({ head: 'feat-x', base: 'feat-y' });
      await insertPr({ head: 'feat-y', base: 'feat-x' });

      const res = await post(x, { enabled: true });

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('stack_cycle');
      expect(await queuedIds()).toEqual([]);
    });

    it('re-arms an already-queued member without violating the active-entry index', async () => {
      const { b, c } = await seedStack();
      await post(b, { enabled: true });

      const res = await post(c, { enabled: true });

      expect(res.status).toBe(200);
      const entries = await db
        .select({ id: mergeQueueEntries.id, prId: mergeQueueEntries.pullRequestId })
        .from(mergeQueueEntries)
        .where(eq(mergeQueueEntries.pullRequestId, b));
      expect(entries).toHaveLength(1);
    });

    it('404s for an unknown PR and 403s across workspaces', async () => {
      expect((await post('nope', { enabled: true })).status).toBe(404);

      await db.insert(usersTable).values({ id: 'other-user', email: 'o@e.com' });
      await db.insert(workspacesTable).values({
        id: 'ws2',
        ownerId: 'other-user',
        name: 'ws2',
        settings: {},
      });
      await db.insert(repositoriesTable).values({
        id: 'repo3',
        workspaceId: 'ws2',
        name: 'd',
        url: 'https://github.com/a/d',
        defaultBranch: 'main',
      });
      const foreign = await insertPr({
        head: 'feat-z',
        base: 'main',
        workspaceId: 'ws2',
        repositoryId: 'repo3',
      });

      expect([403, 404]).toContain((await post(foreign, { enabled: true })).status);
    });
  });

  describe('dequeue', () => {
    it('cascades upward — a parked descendant would otherwise wait forever', async () => {
      const { a, b, c } = await seedStack();
      await post(c, { enabled: true });

      await post(b, { enabled: false });

      // a keeps its place; b and everything stacked on it comes out.
      expect(await queuedIds()).toEqual([a]);
    });

    it('does not drag the ancestors out with it', async () => {
      const { a, b, c } = await seedStack();
      await post(c, { enabled: true });

      await post(c, { enabled: false });

      expect(await queuedIds()).toEqual([a, b].sort());
    });
  });

  describe('free-plan limit', () => {
    async function goUnlimited(): Promise<void> {
      await db
        .update(usersTable)
        .set({ planOverride: 'unlimited' })
        .where(eq(usersTable.id, TEST_USER_ID));
    }

    it('refuses a stack that does not fit, and enqueues NOTHING', async () => {
      // All-or-nothing: a half-enqueued stack stops silently halfway, because
      // the retarget of the next rung only happens if that rung is queued.
      const ids: string[] = [];
      for (let i = 0; i < FREE_PLAN_MERGE_QUEUE_LIMIT + 1; i++) {
        ids.push(
          await insertPr({ head: `feat-${i}`, base: i === 0 ? 'main' : `feat-${i - 1}` })
        );
      }

      const res = await post(ids[ids.length - 1]!, { enabled: true });

      expect(res.status).toBe(402);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe(MERGE_QUEUE_LIMIT_ERROR_CODE);
      // The copy has to name the shortfall — the modal has nowhere else to
      // learn that this was a stack rather than one PR.
      expect(body.error).toContain(`${FREE_PLAN_MERGE_QUEUE_LIMIT + 1} merge-queue slots`);
      expect(await queuedIds()).toEqual([]);
    });

    it('counts what is already queued against the stack', async () => {
      await insertPr({ head: 'unrelated', base: 'main', queued: true });
      const a = await insertPr({ head: 'feat-a', base: 'main' });
      const b = await insertPr({ head: 'feat-b', base: 'feat-a' });
      const c = await insertPr({ head: 'feat-c', base: 'feat-b' });

      // 1 queued + 3 more > 3.
      expect((await post(c, { enabled: true })).status).toBe(402);
      expect(await queuedIds()).toHaveLength(1);

      // 1 queued + 2 more == 3: fits exactly.
      expect((await post(b, { enabled: true })).status).toBe(200);
      expect(await queuedIds()).toHaveLength(3);
      void a;
    });

    it('never lets an already-queued member make its own stack unaffordable', async () => {
      const { a, b, c } = await seedStack();
      await post(c, { enabled: true });

      // Re-arming the same three must not count them twice.
      expect((await post(c, { enabled: true })).status).toBe(200);
      expect(await queuedIds()).toEqual([a, b, c].sort());
    });

    it('lets an unlimited plan enqueue a stack past the free cap', async () => {
      await goUnlimited();
      const ids: string[] = [];
      for (let i = 0; i < FREE_PLAN_MERGE_QUEUE_LIMIT + 2; i++) {
        ids.push(
          await insertPr({ head: `feat-${i}`, base: i === 0 ? 'main' : `feat-${i - 1}` })
        );
      }

      const res = await post(ids[ids.length - 1]!, { enabled: true });

      expect(res.status).toBe(200);
      expect(await queuedIds()).toHaveLength(FREE_PLAN_MERGE_QUEUE_LIMIT + 2);
    });

    it('does not gate a dequeue', async () => {
      await goUnlimited();
      const { c } = await seedStack();
      await post(c, { enabled: true, includeDescendants: true });
      await db
        .update(usersTable)
        .set({ planOverride: null })
        .where(eq(usersTable.id, TEST_USER_ID));

      expect((await post(c, { enabled: false })).status).toBe(200);
    });
  });
});
