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
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  users as usersTable,
  workspaces as workspacesTable,
  settings as settingsTable,
} from '../../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Free-plan merge-queue cap at the route surface: POST /:id/merge-queue must
 * 402 with MERGE_QUEUE_LIMIT_ERROR_CODE once the owner has
 * FREE_PLAN_MERGE_QUEUE_LIMIT PRs queued — and pass for comped/unlimited
 * users, legacy (headerless) clients, dequeues, and re-arms of an
 * already-queued PR. Uses the REAL apiErrorHandler so the status/code
 * contract is the one production serves.
 */

const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
  'x-talyn-client-version': '0.3.0-test',
};
const headerlessHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};
// One below MIN_MERGE_QUEUE_PAYWALL_CLIENT — and deliberately ABOVE the task
// floor, pinning the fact that the two gates have separate floors: this build
// renders a task 402 but not a merge-queue one.
const prePaywallHeaders = {
  ...headerlessHeaders,
  'x-talyn-client-version': '0.2.8',
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

describe('free-plan merge-queue limit at the route surface', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let prSeq = 0;

  async function insertPr(opts: { queued: boolean; state?: string }): Promise<string> {
    const id = `pr-${++prSeq}`;
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      taskId: null,
      owner: 'a',
      repo: 'b',
      number: prSeq,
      state: opts.state ?? 'open',
      mergeQueued: opts.queued,
      mergeQueuedAt: opts.queued ? new Date() : null,
      mergeMethod: 'squash',
      mergeQueueState: opts.queued
        ? { status: 'waiting', attempts: 0, accounted: true }
        : null,
      lastPolledAt: new Date(),
      lastSummary: {},
    });
    return id;
  }

  function enqueue(prId: string, reqHeaders: Record<string, string> = headers) {
    return fetch(`${url}/pull-requests/${prId}/merge-queue`, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({ enabled: true }),
    });
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    // Pin the legacy engine: this suite's subject is the billing gate, and the
    // v2 triggers firing background evaluations against the torn-down test DB
    // would only add noise.
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
    // The route kicks a processor tick after enqueueing — irrelevant here.
    vi.spyOn(mergeQueueProcessor, 'runOnce').mockResolvedValue(undefined);
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

  async function fillQueue(): Promise<void> {
    for (let i = 0; i < FREE_PLAN_MERGE_QUEUE_LIMIT; i++) {
      await insertPr({ queued: true });
    }
  }

  it('402s with the merge-queue code once a free owner has a full queue', async () => {
    await fillQueue();
    const pr = await insertPr({ queued: false });
    const res = await enqueue(pr);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe(MERGE_QUEUE_LIMIT_ERROR_CODE);
    // The PR must NOT have been queued.
    const rows = await db
      .select({ mergeQueued: pullRequestsTable.mergeQueued })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, pr));
    expect(rows[0]?.mergeQueued).toBe(false);
  });

  it('queues normally below the limit', async () => {
    await insertPr({ queued: true });
    const pr = await insertPr({ queued: false });
    expect((await enqueue(pr)).status).toBe(200);
  });

  it('closed/merged rows never eat a free slot', async () => {
    // Stale bookkeeping: queued flags on non-open PRs must not count.
    for (let i = 0; i < FREE_PLAN_MERGE_QUEUE_LIMIT; i++) {
      await insertPr({ queued: true, state: 'merged' });
    }
    const pr = await insertPr({ queued: false });
    expect((await enqueue(pr)).status).toBe(200);
  });

  it('re-arming an already-queued PR at the limit never self-blocks', async () => {
    await fillQueue();
    const rows = await db
      .select({ id: pullRequestsTable.id })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.mergeQueued, true))
      .limit(1);
    expect((await enqueue(rows[0].id)).status).toBe(200);
  });

  it('dequeueing is never gated, even at the limit', async () => {
    await fillQueue();
    const rows = await db
      .select({ id: pullRequestsTable.id })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.mergeQueued, true))
      .limit(1);
    const res = await fetch(`${url}/pull-requests/${rows[0].id}/merge-queue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });

  it('comped (plan_override) owners are unlimited', async () => {
    await db
      .update(usersTable)
      .set({ planOverride: 'unlimited' })
      .where(eq(usersTable.id, TEST_USER_ID));
    await fillQueue();
    const pr = await insertPr({ queued: false });
    expect((await enqueue(pr)).status).toBe(200);
  });

  it('headerless callers (CLI / MCP / curl) are enforced', async () => {
    await fillQueue();
    const pr = await insertPr({ queued: false });
    const res = await enqueue(pr, headerlessHeaders);
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe(MERGE_QUEUE_LIMIT_ERROR_CODE);
    // And the PR must NOT have been queued — the old code fell through to an
    // ungated armQueue(), which uncapped the whole subsystem.
    const rows = await db
      .select({ mergeQueued: pullRequestsTable.mergeQueued })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, pr));
    expect(rows[0]?.mergeQueued).toBe(false);
  });

  it('pre-paywall builds (version below the floor) bypass the gate', async () => {
    await fillQueue();
    const pr = await insertPr({ queued: false });
    expect((await enqueue(pr, prePaywallHeaders)).status).toBe(200);
  });

  it('no POLAR env → no enforcement (the kill switch)', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    await fillQueue();
    const pr = await insertPr({ queued: false });
    expect((await enqueue(pr)).status).toBe(200);
  });
});
