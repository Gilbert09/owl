import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { adminRoutes } from '../../routes/admin/index.js';
import { createTestDb, seedUser } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  adminAuditLog,
  tasks as tasksTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';

/**
 * The mutations that change money and privilege.
 *
 * Written refusal-first: for each one, the cases that must FAIL outnumber the
 * case that succeeds, because the whole design here is a stack of small
 * specific refusals rather than a permission model. If any of them stops
 * refusing, nothing else catches it — `is_admin` is the only other gate, and
 * by this point it has already been satisfied.
 *
 * The other invariant running through every case: the audit row and the change
 * commit together, or neither does. A comp with no record of who granted it is
 * exactly what this posture exists to prevent.
 */

const OPERATOR = 'user-operator';
const ALICE = 'user-alice';

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let closeServer: () => Promise<void>;

function stubAdmin(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  req.user = { id: OPERATOR, email: 'op@talyn.dev', isAdmin: true };
  next();
}

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', stubAdmin, adminRoutes());
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

interface MutationResponse {
  success: boolean;
  error?: string;
  code?: string;
  data?: Record<string, unknown>;
}

async function post(path: string, body: unknown): Promise<{ status: number; body: MutationResponse }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as MutationResponse };
}

const REASON = 'customer reported the agent hung mid-run';

async function alicePlan() {
  const rows = await db
    .select({ plan: usersTable.plan, planOverride: usersTable.planOverride, isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, ALICE));
  return rows[0]!;
}

async function auditRows() {
  return db.select().from(adminAuditLog);
}

beforeEach(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  cleanup = testDb.cleanup;
  delete process.env.TALYN_ADMIN_GRANT_ENABLED;

  await seedUser(db, { id: OPERATOR, email: 'op@talyn.dev' });
  await seedUser(db, { id: ALICE, email: 'alice@example.test' });
  await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, OPERATOR));
  await db
    .insert(workspacesTable)
    .values({ id: 'ws-1', ownerId: ALICE, name: 'Acme', settings: {} });
  await db.insert(tasksTable).values({
    id: 'task-1',
    workspaceId: 'ws-1',
    type: 'code_writing',
    status: 'in_progress',
    priority: 'medium',
    title: 'A task',
    description: '',
    metadata: { cloudTask: { provider: 'selfhosted', remoteTaskId: 'talyn-1' } },
  });

  const s = await makeServer();
  url = s.url;
  closeServer = s.close;
});

afterEach(async () => {
  await closeServer();
  await cleanup();
  vi.restoreAllMocks();
  delete process.env.TALYN_ADMIN_GRANT_ENABLED;
});

describe('POST /admin/users/:id/plan-override', () => {
  const ok = { planOverride: 'unlimited', reason: REASON, confirm: 'alice@example.test' };

  it('comps an account and records it', async () => {
    const res = await post(`/api/v1/admin/users/${ALICE}/plan-override`, ok);
    expect(res.status).toBe(200);
    expect((await alicePlan()).planOverride).toBe('unlimited');

    const [row] = await auditRows();
    expect(row!.action).toBe('user.plan_override');
    expect(row!.targetId).toBe(ALICE);
    expect(row!.reason).toBe(REASON);
    expect(row!.before).toEqual({ plan: 'free', planOverride: null });
    expect(row!.after).toEqual({ plan: 'free', planOverride: 'unlimited' });
  });

  it('writes plan_override ONLY, never plan', async () => {
    // `plan` is Polar's column. A manual write there is reverted by the next
    // subscription webhook, which reads as the comp wearing off days later
    // with nothing to explain it.
    await post(`/api/v1/admin/users/${ALICE}/plan-override`, ok);
    expect((await alicePlan()).plan).toBe('free');
  });

  it('can take a comp away', async () => {
    await post(`/api/v1/admin/users/${ALICE}/plan-override`, ok);
    const res = await post(`/api/v1/admin/users/${ALICE}/plan-override`, {
      planOverride: null,
      reason: REASON,
      confirm: 'alice@example.test',
    });
    expect(res.status).toBe(200);
    expect((await alicePlan()).planOverride).toBeNull();
  });

  it('refuses without a reason, and changes nothing', async () => {
    const res = await post(`/api/v1/admin/users/${ALICE}/plan-override`, {
      planOverride: 'unlimited',
      confirm: 'alice@example.test',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('reason_required');
    expect((await alicePlan()).planOverride).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it.each([
    ['a wrong email', 'someone-else@example.test'],
    ['an empty confirm', ''],
    ['a missing confirm', undefined],
  ])('refuses %s, and changes nothing', async (_label, confirm) => {
    const res = await post(`/api/v1/admin/users/${ALICE}/plan-override`, {
      planOverride: 'unlimited',
      reason: REASON,
      confirm,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('confirm_mismatch');
    expect((await alicePlan()).planOverride).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('accepts a case-different confirm — the operator is reading, not transcribing', async () => {
    const res = await post(`/api/v1/admin/users/${ALICE}/plan-override`, {
      ...ok,
      confirm: 'Alice@Example.TEST',
    });
    expect(res.status).toBe(200);
  });

  it('refuses to comp YOUR OWN account', async () => {
    // Blocks the quiet self-comp. psql still works, and leaving shell history
    // instead of a silent API call is the feature.
    const res = await post(`/api/v1/admin/users/${OPERATOR}/plan-override`, {
      planOverride: 'unlimited',
      reason: REASON,
      confirm: 'op@talyn.dev',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('self_mutation_forbidden');
    expect(await auditRows()).toHaveLength(0);
  });

  it.each([['gold'], ['UNLIMITED'], [true], [0]])(
    'refuses an invalid plan value %j',
    async (planOverride) => {
      const res = await post(`/api/v1/admin/users/${ALICE}/plan-override`, {
        planOverride,
        reason: REASON,
        confirm: 'alice@example.test',
      });
      expect(res.status).toBe(400);
      expect((await alicePlan()).planOverride).toBeNull();
    }
  );

  it('404s an unknown user before checking confirm', async () => {
    // Order matters: checking confirm first would let someone probe for
    // accounts by watching which error came back.
    const res = await post('/api/v1/admin/users/nope/plan-override', {
      planOverride: 'unlimited',
      reason: REASON,
      confirm: 'anything@example.test',
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/users/:id/admin', () => {
  const ok = { isAdmin: true, reason: REASON, confirm: 'alice@example.test' };

  it('refuses by default — the deploy has to opt in', async () => {
    delete process.env.TALYN_ADMIN_GRANT_ENABLED;
    const res = await post(`/api/v1/admin/users/${ALICE}/admin`, ok);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_grant_disabled');
    expect((await alicePlan()).isAdmin).toBe(false);
    expect(await auditRows()).toHaveLength(0);
  });

  it('grants once enabled, and records it', async () => {
    process.env.TALYN_ADMIN_GRANT_ENABLED = '1';
    const res = await post(`/api/v1/admin/users/${ALICE}/admin`, ok);
    expect(res.status).toBe(200);
    expect((await alicePlan()).isAdmin).toBe(true);
    const [row] = await auditRows();
    expect(row!.action).toBe('user.admin');
    expect(row!.after).toEqual({ isAdmin: true });
  });

  it('refuses to demote the LAST admin', async () => {
    // The only ways back in are TALYN_ADMIN_EMAILS (needs a redeploy) or hand
    // SQL. Recoverable, but genuinely disruptive.
    process.env.TALYN_ADMIN_GRANT_ENABLED = '1';
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, ALICE));
    await db.update(usersTable).set({ isAdmin: false }).where(eq(usersTable.id, OPERATOR));

    const res = await post(`/api/v1/admin/users/${ALICE}/admin`, {
      isAdmin: false,
      reason: REASON,
      confirm: 'alice@example.test',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('last_admin');
    expect((await alicePlan()).isAdmin).toBe(true);
    // The rollback matters as much as the refusal.
    expect(await auditRows()).toHaveLength(0);
  });

  it('allows demoting when another admin remains', async () => {
    process.env.TALYN_ADMIN_GRANT_ENABLED = '1';
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, ALICE));
    const res = await post(`/api/v1/admin/users/${ALICE}/admin`, {
      isAdmin: false,
      reason: REASON,
      confirm: 'alice@example.test',
    });
    expect(res.status).toBe(200);
    expect((await alicePlan()).isAdmin).toBe(false);
  });

  it('refuses to change your OWN admin flag', async () => {
    process.env.TALYN_ADMIN_GRANT_ENABLED = '1';
    const res = await post(`/api/v1/admin/users/${OPERATOR}/admin`, {
      isAdmin: false,
      reason: REASON,
      confirm: 'op@talyn.dev',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('self_mutation_forbidden');
  });

  it.each([['yes'], [1], [null], [undefined]])('refuses a non-boolean isAdmin %j', async (isAdmin) => {
    process.env.TALYN_ADMIN_GRANT_ENABLED = '1';
    const res = await post(`/api/v1/admin/users/${ALICE}/admin`, {
      isAdmin,
      reason: REASON,
      confirm: 'alice@example.test',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/tasks/:id/retry', () => {
  it('requeues the task and clears the cloud envelope', async () => {
    const res = await post('/api/v1/admin/tasks/task-1/retry', { reason: REASON });
    expect(res.status).toBe(200);

    const [task] = await db
      .select({ status: tasksTable.status, metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, 'task-1'));
    expect(task!.status).toBe('queued');
    // Without this the dispatcher short-circuits on its idempotency check and
    // re-adopts the dead run — the exact failure a retry is used to fix.
    expect((task!.metadata as Record<string, unknown>).cloudTask).toBeUndefined();
  });

  it('records the before/after status', async () => {
    await post('/api/v1/admin/tasks/task-1/retry', { reason: REASON });
    const [row] = await auditRows();
    expect(row!.action).toBe('task.retry');
    expect(row!.before).toEqual({ status: 'in_progress' });
    expect(row!.after).toEqual({ status: 'queued' });
  });

  it('refuses without a reason', async () => {
    const res = await post('/api/v1/admin/tasks/task-1/retry', {});
    expect(res.status).toBe(400);
    const [task] = await db
      .select({ status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, 'task-1'));
    expect(task!.status).toBe('in_progress');
  });

  it('404s an unknown task and writes no audit row', async () => {
    const res = await post('/api/v1/admin/tasks/nope/retry', { reason: REASON });
    expect(res.status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('POST /admin/tasks/:id/kill', () => {
  it('cancels the task and records it', async () => {
    const res = await post('/api/v1/admin/tasks/task-1/kill', { reason: REASON });
    expect(res.status).toBe(200);

    const [task] = await db
      .select({ status: tasksTable.status, result: tasksTable.result })
      .from(tasksTable)
      .where(eq(tasksTable.id, 'task-1'));
    expect(task!.status).toBe('cancelled');
    expect(JSON.stringify(task!.result)).toMatch(/Talyn operator/);

    const [row] = await auditRows();
    expect(row!.action).toBe('task.kill');
    expect(row!.after).toEqual({ status: 'cancelled' });
  });

  it('records whether the remote run was actually stopped', async () => {
    // The provider is unconfigured here, so no remote cancel is attempted —
    // but the flag has to be present either way, because "cancelled locally,
    // the run may still open a PR" is a materially different outcome.
    await post('/api/v1/admin/tasks/task-1/kill', { reason: REASON });
    const [row] = await auditRows();
    expect(row!.params).toHaveProperty('remoteCancelled');
  });

  it('refuses without a reason', async () => {
    const res = await post('/api/v1/admin/tasks/task-1/kill', { reason: '  ' });
    expect(res.status).toBe(400);
    const [task] = await db
      .select({ status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, 'task-1'));
    expect(task!.status).toBe('in_progress');
  });

  it('404s an unknown task', async () => {
    const res = await post('/api/v1/admin/tasks/nope/kill', { reason: REASON });
    expect(res.status).toBe(404);
  });
});

describe('every mutation is reachable only by an admin', () => {
  it.each([
    ['/api/v1/admin/users/user-alice/plan-override'],
    ['/api/v1/admin/users/user-alice/admin'],
    ['/api/v1/admin/tasks/task-1/retry'],
    ['/api/v1/admin/tasks/task-1/kill'],
  ])('403s a non-admin on %s', async (path) => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/admin',
      (req, _res, next) => {
        req.user = { id: 'user-member', email: 'customer@example.test', isAdmin: false };
        next();
      },
      adminRoutes()
    );
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: REASON, confirm: 'alice@example.test', isAdmin: true }),
    });
    expect(res.status).toBe(403);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    // Nothing changed, and nothing was logged.
    expect(await auditRows()).toHaveLength(0);
  });
});
