import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket as WSSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  encodeDaemonMessage,
  decodeDaemonMessage,
  DAEMON_CLOSE_UNAUTHORIZED,
  type DaemonHello,
  type DaemonMessage,
} from '@fastowl/shared';

// Pin HOME to a tmp dir BEFORE importing the config/ws modules so
// `USER_CONFIG` (captured at module-load time) lands in the sandbox.
const TEST_HOME = path.join(
  os.tmpdir(),
  `fastowl-daemon-ws-test-${randomBytes(4).toString('hex')}`,
);
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
fs.mkdirSync(TEST_HOME, { recursive: true });

const { DaemonWsClient } = await import('../wsClient.js');
const { loadConfig, saveConfig } = await import('../config.js');
const { shutdownAllSessions } = await import('../executor.js');

const FASTOWL_DIR = path.join(TEST_HOME, '.fastowl');

interface FakeBackend {
  url: string;
  wss: WebSocketServer;
  connections: WSSocket[];
  received: DaemonMessage[];
  close: () => Promise<void>;
  waitForNext: (predicate: (m: DaemonMessage) => boolean, ms?: number) => Promise<DaemonMessage>;
}

async function makeBackend(): Promise<FakeBackend> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  const connections: WSSocket[] = [];
  const received: DaemonMessage[] = [];
  const waiters: Array<{
    predicate: (m: DaemonMessage) => boolean;
    resolve: (m: DaemonMessage) => void;
  }> = [];

  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', (raw) => {
      const msg = decodeDaemonMessage(raw.toString());
      received.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    wss,
    connections,
    received,
    waitForNext(predicate, ms = 3000) {
      // Check already-received first so a fast handshake isn't missed.
      for (const msg of received) {
        if (predicate(msg)) return Promise.resolve(msg);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('waitForNext timed out'));
        }, ms);
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of connections) {
          try {
            c.terminate();
          } catch {
            // fine
          }
        }
        wss.close(() => resolve());
      }),
  };
}

function cleanConfig(): void {
  if (fs.existsSync(FASTOWL_DIR)) {
    fs.rmSync(FASTOWL_DIR, { recursive: true, force: true });
  }
}

describe('DaemonWsClient', () => {
  let backend: FakeBackend;
  let client: InstanceType<typeof DaemonWsClient> | null = null;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    cleanConfig();
    backend = await makeBackend();
    // process.exit is called on unauthorized close + after update_daemon.
    // Trap it so test runs aren't killed by a mis-routed exit call.
    // process.exit() fires from WS close-event handlers; throwing
    // inside those bubbles out as an uncaughtException. The mock just
    // records the call and returns; tests assert via exitSpy.mock.calls.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      // swallow
    }) as never);
  });

  afterEach(async () => {
    client?.shutdown();
    client = null;
    shutdownAllSessions();
    await backend.close();
    cleanConfig();
    exitSpy.mockRestore();
  });

  it('sends a hello frame with host metadata after the WS opens', async () => {
    client = new DaemonWsClient({
      backendUrl: backend.url,
      pairingToken: 'pair-first-time',
    });
    await client.start();

    const hello = (await backend.waitForNext((m) => m.kind === 'hello')) as DaemonHello;
    expect(hello.kind).toBe('hello');
    expect(hello.pairingToken).toBe('pair-first-time');
    expect(hello.deviceToken).toBeUndefined();
    expect(hello.daemonVersion).toMatch(/[0-9a-z.+-]+/);
    expect(hello.hostOs).toBe(process.platform);
    expect(hello.hostArch).toBe(process.arch);
    expect(hello.hostname.length).toBeGreaterThan(0);
  });

  it('persists the device token returned in hello_ack and scrubs pairing tokens from the file', async () => {
    // Pre-seed a file so we can observe the overwrite behaviour.
    saveConfig({ backendUrl: backend.url, pairingToken: 'pair-before' });

    client = new DaemonWsClient({
      backendUrl: backend.url,
      pairingToken: 'pair-before',
    });
    await client.start();

    // Wait for hello, then respond with a device token.
    await backend.waitForNext((m) => m.kind === 'hello');
    backend.connections[0].send(
      encodeDaemonMessage({
        kind: 'hello_ack',
        environmentId: 'env-1',
        deviceToken: 'dev-persisted',
      }),
    );

    // hello_ack handling is synchronous after the message event — a
    // microtask tick is enough. Give it a shade more so the fs write
    // lands on slower CI disks.
    await new Promise((r) => setTimeout(r, 50));

    const saved = loadConfig();
    expect(saved?.deviceToken).toBe('dev-persisted');
    expect(saved?.pairingToken).toBeUndefined();
  });

  it('clears a stale pairing-token file when re-pairing with an existing device token', async () => {
    // File-seeded pairing tokens are one-shot: even if the backend
    // reports "already paired" (no new device token in ack), the stale
    // pairing-token field should be cleaned up.
    saveConfig({
      backendUrl: backend.url,
      deviceToken: 'dev-existing',
      pairingToken: 'pair-stale',
    });

    client = new DaemonWsClient({
      backendUrl: backend.url,
      deviceToken: 'dev-existing',
      pairingToken: 'pair-stale',
    });
    await client.start();

    await backend.waitForNext((m) => m.kind === 'hello');
    backend.connections[0].send(
      encodeDaemonMessage({
        kind: 'hello_ack',
        environmentId: 'env-1',
        // No deviceToken — backend is re-ack'ing an existing pairing.
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const saved = loadConfig();
    expect(saved?.pairingToken).toBeUndefined();
    expect(saved?.deviceToken).toBe('dev-existing');
  });

  it('dispatches ping → { pong: true }', async () => {
    client = new DaemonWsClient({ backendUrl: backend.url, pairingToken: 'p' });
    await client.start();
    await backend.waitForNext((m) => m.kind === 'hello');

    backend.connections[0].send(
      encodeDaemonMessage({
        kind: 'request',
        id: 'req-ping',
        payload: { op: 'ping' },
      }),
    );

    const res = (await backend.waitForNext(
      (m) => m.kind === 'response' && m.id === 'req-ping',
    )) as { kind: 'response'; id: string; ok: boolean; data?: unknown; error?: string };
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ pong: true });
  });

  it('dispatches run → returns the ExecResult from the executor', async () => {
    client = new DaemonWsClient({ backendUrl: backend.url, pairingToken: 'p' });
    await client.start();
    await backend.waitForNext((m) => m.kind === 'hello');

    backend.connections[0].send(
      encodeDaemonMessage({
        kind: 'request',
        id: 'req-run',
        payload: {
          op: 'run',
          // `git --version` is on the `run` allowlist, always installed
          // on CI, and deterministic enough to regex-match.
          binary: 'git',
          args: ['--version'],
        },
      }),
    );

    const res = (await backend.waitForNext(
      (m) => m.kind === 'response' && m.id === 'req-run',
      5000,
    )) as { ok: boolean; data: { stdout: string; code: number } };
    expect(res.ok).toBe(true);
    expect(res.data.code).toBe(0);
    expect(res.data.stdout).toMatch(/^git version/);
  });

  it('dispatches run errors with ok=false + error message on bad binary', async () => {
    client = new DaemonWsClient({ backendUrl: backend.url, pairingToken: 'p' });
    await client.start();
    await backend.waitForNext((m) => m.kind === 'hello');

    backend.connections[0].send(
      encodeDaemonMessage({
        kind: 'request',
        id: 'req-bad',
        payload: { op: 'run', binary: 'not-on-allowlist', args: [] },
      }),
    );

    const res = (await backend.waitForNext(
      (m) => m.kind === 'response' && m.id === 'req-bad',
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not in run allowlist/);
  });

  it('dispatches unknown git method with ok=false', async () => {
    client = new DaemonWsClient({ backendUrl: backend.url, pairingToken: 'p' });
    await client.start();
    await backend.waitForNext((m) => m.kind === 'hello');

    backend.connections[0].send(
      encodeDaemonMessage({
        kind: 'request',
        id: 'req-git-bad',
        payload: {
          op: 'git',
          method: 'notARealMethod' as never,
          args: [],
        },
      }),
    );

    const res = (await backend.waitForNext(
      (m) => m.kind === 'response' && m.id === 'req-git-bad',
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown git method/);
  });

  it('rejects inbound proxy_http_request (daemon → backend only)', async () => {
    client = new DaemonWsClient({ backendUrl: backend.url, pairingToken: 'p' });
    await client.start();
    await backend.waitForNext((m) => m.kind === 'hello');

    backend.connections[0].send(
      encodeDaemonMessage({
        kind: 'request',
        id: 'req-proxy',
        payload: {
          op: 'proxy_http_request',
          method: 'GET',
          path: '/',
          headers: {},
          bodyBase64: '',
        },
      }),
    );

    const res = (await backend.waitForNext(
      (m) => m.kind === 'response' && m.id === 'req-proxy',
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/daemon.*backend only/);
  });

  it('closes with DAEMON_CLOSE_UNAUTHORIZED → process.exit(2)', async () => {
    client = new DaemonWsClient({ backendUrl: backend.url, pairingToken: 'bad-token' });
    await client.start();
    await backend.waitForNext((m) => m.kind === 'hello');

    backend.connections[0].close(DAEMON_CLOSE_UNAUTHORIZED, 'unauthorized');
    // The daemon's close handler calls process.exit(2), which our spy
    // translates into a throw. Poll for the exit call.
    const saw = await waitFor(() => exitSpy.mock.calls.some((c) => c[0] === 2), 3000);
    expect(saw).toBe(true);
  });

  it('reconnects after a non-authorization close', async () => {
    client = new DaemonWsClient({ backendUrl: backend.url, pairingToken: 'p' });
    await client.start();
    await backend.waitForNext((m) => m.kind === 'hello');

    // Drop the first connection without the unauthorized code. The
    // daemon should schedule a reconnect (1s backoff on the first try).
    const firstConn = backend.connections[0];
    firstConn.close(1011, 'server restart');

    // Wait for a second hello (from the reconnected socket). Allow
    // generous room for the 1s initial backoff.
    const secondHello = await backend.waitForNext(
      (m) => m.kind === 'hello' && backend.connections.length > 1,
      4000,
    );
    expect(secondHello.kind).toBe('hello');
    expect(backend.connections.length).toBeGreaterThanOrEqual(2);
  });

  it('buffers session events while the WS is down and flushes on reconnect', async () => {
    // flushOutbound fires from handleHelloAck — wire an auto-responder
    // so every fresh hello (initial + reconnect) is ack'd, triggering
    // the queue drain on the second connect.
    backend.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = decodeDaemonMessage(raw.toString());
        if (msg.kind === 'hello') {
          ws.send(
            encodeDaemonMessage({ kind: 'hello_ack', environmentId: 'env-1' }),
          );
        }
      });
    });

    client = new DaemonWsClient({ backendUrl: backend.url, pairingToken: 'p' });
    await client.start();
    await backend.waitForNext((m) => m.kind === 'hello');

    // Spawn an interactive child that holds stdin open, so the session
    // has a live child to write to. Use the WS dispatcher to exercise
    // the real path (request → executor → session registered).
    const NODE = 'node';
    backend.connections[0].send(
      encodeDaemonMessage({
        kind: 'request',
        id: 'req-spawn',
        payload: {
          op: 'stream_spawn',
          sessionId: 'buf-sess',
          binary: NODE,
          args: [
            '-e',
            'process.stdin.on("data",(c)=>process.stdout.write(String(c)));',
          ],
          keepStdinOpen: true,
        },
      }),
    );
    await backend.waitForNext((m) => m.kind === 'response' && m.id === 'req-spawn');

    // Kill the current WS so subsequent session.data events enqueue.
    backend.connections[0].terminate();

    // Now write to the session. The child echoes it back as session.data
    // events — which the daemon is supposed to buffer since the WS is
    // down. We don't actually see them until the next connection opens.
    backend.connections[0].once('close', () => {
      // no-op
    });

    // Send the write via the *new* connection once it arrives.
    // Easier route: directly drive writeSession via the executor, since
    // what we want to assert is the outbound-queue-flush mechanic, not
    // a specific request path.
    const { writeSession } = await import('../executor.js');
    // Wait until the WS is confirmed closed from the client side.
    await waitFor(
      () => (client as unknown as { ws: WSSocket | null }).ws?.readyState !== 1,
      2000,
    );
    writeSession('buf-sess', Buffer.from('buffered'));

    // Now wait for reconnect + the flushed session.data event.
    await backend.waitForNext(
      (m) => m.kind === 'hello' && backend.connections.length > 1,
      4000,
    );
    const dataEvt = await backend.waitForNext(
      (m) =>
        m.kind === 'event' &&
        m.payload.type === 'session.data' &&
        m.payload.sessionId === 'buf-sess',
      4000,
    );
    expect(dataEvt.kind).toBe('event');
    // The echoed bytes survived the disconnect/reconnect cycle.
    if (dataEvt.kind === 'event' && dataEvt.payload.type === 'session.data') {
      const bytes = Buffer.from(dataEvt.payload.dataBase64, 'base64').toString();
      expect(bytes).toBe('buffered');
    }
  });

  it('does NOT buffer response frames (only events)', async () => {
    // Responses are correlated to backend-initiated requests; flushing
    // them after a reconnect would pair the old id with whatever state
    // the backend restarted into. The code's send() drops non-event
    // frames when the WS is down. Assert shutdown() doesn't re-emit.
    client = new DaemonWsClient({ backendUrl: backend.url, pairingToken: 'p' });
    await client.start();
    await backend.waitForNext((m) => m.kind === 'hello');

    // Yank the connection, then shut down the client cleanly. No new
    // connection should happen (shuttingDown = true).
    backend.connections[0].terminate();
    client.shutdown();

    const before = backend.received.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(backend.received.length).toBe(before);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}
