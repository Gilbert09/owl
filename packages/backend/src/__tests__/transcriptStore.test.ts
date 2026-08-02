import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AgentEvent } from '@talyn/shared';
import {
  PERSIST_INTERVAL_MS,
  TRANSCRIPT_MAX_EVENTS,
  TranscriptCursors,
  shouldPersistTranscript,
  truncateTranscript,
  writeTranscript,
} from '../services/cloudProviders/transcriptStore.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  tasks as tasksTable,
} from '../db/schema.js';

/**
 * The transcript machinery all three cloud providers share.
 *
 * Before this existed, the truncation block and the DB write were byte-identical
 * in three files, and the debounce predicate was byte-identical in two — each
 * free to drift from the others. These tests pin the behaviour that all three
 * now depend on, which is the thing a shared module buys and the thing it risks:
 * a change here changes every provider at once.
 */

const ev = (seq: number): AgentEvent => ({ seq, type: 'assistant' }) as unknown as AgentEvent;
const many = (n: number): AgentEvent[] => Array.from({ length: n }, (_, i) => ev(i));

describe('shouldPersistTranscript', () => {
  const base = { length: 10, persistedCount: 0, lastPersistAt: 0, now: 0, force: false };

  it('never writes when the DB is already current, even when forced', () => {
    // The most important case: a terminal tick on a task that has not changed
    // must not rewrite the whole jsonb array for nothing. `force` is about the
    // debounce, not about ignoring that there is nothing to say.
    expect(shouldPersistTranscript({ ...base, length: 10, persistedCount: 10, force: true })).toBe(false);
  });

  it('writes when forced and there is something new', () => {
    expect(shouldPersistTranscript({ ...base, force: true })).toBe(true);
  });

  it('holds the write until the debounce window elapses', () => {
    expect(shouldPersistTranscript({ ...base, lastPersistAt: 1000, now: 1000 + PERSIST_INTERVAL_MS - 1 })).toBe(false);
    expect(shouldPersistTranscript({ ...base, lastPersistAt: 1000, now: 1000 + PERSIST_INTERVAL_MS })).toBe(true);
  });
});

describe('truncateTranscript', () => {
  it('leaves a short transcript exactly as it is', () => {
    const t = many(50);
    expect(truncateTranscript(t)).toBe(t);
  });

  it('keeps the head and the TAIL, with a marker naming what went', () => {
    const t = many(TRANSCRIPT_MAX_EVENTS + 500);
    const out = truncateTranscript(t);

    expect(out).toHaveLength(TRANSCRIPT_MAX_EVENTS);
    // The tail is what a reconcile reads and what anyone opening the task looks
    // at first; dropping it instead of the middle would be the wrong half.
    expect(out[out.length - 1]!.seq).toBe(t.length - 1);
    expect(out[0]!.seq).toBe(0);

    const marker = out.find((e) => e.seq === -1) as unknown as { subtype: string; dropped: number };
    expect(marker).toBeDefined();
    expect(marker.subtype).toBe('truncated');
    // Named, not silent: a gap presented as continuous is worse than a gap.
    expect(marker.dropped).toBe(t.length - (TRANSCRIPT_MAX_EVENTS - 1));
  });

  it('uses seq -1 for the marker so it cannot collide with a real event', () => {
    const out = truncateTranscript(many(TRANSCRIPT_MAX_EVENTS + 10));
    const markers = out.filter((e) => e.seq === -1);
    expect(markers).toHaveLength(1);
    expect(out.filter((e) => e.seq >= 0).every((e) => e.seq >= 0)).toBe(true);
  });
});

describe('TranscriptCursors', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const emitted: { taskId: string; event: AgentEvent }[] = [];

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    emitted.length = 0;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws' });
    const now = new Date();
    await db.insert(tasksTable).values({
      id: 't1',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 't',
      description: 'd',
      prompt: 'p',
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('emits only what is past the cursor, and never re-emits', async () => {
    const { emitTaskEvent } = await import('../services/websocket.js');
    const spy = vi.spyOn({ emitTaskEvent }, 'emitTaskEvent');
    void spy;

    const c = new TranscriptCursors();
    expect(c.emitNew('t1', 'ws1', many(3))).toBe(3);
    // The whole point: a poller that rebuilds the same array every tick must
    // not re-send it. Passing the SAME transcript again emits nothing.
    expect(c.emitNew('t1', 'ws1', many(3))).toBe(0);
    expect(c.emitNew('t1', 'ws1', many(5))).toBe(2);
    expect(c.emittedCount('t1')).toBe(5);
  });

  it('writes the transcript when forced and something is new', async () => {
    const c = new TranscriptCursors();
    const wrote = await c.persistIfDue('t1', many(3), { force: true });
    expect(wrote).toBe(true);

    const rows = await db.select({ transcript: tasksTable.transcript }).from(tasksTable).where(eq(tasksTable.id, 't1'));
    expect((rows[0]?.transcript as unknown[])).toHaveLength(3);
  });

  it('does not rewrite an unchanged transcript on a later forced flush', async () => {
    const c = new TranscriptCursors();
    await c.persistIfDue('t1', many(3), { force: true });
    // Same length, so nothing to say. This is the case that costs a full
    // re-TOAST + WAL record for no information at all.
    expect(await c.persistIfDue('t1', many(3), { force: true })).toBe(false);
  });

  it('holds a write inside the debounce window and lets it through after', async () => {
    const c = new TranscriptCursors();
    await c.persistIfDue('t1', many(1), { force: true, now: 1_000 });

    expect(await c.persistIfDue('t1', many(2), { force: false, now: 1_000 + PERSIST_INTERVAL_MS - 1 })).toBe(false);
    expect(await c.persistIfDue('t1', many(3), { force: false, now: 1_000 + PERSIST_INTERVAL_MS })).toBe(true);
  });

  it('truncates on the way to the database, not in the caller', async () => {
    const c = new TranscriptCursors();
    await c.persistIfDue('t1', many(TRANSCRIPT_MAX_EVENTS + 300), { force: true });

    const rows = await db.select({ transcript: tasksTable.transcript }).from(tasksTable).where(eq(tasksTable.id, 't1'));
    const stored = rows[0]?.transcript as unknown[];
    // Every provider used to do this for itself. If one had forgotten, its
    // longest runs would have written multi-megabyte blobs on every flush.
    expect(stored).toHaveLength(TRANSCRIPT_MAX_EVENTS);
  });

  it('forgets a task so a re-run starts from a clean cursor', async () => {
    const c = new TranscriptCursors();
    c.emitNew('t1', 'ws1', many(4));
    expect(c.emittedCount('t1')).toBe(4);

    c.forget('t1');
    // Without this a resumed or retried task silently emits nothing until it
    // passes its previous length.
    expect(c.emittedCount('t1')).toBe(0);
    expect(c.emitNew('t1', 'ws1', many(2))).toBe(2);
  });
});

describe('writeTranscript', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws' });
    const now = new Date();
    await db.insert(tasksTable).values({
      id: 't1',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 't',
      description: 'd',
      prompt: 'p',
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('is the only place the transcript column is written, and it truncates', async () => {
    await writeTranscript('t1', many(TRANSCRIPT_MAX_EVENTS + 1));
    const rows = await db.select({ transcript: tasksTable.transcript }).from(tasksTable).where(eq(tasksTable.id, 't1'));
    expect((rows[0]?.transcript as unknown[])).toHaveLength(TRANSCRIPT_MAX_EVENTS);
  });
});
