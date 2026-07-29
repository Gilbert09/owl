import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { FREE_PLAN_ACTIVE_TASK_LIMIT, TASK_LIMIT_ERROR_CODE } from '@talyn/shared';
import { taskRoutes } from '../../routes/tasks.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  repositories as repositoriesTable,
  tasks as tasksTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Free-plan concurrency enforcement at the route surface: creation and every
 * re-activation path must 402 with TASK_LIMIT_ERROR_CODE once the owner has
 * FREE_PLAN_ACTIVE_TASK_LIMIT active tasks — and pass for comped/unlimited
 * users. Uses the REAL apiErrorHandler so the status/code contract is the
 * one production serves.
 */

// Enforcement is FAIL-CLOSED (services/billing/clientGate.ts): only a bare
// X.Y.Z older than MIN_TASK_PAYWALL_CLIENT is exempt. A missing header is
// NOT — that used to be the exemption, which let the CLI, the MCP server,
// and plain curl through.
const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
  'x-talyn-client-version': '0.3.0-test',
};
const headerlessHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};
const prePaywallHeaders = {
  ...headerlessHeaders,
  'x-talyn-client-version': '0.2.2', // one below MIN_TASK_PAYWALL_CLIENT
};
const savedPolarToken = process.env.POLAR_ACCESS_TOKEN;

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/tasks', requireAuth, wrapAsyncRoutes(taskRoutes()));
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

describe('free-plan task limit at the route surface', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let taskSeq = 0;

  async function insertTask(status: string): Promise<string> {
    const id = `task-${++taskSeq}`;
    await db.insert(tasksTable).values({
      id,
      workspaceId: 'ws1',
      type: 'code_writing',
      status,
      title: 't',
      description: 'd',
      repositoryId: 'repo1',
    });
    return id;
  }

  async function fillToLimit(): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < FREE_PLAN_ACTIVE_TASK_LIMIT; i++) ids.push(await insertTask('queued'));
    return ids;
  }

  function createBody() {
    return JSON.stringify({
      workspaceId: 'ws1',
      type: 'code_writing',
      title: 'new task',
      description: 'd',
      repositoryId: 'repo1',
    });
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    await seedUser(db);
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'repo',
      url: 'https://github.com/x/y',
    });
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    if (savedPolarToken === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolarToken;
    await close();
    await cleanup();
  });

  describe('POST /tasks', () => {
    it('creates while under the limit', async () => {
      await insertTask('queued');
      const res = await fetch(`${url}/tasks`, { method: 'POST', headers, body: createBody() });
      expect(res.status).toBe(201);
    });

    it(`402s with ${TASK_LIMIT_ERROR_CODE} at the limit`, async () => {
      await fillToLimit();
      const res = await fetch(`${url}/tasks`, { method: 'POST', headers, body: createBody() });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { success: boolean; error: string; code: string };
      expect(body.success).toBe(false);
      expect(body.code).toBe(TASK_LIMIT_ERROR_CODE);
      expect(body.error).toMatch(/free plan/i);
      // And the task was NOT created.
      const rows = await db.select({ id: tasksTable.id }).from(tasksTable);
      expect(rows).toHaveLength(FREE_PLAN_ACTIVE_TASK_LIMIT);
    });

    it.each([
      { label: 'unlimited (subscription)', set: { plan: 'unlimited' } },
      { label: 'comped (plan_override)', set: { planOverride: 'unlimited' } },
    ])('$label user creates past the limit', async ({ set }) => {
      await db.update(usersTable).set(set).where(eq(usersTable.id, TEST_USER_ID));
      await fillToLimit();
      const res = await fetch(`${url}/tasks`, { method: 'POST', headers, body: createBody() });
      expect(res.status).toBe(201);
    });

    it('billing env absent → no enforcement', async () => {
      delete process.env.POLAR_ACCESS_TOKEN;
      await fillToLimit();
      const res = await fetch(`${url}/tasks`, { method: 'POST', headers, body: createBody() });
      expect(res.status).toBe(201);
    });
  });

  // The bypass is fail-closed: identifying as a pre-paywall build exempts you,
  // omitting the header does not. Every activation path is covered on both
  // sides — a gap here is a silent, unmetered paywall hole.
  describe('headerless callers (CLI / MCP / curl) are enforced', () => {
    it(`POST /tasks 402s with ${TASK_LIMIT_ERROR_CODE} at the limit`, async () => {
      await fillToLimit();
      const res = await fetch(`${url}/tasks`, {
        method: 'POST',
        headers: headerlessHeaders,
        body: createBody(),
      });
      expect(res.status).toBe(402);
      expect(((await res.json()) as { code: string }).code).toBe(TASK_LIMIT_ERROR_CODE);
      // And the task was NOT created.
      const rows = await db.select({ id: tasksTable.id }).from(tasksTable);
      expect(rows).toHaveLength(FREE_PLAN_ACTIVE_TASK_LIMIT);
    });

    it.each([
      { label: 'retry', path: (id: string) => `/tasks/${id}/retry` },
      { label: 'start', path: (id: string) => `/tasks/${id}/start` },
    ])('$label of an inactive task 402s at the limit', async ({ path }) => {
      await fillToLimit();
      const failedId = await insertTask('failed');
      const res = await fetch(`${url}${path(failedId)}`, {
        method: 'POST',
        headers: headerlessHeaders,
      });
      expect(res.status).toBe(402);
      const rows = await db
        .select({ status: tasksTable.status })
        .from(tasksTable)
        .where(eq(tasksTable.id, failedId));
      expect(rows[0].status).toBe('failed');
    });

    it('PATCH to an active status 402s at the limit', async () => {
      await fillToLimit();
      const failedId = await insertTask('failed');
      const res = await fetch(`${url}/tasks/${failedId}`, {
        method: 'PATCH',
        headers: headerlessHeaders,
        body: JSON.stringify({ status: 'queued' }),
      });
      expect(res.status).toBe(402);
    });
  });

  describe('pre-paywall builds (version below the floor) stay exempt', () => {
    it('POST /tasks is not enforced at the limit', async () => {
      await fillToLimit();
      const res = await fetch(`${url}/tasks`, {
        method: 'POST',
        headers: prePaywallHeaders,
        body: createBody(),
      });
      expect(res.status).toBe(201);
    });

    it.each([
      { label: 'retry', path: (id: string) => `/tasks/${id}/retry` },
      { label: 'start', path: (id: string) => `/tasks/${id}/start` },
    ])('$label of an inactive task is not enforced at the limit', async ({ path }) => {
      await fillToLimit();
      const failedId = await insertTask('failed');
      const res = await fetch(`${url}${path(failedId)}`, {
        method: 'POST',
        headers: prePaywallHeaders,
      });
      expect(res.status).toBe(200);
    });

    it('PATCH to an active status is not enforced at the limit', async () => {
      await fillToLimit();
      const failedId = await insertTask('failed');
      const res = await fetch(`${url}/tasks/${failedId}`, {
        method: 'PATCH',
        headers: prePaywallHeaders,
        body: JSON.stringify({ status: 'queued' }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('re-activation paths', () => {
    it.each([
      { label: 'POST /tasks/:id/retry', path: (id: string) => `/tasks/${id}/retry` },
      { label: 'POST /tasks/:id/start', path: (id: string) => `/tasks/${id}/start` },
    ])('$label 402s for an inactive task at the limit', async ({ path }) => {
      await fillToLimit();
      const failedId = await insertTask('failed');
      const res = await fetch(`${url}${path(failedId)}`, { method: 'POST', headers });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe(TASK_LIMIT_ERROR_CODE);
      // Task stays failed.
      const rows = await db
        .select({ status: tasksTable.status })
        .from(tasksTable)
        .where(eq(tasksTable.id, failedId));
      expect(rows[0].status).toBe('failed');
    });

    it('PATCH /tasks/:id to an active status 402s at the limit', async () => {
      await fillToLimit();
      const failedId = await insertTask('failed');
      const res = await fetch(`${url}/tasks/${failedId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'queued' }),
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe(TASK_LIMIT_ERROR_CODE);
    });

    it('PATCH to a terminal status is never gated', async () => {
      const ids = await fillToLimit();
      const res = await fetch(`${url}/tasks/${ids[0]}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'cancelled' }),
      });
      expect(res.status).toBe(200);
    });

    it('retry of a still-active task never self-blocks (idempotent re-queue)', async () => {
      const ids = await fillToLimit();
      const res = await fetch(`${url}/tasks/${ids[0]}/retry`, { method: 'POST', headers });
      expect(res.status).toBe(200);
    });

    it('retry passes once a slot frees', async () => {
      const ids = await fillToLimit();
      await db
        .update(tasksTable)
        .set({ status: 'completed' })
        .where(eq(tasksTable.id, ids[0]));
      const failedId = await insertTask('failed');
      const res = await fetch(`${url}/tasks/${failedId}/retry`, { method: 'POST', headers });
      expect(res.status).toBe(200);
    });
  });
});
