import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type {
  AdminPage,
  AdminTaskDetail,
  AdminTaskSummary,
  AdminUserDetail,
  AdminUserSummary,
  AdminWorkspaceDetail,
  AdminWorkspaceSummary,
} from '@talyn/shared';
import { adminRoutes } from '../../routes/admin/index.js';
import { createTestDb, seedUser } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  integrations as integrationsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';

/**
 * The console's cross-tenant product reads.
 *
 * The load-bearing case is the first one: an operator reading ANOTHER owner's
 * rows. That is what proves the router's placement above `ownerScope` is real
 * rather than intended — under RLS these queries do not error, they return
 * zero rows, so a misplaced mount produces a console that looks like it works
 * and shows nothing. This is the mirror image of rlsEnforcement.test.ts, which
 * proves the product routes CAN'T do this.
 */

const OPERATOR = 'user-operator';
const ALICE = 'user-alice';
const BOB = 'user-bob';

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

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let closeServer: () => Promise<void>;

/**
 * Typed against the SHARED types rather than `any`, so these cases double as
 * a check that @talyn/shared's contract matches what the routes actually
 * return — a drift there is invisible to the backend and breaks the console.
 */
interface Envelope<T> {
  success: boolean;
  data: T;
  error?: string;
}

async function get<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: (await res.json()) as Envelope<T> };
}

type UserPage = AdminPage<AdminUserSummary>;
type WorkspacePage = AdminPage<AdminWorkspaceSummary>;
type TaskPage = AdminPage<AdminTaskSummary>;

beforeEach(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  cleanup = testDb.cleanup;

  await seedUser(db, { id: OPERATOR, email: 'op@talyn.dev' });
  await seedUser(db, { id: ALICE, email: 'alice@example.test' });
  await seedUser(db, { id: BOB, email: 'bob@example.test' });
  // Alice is comped; Bob pays. Two different routes to "unlimited", which the
  // plan filter has to treat the same.
  await db
    .update(usersTable)
    .set({ planOverride: 'unlimited' })
    .where(eq(usersTable.id, ALICE));
  await db.update(usersTable).set({ plan: 'unlimited' }).where(eq(usersTable.id, BOB));

  await db.insert(workspacesTable).values([
    { id: 'ws-alice-1', ownerId: ALICE, name: 'Alice One', settings: {}, logo: { d: 'x' } },
    { id: 'ws-alice-2', ownerId: ALICE, name: 'Alice Two', settings: {} },
    { id: 'ws-bob', ownerId: BOB, name: 'Bob Space', settings: {} },
  ]);
  await db.insert(repositoriesTable).values({
    id: 'repo-1',
    workspaceId: 'ws-alice-1',
    name: 'a/b',
    url: 'https://github.com/a/b',
    defaultBranch: 'main',
  });
  await db.insert(integrationsTable).values([
    { id: 'int-1', workspaceId: 'ws-alice-1', type: 'github', config: { secret: 'nope' } },
    { id: 'int-2', workspaceId: 'ws-alice-1', type: 'selfhosted', config: { key: 'nope' } },
  ]);
  await db.insert(tasksTable).values([
    {
      id: 'task-alice',
      workspaceId: 'ws-alice-1',
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 'Alice task',
      description: '',
      transcript: [{ type: 'text', text: 'SECRET TRANSCRIPT' }],
      metadata: {
        cloudTask: {
          provider: 'selfhosted',
          remoteTaskId: 'talyn-a',
          extra: { host: 'hetzner-64', phase: 'agent', costUsd: 0.5 },
        },
      },
    },
    {
      id: 'task-bob',
      workspaceId: 'ws-bob',
      type: 'pr_review',
      status: 'completed',
      priority: 'medium',
      title: 'Bob task',
      description: '',
      metadata: { cloudTask: { provider: 'claude_code', remoteTaskId: 'cc-b' } },
    },
  ]);

  const s = await makeServer();
  url = s.url;
  closeServer = s.close;
});

afterEach(async () => {
  await closeServer();
  await cleanup();
});

describe('cross-tenant reach', () => {
  it("returns OTHER owners' users, not just the caller's", async () => {
    // The whole point of mounting above ownerScope. Under RLS this list would
    // be empty and the page would look merely quiet.
    const { status, body } = await get<UserPage>('/api/v1/admin/users');
    expect(status).toBe(200);
    const emails = body.data.items.map((u) => u.email);
    expect(emails).toContain('alice@example.test');
    expect(emails).toContain('bob@example.test');
  });

  it("returns OTHER owners' workspaces with their owner's email", async () => {
    const { body } = await get<WorkspacePage>('/api/v1/admin/workspaces');
    const names = body.data.items.map((w) => w.name);
    expect(names).toContain('Alice One');
    expect(names).toContain('Bob Space');
    const alice = body.data.items.find((w) => w.name === 'Alice One')!;
    expect(alice.ownerEmail).toBe('alice@example.test');
  });

  it("returns OTHER owners' tasks", async () => {
    const { body } = await get<TaskPage>('/api/v1/admin/tasks');
    const ids = body.data.items.map((t) => t.id);
    expect(ids).toContain('task-alice');
    expect(ids).toContain('task-bob');
  });
});

describe('what must not leak', () => {
  it('the user list carries no Polar ids', async () => {
    const { body } = await get<UserPage>('/api/v1/admin/users');
    for (const user of body.data.items) {
      expect(user).not.toHaveProperty('polarCustomerId');
      expect(user).not.toHaveProperty('polarSubscriptionId');
    }
  });

  it('the workspace list carries no logo or settings', async () => {
    const { body } = await get<WorkspacePage>('/api/v1/admin/workspaces');
    for (const ws of body.data.items) {
      expect(ws).not.toHaveProperty('logo');
      expect(ws).not.toHaveProperty('settings');
    }
  });

  it('the task list carries no transcript', async () => {
    const { body } = await get<TaskPage>('/api/v1/admin/tasks');
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('SECRET TRANSCRIPT');
  });

  it('a task detail withholds the transcript unless asked', async () => {
    const { body } = await get<AdminTaskDetail>('/api/v1/admin/tasks/task-alice');
    expect(body.data.transcript).toBeNull();
    expect(JSON.stringify(body)).not.toContain('SECRET TRANSCRIPT');
  });

  it('a task detail returns the transcript when explicitly asked', async () => {
    const { body } = await get<AdminTaskDetail>('/api/v1/admin/tasks/task-alice?transcript=1');
    expect(JSON.stringify(body.data.transcript)).toContain('SECRET TRANSCRIPT');
  });

  it('a user detail DOES carry the Polar ids — that is what it is for', async () => {
    // The inverse of the list assertion above. An operator on a detail page is
    // chasing a billing problem, and the Polar id is the thing that resolves
    // it; withholding it there would just mean opening the Polar dashboard and
    // searching by email instead.
    const { body } = await get<AdminUserDetail>(`/api/v1/admin/users/${ALICE}`);
    expect(body.data).toHaveProperty('polarCustomerId');
    expect(body.data.workspaces.map((w) => w.name).sort()).toEqual(['Alice One', 'Alice Two']);
    expect(body.data.activeTaskCount).toBe(1);
  });

  it('a workspace detail reports provider TYPES, never their config', async () => {
    // Knowing a provider is configured is the operator's question. Knowing
    // its credential never is.
    const { body } = await get<AdminWorkspaceDetail>('/api/v1/admin/workspaces/ws-alice-1');
    expect(body.data.providers).toEqual(['github', 'selfhosted']);
    expect(JSON.stringify(body)).not.toContain('nope');
  });
});

describe('derived fields', () => {
  it('counts a user\'s workspaces', async () => {
    const { body } = await get<UserPage>('/api/v1/admin/users');
    const alice = body.data.items.find((u) => u.email === 'alice@example.test')!;
    expect(alice.workspaceCount).toBe(2);
  });

  it('reports effectivePlan from the override, not just the plan column', async () => {
    // Alice is comped: plan='free', planOverride='unlimited'. Showing 'free'
    // here would contradict what the entitlement gate actually enforces.
    const { body } = await get<UserPage>('/api/v1/admin/users');
    const alice = body.data.items.find((u) => u.email === 'alice@example.test')!;
    expect(alice.plan).toBe('free');
    expect(alice.planOverride).toBe('unlimited');
    expect(alice.effectivePlan).toBe('unlimited');
  });

  it('surfaces the fleet fields the SQL extracts', async () => {
    const { body } = await get<TaskPage>('/api/v1/admin/tasks');
    const task = body.data.items.find((t) => t.id === 'task-alice')!;
    expect(task.provider).toBe('selfhosted');
    expect(task.fleetHost).toBe('hetzner-64');
    expect(task.phase).toBe('agent');
    expect(task.costUsd).toBeCloseTo(0.5);
  });

  it('counts a workspace\'s repos and tasks', async () => {
    const { body } = await get<AdminWorkspaceDetail>('/api/v1/admin/workspaces/ws-alice-1');
    expect(body.data.repositoryCount).toBe(1);
    expect(body.data.taskCount).toBe(1);
    expect(body.data.activeTaskCount).toBe(1);
  });
});

describe('filters', () => {
  it('filters tasks by host', async () => {
    const { body } = await get<TaskPage>('/api/v1/admin/tasks?host=hetzner-64');
    expect(body.data.items.map((t) => t.id)).toEqual(['task-alice']);
  });

  it('filters tasks by provider', async () => {
    const { body } = await get<TaskPage>('/api/v1/admin/tasks?provider=claude_code');
    expect(body.data.items.map((t) => t.id)).toEqual(['task-bob']);
  });

  it('filters tasks by owner', async () => {
    const { body } = await get<TaskPage>(`/api/v1/admin/tasks?ownerId=${BOB}`);
    expect(body.data.items.map((t) => t.id)).toEqual(['task-bob']);
  });

  it('finds both routes to unlimited when filtering by plan', async () => {
    // Alice is comped (planOverride), Bob subscribes (plan). An operator
    // asking for unlimited accounts means the ones that BEHAVE that way.
    const { body } = await get<UserPage>('/api/v1/admin/users?plan=unlimited');
    const emails = body.data.items.map((u) => u.email);
    expect(emails).toContain('alice@example.test');
    expect(emails).toContain('bob@example.test');
    expect(emails).not.toContain('op@talyn.dev');
  });

  it('searches users by email', async () => {
    const { body } = await get<UserPage>('/api/v1/admin/users?q=alice');
    expect(body.data.items.map((u) => u.email)).toEqual(['alice@example.test']);
  });

  it('ignores a search term below the minimum length', async () => {
    // A one-character term is an `ilike '%a%'` over every user — a table scan
    // dressed up as a search.
    const { body } = await get<UserPage>('/api/v1/admin/users?q=a');
    expect(body.data.items.length).toBeGreaterThan(1);
  });

  // All ≥ the minimum search length, so they genuinely reach the `ilike` —
  // a single `%` is discarded earlier by the length rule and would prove
  // nothing about escaping.
  it.each([['%%'], ['__'], ['a%b'], ['a_b'], ['%e%']])(
    'escapes the wildcard %j rather than matching everything',
    async (term) => {
      // Unescaped, `?q=%%` is "return every user in the deployment" — a
      // cross-tenant dump dressed up as a search.
      const { body } = await get<UserPage>(`/api/v1/admin/users?q=${encodeURIComponent(term)}`);
      expect(body.data.items).toEqual([]);
    }
  );

  it('still matches a literal underscore in an address', async () => {
    // Escaping must make `_` literal, not inert — the inverse of the cases
    // above, and the one that catches over-escaping.
    await db.insert(usersTable).values({ id: 'user-us', email: 'a_b@example.test' });
    const { body } = await get<UserPage>('/api/v1/admin/users?q=a_b');
    expect(body.data.items.map((u) => u.email)).toEqual(['a_b@example.test']);
  });
});

describe('pagination', () => {
  it('clamps limit to the maximum', async () => {
    // An unbounded admin list is a cross-tenant table scan.
    const { body } = await get<UserPage>('/api/v1/admin/users?limit=99999');
    expect(body.data.items.length).toBeLessThanOrEqual(100);
  });

  it('walks pages via the cursor without repeating or skipping', async () => {
    const first = await get<UserPage>('/api/v1/admin/users?limit=1');
    expect(first.body.data.items).toHaveLength(1);
    expect(first.body.data.nextCursor).toBeTruthy();

    const seen = new Set<string>([first.body.data.items[0].id]);
    let cursor: string | null = first.body.data.nextCursor;
    while (cursor) {
      const page = await get<UserPage>(
        `/api/v1/admin/users?limit=1&before=${encodeURIComponent(cursor)}`
      );
      for (const u of page.body.data.items) {
        expect(seen.has(u.id), `saw ${u.id} twice`).toBe(false);
        seen.add(u.id);
      }
      cursor = page.body.data.nextCursor;
    }
    expect(seen.size).toBe(3);
  });

  it('returns nextCursor null on the last page', async () => {
    const { body } = await get<UserPage>('/api/v1/admin/users?limit=100');
    expect(body.data.nextCursor).toBeNull();
  });

  it('ignores a malformed cursor rather than erroring', async () => {
    const { status, body } = await get<UserPage>('/api/v1/admin/users?before=garbage');
    expect(status).toBe(200);
    expect(body.data.items.length).toBe(3);
  });
});

describe('not found', () => {
  it.each([
    ['/api/v1/admin/users/nope', 'User not found'],
    ['/api/v1/admin/workspaces/nope', 'Workspace not found'],
    ['/api/v1/admin/tasks/nope', 'Task not found'],
  ])('404s %s', async (path, message) => {
    const { status, body } = await get<unknown>(path);
    expect(status).toBe(404);
    expect(body.error).toBe(message);
  });
});
