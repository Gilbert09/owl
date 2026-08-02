import type { AgentEvent } from '@talyn/shared';
import { emitTaskEvent } from '../websocket.js';
import { PERSIST_INTERVAL_MS, writeTranscript } from '../cloudProviders/transcriptStore.js';
import { getPostHogCodeClient } from './credentials.js';
import { AcpConverter, type AcpLogEntry, type AgentEventInput } from './acpConverter.js';
import type { PostHogCodeClient } from './client.js';

/**
 * Streams a PostHog Code cloud run's logs into a FastOwl task's
 * `transcript`, so the structured-conversation renderer shows the agent
 * working live instead of a blank "Waiting for the agent to start…" box.
 *
 * PostHog owns the agent loop; we're a read-only consumer:
 *   - live in-flight runs → SSE (`/stream/`). Connecting with no
 *     Last-Event-ID replays the run from the start (the Redis stream is
 *     an append log) then tails — so the SSE is its own backfill.
 *   - if the live stream is gone (completed run reopened, or a run that
 *     finished while the backend was down) → one-shot durable backfill
 *     from `/session_logs/` (S3).
 *
 * Lifecycle is driven from the poller, gated on the task being viewed
 * (services/cloudProviders/taskWatch.ts): `ensure()` while a task is
 * in-progress AND watched (idempotent, self-healing across
 * reconnects/restarts), `stop()` once the watch lapses or the run
 * reaches a terminal status. The poller continues to own
 * status/PR/finalisation — this service only owns the transcript.
 */

/**
 * Each persist REWRITES the WHOLE jsonb array — a full re-TOAST + WAL record +
 * dead tuple every time, the dominant consumer of the Supabase disk-IO budget
 * on an active run. So the flush is debounced by time rather than event count:
 * a token-level burst coalesces into one write per window. Events still stream
 * to the UI live via `emitTaskEvent` regardless — the DB blob is only the
 * durable snapshot, so a longer window costs nothing perceptible. The
 * stream-end tail and `flushNow()` cover anything still buffered at the end.
 */
const MAX_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 1500;
// A live run's SSE closes between bursts; we reconnect-to-tail until this
// many consecutive reconnects bring nothing new (then the run is idle and
// the poller will finalise it). At RECONNECT_DELAY_MS each, ~6s of quiet.
const MAX_EMPTY_RECONNECTS = 4;
/** session_logs page size (the API caps `limit` at 5000) and a safety bound. */
const SESSION_LOG_PAGE = 5000;
const SESSION_LOG_MAX_PAGES = 50;
// A connected SSE that goes completely silent (no frames, not even
// keepalives) means the socket is dead but undici never noticed — without a
// bound, `reader.read()` blocks forever and the stream entry leaks. PostHog
// sends keepalive frames well inside this window on a healthy connection,
// so 120s of true silence is a wedge, not a quiet run.
const STREAM_IDLE_TIMEOUT_MS = 120_000;

interface ActiveStream {
  taskId: string;
  workspaceId: string;
  posthogTaskId: string;
  posthogRunId: string;
  abort: AbortController;
  converter: AcpConverter;
  transcript: AgentEvent[];
  /** Monotonic seq for the next appended event (survives a seeded
   *  transcript that may contain a truncation marker with seq -1). */
  nextSeq: number;
  lastEventId?: string;
  /** Events appended since the last DB flush. */
  unpersisted: number;
  /** When the transcript last flushed to the DB (persist debounce). */
  lastPersistAt: number;
  closed: boolean;
  /** Skip SSE, pull the durable S3 log once (terminal runs). */
  backfillOnly: boolean;
}

class PostHogCodeStreamer {
  private active = new Map<string, ActiveStream>();

  /**
   * Begin streaming a cloud run's logs into `taskId`'s transcript.
   * Idempotent — a no-op if a stream is already live for the task.
   */
  ensure(input: {
    taskId: string;
    workspaceId: string;
    posthogTaskId: string;
    posthogRunId: string;
    /**
     * Skip the live SSE stream and pull the durable S3 log once. Used for
     * terminal runs (whose live Redis stream is gone, so an SSE attempt
     * just blocks until it times out).
     */
    backfillOnly?: boolean;
    /**
     * Pre-existing transcript to append the new run's events onto, rather
     * than replacing it. Used for follow-up runs (resume) so the prior
     * conversation stays visible and seqs continue. Persisted on the first
     * flush so the seed survives even if the new run is empty.
     */
    seedTranscript?: AgentEvent[];
  }): void {
    if (this.active.has(input.taskId)) return;
    const seed = input.seedTranscript ?? [];
    const stream: ActiveStream = {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      posthogTaskId: input.posthogTaskId,
      posthogRunId: input.posthogRunId,
      abort: new AbortController(),
      converter: new AcpConverter(),
      transcript: [...seed],
      nextSeq: seed.reduce((max, e) => Math.max(max, e.seq + 1), 0),
      // Persist on the next append so a seed-only resume still saves.
      unpersisted: seed.length > 0 ? 1 : 0,
      lastPersistAt: Date.now(),
      closed: false,
      backfillOnly: Boolean(input.backfillOnly),
    };
    this.active.set(input.taskId, stream);
    void this.run(stream).catch((err) => {
      console.warn(
        `[posthogCode] stream failed for task ${input.taskId.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
      this.cleanup(stream);
    });
  }

  /** Is a stream (live or backfill) currently active for this task? */
  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /**
   * Force-persist a live stream's in-memory transcript, if one is active.
   * The read loop only persists every PERSIST_INTERVAL_MS, so a reader
   * opening the task mid-run (which fetches the durable transcript) would
   * otherwise miss the last few buffered events. Called from the
   * refresh-logs route before it returns. No-op if no stream is active.
   */
  async flushNow(taskId: string): Promise<void> {
    const stream = this.active.get(taskId);
    if (!stream || stream.transcript.length === 0) return;
    // Mark everything dirty so persist() writes the current array.
    stream.unpersisted = Math.max(stream.unpersisted, 1);
    await this.persist(stream);
  }

  /** Stop streaming a task (terminal status, or shutdown). */
  stop(taskId: string): void {
    const stream = this.active.get(taskId);
    if (!stream) return;
    stream.closed = true;
    stream.abort.abort();
    this.active.delete(taskId);
  }

  shutdownAll(): void {
    for (const taskId of [...this.active.keys()]) this.stop(taskId);
  }

  private cleanup(stream: ActiveStream): void {
    if (this.active.get(stream.taskId) === stream) {
      this.active.delete(stream.taskId);
    }
  }

  private async run(stream: ActiveStream): Promise<void> {
    const tag = `${stream.taskId.slice(0, 8)} run ${stream.posthogRunId.slice(0, 8)}`;
    const client = await getPostHogCodeClient(stream.workspaceId);
    if (!client) {
      console.warn(`[posthogCode] ${tag}: no client (credentials missing) — not streaming`);
      this.cleanup(stream);
      return;
    }

    // Terminal runs have no live stream — go straight to the durable log.
    if (stream.backfillOnly) {
      console.log(`[posthogCode] ${tag}: backfilling from session_logs`);
      await this.backfillFromSessionLogs(stream, client);
      await this.persist(stream);
      console.log(`[posthogCode] ${tag}: backfill done — ${stream.transcript.length} events`);
      this.cleanup(stream);
      return;
    }

    let errorAttempts = 0;
    let emptyReconnects = 0;
    while (!stream.closed) {
      const before = stream.transcript.length;
      try {
        console.log(`[posthogCode] ${tag}: opening SSE stream${stream.lastEventId ? ` (resume ${stream.lastEventId})` : ''}`);
        await this.consumeStream(stream, client);
        if (stream.closed) break;
        // A clean end means the SSE body closed. PostHog drains the buffered
        // Redis stream then closes between bursts rather than holding a
        // forever-tail, so this does NOT mean the run is done — keep tailing
        // by reconnecting and resuming from `lastEventId` (no re-replay, no
        // dupes). Give up only after several reconnects bring nothing new
        // (run idle/finished — the poller finalises it from there).
        errorAttempts = 0;
        if (stream.transcript.length > before) {
          // Got events — resume immediately to catch the next burst.
          emptyReconnects = 0;
          continue;
        }
        if (++emptyReconnects >= MAX_EMPTY_RECONNECTS) {
          console.log(`[posthogCode] ${tag}: no new events after ${MAX_EMPTY_RECONNECTS} reconnects — stopping tail (${stream.transcript.length} events)`);
          break;
        }
        await delay(RECONNECT_DELAY_MS);
      } catch (err) {
        if (stream.closed) break;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[posthogCode] ${tag}: stream error: ${msg}`);
        // The live stream may not exist (run finished, Redis trimmed).
        // Fall back to the durable S3 log once, then we're done.
        if (msg.includes('Stream not available') || msg.includes('(404)')) {
          console.log(`[posthogCode] ${tag}: live stream unavailable — falling back to session_logs`);
          await this.backfillFromSessionLogs(stream, client);
          break;
        }
        errorAttempts += 1;
        if (errorAttempts > MAX_RECONNECTS) {
          // Last resort: pull whatever durable log exists so the user
          // isn't left with a blank pane.
          await this.backfillFromSessionLogs(stream, client).catch((backfillErr) => {
            const bMsg = backfillErr instanceof Error ? backfillErr.message : String(backfillErr);
            console.warn(`[posthogCode] ${tag}: last-resort backfill failed: ${bMsg}`);
          });
          break;
        }
        await delay(RECONNECT_DELAY_MS);
      }
    }

    // Settle trailing streamed text + any tool calls left without a
    // terminal update (run still in progress / interrupted).
    this.appendEvents(stream, stream.converter.end());
    await this.persist(stream);
    this.cleanup(stream);
  }

  /** Read the SSE body to completion, emitting converted events. */
  private async consumeStream(
    stream: ActiveStream,
    client: PostHogCodeClient,
  ): Promise<void> {
    const res = await client.openRunStream(stream.posthogTaskId, stream.posthogRunId, {
      lastEventId: stream.lastEventId,
      signal: stream.abort.signal,
    });
    console.log(
      `[posthogCode] ${stream.taskId.slice(0, 8)}: stream connected (${res.status} ${res.headers.get('content-type') ?? '?'})`,
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let frames = 0;
    let acpEntries = 0;

    try {
      for (;;) {
        const read = await raceWithIdleTimeout(reader.read(), STREAM_IDLE_TIMEOUT_MS);
        if (read === IDLE_TIMED_OUT) {
          // Clean error path: cancel the dead reader and surface a stream
          // error — run()'s catch counts it as a reconnect attempt and
          // eventually falls back to the durable session_logs backfill.
          void reader.cancel().catch(() => undefined);
          throw new StreamError(
            `SSE stream idle for ${STREAM_IDLE_TIMEOUT_MS}ms — aborting dead connection`,
          );
        }
        const { done, value } = read;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        // SSE frames are separated by a blank line.
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          frames += 1;
          if (this.handleFrame(stream, frame)) {
            acpEntries += 1;
            if (acpEntries === 1) {
              console.log(`[posthogCode] ${stream.taskId.slice(0, 8)}: first ACP event received`);
            }
          }
        }
      }
    } finally {
      console.log(
        `[posthogCode] ${stream.taskId.slice(0, 8)}: read loop done — ${frames} frames, ${acpEntries} ACP entries`,
      );
      reader.releaseLock();
    }
  }

  /** Returns true if the frame carried an ACP log entry (not a keepalive). */
  private handleFrame(stream: ActiveStream, frame: string): boolean {
    const { eventName, eventId, data } = parseSseFrame(frame);
    if (eventName === 'keepalive' || !data) return false;

    let parsed: AcpLogEntry & { error?: string; type?: string };
    try {
      parsed = JSON.parse(data);
    } catch {
      return false;
    }

    if (eventName === 'error') {
      throw new StreamError(typeof parsed.error === 'string' ? parsed.error : 'stream error');
    }
    if (parsed.type === 'keepalive') return false;

    if (eventId) {
      // Client-side dedup by Redis stream id. A reconnect resumes via
      // Last-Event-ID, but if PostHog ignores it and replays from the
      // start, skip everything we've already processed — so reconnect-to-
      // tail can't double-emit or grow the transcript unbounded.
      if (stream.lastEventId && !streamIdGreaterThan(eventId, stream.lastEventId)) {
        return false;
      }
      stream.lastEventId = eventId;
    }
    this.appendEvents(stream, stream.converter.push(parsed));
    return true;
  }

  /**
   * Durable fallback: rebuild the transcript from the S3 session log.
   * The endpoint caps each page at `SESSION_LOG_PAGE` entries, so we page
   * through with `after` (an ISO timestamp) until drained — a long run can
   * have tens of thousands of entries and a single fetch would truncate it.
   */
  private async backfillFromSessionLogs(
    stream: ActiveStream,
    client: PostHogCodeClient,
  ): Promise<void> {
    let after: string | undefined;
    for (let page = 0; page < SESSION_LOG_MAX_PAGES; page += 1) {
      const batch = await client.getSessionLogs(stream.posthogTaskId, stream.posthogRunId, {
        after,
        limit: SESSION_LOG_PAGE,
      });
      if (batch.length === 0) break;
      // `after` is inclusive on some backends — drop entries we've already
      // consumed at the boundary timestamp.
      const fresh = after ? batch.filter((e) => (e.timestamp ?? '') > after!) : batch;
      for (const entry of fresh) {
        this.appendEvents(stream, stream.converter.push(entry));
      }
      const last = batch[batch.length - 1]?.timestamp;
      if (!last || batch.length < SESSION_LOG_PAGE || last === after) break;
      after = last;
    }
    this.appendEvents(stream, stream.converter.end());
  }

  private appendEvents(stream: ActiveStream, inputs: AgentEventInput[]): void {
    if (inputs.length === 0) return;
    for (const input of inputs) {
      const event: AgentEvent = { ...input, seq: stream.nextSeq++ } as AgentEvent;
      stream.transcript.push(event);
      emitTaskEvent(stream.workspaceId, stream.taskId, event);
      stream.unpersisted += 1;
    }
    if (Date.now() - stream.lastPersistAt >= PERSIST_INTERVAL_MS) {
      void this.persist(stream).catch((err) =>
        console.warn(
          `[posthogCode] transcript persist failed for ${stream.taskId.slice(0, 8)}:`,
          err instanceof Error ? err.message : err,
        ),
      );
    }
  }

  private async persist(stream: ActiveStream): Promise<void> {
    if (stream.unpersisted === 0) return;
    stream.unpersisted = 0;
    stream.lastPersistAt = Date.now();
    // Truncation and the write itself are shared; the debounce is NOT. This
    // streamer counts unpersisted appends against a wall clock, because it
    // owns a long-lived accumulator and knows exactly what is dirty. The two
    // pollers rebuild or re-read and compare counts instead. Same interval,
    // different question, so only the half that is genuinely identical moves.
    await writeTranscript(stream.taskId, stream.transcript);
  }
}

class StreamError extends Error {}

/**
 * Parse one SSE frame (the text between blank-line separators) into its
 * `event:` name, `id:`, and concatenated `data:` payload. Per the SSE
 * spec, multiple `data:` lines join with newlines. Pure + exported for
 * tests.
 */
export function parseSseFrame(frame: string): {
  eventName: string;
  eventId: string;
  data: string;
} {
  let eventName = '';
  let eventId = '';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('id:')) eventId = line.slice(3).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return { eventName, eventId, data: dataLines.join('\n') };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sentinel returned by {@link raceWithIdleTimeout} when the timer wins. */
export const IDLE_TIMED_OUT = Symbol('idle-timed-out');

/**
 * Race a promise against an idle timer. Resolves with the promise's value,
 * or with {@link IDLE_TIMED_OUT} once `ms` elapses first. The timer is
 * cleared when the promise settles, so it never keeps the process alive.
 * Exported for tests.
 */
export function raceWithIdleTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof IDLE_TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof IDLE_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(IDLE_TIMED_OUT), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

/**
 * Compare two Redis stream ids (`<ms>-<seq>`). Returns true if `a` is
 * strictly newer than `b`. Non-numeric ids fall back to string compare.
 */
export function streamIdGreaterThan(a: string, b: string): boolean {
  const [am, as] = a.split('-');
  const [bm, bs] = b.split('-');
  const amN = Number(am);
  const bmN = Number(bm);
  if (Number.isNaN(amN) || Number.isNaN(bmN)) return a > b;
  if (amN !== bmN) return amN > bmN;
  return Number(as || 0) > Number(bs || 0);
}

export const postHogCodeStreamer = new PostHogCodeStreamer();
