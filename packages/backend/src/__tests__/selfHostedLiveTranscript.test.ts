import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FleetClient } from '../services/selfHosted/client.js';
import { toAgentEvent } from '../services/selfHosted/poller.js';

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


/**
 * The fleet's envelope must be unwrapped before it becomes an AgentEvent.
 *
 * The fleet ships `{type, subtype, raw, guestSeq}` where `raw` is the Agent SDK
 * message; AgentEvent carries that message at the TOP level. Spreading the
 * wrapper put `message` one level down under `raw`, and the renderer — which
 * reads `message.content` — found nothing. The transcript was structurally
 * valid, persisted, the right length, and displayed as an empty terminal.
 *
 * Nothing type-checks a jsonb column, so only a test on the shape catches this.
 */
describe('toAgentEvent', () => {
  it('lifts the SDK message to the top level', () => {
    const out = toAgentEvent({
      seq: 3,
      at: '2026-08-03T16:01:20Z',
      event: {
        type: 'assistant',
        guestSeq: 3,
        raw: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
      },
    });
    // The renderer reads exactly this path. Before the fix it was out.raw.message.
    expect(out.message?.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(out.type).toBe('assistant');
    expect(out.seq).toBe(3);
  });

  it('keeps the fleet seq rather than the guest one', () => {
    // The fleet's seq is host-assigned and monotonic across a run; the guest's
    // restarts. Cursor arithmetic depends on using the fleet's.
    const out = toAgentEvent({
      seq: 12,
      at: '',
      event: { type: 'system', guestSeq: 4, raw: { type: 'system', subtype: 'init' } },
    });
    expect(out.seq).toBe(12);
  });

  it('carries a result summary through', () => {
    const out = toAgentEvent({
      seq: 99,
      at: '',
      event: { type: 'result', subtype: 'success', raw: { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 3.83 } },
    });
    expect(out.result).toBe('done');
    expect(out.total_cost_usd).toBe(3.83);
  });

  // An older fleet that does not wrap must still ingest, rather than silently
  // producing entries with nothing in them — the failure this whole test exists
  // to prevent.
  it('passes an unwrapped event through unchanged', () => {
    const out = toAgentEvent({
      seq: 1,
      at: '',
      event: { type: 'assistant', message: { content: [{ type: 'text', text: 'plain' }] } },
    });
    expect(out.message?.content).toEqual([{ type: 'text', text: 'plain' }]);
  });

  // The merged fleet appends synthetic task_started / task_complete markers to
  // the event stream so a reader can attribute it. They carry no `raw` and no
  // SDK message — the poller must ingest them without throwing and keep the
  // fleet seq, and the renderer skips types it does not know.
  it.each([
    ['task_started', { type: 'task_started', taskId: 'task-1' }],
    ['task_complete', { type: 'task_complete', taskId: 'task-1', status: 'completed' }],
  ])('tolerates the host\'s synthetic %s marker', (_label, event) => {
    const out = toAgentEvent({ seq: 7, at: '2026-08-23T10:00:00Z', event });
    expect(out.seq).toBe(7);
    expect(out.type).toBe(event.type);
    expect(out.message).toBeUndefined();
  });
});
