import type { TaskScheduleError } from '@talyn/shared';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  taskQueueService,
  dispatchBackoffMs,
  isBackingOff,
  MAX_DISPATCH_ATTEMPTS,
} from '../services/taskQueue.js';
import {
  registerCloudProvider,
  getCloudProvider,
} from '../services/cloudProviders/registry.js';
import type { CloudTaskProvider } from '../services/cloudProviders/types.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../db/schema.js';

/**
 * Build a fake PostHog Code provider whose `dispatch` is a spy, so the
 * scheduler can be tested without touching the real cloud client. We
 * register it under the real `posthog_code` type and restore the original
 * provider afterwards.
 */
function fakeProvider(
  dispatch: CloudTaskProvider['dispatch']
): CloudTaskProvider {
  return {
    type: 'posthog_code',
    displayName: 'Fake PostHog Code',
    validateCredentials: vi.fn(async () => ({ ok: true })),
    hasCredentials: vi.fn(async () => true),
    removeCredentials: vi.fn(async () => {}),
    dispatch,
    reconcile: vi.fn(async () => {}),
    stopStreaming: vi.fn(() => {}),
  };
}

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({
    id: 'ws1',
    ownerId: TEST_USER_ID,
    name: 'ws',
    settings: {},
  });
  await db.insert(environmentsTable).values({
    id: 'cloud1',
    ownerId: TEST_USER_ID,
    name: 'PostHog Code',
    type: 'posthog_code',
    status: 'connected',
    config: { type: 'posthog_code' },
  });
  await db.insert(repositoriesTable).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: 'a/b',
    url: 'https://github.com/a/b',
    defaultBranch: 'main',
  });
}

async function insertQueuedTask(
  db: Database,
  overrides: Partial<{
    id: string;
    status: string;
    repositoryId: string | null;
    assignedEnvironmentId: string | null;
    metadata: Record<string, unknown>;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? `t-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'code_writing',
    status: overrides.status ?? 'queued',
    priority: 'medium',
    title: `task-${id}`,
    description: 'd',
    prompt: 'do',
    repositoryId:
      overrides.repositoryId === undefined ? 'repo1' : overrides.repositoryId,
    assignedEnvironmentId:
      overrides.assignedEnvironmentId === undefined
        ? 'cloud1'
        : overrides.assignedEnvironmentId,
    metadata: overrides.metadata,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function readTask(
  db: Database,
  id: string
): Promise<{ status: string; completedAt: Date | null; metadata: Record<string, unknown> }> {
  const rows = await db
    .select({
      status: tasksTable.status,
      completedAt: tasksTable.completedAt,
      metadata: tasksTable.metadata,
    })
    .from(tasksTable)
    .where(eq(tasksTable.id, id));
  return {
    status: rows[0].status,
    completedAt: rows[0].completedAt,
    metadata: (rows[0].metadata as Record<string, unknown>) ?? {},
  };
}

describe('taskQueueService.processQueue (cloud dispatch)', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let originalProvider: CloudTaskProvider | null;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);
    originalProvider = getCloudProvider('posthog_code');
  });

  afterEach(async () => {
    taskQueueService.shutdown();
    taskQueueService.resetForTests();
    if (originalProvider) registerCloudProvider(originalProvider);
    await cleanup();
    vi.restoreAllMocks();
  });

  it('no-ops when the queue is empty', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeProvider(dispatch));
    await taskQueueService.processQueue();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches a queued task to its cloud provider', async () => {
    const id = await insertQueuedTask(db);
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeProvider(dispatch));

    await taskQueueService.processQueue();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [task, env] = dispatch.mock.calls[0];
    expect(task.id).toBe(id);
    expect(env.id).toBe('cloud1');
    expect(env.type).toBe('posthog_code');
  });

  it('rolls the task back to queued + writes lastScheduleError when dispatch fails', async () => {
    const id = await insertQueuedTask(db);
    registerCloudProvider(
      fakeProvider(vi.fn(async () => ({ ok: false as const, error: 'no api key' })))
    );

    await taskQueueService.processQueue();

    const rows = await db
      .select({ status: tasksTable.status, metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));
    expect(rows[0].status).toBe('queued');
    const meta = rows[0].metadata as { lastScheduleError?: { reason?: string } };
    expect(meta.lastScheduleError?.reason).toMatch(/no api key/);
  });

  // A provider being BUSY is not a failure, and the record has to say so.
  //
  // Both arrive as `ok: false` and both leave the task queued, so without the
  // `capacity` flag the UI could only call it "Last attempt to start this task
  // failed" — which is what made a normal wait for a fleet runner look like
  // something had gone wrong and needed attention.
  it('marks a capacity refusal as capacity, with a retry time', async () => {
    const id = await insertQueuedTask(db);
    registerCloudProvider(
      fakeProvider(
        vi.fn(async () => ({
          ok: false as const,
          error: 'All self-hosted runners are busy.',
          capacity: true,
        }))
      )
    );

    await taskQueueService.processQueue();

    const rows = await db
      .select({ status: tasksTable.status, metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));
    expect(rows[0].status).toBe('queued');

    const err = (rows[0].metadata as { lastScheduleError?: TaskScheduleError })
      .lastScheduleError;
    expect(err?.capacity).toBe(true);
    // Without this the banner cannot say when it will try again, which is the
    // difference between "stuck" and "waiting".
    expect(err?.retryAt).toBeTruthy();
    expect(Date.parse(err!.retryAt!)).toBeGreaterThan(Date.now() - 1000);
    expect(err?.maxAttempts).toBeGreaterThan(1);
  });

  it('does NOT mark an ordinary dispatch failure as capacity', async () => {
    // The inverse, so the flag cannot regress into always-on — which would
    // render a genuinely broken task as "waiting for a runner" forever.
    const id = await insertQueuedTask(db);
    registerCloudProvider(
      fakeProvider(vi.fn(async () => ({ ok: false as const, error: 'no api key' })))
    );

    await taskQueueService.processQueue();

    const rows = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));
    const err = (rows[0].metadata as { lastScheduleError?: TaskScheduleError })
      .lastScheduleError;
    expect(err?.capacity).toBeUndefined();
  });

  it('falls back to the workspace provider and dispatches a task with no pinned env', async () => {
    // CLI / MCP / generic-API tasks arrive with no assignedEnvironmentId.
    const id = await insertQueuedTask(db, { assignedEnvironmentId: null });
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeProvider(dispatch));

    await taskQueueService.processQueue();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [, env] = dispatch.mock.calls[0];
    expect(env.id).toBe('cloud1');
    // The resolved env is persisted onto the row so it's stable + visible.
    const rows = await db
      .select({ envId: tasksTable.assignedEnvironmentId })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));
    expect(rows[0].envId).toBe('cloud1');
  });

  it('skips a no-env task only when the workspace has no connected provider', async () => {
    // No env marker for the owner → nothing resolves.
    await db.delete(environmentsTable).where(eq(environmentsTable.id, 'cloud1'));
    await insertQueuedTask(db, { assignedEnvironmentId: null });
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeProvider(dispatch));

    await taskQueueService.processQueue();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('backs off after a failed dispatch — the immediate next tick skips the task', async () => {
    const id = await insertQueuedTask(db);
    const dispatch = vi.fn(async () => ({ ok: false as const, error: 'provider down' }));
    registerCloudProvider(fakeProvider(dispatch));

    await taskQueueService.processQueue();
    expect(dispatch).toHaveBeenCalledTimes(1);

    const after = await readTask(db, id);
    expect(after.status).toBe('queued');
    expect(after.metadata.dispatchAttempts).toBe(1);
    const nextAt = Date.parse(String(after.metadata.nextDispatchAttemptAt));
    expect(nextAt).toBeGreaterThan(Date.now());

    // The 5s tick fires again immediately — the backoff window must hold.
    await taskQueueService.processQueue();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('lands the task in terminal failed after MAX_DISPATCH_ATTEMPTS', async () => {
    const id = await insertQueuedTask(db, {
      metadata: { dispatchAttempts: MAX_DISPATCH_ATTEMPTS - 1 },
    });
    const dispatch = vi.fn(async () => ({ ok: false as const, error: 'still down' }));
    registerCloudProvider(fakeProvider(dispatch));

    await taskQueueService.processQueue();

    const after = await readTask(db, id);
    expect(after.status).toBe('failed');
    expect(after.completedAt).not.toBeNull();
    expect(after.metadata.dispatchAttempts).toBe(MAX_DISPATCH_ATTEMPTS);
    expect(after.metadata.nextDispatchAttemptAt).toBeUndefined();
    const lastError = after.metadata.lastScheduleError as { reason?: string };
    expect(lastError.reason).toMatch(/still down/);

    // Terminal — the next tick must not touch it again.
    await taskQueueService.processQueue();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a throwing dispatch is contained: the failure is recorded and other tasks still run', async () => {
    const poisonId = await insertQueuedTask(db, { id: 'poison' });
    const healthyId = await insertQueuedTask(db, { id: 'healthy' });
    const dispatch = vi.fn(async (task: { id: string }) => {
      if (task.id === poisonId) throw new Error('converter blew up');
      return { ok: true as const };
    });
    registerCloudProvider(fakeProvider(dispatch as CloudTaskProvider['dispatch']));

    await taskQueueService.processQueue();

    // Both tasks were attempted despite the first one throwing.
    expect(dispatch).toHaveBeenCalledTimes(2);
    const poisoned = await readTask(db, poisonId);
    expect(poisoned.status).toBe('queued');
    expect(poisoned.metadata.dispatchAttempts).toBe(1);
    expect(String((poisoned.metadata.lastScheduleError as { reason: string }).reason)).toMatch(
      /converter blew up/
    );
    const healthy = await readTask(db, healthyId);
    expect(healthy.metadata.dispatchedAt).toBeDefined();
  });

  it('a successful dispatch clears the retry bookkeeping', async () => {
    const id = await insertQueuedTask(db, {
      metadata: {
        dispatchAttempts: 3,
        nextDispatchAttemptAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    registerCloudProvider(fakeProvider(vi.fn(async () => ({ ok: true as const }))));

    await taskQueueService.processQueue();

    const after = await readTask(db, id);
    expect(after.metadata.dispatchAttempts).toBeUndefined();
    expect(after.metadata.nextDispatchAttemptAt).toBeUndefined();
    expect(after.metadata.dispatchedAt).toBeDefined();
  });
});

describe('dispatch backoff policy', () => {
  it.each([
    [1, 10_000],
    [2, 20_000],
    [3, 40_000],
    [7, 600_000], // 640s uncapped — hits the 10-minute cap
    [10, 600_000],
    [40, 600_000],
  ])('attempt %i backs off %ims', (attempts, expected) => {
    expect(dispatchBackoffMs(attempts)).toBe(expected);
  });

  it('caps at 10 minutes', () => {
    expect(dispatchBackoffMs(1000)).toBe(600_000);
  });

  it('isBackingOff respects the window and tolerates junk metadata', () => {
    const base = { id: 't', workspaceId: 'w' } as never;
    const task = (metadata: unknown) => ({ ...(base as object), metadata }) as never;
    const now = Date.now();
    expect(isBackingOff(task({ nextDispatchAttemptAt: new Date(now + 5000).toISOString() }), now)).toBe(true);
    expect(isBackingOff(task({ nextDispatchAttemptAt: new Date(now - 5000).toISOString() }), now)).toBe(false);
    expect(isBackingOff(task({ nextDispatchAttemptAt: 'not-a-date' }), now)).toBe(false);
    expect(isBackingOff(task({}), now)).toBe(false);
    expect(isBackingOff(task(undefined), now)).toBe(false);
  });
});
