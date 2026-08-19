import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The fleet client is mocked to PROVE IT IS NEVER CALLED. A task with no run id
// has nothing to ask a host about, and a reconcile that reached for one would be
// asking the fleet to identify a run the fleet was never told to start.
const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    getRun: vi.fn(),
    getEvents: vi.fn(),
  },
}));
vi.mock('../services/selfHosted/credentials.js', () => ({
  getSelfHostedClient: vi.fn(async () => mockClient),
  getSelfHostedCredentials: vi.fn(async () => ({ claudeToken: 'sk-ant-oat01-x' })),
}));

import { eq } from 'drizzle-orm';
import { selfHostedPoller, DISPATCH_GRACE_MS } from '../services/selfHosted/poller.js';
import { _resetTaskWatch } from '../services/cloudProviders/taskWatch.js';
import { drainTaskMetadata } from '../services/taskMetadataMutex.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import * as schema from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { CloudTaskRow } from '../services/cloudProviders/types.js';

const WS = 'ws-1';

/**
 * A task that says it is in progress and names no run.
 *
 * This is the state two real tasks were found in — "Get PostHog/posthog#70991
 * mergeable" and "#74692". They carry the selfhosted marker, so the generic
 * poller routes them here every tick, and they carry no `remoteTaskId`, so
 * every branch of the reconcile used to fall off the front of the method.
 */
function undispatchedRow(id: string, overrides: Partial<CloudTaskRow> = {}): CloudTaskRow {
  return {
    id,
    workspaceId: WS,
    title: 'Get PostHog/posthog#70991 mergeable',
    repositoryId: null,
    metadata: { cloudTask: { provider: 'selfhosted', status: 'queued' } },
    transcriptEmpty: true,
    watched: false,
    status: 'in_progress',
    completedAt: null,
    updatedAt: new Date(Date.now() - DISPATCH_GRACE_MS - 60_000),
    ...overrides,
  };
}

async function seedTask(
  db: Database,
  id: string,
  values: Partial<typeof schema.tasks.$inferInsert> = {},
): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    workspaceId: WS,
    type: 'code_writing',
    status: 'in_progress',
    title: 'Get PostHog/posthog#70991 mergeable',
    description: 'D',
    metadata: { cloudTask: { provider: 'selfhosted', status: 'queued' } },
    ...values,
  });
}

async function readTask(db: Database, id: string) {
  const rows = await db
    .select({
      status: schema.tasks.status,
      completedAt: schema.tasks.completedAt,
      metadata: schema.tasks.metadata,
      result: schema.tasks.result,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id));
  return rows[0];
}

describe('selfHostedPoller — a task in progress with no fleet run', () => {
  let cleanup: () => Promise<void>;
  let db: Database;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
    mockClient.getRun.mockReset();
    mockClient.getEvents.mockReset().mockResolvedValue({ events: [] });
    _resetTaskWatch();
    await seedUser(db);
    await db.insert(schema.workspaces).values({ id: WS, ownerId: 'user-test', name: 'WS' });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await cleanup();
  });

  // The bug, stated as the property that was missing: a task nobody will ever
  // finish must not go on presenting as a task in progress.
  it('fails it, rather than leaving it in progress forever', async () => {
    const id = 'task-never-dispatched';
    await seedTask(db, id);

    await selfHostedPoller.reconcileTask(undispatchedRow(id));
    await drainTaskMetadata(id);

    const t = await readTask(db, id);
    expect(t?.status).toBe('failed');
    // Not completed: the work did not happen, and a completedAt here would put
    // it in the revival and transcript-backfill windows the generic poller
    // scans, which is the wrong queue for a task that never ran.
    expect(t?.completedAt).toBeNull();
  });

  // The reason has to be READABLE, because the person who sees it is the person
  // who asked for the task and has no idea what a dispatch is. "Fleet run ended
  // failed" would send them looking for a failure on the metal that never
  // happened — the same mistake failVanishedRun exists to avoid.
  it('says why, in terms the person who asked for the task can act on', async () => {
    const id = 'task-reason';
    await seedTask(db, id);

    await selfHostedPoller.reconcileTask(undispatchedRow(id));
    await drainTaskMetadata(id);

    const result = (await readTask(db, id))?.result as { success: boolean; summary: string };
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/never reached the fleet/i);
    expect(result.summary).toMatch(/retry/i);
  });

  // The operator console reads `run?.status ?? task.cloudStatus`. With no run
  // there is no live status, so a cloudTask left saying `queued` keeps the Runs
  // page showing a row that is running and a Cancel button that can only error.
  it('stamps the cloud status too, not just the task status', async () => {
    const id = 'task-cloud-status';
    await seedTask(db, id);

    await selfHostedPoller.reconcileTask(undispatchedRow(id));
    await drainTaskMetadata(id);

    const meta = (await readTask(db, id))?.metadata as {
      cloudTask?: { status?: string; provider?: string };
    };
    expect(meta.cloudTask?.status).toBe('failed');
    // The marker survives, so the task still resolves to a provider and can be
    // retried onto the same one.
    expect(meta.cloudTask?.provider).toBe('selfhosted');
  });

  it('asks no host about a run that does not exist', async () => {
    const id = 'task-no-host-call';
    await seedTask(db, id);

    await selfHostedPoller.reconcileTask(undispatchedRow(id));
    await drainTaskMetadata(id);

    expect(mockClient.getRun).not.toHaveBeenCalled();
    expect(mockClient.getEvents).not.toHaveBeenCalled();
  });

  // A dispatch in flight looks exactly like a dispatch that never happened, for
  // as long as it takes the executor to write the run id and flip the status.
  // Failing inside that window would kill healthy runs — the failure mode this
  // whole change is supposed to remove, aimed at the wrong tasks.
  it.each([
    ['just started', 5_000],
    ['a minute in', 60_000],
    ['one second inside the grace period', DISPATCH_GRACE_MS - 1_000],
  ])('leaves a task alone that is %s', async (label, ageMs) => {
    const id = `task-young-${ageMs}`;
    await seedTask(db, id);

    await selfHostedPoller.reconcileTask(
      undispatchedRow(id, { updatedAt: new Date(Date.now() - ageMs) }),
    );
    await drainTaskMetadata(id);

    const t = await readTask(db, id);
    expect(t?.status, `a task ${label} must not be failed`).toBe('in_progress');
    expect(t?.result).toBeNull();
  });

  // The generic poller also loads COMPLETED tasks: revival candidates, and
  // recently-finished tasks whose transcript has not landed yet. Neither has a
  // remote run to reconcile in the shape this branch looks for, and failing
  // either one would turn a finished task into a failed one.
  it.each([
    ['a revival candidate', 'completed' as const],
    ['a cancelled task', 'cancelled' as const],
    ['an already-failed task', 'failed' as const],
  ])('never touches %s', async (_label, status) => {
    const id = `task-${status}`;
    await seedTask(db, id, {
      status,
      completedAt: new Date(),
      result: { success: true, summary: 'done' },
    });

    await selfHostedPoller.reconcileTask(undispatchedRow(id, { status, completedAt: new Date() }));
    await drainTaskMetadata(id);

    expect((await readTask(db, id))?.status).toBe(status);
  });

  // Routing safety: this reconcile is reached through the provider seam, and a
  // task belonging to another provider must fall straight back out of it rather
  // than being failed by the fleet's rules.
  it('ignores a task that belongs to another provider', async () => {
    const id = 'task-other-provider';
    await seedTask(db, id, { metadata: { cloudTask: { provider: 'posthog_code' } } });

    await selfHostedPoller.reconcileTask(
      undispatchedRow(id, { metadata: { cloudTask: { provider: 'posthog_code' } } }),
    );
    await drainTaskMetadata(id);

    expect((await readTask(db, id))?.status).toBe('in_progress');
  });
});
