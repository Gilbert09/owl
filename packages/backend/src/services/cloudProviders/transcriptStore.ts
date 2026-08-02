import { eq } from 'drizzle-orm';
import type { AgentEvent } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable } from '../../db/schema.js';
import { emitTaskEvent } from '../websocket.js';

/**
 * The transcript machinery every cloud provider needs, in one place.
 *
 * # What is actually shared, and what is not
 *
 * docs/CLOUD_PROVIDERS.md defers a `TranscriptSource`/`TranscriptConverter`
 * abstraction "until a third provider exists", and spec §10.5 proposes a single
 * generic streamer owning seq assignment, the debounced persist, truncation,
 * live emission, reconnect-to-tail and watch-gating.
 *
 * Reading all three implementations, that list is too long. **Seq assignment is
 * not shared** — the three providers have genuinely different models:
 *
 *   - PostHog assigns its own monotonic seq as events arrive, continuing past a
 *     seeded transcript so a resumed run does not restart numbering.
 *   - Claude rebuilds the whole transcript every tick from the full event log,
 *     so seq is the array index and is only stable because the log is.
 *   - The fleet assigns seq HOST-side and it is authoritative, so a backend
 *     restart mid-run resumes with the numbering intact.
 *
 * Those are three different correctness arguments, not one mechanism with
 * three call sites. Nor is reconnect-to-tail shared (only PostHog has a live
 * SSE with Last-Event-ID resumption) or watch-gating (PostHog and the fleet
 * gate differently, Claude gates its event fetch rather than a stream).
 *
 * What IS shared, byte-for-byte across all three today, is everything below:
 * emit anything past the websocket cursor, debounce the durable write, truncate
 * the middle when it gets long, and rewrite the blob. That is what this owns.
 *
 * # Why the debounce matters
 *
 * Each persist REWRITES the whole jsonb array — a full re-TOAST, a WAL record
 * and a dead tuple every time — and it is the dominant consumer of the Supabase
 * disk-IO budget on an active run. Events still reach the UI live through
 * `emitTaskEvent` regardless, so a longer window costs nothing perceptible.
 */

export const TRANSCRIPT_MAX_EVENTS = 2000;
export const PERSIST_INTERVAL_MS = 45_000;

/**
 * Decide whether to rewrite the transcript blob. Skip when the DB is already
 * current, or when the debounce window has not elapsed — unless `force` (a
 * terminal tick) demands a final flush.
 *
 * Pure, so the truth table is testable without a database. Both the Claude
 * poller and the fleet poller exported their own identical copy of this; they
 * now re-export this one, so the two cannot drift apart.
 */
export function shouldPersistTranscript(opts: {
  length: number;
  persistedCount: number;
  lastPersistAt: number;
  now: number;
  force: boolean;
}): boolean {
  if (opts.length === opts.persistedCount) return false;
  return opts.force || opts.now - opts.lastPersistAt >= PERSIST_INTERVAL_MS;
}

/**
 * Truncate the MIDDLE of a long transcript, keeping the head and the tail.
 *
 * The tail is what a reconcile needs and what anyone reading it looks at first;
 * the head is where the task was set up. The marker carries `seq: -1` so it can
 * never collide with a real event, and `dropped` so the renderer can say how
 * much is missing rather than silently presenting a gap as continuous.
 */
export function truncateTranscript(transcript: AgentEvent[]): AgentEvent[] {
  if (transcript.length <= TRANSCRIPT_MAX_EVENTS) return transcript;
  const head = transcript.slice(0, 100);
  const tail = transcript.slice(transcript.length - (TRANSCRIPT_MAX_EVENTS - 101));
  const marker = {
    seq: -1,
    type: 'system',
    subtype: 'truncated',
    dropped: transcript.length - (head.length + tail.length),
  } as unknown as AgentEvent;
  return [...head, marker, ...tail];
}

/** Write the transcript blob. The only place any provider touches the column. */
export async function writeTranscript(taskId: string, transcript: AgentEvent[]): Promise<void> {
  await getDbClient()
    .update(tasksTable)
    .set({
      transcript: truncateTranscript(transcript) as unknown as object,
      updatedAt: new Date(),
    })
    .where(eq(tasksTable.id, taskId));
}

/**
 * Per-task transcript bookkeeping: what has been emitted, what has been
 * persisted, and when.
 *
 * Deliberately NOT a store of the transcript itself for every provider — the
 * three disagree about who owns the array (PostHog accumulates one, Claude
 * rebuilds one each tick from the vendor's log). It owns the two cursors and
 * the debounce clock, which they all keep identically and all keep separately.
 */
export class TranscriptCursors {
  /** taskId → events already emitted over the websocket. */
  private emitted = new Map<string, number>();
  /** taskId → events already written to the DB. Trails `emitted`, because the
   *  durable write is debounced while emission stays live. */
  private persisted = new Map<string, number>();
  private lastPersistAt = new Map<string, number>();

  /**
   * Emit every event past the websocket cursor and advance it.
   *
   * Takes the whole transcript rather than a delta so it serves both models:
   * a provider that rebuilds its array each tick passes the rebuilt one, and a
   * provider that appends passes its accumulator. Either way only the tail past
   * the cursor goes out, which is what stops an unchanged transcript
   * re-emitting every tick.
   */
  emitNew(taskId: string, workspaceId: string, transcript: AgentEvent[]): number {
    const from = this.emitted.get(taskId) ?? 0;
    if (transcript.length <= from) return 0;
    for (let i = from; i < transcript.length; i += 1) {
      emitTaskEvent(workspaceId, taskId, transcript[i]!);
    }
    this.emitted.set(taskId, transcript.length);
    return transcript.length - from;
  }

  /** How many events this task has emitted so far. */
  emittedCount(taskId: string): number {
    return this.emitted.get(taskId) ?? 0;
  }

  /**
   * Persist if the debounce allows it, or if forced. Returns whether it wrote.
   */
  async persistIfDue(
    taskId: string,
    transcript: AgentEvent[],
    opts: { force: boolean; now?: number } = { force: false },
  ): Promise<boolean> {
    const now = opts.now ?? Date.now();
    const due = shouldPersistTranscript({
      length: transcript.length,
      persistedCount: this.persisted.get(taskId) ?? 0,
      lastPersistAt: this.lastPersistAt.get(taskId) ?? 0,
      now,
      force: opts.force,
    });
    if (!due) return false;
    // Advance the bookkeeping BEFORE the await. Two ticks overlapping on a slow
    // write would otherwise both see the old counts and both rewrite the blob —
    // which is the exact cost the debounce exists to avoid.
    this.lastPersistAt.set(taskId, now);
    this.persisted.set(taskId, transcript.length);
    await writeTranscript(taskId, transcript);
    return true;
  }

  /** Forget a task (terminal, stopped, deleted). */
  forget(taskId: string): void {
    this.emitted.delete(taskId);
    this.persisted.delete(taskId);
    this.lastPersistAt.delete(taskId);
  }
}
