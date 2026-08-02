import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FleetClient } from '../services/selfHosted/client.js';

/**
 * The live transcript stream.
 *
 * The fleet's cursor poll is correct but its latency is the caller's poll
 * interval — 10s — which is what an agent's output arriving in ten-second
 * bursts looks like to somebody watching a task. The follow endpoint pushes
 * instead.
 *
 * Both run at once, deliberately: the stream is an optimisation and the poll is
 * still what finalises the task. That only works because the fleet's `seq` is
 * authoritative, so whichever path sees an event first wins and the other drops
 * it. The de-duplication is the thing worth testing — without it the desktop
 * gets every event twice.
 */
describe('FleetClient.followEvents', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  /** Serve a canned SSE body, one chunk per array entry. */
  function serveSSE(chunks: string[], ok = true): void {
    globalThis.fetch = vi.fn(async () => {
      if (!ok) {
        return { ok: false, status: 503, statusText: 'Service Unavailable', body: null } as Response;
      }
      const encoder = new TextEncoder();
      let i = 0;
      const body = {
        getReader() {
          return {
            async read() {
              if (i >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: encoder.encode(chunks[i++]!) };
            },
            async cancel() {},
          };
        },
      };
      return { ok: true, status: 200, statusText: 'OK', body } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  function frame(events: { seq: number }[], terminal = false): string {
    return `data: ${JSON.stringify({ events: events.map((e) => ({ ...e, at: '', event: {} })), cursor: events.at(-1)?.seq ?? 0, terminal })}\n\n`;
  }

  it('yields each frame as it arrives', async () => {
    serveSSE([frame([{ seq: 1 }]), frame([{ seq: 2 }, { seq: 3 }])]);
    const client = new FleetClient('http://fleet', 'tok');

    const seen: number[] = [];
    for await (const f of client.followEvents('r1', 0, new AbortController().signal)) {
      for (const e of f.events) seen.push(e.seq);
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it('handles a frame split across chunk boundaries', async () => {
    // A TCP read boundary lands wherever it lands. Buffering has to survive one
    // arriving mid-JSON, or a long transcript loses whichever events straddle
    // a chunk — intermittently, and only under load.
    const whole = frame([{ seq: 1 }, { seq: 2 }]);
    serveSSE([whole.slice(0, 12), whole.slice(12, 30), whole.slice(30)]);
    const client = new FleetClient('http://fleet', 'tok');

    const seen: number[] = [];
    for await (const f of client.followEvents('r1', 0, new AbortController().signal)) {
      for (const e of f.events) seen.push(e.seq);
    }
    expect(seen).toEqual([1, 2]);
  });

  it('skips ping comments without treating them as data', async () => {
    serveSSE([': ping\n\n', frame([{ seq: 1 }]), ': ping\n\n', frame([{ seq: 2 }])]);
    const client = new FleetClient('http://fleet', 'tok');

    const seen: number[] = [];
    for await (const f of client.followEvents('r1', 0, new AbortController().signal)) {
      for (const e of f.events) seen.push(e.seq);
    }
    // The server sends these through idle gaps so a proxy does not reap the
    // connection; parsing one as a frame would throw on every quiet minute.
    expect(seen).toEqual([1, 2]);
  });

  it('survives a malformed frame rather than killing the stream', async () => {
    serveSSE([frame([{ seq: 1 }]), 'data: {not json\n\n', frame([{ seq: 2 }])]);
    const client = new FleetClient('http://fleet', 'tok');

    const seen: number[] = [];
    for await (const f of client.followEvents('r1', 0, new AbortController().signal)) {
      for (const e of f.events) seen.push(e.seq);
    }
    // The poll underneath holds the same cursor and will re-fetch whatever the
    // bad frame contained, so dying here would trade a recoverable gap for a
    // stalled transcript.
    expect(seen).toEqual([1, 2]);
  });

  it('throws on a non-OK response so the caller can fall back to polling', async () => {
    serveSSE([], false);
    const client = new FleetClient('http://fleet', 'tok');
    await expect(async () => {
      for await (const _ of client.followEvents('r1', 0, new AbortController().signal)) {
        // no frames expected
      }
    }).rejects.toThrow(/503/);
  });

  it('resumes from the cursor it is given', async () => {
    serveSSE([frame([{ seq: 51 }])]);
    const client = new FleetClient('http://fleet', 'tok');
    for await (const _ of client.followEvents('r1', 50, new AbortController().signal)) break;

    const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    // A reconnect that restarted at 0 would replay the whole transcript into
    // the desktop, which is worse than the gap it was trying to close.
    expect(url).toContain('after=50');
    expect(url).toContain('follow=1');
  });
});

describe('poller de-duplication', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('emits an event once when the poll and the stream both deliver it', async () => {
    const emitted: unknown[] = [];
    vi.doMock('../services/websocket.js', () => ({
      emitTaskEvent: (_ws: string, _id: string, ev: unknown) => emitted.push(ev),
      emitTaskStatus: () => {},
      emitTaskUpdate: () => {},
    }));

    const { selfHostedPoller } = await import('../services/selfHosted/poller.js');
    // `ingest` is the shared path both the poll and the stream go through; the
    // whole safety of running them together rests on it.
    const ingest = (
      selfHostedPoller as unknown as {
        ingest: (row: { id: string; workspaceId: string }, events: unknown[]) => void;
      }
    ).ingest.bind(selfHostedPoller);

    const row = { id: 'task-1', workspaceId: 'ws1' };
    const events = [
      { seq: 1, at: '', event: { type: 'assistant' } },
      { seq: 2, at: '', event: { type: 'assistant' } },
    ];

    ingest(row, events); // the stream got there first
    ingest(row, events); // the poll re-fetches the same range

    expect(emitted).toHaveLength(2);

    // And a later event still gets through — a de-dupe that also blocks
    // progress would be worse than the double-emit it prevents.
    ingest(row, [{ seq: 3, at: '', event: { type: 'assistant' } }]);
    expect(emitted).toHaveLength(3);

    selfHostedPoller.stopStreaming('task-1');
  });
});
