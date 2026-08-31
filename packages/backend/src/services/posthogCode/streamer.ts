import type { AgentEvent } from '@talyn/shared';
import { emitTaskEvent, emitTaskUpdate } from '../websocket.js';
import { PERSIST_INTERVAL_MS, writeTranscript } from '../cloudProviders/transcriptStore.js';
import { getPostHogCodeClient } from './credentials.js';
import { AcpConverter, type AcpLogEntry, type AgentEventInput } from './acpConverter.js';
import type { PostHogCodeClient } from './client.js';

/**
 * Streams a PostHog Code cloud run's logs into a FastOwl task's
 * `transcript`, so the structured-conversation renderer shows the agent
 * working live instead of a blank "Waiting for the agent to start…" box.
 *
 * PostHog owns the agent loop; we're a read-only consumer of two sources.
 * The durable log (`/session_logs/`, S3) is the record: the whole run, chunks
 * coalesced, a few seconds behind. The live stream (`/stream/`, SSE) is the
 * tail: Redis keeps only its newest 5,000 entries, so a replay from the start
 * of a long run begins partway through. A live attach therefore seeds from the
 * log, tails with `start=latest` + `Last-Event-ID`, and rebuilds from the log
 * once the stream says the run is complete.
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
// A body that closes without a rotation or completion frame is a proxy hiccup;
// reconnect-to-tail until this many reconnects in a row bring nothing new.
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

const SSE_KEEPALIVE_EVENT = 'keepalive';
/** The server's 15-minute connection cap, not the run's end. */
const SSE_ROTATED_EVENT = 'end';
const SSE_COMPLETE_EVENT = 'stream-end';
const SSE_ERROR_EVENT = 'error';

type StreamOutcome = 'closed' | 'rotated' | 'complete';
type FrameOutcome = 'entry' | 'skip' | 'rotated' | 'complete';

interface ActiveStream {
  taskId: string;
  workspaceId: string;
  posthogTaskId: string;
  posthogRunId: string;
  abort: AbortController;
  converter: AcpConverter;
  transcript: AgentEvent[];
  nextSeq: number;
  lastEventId?: string;
  /** Newest `timestamp` (ms) of a coalescable entry seen on the live stream. */
  lastLiveEntryAt: number;
  /** Events appended since the last DB flush. */
  unpersisted: number;
  /** When the transcript last flushed to the DB (persist debounce). */
  lastPersistAt: number;
  closed: boolean;
  /** Skip SSE, pull the durable S3 log once (terminal runs). */
  backfillOnly: boolean;
}

interface DurableRead {
  converter: AcpConverter;
  events: AgentEvent[];
  entries: number;
  lastEntryAt: number;
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
  }): void {
    if (this.active.has(input.taskId)) return;
    const stream: ActiveStream = {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      posthogTaskId: input.posthogTaskId,
      posthogRunId: input.posthogRunId,
      abort: new AbortController(),
      converter: new AcpConverter(),
      transcript: [],
      nextSeq: 0,
      lastLiveEntryAt: 0,
      unpersisted: 0,
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
      const entries = await this.replaceFromDurableLog(stream, client, { finalize: true });
      console.log(`[posthogCode] ${tag}: backfill done — ${entries} entries, ${stream.transcript.length} events`);
      this.cleanup(stream);
      return;
    }

    // An empty log means the run has barely started: replay from the beginning.
    let startLatest = false;
    try {
      startLatest = (await this.replaceFromDurableLog(stream, client, { finalize: false })) > 0;
    } catch (err) {
      console.warn(
        `[posthogCode] ${tag}: durable seed failed, replaying the live stream instead: ${err instanceof Error ? err.message : err}`,
      );
    }

    let errorAttempts = 0;
    let emptyReconnects = 0;
    let runComplete = false;
    while (!stream.closed) {
      const before = stream.transcript.length;
      try {
        console.log(
          `[posthogCode] ${tag}: opening SSE stream${stream.lastEventId ? ` (resume ${stream.lastEventId})` : startLatest ? ' (start=latest)' : ''}`,
        );
        const outcome = await this.consumeStream(stream, client, startLatest);
        if (stream.closed) break;
        errorAttempts = 0;
        if (outcome === 'complete') {
          runComplete = true;
          break;
        }
        if (outcome === 'rotated') continue;
        if (stream.transcript.length > before) {
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
        // The live stream is gone (run finished, Redis expired): the durable
        // log is all there is, and if that is empty too, keep what we saw.
        if (msg.includes('Stream not available') || msg.includes('(404)')) {
          console.log(`[posthogCode] ${tag}: live stream unavailable — falling back to session_logs`);
          const entries = await this.replaceFromDurableLog(stream, client, { finalize: true }).catch((backfillErr) => {
            const bMsg = backfillErr instanceof Error ? backfillErr.message : String(backfillErr);
            console.warn(`[posthogCode] ${tag}: durable fallback failed: ${bMsg}`);
            return 0;
          });
          if (entries > 0) {
            this.cleanup(stream);
            return;
          }
          break;
        }
        errorAttempts += 1;
        if (errorAttempts > MAX_RECONNECTS) {
          // Last resort: pull whatever durable log exists so the user
          // isn't left with a blank pane.
          await this.replaceFromDurableLog(stream, client, { finalize: true }).catch((backfillErr) => {
            const bMsg = backfillErr instanceof Error ? backfillErr.message : String(backfillErr);
            console.warn(`[posthogCode] ${tag}: last-resort backfill failed: ${bMsg}`);
          });
          break;
        }
        await delay(RECONNECT_DELAY_MS);
      }
    }

    // The durable log is the record; the live stream was only a slice of it.
    if (runComplete && !stream.closed) {
      const rebuilt = await this.reconcileWithDurableLog(stream, client).catch((err) => {
        console.warn(
          `[posthogCode] ${tag}: durable rebuild failed, keeping the live transcript: ${err instanceof Error ? err.message : err}`,
        );
        return false;
      });
      if (rebuilt) {
        console.log(`[posthogCode] ${tag}: run complete — transcript rebuilt from session_logs (${stream.transcript.length} events)`);
        this.cleanup(stream);
        return;
      }
    }

    // Settle trailing streamed text + any tool calls left without a
    // terminal update (run still in progress / interrupted).
    this.appendEvents(stream, stream.converter.end());
    await this.persist(stream);
    this.cleanup(stream);
  }

  /** Read the SSE body until it closes or the server announces an end. */
  private async consumeStream(
    stream: ActiveStream,
    client: PostHogCodeClient,
    startLatest: boolean,
  ): Promise<StreamOutcome> {
    const res = await client.openRunStream(stream.posthogTaskId, stream.posthogRunId, {
      lastEventId: stream.lastEventId,
      startLatest,
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
    let outcome: StreamOutcome = 'closed';

    try {
      read: for (;;) {
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
          const kind = this.handleFrame(stream, frame);
          if (kind === 'entry') {
            acpEntries += 1;
            if (acpEntries === 1) {
              console.log(`[posthogCode] ${stream.taskId.slice(0, 8)}: first ACP event received`);
            }
          } else if (kind === 'rotated' || kind === 'complete') {
            outcome = kind;
            void reader.cancel().catch(() => undefined);
            break read;
          }
        }
      }
    } finally {
      console.log(
        `[posthogCode] ${stream.taskId.slice(0, 8)}: read loop done — ${frames} frames, ${acpEntries} ACP entries, ${outcome}`,
      );
      reader.releaseLock();
    }
    return outcome;
  }

  /** Classify one frame, appending it to the transcript if it is an ACP entry. */
  private handleFrame(stream: ActiveStream, frame: string): FrameOutcome {
    const { eventName, eventId, data } = parseSseFrame(frame);
    if (!data || eventName === SSE_KEEPALIVE_EVENT) return 'skip';
    if (eventName === SSE_ROTATED_EVENT) return 'rotated';
    if (eventName === SSE_COMPLETE_EVENT) return 'complete';

    let parsed: AcpLogEntry & { error?: string };
    try {
      parsed = JSON.parse(data);
    } catch {
      return 'skip';
    }

    if (eventName === SSE_ERROR_EVENT) {
      throw new StreamError(typeof parsed.error === 'string' ? parsed.error : 'stream error');
    }
    if (parsed.type === 'keepalive') return 'skip';

    if (eventId) {
      // Client-side dedup by Redis stream id. A reconnect resumes via
      // Last-Event-ID, but if PostHog ignores it and replays from the
      // start, skip everything we've already processed — so reconnect-to-
      // tail can't double-emit or grow the transcript unbounded.
      if (stream.lastEventId && !streamIdGreaterThan(eventId, stream.lastEventId)) {
        return 'skip';
      }
      stream.lastEventId = eventId;
    }
    if (!isMessageChunk(parsed)) {
      stream.lastLiveEntryAt = Math.max(stream.lastLiveEntryAt, entryTimestampMs(parsed));
    }
    this.appendEvents(stream, stream.converter.push(parsed));
    return 'entry';
  }

  /** Pages are capped by bytes as well as `limit`, so only `hasMore` ends paging. */
  private async readDurableLog(
    stream: ActiveStream,
    client: PostHogCodeClient,
    opts: { finalize: boolean },
  ): Promise<DurableRead> {
    const converter = new AcpConverter();
    const events: AgentEvent[] = [];
    let entries = 0;
    let lastEntryAt = 0;
    let seq = 0;
    const push = (inputs: AgentEventInput[]) => {
      for (const input of inputs) events.push({ ...input, seq: seq++ } as AgentEvent);
    };
    for (let page = 0; page < SESSION_LOG_MAX_PAGES; page += 1) {
      const result = await client.getSessionLogs(stream.posthogTaskId, stream.posthogRunId, {
        offset: entries,
        limit: SESSION_LOG_PAGE,
      });
      for (const entry of result.entries) {
        lastEntryAt = Math.max(lastEntryAt, entryTimestampMs(entry));
        push(converter.push(entry));
      }
      entries += result.entries.length;
      if (!result.hasMore || result.entries.length === 0) break;
    }
    if (opts.finalize) push(converter.end());
    return { converter, events, entries, lastEntryAt };
  }

  /** An empty log is a run that has not flushed yet: leave the transcript alone. */
  private async replaceFromDurableLog(
    stream: ActiveStream,
    client: PostHogCodeClient,
    opts: { finalize: boolean },
  ): Promise<number> {
    const durable = await this.readDurableLog(stream, client, opts);
    if (durable.entries === 0) return 0;
    await this.replaceTranscript(stream, durable);
    return durable.entries;
  }

  /** The sandbox flushes the log asynchronously: a log behind the stream must not replace it. */
  private async reconcileWithDurableLog(
    stream: ActiveStream,
    client: PostHogCodeClient,
  ): Promise<boolean> {
    const durable = await this.readDurableLog(stream, client, { finalize: true });
    if (durable.entries === 0 || durable.lastEntryAt < stream.lastLiveEntryAt) return false;
    await this.replaceTranscript(stream, durable);
    return true;
  }

  /**
   * The desktop merges `task:event`s by seq, so a transcript restarting at 0
   * needs a reset first, and the reset must follow the persist or a concurrent
   * `GET /tasks/:id` re-merges the old events on top.
   */
  private async replaceTranscript(stream: ActiveStream, durable: DurableRead): Promise<void> {
    if (stream.closed) return;
    stream.converter = durable.converter;
    stream.transcript = durable.events;
    stream.nextSeq = durable.events.length;
    stream.unpersisted = 1;
    await this.persist(stream);
    emitTaskUpdate(stream.workspaceId, stream.taskId, { transcript: [] });
    for (const event of durable.events) emitTaskEvent(stream.workspaceId, stream.taskId, event);
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

/** An entry's `timestamp` as epoch ms, or 0 when it has none we can read. */
function entryTimestampMs(entry: AcpLogEntry): number {
  if (typeof entry.timestamp !== 'string') return 0;
  const ms = Date.parse(entry.timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Chunks never reach the durable log (coalesced, stamped with the first chunk's time). */
function isMessageChunk(entry: AcpLogEntry): boolean {
  if (entry.notification?.method !== 'session/update') return false;
  const update = (entry.notification.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update;
  return update?.sessionUpdate === 'agent_message_chunk';
}

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
