import type { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import {
  decodeDaemonMessage,
  encodeDaemonMessage,
  type DaemonHello,
  type DaemonHelloAck,
  type DaemonMessage,
  type DaemonResponse,
  DAEMON_CLOSE_UNAUTHORIZED,
} from '@fastowl/shared';
import { daemonRegistry } from './daemonRegistry.js';
import { handleProxyHttpRequest } from './daemonProxyHandler.js';

/**
 * Wire the `/daemon-ws` endpoint onto an existing WebSocketServer. A
 * single upgrade path on the same HTTP server as the user-facing `/ws`
 * keeps deploy footprints small (one port, one TLS terminator).
 *
 * Flow:
 *   1. Daemon dials `/daemon-ws` anonymously (no URL token — tokens
 *      would leak into access logs).
 *   2. Daemon sends a `hello` message carrying the pairing or device
 *      token. Must arrive within the handshake window or we close.
 *   3. Backend authenticates via daemonRegistry.authenticate().
 *      - Bad token → close with 4401.
 *      - Good pairing → issue device token in hello_ack, save hash.
 *      - Good device token → hello_ack with the existing env id.
 *   4. Backend registers the WS and forwards subsequent messages.
 */
export function registerDaemonWs(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage, path?: string) => {
    // The user-facing `/ws` handler runs on the same server; we only
    // take over connections upgraded to `/daemon-ws`. The path arg is
    // passed by routers like `setupWebSocket` that split by path; if
    // the caller didn't pass it, fall back to parsing the URL.
    const effectivePath = path ?? new URL(req.url ?? '/', 'http://localhost').pathname;
    if (effectivePath !== '/daemon-ws') return;
    void handleConnection(ws);
  });
}

/**
 * Exported separately so the HTTP server can dispatch at upgrade time
 * instead of layering two `connection` handlers on one WSS. See
 * `src/index.ts` — we create two WSS instances and route by path.
 */
export async function handleConnection(ws: WebSocket): Promise<void> {
  let environmentId: string | null = null;
  let handshakeTimer: NodeJS.Timeout | null = setTimeout(() => {
    // Daemons must send `hello` within 5 seconds of connecting.
    console.warn('daemon-ws: hello timeout; closing');
    ws.close(DAEMON_CLOSE_UNAUTHORIZED, 'hello timeout');
  }, 5_000);

  ws.on('message', async (raw) => {
    let msg: DaemonMessage;
    try {
      msg = decodeDaemonMessage(raw.toString());
    } catch (err) {
      console.error('daemon-ws: bad message:', err);
      return;
    }

    if (!environmentId) {
      if (msg.kind !== 'hello') {
        ws.close(DAEMON_CLOSE_UNAUTHORIZED, 'expected hello');
        return;
      }
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      const result = await daemonRegistry.authenticate({
        pairingToken: msg.pairingToken,
        deviceToken: msg.deviceToken,
      });
      if (!result) {
        ws.close(DAEMON_CLOSE_UNAUTHORIZED, 'invalid token');
        return;
      }
      environmentId = result.environmentId;
      daemonRegistry.register({
        environmentId,
        ws,
        meta: {
          os: msg.hostOs,
          arch: msg.hostArch,
          hostname: msg.hostname,
          daemonVersion: msg.daemonVersion,
        },
        liveSessionIds: new Set(
          (msg.activeSessions ?? []).map((s) => s.sessionId),
        ),
      });
      const ack: DaemonHelloAck = {
        kind: 'hello_ack',
        environmentId,
        deviceToken: result.newDeviceToken,
      };
      ws.send(encodeDaemonMessage(ack));
      console.log(`daemon-ws: paired env=${environmentId} host=${msg.hostname}`);
      return;
    }

    // After handshake: route responses + events into the registry.
    switch (msg.kind) {
      case 'response':
        daemonRegistry.resolveResponse(msg.id, msg.ok, msg.data, msg.error);
        break;
      case 'event':
        daemonRegistry.handleEvent(environmentId, msg.payload);
        break;
      case 'request': {
        // Daemon → backend requests are today only the proxy path —
        // child processes on the VM making REST calls that we re-issue
        // as authenticated localhost fetches. Extend this switch if/when
        // we add other daemon-initiated operations.
        const envId = environmentId; // TS narrowing
        void dispatchDaemonRequest(ws, envId, msg);
        break;
      }
      default:
        // hello / hello_ack post-handshake is invalid; ignore.
        break;
    }
  });

  ws.on('close', () => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    if (environmentId) {
      console.log(`daemon-ws: env=${environmentId} disconnected`);
      daemonRegistry.unregister(environmentId);
    }
  });

  ws.on('error', (err) => {
    console.error('daemon-ws error:', err);
  });
}

/**
 * Avoid the unused-import noise when we only re-export types.
 */
export type { DaemonHello };

/**
 * Dispatch a daemon-initiated request. Today the only kind is the
 * HTTP proxy; anything else returns a `not implemented` response so
 * the daemon doesn't hang on a missing handler.
 */
async function dispatchDaemonRequest(
  ws: WebSocket,
  environmentId: string,
  req: Extract<DaemonMessage, { kind: 'request' }>
): Promise<void> {
  let response: DaemonResponse;
  try {
    if (req.payload.op === 'proxy_http_request') {
      const result = await handleProxyHttpRequest(environmentId, req.payload);
      response = { kind: 'response', id: req.id, ok: true, data: result };
    } else {
      response = {
        kind: 'response',
        id: req.id,
        ok: false,
        error: `daemon→backend op not supported: ${req.payload.op}`,
      };
    }
  } catch (err) {
    response = {
      kind: 'response',
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    ws.send(encodeDaemonMessage(response));
  } catch (err) {
    console.error('daemon-ws: failed to send response:', err);
  }
}
