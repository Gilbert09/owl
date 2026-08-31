import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The streamer resolves its PostHog client via the credentials module;
// mock it so we can feed a scripted SSE body / session-log backfill.
const mockClient = {
  openRunStream: vi.fn(),
  getSessionLogs: vi.fn(),
};
vi.mock('../services/posthogCode/credentials.js', () => ({
  getPostHogCodeClient: vi.fn(async () => mockClient),
}));
// Spied rather than left to broadcast into the void: a rebuilt transcript has
// to be announced with a reset before its events, and only the spies see that.
const { emitTaskEvent, emitTaskUpdate } = vi.hoisted(() => ({
  emitTaskEvent: vi.fn(),
  emitTaskUpdate: vi.fn(),
}));
vi.mock('../services/websocket.js', () => ({ emitTaskEvent, emitTaskUpdate }));

import { eq } from 'drizzle-orm';
import {
  postHogCodeStreamer,
  streamIdGreaterThan,
} from '../services/posthogCode/streamer.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import * as schema from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { AgentEvent } from '@talyn/shared';

const WS = 'ws-1';
const TASK = 'task-1';

/** Build a ReadableStream that emits the given SSE frames then closes. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

/**
 * A stream that emits the given frames then stays open (never closes), so
 * the streamer tails it without hitting its periodic-persist threshold —
 * lets us exercise flushNow() on a live, mid-run stream.
 */
function openSseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      // intentionally no close()
    },
  });
}

/** A minimal `fetch` Response stand-in carrying the scripted SSE body. */
function sseResponse(frames: string[], body = sseStream(frames)): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body,
  };
}

function acpEntry(update: Record<string, unknown>, timestamp?: string) {
  return {
    type: 'notification',
    ...(timestamp ? { timestamp } : {}),
    notification: { method: 'session/update', params: { update } },
  };
}

function acpFrame(update: Record<string, unknown>, id: string, timestamp?: string): string {
  return `id: ${id}\ndata: ${JSON.stringify(acpEntry(update, timestamp))}\n\n`;
}

function message(text: string, timestamp?: string) {
  return acpEntry({ sessionUpdate: 'agent_message', content: { text } }, timestamp);
}

const STREAM_END_FRAME = 'event: stream-end\ndata: {"status":"complete"}\n\n';
const ROTATED_FRAME = 'event: end\ndata: {"type":"rotated"}\n\n';
const KEEPALIVE_FRAME = 'event: keepalive\ndata: {"type":"keepalive"}\n\n';
const STREAM_GONE = new Error('PostHog Code stream open failed (404): Stream not available');

function page(entries: unknown[], hasMore = false) {
  return { entries, hasMore, matchingCount: entries.length };
}

const EMPTY_PAGE = page([]);

async function seedTask(db: Database): Promise<void> {
  await seedUser(db);
  await db.insert(schema.workspaces).values({ id: WS, ownerId: 'user-test', name: 'WS' });
  await db.insert(schema.tasks).values({
    id: TASK,
    workspaceId: WS,
    type: 'code_writing',
    status: 'in_progress',
    title: 'T',
    description: 'D',
  });
}

async function getTranscript(db: Database): Promise<AgentEvent[]> {
  const rows = await db.select({ transcript: schema.tasks.transcript }).from(schema.tasks).where(eq(schema.tasks.id, TASK));
  return (rows[0]?.transcript as AgentEvent[]) ?? [];
}

/** Poll the DB until the persisted transcript is non-empty (or timeout). */
async function waitForTranscript(db: Database, timeoutMs = 2000): Promise<AgentEvent[]> {
  const start = Date.now();
  for (;;) {
    const t = await getTranscript(db);
    if (t.length > 0) return t;
    if (Date.now() - start > timeoutMs) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Poll until the streamer has torn its entry down (the lifecycle ended). */
async function waitForInactive(timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (postHogCodeStreamer.isActive(TASK) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

function texts(transcript: AgentEvent[]): string[] {
  return transcript.map((e) => (e.message as { content: Array<{ text: string }> }).content[0].text);
}

function ensureLive(): void {
  postHogCodeStreamer.ensure({ taskId: TASK, workspaceId: WS, posthogTaskId: 'pt', posthogRunId: 'pr' });
}

describe('postHogCodeStreamer', () => {
  let cleanup: () => Promise<void>;
  let db: Database;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
    mockClient.openRunStream.mockReset();
    mockClient.getSessionLogs.mockReset();
    emitTaskEvent.mockReset();
    emitTaskUpdate.mockReset();
    await seedTask(db);
  });

  afterEach(async () => {
    postHogCodeStreamer.shutdownAll();
    await cleanup();
  });

  it('consumes the SSE stream, persists a transcript, and stamps ordered seqs', async () => {
    // Nothing durable yet, so the attach replays the live stream from the
    // start. The body closes without an announcement; the resume then finds
    // the stream gone, so the lifecycle settles on the (still empty) log.
    mockClient.getSessionLogs.mockResolvedValue(EMPTY_PAGE);
    mockClient.openRunStream
      .mockResolvedValueOnce(
        sseResponse([
          acpFrame({ sessionUpdate: 'agent_message', content: { text: 'Hello' } }, '1-0'),
          acpFrame({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', rawInput: { command: 'ls' } }, '2-0'),
          acpFrame({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: 'a.txt' }, '3-0'),
          KEEPALIVE_FRAME,
        ]) as Response,
      )
      .mockRejectedValue(STREAM_GONE);

    ensureLive();
    const transcript = await waitForTranscript(db);

    // assistant(text) → assistant(tool_use) → user(tool_result), plus the
    // converter's flush of any trailing text (none here).
    expect(transcript.map((e) => e.type)).toEqual(['assistant', 'assistant', 'user']);
    expect(transcript.map((e) => e.seq)).toEqual([0, 1, 2]);

    // tool_use / tool_result pair on the same id so the renderer can collapse them.
    const toolUse = (transcript[1].message as { content: Array<{ id: string }> }).content[0];
    const toolResult = (transcript[2].message as { content: Array<{ tool_use_id: string }> }).content[0];
    expect(toolResult.tool_use_id).toBe(toolUse.id);
    // An empty durable log replays the live stream from the beginning.
    expect(mockClient.openRunStream.mock.calls[0][2]).toMatchObject({ startLatest: false });
  });

  it('is idempotent — a concurrent second ensure does not reopen the stream', async () => {
    mockClient.getSessionLogs.mockResolvedValue(EMPTY_PAGE);
    mockClient.openRunStream
      .mockResolvedValueOnce(
        sseResponse([acpFrame({ sessionUpdate: 'agent_message', content: { text: 'hi' } }, '1-0')]) as Response,
      )
      .mockRejectedValue(STREAM_GONE);

    // The second ensure runs while the first is still active (the stream
    // is registered synchronously), so it must be a no-op. One lifecycle
    // opens the stream once and resumes once (the resume is what 404s); a
    // second lifecycle would double that.
    ensureLive();
    ensureLive();
    await waitForTranscript(db);
    await waitForInactive();

    expect(mockClient.openRunStream).toHaveBeenCalledTimes(2);
  });

  it('falls back to the durable session-log backfill when the live stream is unavailable', async () => {
    mockClient.openRunStream.mockRejectedValue(STREAM_GONE);
    mockClient.getSessionLogs.mockResolvedValue(page([message('from S3')]));

    ensureLive();
    const transcript = await waitForTranscript(db);

    expect(transcript).toHaveLength(1);
    expect(texts(transcript)).toEqual(['from S3']);
  });

  it('seeds from the durable log, then tails the live stream from `latest`', async () => {
    mockClient.getSessionLogs.mockResolvedValue(page([message('seeded', '2026-08-30T10:00:00.000Z')]));
    mockClient.openRunStream.mockResolvedValue(
      sseResponse([], openSseStream([acpFrame({ sessionUpdate: 'agent_message', content: { text: 'live' } }, '5-0')])) as Response,
    );

    ensureLive();
    const seeded = await waitForTranscript(db);
    expect(texts(seeded)).toEqual(['seeded']);

    // The seed covers the history, so the stream must not replay it: the
    // Redis window would start partway through a long run anyway.
    await vi.waitFor(() => expect(mockClient.openRunStream).toHaveBeenCalled());
    expect(mockClient.openRunStream.mock.calls[0][2]).toMatchObject({ startLatest: true, lastEventId: undefined });

    await vi.waitFor(async () => {
      await postHogCodeStreamer.flushNow(TASK);
      expect(texts(await getTranscript(db))).toEqual(['seeded', 'live']);
    });
    expect((await getTranscript(db)).map((e) => e.seq)).toEqual([0, 1]);
  });

  it('flushNow() persists the in-memory transcript of a live stream mid-run', async () => {
    // Two events — inside the time-based persist debounce window, so
    // the stream would not persist on its own within the test's lifetime.
    // The body stays open (in-progress run still tailing).
    mockClient.getSessionLogs.mockResolvedValue(EMPTY_PAGE);
    mockClient.openRunStream.mockResolvedValue(
      sseResponse(
        [],
        openSseStream([
          acpFrame({ sessionUpdate: 'agent_message', content: { text: 'one' } }, '1-0'),
          acpFrame({ sessionUpdate: 'agent_message', content: { text: 'two' } }, '2-0'),
        ]),
      ) as Response,
    );

    ensureLive();

    // The stream never closes, so it won't auto-persist; poll flushNow until
    // the processed events land in the DB (or time out).
    const start = Date.now();
    let transcript = await getTranscript(db);
    while (transcript.length < 2 && Date.now() - start < 2000) {
      await postHogCodeStreamer.flushNow(TASK);
      transcript = await getTranscript(db);
      if (transcript.length < 2) await new Promise((r) => setTimeout(r, 25));
    }

    expect(texts(transcript)).toEqual(['one', 'two']);
  });

  it('flushNow() is a harmless no-op when no stream is active', async () => {
    await expect(postHogCodeStreamer.flushNow('no-such-task')).resolves.toBeUndefined();
  });

  it('debounces persists by time, not event count — a burst above the old 25-event threshold stays buffered', async () => {
    // 30 events in one burst — under the old `PERSIST_EVERY = 25` trigger
    // this would have flushed mid-burst; the debounce must hold them all in
    // memory. The body stays open (live run still tailing).
    const frames = Array.from({ length: 30 }, (_, i) =>
      acpFrame({ sessionUpdate: 'agent_message', content: { text: `e${i}` } }, `${i + 1}-0`),
    );
    mockClient.getSessionLogs.mockResolvedValue(EMPTY_PAGE);
    mockClient.openRunStream.mockResolvedValue(sseResponse([], openSseStream(frames)) as Response);

    ensureLive();

    // Give the read loop time to ingest the whole burst, then prove no
    // count-triggered persist fired.
    await new Promise((r) => setTimeout(r, 300));
    expect(await getTranscript(db)).toHaveLength(0);

    // flushNow drains the buffer — all 30 events were retained in memory.
    await postHogCodeStreamer.flushNow(TASK);
    const transcript = await getTranscript(db);
    expect(transcript).toHaveLength(30);
    expect(transcript.map((e) => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('isActive() reflects the stream lifecycle', async () => {
    mockClient.getSessionLogs.mockResolvedValue(EMPTY_PAGE);
    mockClient.openRunStream.mockResolvedValue(
      sseResponse([], openSseStream([acpFrame({ sessionUpdate: 'agent_message', content: { text: 'hi' } }, '1-0')])) as Response,
    );

    expect(postHogCodeStreamer.isActive(TASK)).toBe(false);
    ensureLive();
    expect(postHogCodeStreamer.isActive(TASK)).toBe(true);
    postHogCodeStreamer.stop(TASK);
    expect(postHogCodeStreamer.isActive(TASK)).toBe(false);
  });

  it('pages the durable log by offset until the server says there is no more', async () => {
    // A page can be shorter than the limit and still not be the last one:
    // the server also caps a page by bytes. Only `hasMore` ends paging.
    mockClient.getSessionLogs
      .mockResolvedValueOnce(page([message('p1'), message('p1b'), message('p1c')], true))
      .mockResolvedValueOnce(page([message('p2')], false));

    postHogCodeStreamer.ensure({ taskId: TASK, workspaceId: WS, posthogTaskId: 'pt', posthogRunId: 'pr', backfillOnly: true });
    const transcript = await waitForTranscript(db);

    expect(mockClient.getSessionLogs).toHaveBeenCalledTimes(2);
    expect(mockClient.getSessionLogs.mock.calls[0][2]).toMatchObject({ offset: 0, limit: 5000 });
    expect(mockClient.getSessionLogs.mock.calls[1][2]).toMatchObject({ offset: 3, limit: 5000 });
    expect(texts(transcript)).toEqual(['p1', 'p1b', 'p1c', 'p2']);
    expect(mockClient.openRunStream).not.toHaveBeenCalled();
  });

  it('a durable page that is empty but claims more ends paging rather than spinning', async () => {
    mockClient.getSessionLogs.mockResolvedValue(page([], true));

    postHogCodeStreamer.ensure({ taskId: TASK, workspaceId: WS, posthogTaskId: 'pt', posthogRunId: 'pr', backfillOnly: true });
    await waitForInactive();

    expect(mockClient.getSessionLogs).toHaveBeenCalledTimes(1);
    expect(await getTranscript(db)).toHaveLength(0);
  });

  it('`stream-end` ends the tail and rebuilds the transcript from the durable log', async () => {
    mockClient.getSessionLogs
      // The seed, before the stream opens.
      .mockResolvedValueOnce(page([message('A', '2026-08-30T10:00:00.000Z')]))
      // The rebuild, once the run is complete: the log has caught up.
      .mockResolvedValueOnce(page([message('A', '2026-08-30T10:00:00.000Z'), message('B', '2026-08-30T10:00:05.000Z')]));
    mockClient.openRunStream.mockResolvedValue(
      sseResponse([
        acpFrame({ sessionUpdate: 'agent_message', content: { text: 'B' } }, '7-0', '2026-08-30T10:00:05.000Z'),
        STREAM_END_FRAME,
      ]) as Response,
    );

    ensureLive();
    await waitForInactive();

    // Complete means complete: no reconnect-to-tail after the announcement.
    expect(mockClient.openRunStream).toHaveBeenCalledTimes(1);
    const transcript = await getTranscript(db);
    expect(texts(transcript)).toEqual(['A', 'B']);
    expect(transcript.map((e) => e.seq)).toEqual([0, 1]);

    // The rebuilt transcript restarts at seq 0, so the desktop (which merges
    // by seq) is told to drop what it has before the events are re-sent.
    const resetIndex = emitTaskUpdate.mock.invocationCallOrder.at(-1)!;
    expect(emitTaskUpdate).toHaveBeenLastCalledWith(WS, TASK, { transcript: [] });
    const reEmitted = emitTaskEvent.mock.calls
      .filter((_, i) => emitTaskEvent.mock.invocationCallOrder[i] > resetIndex)
      .map((c) => (c[2] as AgentEvent).seq);
    expect(reEmitted).toEqual([0, 1]);
  });

  it('keeps the live transcript when the durable log has not caught up at `stream-end`', async () => {
    mockClient.getSessionLogs
      .mockResolvedValueOnce(page([message('A', '2026-08-30T10:00:00.000Z')]))
      // Still only A: the sandbox has not flushed B yet.
      .mockResolvedValueOnce(page([message('A', '2026-08-30T10:00:00.000Z')]));
    mockClient.openRunStream.mockResolvedValue(
      sseResponse([
        acpFrame({ sessionUpdate: 'agent_message', content: { text: 'B' } }, '7-0', '2026-08-30T10:00:05.000Z'),
        STREAM_END_FRAME,
      ]) as Response,
    );

    ensureLive();
    await waitForInactive();

    expect(texts(await getTranscript(db))).toEqual(['A', 'B']);
    // One reset for the seed; a rebuild that did not happen announces nothing.
    expect(emitTaskUpdate).toHaveBeenCalledTimes(1);
  });

  it('a rotated connection resumes at once from Last-Event-ID and never counts as idle', async () => {
    mockClient.getSessionLogs.mockResolvedValue(EMPTY_PAGE);
    mockClient.openRunStream
      .mockResolvedValueOnce(
        sseResponse([acpFrame({ sessionUpdate: 'agent_message', content: { text: 'one' } }, '1-0'), ROTATED_FRAME]) as Response,
      )
      // Five quiet rotations in a row: more than MAX_EMPTY_RECONNECTS, and
      // the tail must survive every one of them.
      .mockResolvedValueOnce(sseResponse([KEEPALIVE_FRAME, ROTATED_FRAME]) as Response)
      .mockResolvedValueOnce(sseResponse([ROTATED_FRAME]) as Response)
      .mockResolvedValueOnce(sseResponse([ROTATED_FRAME]) as Response)
      .mockResolvedValueOnce(sseResponse([ROTATED_FRAME]) as Response)
      .mockResolvedValueOnce(sseResponse([ROTATED_FRAME]) as Response)
      .mockResolvedValueOnce(
        sseResponse([acpFrame({ sessionUpdate: 'agent_message', content: { text: 'two' } }, '9-0'), STREAM_END_FRAME]) as Response,
      );

    ensureLive();
    await waitForInactive();

    expect(mockClient.openRunStream).toHaveBeenCalledTimes(7);
    for (const call of mockClient.openRunStream.mock.calls.slice(1)) {
      expect(call[2]).toMatchObject({ lastEventId: '1-0' });
    }
    expect(texts(await getTranscript(db))).toEqual(['one', 'two']);
  });

  it('a body that closes without an announcement reconnects, then gives up after several quiet reconnects', async () => {
    mockClient.getSessionLogs.mockResolvedValue(EMPTY_PAGE);
    mockClient.openRunStream
      .mockResolvedValueOnce(
        sseResponse([acpFrame({ sessionUpdate: 'agent_message', content: { text: 'one' } }, '1-0')]) as Response,
      )
      .mockResolvedValue(sseResponse([KEEPALIVE_FRAME]) as Response);

    ensureLive();
    await waitForInactive(12_000);

    // One connect with events, then MAX_EMPTY_RECONNECTS quiet ones.
    expect(mockClient.openRunStream).toHaveBeenCalledTimes(5);
    expect(texts(await getTranscript(db))).toEqual(['one']);
  }, 15_000);
});

describe('streamIdGreaterThan', () => {
  it('orders Redis stream ids by ms then seq', () => {
    expect(streamIdGreaterThan('1780316106450-0', '1780316106449-0')).toBe(true);
    expect(streamIdGreaterThan('1780316106450-1', '1780316106450-0')).toBe(true);
    expect(streamIdGreaterThan('1780316106450-0', '1780316106450-0')).toBe(false); // equal → not newer
    expect(streamIdGreaterThan('1780316106449-9', '1780316106450-0')).toBe(false);
  });

  it('falls back to string compare for non-numeric ids', () => {
    expect(streamIdGreaterThan('b', 'a')).toBe(true);
    expect(streamIdGreaterThan('a', 'a')).toBe(false);
  });
});
