import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureApiClient, wsClient } from '@talyn/client';

/**
 * WebSocket heartbeat / zombie detection.
 *
 * The original check was TICK-based: "a heartbeat tick fired while a ping was
 * still outstanding" was treated as proof the socket was dead. That silently
 * assumes one tick means ~25s elapsed, which holds in an Electron renderer and
 * NOT in a browser tab — background timers are clamped to roughly once a
 * minute and frozen outright for a bfcached page. Coming back to a
 * backgrounded tab therefore killed a perfectly healthy socket and started
 * reconnect churn, which is what showed up as WebSocket noise in the console
 * on app.talyn.dev.
 *
 * The fix judges by wall clock and ignores ticks that arrive suspiciously
 * late, because such a tick is evidence about the TIMER, not the socket.
 */

const HEARTBEAT = 25_000;

class FakeWebSocket {
  // All four constants matter. connect() guards with
  // `this.ws?.readyState === WebSocket.CONNECTING`, and with `ws` still null
  // that reads `undefined === undefined` if CONNECTING is missing — so the
  // stub silently made connect() a no-op.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  /** Server answering our ping. */
  pong() {
    this.onmessage?.({
      data: JSON.stringify({ type: 'connection:status', payload: { pong: true } }),
    });
  }
  pings() {
    return this.sent.filter((s) => s.includes('"ping"')).length;
  }
}

async function connect() {
  FakeWebSocket.instances = [];
  await wsClient.connect();
  const ws = FakeWebSocket.instances[0];
  ws.onopen?.();
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  configureApiClient({
    baseUrl: 'http://localhost:4747',
    clientVersion: 'web/test',
    getAccessToken: async () => 'token',
    recoverSession: async () => false,
  });
});

afterEach(() => {
  wsClient.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('heartbeat', () => {
  it('pings on each interval and stays open while ponged', async () => {
    const ws = await connect();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT);
      ws.pong();
    }
    expect(ws.pings()).toBe(4);
    expect(ws.closed).toBe(false);
  });

  it('closes a socket that genuinely stops answering', async () => {
    const ws = await connect();
    await vi.advanceTimersByTimeAsync(HEARTBEAT); // ping, no pong
    expect(ws.closed).toBe(false); // still inside the grace window
    await vi.advanceTimersByTimeAsync(HEARTBEAT); // pong now overdue
    expect(ws.closed).toBe(true);
  });

  /**
   * Freeze the timer the way a hidden tab does: wall-clock time passes while
   * NO tick fires. advanceTimersByTime is the wrong tool — it delivers every
   * scheduled tick on time, which is the opposite of throttling.
   */
  const freezeTimerFor = async (ms: number) => {
    vi.setSystemTime(new Date(Date.now() + ms));
    await vi.advanceTimersByTimeAsync(HEARTBEAT); // the one late tick
  };

  // THE REGRESSION. Under the old tick-based check, that single late tick was
  // read as "a tick fired while a ping was outstanding" and closed a socket
  // the server was perfectly happy with.
  it('does NOT close on a late tick after the timer was frozen', async () => {
    const ws = await connect();
    await vi.advanceTimersByTimeAsync(HEARTBEAT); // ping sent, no pong yet
    await freezeTimerFor(5 * 60_000);
    expect(ws.closed).toBe(false);
    // It re-pinged rather than judging on the stale flag; answering keeps it up.
    ws.pong();
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    ws.pong();
    expect(ws.closed).toBe(false);
  });

  it('still detects a dead socket after a frozen gap', async () => {
    const ws = await connect();
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    await freezeTimerFor(5 * 60_000); // re-pings, does not judge
    expect(ws.closed).toBe(false);
    // Ticks are normal again and nothing answers: it must give up.
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(ws.closed).toBe(true);
  });
});
