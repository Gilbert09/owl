import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { workspaces as workspacesTable, tasks as tasksTable } from '../db/schema.js';
import { retiredRun, retiredEvents, taskIdFromRunId } from '../services/admin/retiredRuns.js';
import type { Database } from '../db/client.js';

/**
 * A run outlives the host that ran it.
 *
 * The fleet retires a terminal run's record two hours after it ends — its
 * startup ledger would otherwise become a scan of every run the box has ever
 * done. After that the host answers "no such run", and the console showed
 * exactly that for the run AND its transcript, for anything older than an
 * afternoon.
 *
 * The transcript was never lost: the streamer persists it to `tasks.transcript`
 * as it arrives, and the task row is the durable record by design. The console
 * simply never asked for it.
 */
describe('retired runs fall back to the task record', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const TASK_ID = '325792e2-4f3c-4a73-b04d-f10e7b361b2a';
  const RUN_ID = `talyn-${TASK_ID}`;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
  });

  afterEach(async () => {
    await cleanup();
  });

  async function seedTask(over: Partial<typeof tasksTable.$inferInsert> = {}) {
    await db.insert(tasksTable).values({
      id: TASK_ID,
      workspaceId: 'ws1',
      type: 'pr_response',
      status: 'completed',
      priority: 'medium',
      title: 'Get PostHog/posthog#79258 mergeable',
      description: 'd',
      transcript: [
        { type: 'assistant', raw: { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } },
        { type: 'result', raw: { type: 'result', subtype: 'success' } },
      ],
      completedAt: new Date('2026-08-10T09:00:00.000Z'),
      ...over,
    });
  }

  it('reads the task id out of the deterministic run id', () => {
    expect(taskIdFromRunId(RUN_ID)).toBe(TASK_ID);
    // Not one of ours — a run the executor never named must not be guessed at.
    expect(taskIdFromRunId('deploy-api-1786301640')).toBeNull();
  });

  it('rebuilds a retired run from the task that owned it', async () => {
    await seedTask();
    const run = await retiredRun(RUN_ID, 'hetzner-64');
    expect(run).toBeTruthy();
    expect(run?.runId).toBe(RUN_ID);
    expect(run?.taskId).toBe(TASK_ID);
    expect(run?.host).toBe('hetzner-64');
    expect(run?.status).toBe('completed');
    // The host's copy is gone, so there is nothing live to measure — null,
    // never a zero that reads as a real measurement.
    expect(run?.memUsedMib).toBeNull();
  });

  it('serves the transcript the streamer persisted', async () => {
    await seedTask();
    const page = await retiredEvents(RUN_ID, 0);
    expect(page?.events).toHaveLength(2);
    expect(page?.events[0]?.event).toMatchObject({ type: 'assistant' });
    // A run whose host record is gone cannot grow a transcript; saying
    // otherwise leaves the console polling forever.
    expect(page?.terminal).toBe(true);
  });

  it('honours the cursor so the page does not re-ship what the client has', async () => {
    await seedTask();
    const page = await retiredEvents(RUN_ID, 1);
    expect(page?.events).toHaveLength(1);
    expect(page?.events[0]?.seq).toBe(2);
  });

  it('returns null for a run no task claims, so it still 404s', async () => {
    expect(await retiredRun('talyn-does-not-exist', 'hetzner-64')).toBeNull();
    expect(await retiredEvents('talyn-does-not-exist', 0)).toBeNull();
  });

  it('copes with a task that never recorded a transcript', async () => {
    await seedTask({ transcript: null });
    const page = await retiredEvents(RUN_ID, 0);
    expect(page?.events).toEqual([]);
    expect(page?.terminal).toBe(true);
  });
});
