import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { WebSocketServer, WebSocket as WSClient } from 'ws';
import {
  encodeDaemonMessage,
  DAEMON_CLOSE_UNAUTHORIZED,
  type DaemonHello,
  type DaemonMessage,
} from '@fastowl/shared';
import { handleConnection } from '../services/daemonWs.js';
import { daemonRegistry } from '../services/daemonRegistry.js';
import * as proxyHandler from '../services/daemonProxyHandler.js';

/**
 * Stand up a real WebSocketServer on a random port that routes every
 * connection through the handleConnection export. Returns a client
 * factory that yields a ws and buffered messages.
 */
async function makeWsServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server, path: '/daemon-ws' });
  wss.on('connection', (ws) => {
    void handleConnection(ws);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${addr.port}/daemon-ws`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
      }),
  };
}

interface Client {
  ws: WSClient;
  messages: DaemonMessage[];
  closeEvents: Array<{ code: number; reason: string }>;
  waitFor: (pred: (msg: DaemonMessage) => boolean, timeoutMs?: number) => Promise<DaemonMessage>;
  waitClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
  send: (msg: DaemonMessage) => void;
  close: () => Promise<void>;
}

async function openClient(url: string): Promise<Client> {
  const ws = new WSClient(url);
  const messages: DaemonMessage[] = [];
  const closeEvents: Array<{ code: number; reason: string }> = [];
  const listeners: Array<(msg: DaemonMessage) => void> = [];
  const closeListeners: Array<(ev: { code: number; reason: string }) => void> = [];

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as DaemonMessage;
      messages.push(msg);
      for (const l of listeners) l(msg);
    } catch {
      // ignore
    }
  });
  ws.on('close', (code, reasonBuf) => {
    const ev = { code, reason: reasonBuf.toString() };
    closeEvents.push(ev);
    for (const l of closeListeners) l(ev);
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  function waitFor(
    pred: (msg: DaemonMessage) => boolean,
    timeoutMs = 1500
  ): Promise<DaemonMessage> {
    return new Promise((resolve, reject) => {
      const existing = messages.find(pred);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      const listener = (msg: DaemonMessage) => {
        if (pred(msg)) {
          clearTimeout(timer);
          listeners.splice(listeners.indexOf(listener), 1);
          resolve(msg);
        }
      };
      listeners.push(listener);
    });
  }

  function waitClose(timeoutMs = 6500): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      if (closeEvents[0]) return resolve(closeEvents[0]);
      const timer = setTimeout(() => reject(new Error('timeout-waiting-close')), timeoutMs);
      closeListeners.push((ev) => {
        clearTimeout(timer);
        resolve(ev);
      });
    });
  }

  function send(msg: DaemonMessage): void {
    ws.send(encodeDaemonMessage(msg));
  }

  return {
    ws,
    messages,
    closeEvents,
    waitFor,
    waitClose,
    send,
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WSClient.CLOSED) return resolve();
        ws.once('close', () => resolve());
        ws.close();
      }),
  };
}

function hello(overrides: Partial<DaemonHello> = {}): DaemonHello {
  return {
    kind: 'hello',
    daemonVersion: '0.1.0+test',
    hostOs: 'linux',
    hostArch: 'x64',
    hostname: 'test-host',
    pairingToken: 'pair-xyz',
    ...overrides,
  };
}

describe('daemonWs handleConnection', () => {
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const s = await makeWsServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    vi.restoreAllMocks();
  });

  it('closes with 4401 when the daemon does not send hello within the handshake window', async () => {
    const c = await openClient(serverUrl);
    const close = await c.waitClose();
    expect(close.code).toBe(DAEMON_CLOSE_UNAUTHORIZED);
  }, 10_000);

  it('closes with 4401 when the first message is not a hello', async () => {
    vi.spyOn(daemonRegistry, 'authenticate');
    const c = await openClient(serverUrl);
    // Send a response-shaped frame as the FIRST message — not a hello.
    c.send({
      kind: 'response',
      id: 'x',
      ok: true,
      data: {},
    } as unknown as DaemonMessage);
    const close = await c.waitClose();
    expect(close.code).toBe(DAEMON_CLOSE_UNAUTHORIZED);
  });

  it('closes with 4401 when authenticate returns null (bad token)', async () => {
    vi.spyOn(daemonRegistry, 'authenticate').mockResolvedValue(null);
    const c = await openClient(serverUrl);
    c.send(hello());
    const close = await c.waitClose();
    expect(close.code).toBe(DAEMON_CLOSE_UNAUTHORIZED);
  });

  it('sends hello_ack with environmentId + deviceToken on successful pairing', async () => {
    vi.spyOn(daemonRegistry, 'authenticate').mockResolvedValue({
      environmentId: 'env-123',
      newDeviceToken: 'dev-tok-456',
    });
    const registerSpy = vi
      .spyOn(daemonRegistry, 'register')
      .mockImplementation(() => {});

    const c = await openClient(serverUrl);
    c.send(hello({ pairingToken: 'pair-xyz' }));

    const ack = (await c.waitFor((m) => m.kind === 'hello_ack')) as {
      kind: 'hello_ack';
      environmentId: string;
      deviceToken?: string;
    };
    expect(ack.environmentId).toBe('env-123');
    expect(ack.deviceToken).toBe('dev-tok-456');
    expect(registerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'env-123',
        meta: expect.objectContaining({
          hostname: 'test-host',
          daemonVersion: '0.1.0+test',
        }),
      })
    );
    await c.close();
  });

  it('also works with a reconnecting deviceToken (no new token issued)', async () => {
    vi.spyOn(daemonRegistry, 'authenticate').mockResolvedValue({
      environmentId: 'env-456',
      // No newDeviceToken on reconnect.
    });
    vi.spyOn(daemonRegistry, 'register').mockImplementation(() => {});

    const c = await openClient(serverUrl);
    c.send(hello({ pairingToken: undefined, deviceToken: 'dev-tok' }));

    const ack = (await c.waitFor((m) => m.kind === 'hello_ack')) as {
      kind: 'hello_ack';
      environmentId: string;
      deviceToken?: string;
    };
    expect(ack.environmentId).toBe('env-456');
    expect(ack.deviceToken).toBeUndefined();
    await c.close();
  });

  it('forwards daemon→backend `response` messages to the registry', async () => {
    vi.spyOn(daemonRegistry, 'authenticate').mockResolvedValue({
      environmentId: 'env-1',
    });
    vi.spyOn(daemonRegistry, 'register').mockImplementation(() => {});
    const resolveSpy = vi
      .spyOn(daemonRegistry, 'resolveResponse')
      .mockImplementation(() => {});

    const c = await openClient(serverUrl);
    c.send(hello());
    await c.waitFor((m) => m.kind === 'hello_ack');

    c.send({
      kind: 'response',
      id: 'req-1',
      ok: true,
      data: { foo: 1 },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(resolveSpy).toHaveBeenCalledWith('req-1', true, { foo: 1 }, undefined);
    await c.close();
  });

  it('forwards `event` frames to daemonRegistry.handleEvent with the env id', async () => {
    vi.spyOn(daemonRegistry, 'authenticate').mockResolvedValue({
      environmentId: 'env-evt',
    });
    vi.spyOn(daemonRegistry, 'register').mockImplementation(() => {});
    const handleEvt = vi
      .spyOn(daemonRegistry, 'handleEvent')
      .mockImplementation(() => {});

    const c = await openClient(serverUrl);
    c.send(hello());
    await c.waitFor((m) => m.kind === 'hello_ack');

    c.send({
      kind: 'event',
      payload: {
        type: 'session.close',
        sessionId: 'sess-1',
        exitCode: 0,
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(handleEvt).toHaveBeenCalledWith('env-evt', expect.objectContaining({
      type: 'session.close',
      sessionId: 'sess-1',
      exitCode: 0,
    }));
    await c.close();
  });

  it('dispatches proxy_http_request daemon→backend requests and replies with the result', async () => {
    vi.spyOn(daemonRegistry, 'authenticate').mockResolvedValue({
      environmentId: 'env-proxy',
    });
    vi.spyOn(daemonRegistry, 'register').mockImplementation(() => {});
    const proxySpy = vi
      .spyOn(proxyHandler, 'handleProxyHttpRequest')
      .mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(JSON.stringify({ ok: true }), 'utf-8').toString('base64'),
      });

    const c = await openClient(serverUrl);
    c.send(hello());
    await c.waitFor((m) => m.kind === 'hello_ack');

    c.send({
      kind: 'request',
      id: 'req-proxy',
      payload: {
        op: 'proxy_http_request',
        method: 'GET',
        path: '/api/v1/tasks',
        headers: {},
        bodyBase64: '',
      },
    });

    const resp = (await c.waitFor((m) => m.kind === 'response' && (m as { id?: string }).id === 'req-proxy')) as {
      kind: 'response';
      id: string;
      ok: boolean;
      data?: unknown;
    };
    expect(resp.ok).toBe(true);
    expect(proxySpy).toHaveBeenCalledWith('env-proxy', expect.objectContaining({
      op: 'proxy_http_request',
      path: '/api/v1/tasks',
    }));
    await c.close();
  });

  it('replies "not supported" to an unknown daemon→backend op', async () => {
    vi.spyOn(daemonRegistry, 'authenticate').mockResolvedValue({
      environmentId: 'env-unsup',
    });
    vi.spyOn(daemonRegistry, 'register').mockImplementation(() => {});

    const c = await openClient(serverUrl);
    c.send(hello());
    await c.waitFor((m) => m.kind === 'hello_ack');

    c.send({
      kind: 'request',
      id: 'req-99',
      payload: { op: 'ping' }, // valid backend→daemon op, but not daemon→backend
    });

    const resp = (await c.waitFor(
      (m) => m.kind === 'response' && (m as { id?: string }).id === 'req-99'
    )) as { kind: 'response'; ok: boolean; error?: string };
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/not supported/i);
    await c.close();
  });

  it('unregisters the env on close after pairing', async () => {
    vi.spyOn(daemonRegistry, 'authenticate').mockResolvedValue({
      environmentId: 'env-close',
    });
    vi.spyOn(daemonRegistry, 'register').mockImplementation(() => {});
    const unregisterSpy = vi
      .spyOn(daemonRegistry, 'unregister')
      .mockImplementation(() => {});

    const c = await openClient(serverUrl);
    c.send(hello());
    await c.waitFor((m) => m.kind === 'hello_ack');
    await c.close();
    // Give the server a beat to notice.
    await new Promise((r) => setTimeout(r, 100));

    expect(unregisterSpy).toHaveBeenCalledWith('env-close');
  });

  it('ignores malformed JSON from the daemon without crashing', async () => {
    vi.spyOn(daemonRegistry, 'authenticate').mockResolvedValue({
      environmentId: 'env-bad',
    });
    vi.spyOn(daemonRegistry, 'register').mockImplementation(() => {});

    const c = await openClient(serverUrl);
    // Bypass encodeDaemonMessage — send raw garbage.
    c.ws.send('not valid json');
    // No close should happen immediately; the server should stay up
    // and still be waiting for a hello.
    await new Promise((r) => setTimeout(r, 100));
    expect(c.closeEvents).toEqual([]);
    // And we can still complete the handshake after the garbage.
    c.send(hello());
    const ack = await c.waitFor((m) => m.kind === 'hello_ack');
    expect((ack as { kind: string }).kind).toBe('hello_ack');
    await c.close();
  });
});
