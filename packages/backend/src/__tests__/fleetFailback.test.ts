import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskQueueService } from '../services/taskQueue.js';
import { registerCloudProvider, getCloudProvider } from '../services/cloudProviders/registry.js';
import { resetFleetAccessCache } from '../services/cloudProviders/fleetAccess.js';
import type { CloudTaskProvider, DispatchResult } from '../services/cloudProviders/types.js';
import type { CloudProviderType } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../db/schema.js';

/**
 * Fail-back across the workspace's provider order (§10.7, §11.6).
 *
 * This is the property that lets the self-hosted fleet be smaller than peak
 * demand: a full box degrades to a hosted provider instead of to an error. The
 * distinction it rests on is that "the fleet is full" and "this repo does not
 * exist" both arrive as a failed dispatch, and only one is worth retrying
 * somewhere else — so every test here pairs a capacity refusal with a terminal
 * one and checks they are routed differently.
 */
function fakeProvider(
  type: CloudProviderType,
  dispatch: CloudTaskProvider['dispatch'],
): CloudTaskProvider {
  return {
    type,
    displayName: `Fake ${type}`,
    validateCredentials: vi.fn(async () => ({ ok: true })),
    hasCredentials: vi.fn(async () => true),
    removeCredentials: vi.fn(async () => {}),
    dispatch,
    reconcile: vi.fn(async () => {}),
    stopStreaming: vi.fn(() => {}),
  };
}

/** A workspace that prefers the fleet and can fall back to PostHog Code. */
async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.com' });
  await db.insert(workspacesTable).values({
    id: 'ws1',
    ownerId: TEST_USER_ID,
    name: 'ws',
    settings: { defaultCloudProvider: 'selfhosted' },
  });
  await db.insert(environmentsTable).values([
    {
      id: 'fleet1',
      ownerId: TEST_USER_ID,
      name: 'Self-hosted',
      type: 'selfhosted',
      status: 'connected',
      config: { type: 'selfhosted' },
    },
    {
      id: 'ph1',
      ownerId: TEST_USER_ID,
      name: 'PostHog Code',
      type: 'posthog_code',
      status: 'connected',
      config: { type: 'posthog_code' },
    },
  ]);
  await db.insert(repositoriesTable).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: 'a/b',
    url: 'https://github.com/a/b',
    defaultBranch: 'main',
  });
  const now = new Date();
  await db.insert(tasksTable).values({
    id: 't1',
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'queued',
    priority: 'medium',
    title: 'failover task',
    description: 'd',
    prompt: 'do',
    repositoryId: 'repo1',
    // Deliberately unpinned: the chain is resolved from the workspace's order.
    assignedEnvironmentId: null,
    createdAt: now,
    updatedAt: now,
  });
}

describe('provider fail-back', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originals = new Map<CloudProviderType, CloudTaskProvider | null>();

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    // The queue service is a singleton with a re-entry guard; without this a
    // previous suite in the same worker leaves it held and every dispatch here
    // silently no-ops.
    taskQueueService.resetForTests();
    await seed(db);
    for (const t of ['selfhosted', 'posthog_code'] as CloudProviderType[]) {
      originals.set(t, getCloudProvider(t));
    }
    process.env.FLEET_ALLOWED_EMAILS = 'tom@example.com';
    resetFleetAccessCache();
  });

  afterEach(async () => {
    taskQueueService.shutdown();
    taskQueueService.resetForTests();
    for (const [, p] of originals) if (p) registerCloudProvider(p);
    originals.clear();
    await cleanup();
    delete process.env.FLEET_ALLOWED_EMAILS;
    resetFleetAccessCache();
  });

  async function taskStatus(): Promise<string> {
    const rows = await db
      .select({ status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'))
      .limit(1);
    return rows[0]?.status ?? '';
  }

  it('falls back to the next provider when the fleet has no capacity', async () => {
    const fleet = vi.fn(
      async (): Promise<DispatchResult> => ({
        ok: false,
        error: 'No fleet capacity: mem',
        capacity: true,
      }),
    );
    const posthog = vi.fn(async (): Promise<DispatchResult> => ({ ok: true }));
    registerCloudProvider(fakeProvider('selfhosted', fleet));
    registerCloudProvider(fakeProvider('posthog_code', posthog));

    await taskQueueService.processQueue();

    expect(fleet).toHaveBeenCalledTimes(1);
    expect(posthog).toHaveBeenCalledTimes(1);
  });

  it('records which env actually ran the task, not the one that was preferred', async () => {
    registerCloudProvider(
      fakeProvider('selfhosted', async () => ({ ok: false, error: 'full', capacity: true })),
    );
    registerCloudProvider(fakeProvider('posthog_code', async () => ({ ok: true })));

    await taskQueueService.processQueue();

    const rows = await db
      .select({ envId: tasksTable.assignedEnvironmentId })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'))
      .limit(1);
    // reconcile and the poller both key off this. Leaving it on the preferred
    // provider would have them poll a run that never started.
    expect(rows[0]?.envId).toBe('ph1');
  });

  // The distinction the whole feature rests on.
  it('does NOT fall back on a terminal error', async () => {
    const fleet = vi.fn(
      async (): Promise<DispatchResult> => ({
        ok: false,
        error: 'repository not found',
        // no `capacity` — nothing about another provider makes this work
      }),
    );
    const posthog = vi.fn(async (): Promise<DispatchResult> => ({ ok: true }));
    registerCloudProvider(fakeProvider('selfhosted', fleet));
    registerCloudProvider(fakeProvider('posthog_code', posthog));

    await taskQueueService.processQueue();

    expect(fleet).toHaveBeenCalledTimes(1);
    expect(posthog).not.toHaveBeenCalled();
  });

  it('stops and records the failure when capacity runs out everywhere', async () => {
    const fleet = vi.fn(
      async (): Promise<DispatchResult> => ({ ok: false, error: 'fleet full', capacity: true }),
    );
    const posthog = vi.fn(
      async (): Promise<DispatchResult> => ({ ok: false, error: 'posthog full', capacity: true }),
    );
    registerCloudProvider(fakeProvider('selfhosted', fleet));
    registerCloudProvider(fakeProvider('posthog_code', posthog));

    await taskQueueService.processQueue();

    expect(fleet).toHaveBeenCalledTimes(1);
    expect(posthog).toHaveBeenCalledTimes(1);

    const rows = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'))
      .limit(1);
    // Recorded against the LAST provider tried — the earlier refusals were
    // ones we deliberately routed around, so reporting the first would name a
    // provider that was never the reason the task could not run.
    expect(JSON.stringify(rows[0]?.metadata ?? {})).toContain('posthog full');
    expect(await taskStatus()).not.toBe('in_progress');
  });

  it('skips the fleet entirely for a workspace that may not use it', async () => {
    const fleet = vi.fn(async (): Promise<DispatchResult> => ({ ok: true }));
    const posthog = vi.fn(async (): Promise<DispatchResult> => ({ ok: true }));
    registerCloudProvider(fakeProvider('selfhosted', fleet));
    registerCloudProvider(fakeProvider('posthog_code', posthog));

    process.env.FLEET_ALLOWED_EMAILS = 'someone-else@example.com';
    resetFleetAccessCache();

    await taskQueueService.processQueue();

    // Not a failure — the task runs, just somewhere else. A workspace that
    // pinned the fleet and is not allowed to use it should get its work done,
    // not get an error.
    expect(fleet).not.toHaveBeenCalled();
    expect(posthog).toHaveBeenCalledTimes(1);
  });
});
