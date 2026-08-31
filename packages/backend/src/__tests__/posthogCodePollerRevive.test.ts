import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same mocking approach as posthogCodePollerGating: script the remote run's
// status/updated_at via a mocked client, stub the streamer.
const { mockClient, mockStreamer } = vi.hoisted(() => ({
  mockClient: {
    getTask: vi.fn(),
    getSessionLogs: vi.fn(),
  },
  mockStreamer: {
    ensure: vi.fn(),
    stop: vi.fn(),
    isActive: vi.fn(() => false),
    flushNow: vi.fn(async () => undefined),
  },
}));
vi.mock('../services/posthogCode/credentials.js', () => ({
  getPostHogCodeClient: vi.fn(async () => mockClient),
}));
vi.mock('../services/posthogCode/streamer.js', () => ({
  postHogCodeStreamer: mockStreamer,
}));

import { eq } from 'drizzle-orm';
import { postHogCodePoller } from '../services/posthogCode/poller.js';
import { _resetTaskWatch } from '../services/cloudProviders/taskWatch.js';
import { drainTaskMetadata } from '../services/taskMetadataMutex.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import * as schema from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { CloudTaskRow } from '../services/cloudProviders/types.js';

const WS = 'ws-1';

/** A recent-ish anchor so completedAt/updated_at can straddle it in each case. */
const COMPLETED_AT = new Date('2026-07-22T12:00:00.000Z');

function row(id: string, overrides: Partial<CloudTaskRow> = {}): CloudTaskRow {
  return {
    id,
    workspaceId: WS,
    title: 'T',
    repositoryId: null,
    metadata: { posthogTaskId: 'pt', posthogRunId: 'pr' },
    transcriptEmpty: false,
    watched: false,
    status: 'completed',
    completedAt: COMPLETED_AT,
    ...overrides,
  };
}

function remoteTask(status: string, updatedAt: Date): unknown {
  return {
    id: 'pt',
    latest_run: { id: 'pr', status, updated_at: updatedAt.toISOString(), output: 'done' },
  };
}

async function seedCompleted(db: Database, id: string): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    workspaceId: WS,
    type: 'code_writing',
    status: 'completed',
    title: 'T',
    description: 'D',
    completedAt: COMPLETED_AT,
    result: { success: true, summary: 'went idle' },
    metadata: {
      posthogTaskId: 'pt',
      posthogRunId: 'pr',
      posthogStatus: 'in_progress',
      reviveEligible: true,
    },
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

describe('postHogCodePoller revival of idle-finalized tasks', () => {
  let cleanup: () => Promise<void>;
  let db: Database;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
    mockClient.getTask.mockReset();
    mockClient.getSessionLogs.mockReset().mockResolvedValue({ entries: [], hasMore: false, matchingCount: 0 });
    mockStreamer.ensure.mockReset();
    mockStreamer.stop.mockReset();
    mockStreamer.isActive.mockReset().mockReturnValue(false);
    _resetTaskWatch();

    await seedUser(db);
    await db.insert(schema.workspaces).values({ id: WS, ownerId: 'user-test', name: 'WS' });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await cleanup();
  });

  it('revives a completed task when its remote run resumed (fresh activity)', async () => {
    const id = 'task-resumed';
    await seedCompleted(db, id);
    // Activity 5 min after we finalized → the run resumed.
    mockClient.getTask.mockResolvedValue(
      remoteTask('in_progress', new Date(COMPLETED_AT.getTime() + 5 * 60_000)),
    );

    await postHogCodePoller.reconcileTask(row(id));
    await drainTaskMetadata(id);

    const t = await readTask(db, id);
    expect(t?.status).toBe('in_progress');
    expect(t?.completedAt).toBeNull();
    expect(t?.result).toBeNull();
    expect((t?.metadata as Record<string, unknown>).reviveEligible).toBe(false);
  });

  it('leaves a completed task alone while its remote run is still idle', async () => {
    const id = 'task-still-idle';
    await seedCompleted(db, id);
    // updated_at predates our finalize → no new activity, just an idle run.
    mockClient.getTask.mockResolvedValue(
      remoteTask('in_progress', new Date(COMPLETED_AT.getTime() - 15 * 60_000)),
    );

    await postHogCodePoller.reconcileTask(row(id));
    await drainTaskMetadata(id);

    const t = await readTask(db, id);
    expect(t?.status).toBe('completed');
    // Still a revival candidate — keep watching it.
    expect((t?.metadata as Record<string, unknown>).reviveEligible).toBe(true);
  });

  it('stops tracking a completed task once its remote run is genuinely terminal', async () => {
    const id = 'task-terminal';
    await seedCompleted(db, id);
    mockClient.getTask.mockResolvedValue(
      remoteTask('completed', new Date(COMPLETED_AT.getTime() + 5 * 60_000)),
    );

    await postHogCodePoller.reconcileTask(row(id));
    await drainTaskMetadata(id);

    const t = await readTask(db, id);
    expect(t?.status).toBe('completed');
    expect((t?.metadata as Record<string, unknown>).reviveEligible).toBe(false);
  });

  it('throttles the resume re-check — no second remote fetch within the window', async () => {
    const id = 'task-throttled';
    await seedCompleted(db, id);
    mockClient.getTask.mockResolvedValue(
      remoteTask('in_progress', new Date(COMPLETED_AT.getTime() - 15 * 60_000)),
    );

    await postHogCodePoller.reconcileTask(row(id));
    await postHogCodePoller.reconcileTask(row(id));

    expect(mockClient.getTask).toHaveBeenCalledTimes(1);
  });
});
