import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { tasks as tasksTable, workspaces as workspacesTable } from '../db/schema.js';
import type { Database } from '../db/client.js';

/**
 * The cloud-task poller no longer selects the `transcript` jsonb (a multi-MB
 * blob) every tick — it computes emptiness server-side. This test pins that
 * SQL expression to the exact JS semantics it replaced
 * (`!Array.isArray(t) || t.length === 0`) across every jsonb shape, using real
 * Postgres semantics via pglite.
 */

let db: Database;
let cleanup: () => Promise<void>;

/** The exact emptiness expression used in cloudProviders/poller.ts. */
const transcriptEmptyExpr = sql<boolean>`CASE WHEN jsonb_typeof(${tasksTable.transcript}) = 'array' THEN jsonb_array_length(${tasksTable.transcript}) = 0 ELSE true END`;

async function seedTask(id: string, transcript: unknown): Promise<void> {
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'in_progress',
    priority: 'medium',
    title: 't',
    description: 'd',
    transcript: transcript as object | null,
  });
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db, { id: 'owner1' });
  await db.insert(workspacesTable).values({ id: 'ws1', ownerId: 'owner1', name: 'ws', settings: {} });
});

afterEach(async () => {
  await cleanup();
});

describe('narrowed transcriptEmpty SQL', () => {
  it.each([
    ['null transcript', null, true],
    ['empty array', [], true],
    ['non-empty array', [{ type: 'message' }], false],
    ['multi-element array', [{ a: 1 }, { b: 2 }], false],
    ['non-array object', { foo: 'bar' }, true],
  ])('%s → empty=%s, matching the old JS check', async (label, transcript, expected) => {
    const id = `task-${label.replace(/\s+/g, '-')}`;
    await seedTask(id, transcript);

    const [row] = await db
      .select({ id: tasksTable.id, transcriptEmpty: transcriptEmptyExpr })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));

    // Old behaviour we must preserve, computed the JS way for cross-check.
    const jsEmpty = !Array.isArray(transcript) || transcript.length === 0;

    expect(row.transcriptEmpty).toBe(expected);
    expect(row.transcriptEmpty).toBe(jsEmpty);
  });

  it('only returns in-progress tasks, with emptiness resolved per row', async () => {
    await seedTask('a', [{ type: 'x' }]);
    await seedTask('b', null);
    await db
      .update(tasksTable)
      .set({ status: 'completed' })
      .where(eq(tasksTable.id, 'a'));

    const rows = await db
      .select({ id: tasksTable.id, transcriptEmpty: transcriptEmptyExpr })
      .from(tasksTable)
      .where(eq(tasksTable.status, 'in_progress'));

    expect(rows).toEqual([{ id: 'b', transcriptEmpty: true }]);
  });
});

/**
 * The cloud poller also loads revival candidates: `completed` tasks a provider
 * optimistically finalised (`metadata.reviveEligible`) within the revive window.
 * Pins the exact WHERE clause from cloudProviders/poller.ts against real
 * Postgres semantics — in particular that the jsonb-containment flag and the
 * completedAt window both gate the completed rows without pulling in others.
 */
describe('cloud poller task selection (in-flight + revival candidates)', () => {
  const REVIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

  async function seedRow(
    id: string,
    status: string,
    opts: { completedAt?: Date | null; reviveEligible?: boolean } = {},
  ): Promise<void> {
    await db.insert(tasksTable).values({
      id,
      workspaceId: 'ws1',
      type: 'code_writing',
      status,
      priority: 'medium',
      title: 't',
      description: 'd',
      completedAt: opts.completedAt ?? null,
      metadata: opts.reviveEligible ? { reviveEligible: true } : {},
    });
  }

  it('selects in-flight tasks and revivable completed tasks in-window, nothing else', async () => {
    const now = Date.now();
    const inWindow = new Date(now - 60 * 60 * 1000); // 1h ago
    const stale = new Date(now - (REVIVE_WINDOW_MS + 60 * 60 * 1000)); // >24h ago

    await seedRow('inflight', 'in_progress');
    await seedRow('revivable', 'completed', { completedAt: inWindow, reviveEligible: true });
    await seedRow('done-no-flag', 'completed', { completedAt: inWindow, reviveEligible: false });
    await seedRow('revivable-stale', 'completed', { completedAt: stale, reviveEligible: true });
    await seedRow('failed-flag', 'failed', { completedAt: inWindow, reviveEligible: true });

    const reviveCutoff = new Date(now - REVIVE_WINDOW_MS);
    const rows = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(
        or(
          eq(tasksTable.status, 'in_progress'),
          and(
            eq(tasksTable.status, 'completed'),
            gte(tasksTable.completedAt, reviveCutoff),
            sql`${tasksTable.metadata} @> '{"reviveEligible":true}'::jsonb`,
          ),
        ),
      );

    expect(rows.map((r) => r.id).sort()).toEqual(['inflight', 'revivable']);
  });

  /**
   * The transcript-backfill window (services/cloudProviders/poller.ts).
   *
   * A provider's "terminal but no transcript → pull the durable log" branch used
   * to get one attempt, on the tick that saw the run finish — which is the moment
   * the provider's log is least likely to have been flushed yet. Miss it and the
   * task was never selected again, so its transcript stayed null forever. This
   * clause re-selects recently-finished tasks that still have nothing.
   */
  it('re-selects recently-finished tasks with no transcript, and drops them once filled', async () => {
    const BACKFILL_WINDOW_MS = 30 * 60 * 1000;
    const now = Date.now();
    const justNow = new Date(now - 60 * 1000); // 1m ago — inside the window
    const oldish = new Date(now - 2 * 60 * 60 * 1000); // 2h ago — outside it

    await seedRow('empty-recent', 'completed', { completedAt: justNow });
    await seedRow('empty-old', 'completed', { completedAt: oldish });
    await seedRow('filled-recent', 'completed', { completedAt: justNow });
    await db
      .update(tasksTable)
      .set({ transcript: [{ id: 'e1', type: 'text' }] })
      .where(eq(tasksTable.id, 'filled-recent'));
    // An empty ARRAY must count as empty too, not just SQL NULL.
    await seedRow('emptyarray-recent', 'completed', { completedAt: justNow });
    await db
      .update(tasksTable)
      .set({ transcript: [] })
      .where(eq(tasksTable.id, 'emptyarray-recent'));

    const backfillCutoff = new Date(now - BACKFILL_WINDOW_MS);
    const rows = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.status, 'completed'),
          gte(tasksTable.completedAt, backfillCutoff),
          sql`CASE WHEN jsonb_typeof(${tasksTable.transcript}) = 'array' THEN jsonb_array_length(${tasksTable.transcript}) = 0 ELSE true END`,
        ),
      );

    // `filled-recent` is excluded because it already has what we'd be fetching —
    // that is what stops this clause re-polling every finished task forever.
    // `empty-old` is excluded by the window; opening it is its recovery path.
    expect(rows.map((r) => r.id).sort()).toEqual(['empty-recent', 'emptyarray-recent']);
  });
});
