import os from 'os';
import WebSocket from 'ws';
import {
  encodeDaemonMessage,
  decodeDaemonMessage,
  type DaemonHello,
  type DaemonHelloAck,
  type DaemonMessage,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonEventPayload,
  DAEMON_CLOSE_UNAUTHORIZED,
} from '@fastowl/shared';
import { exec, spawnInteractive, writeSession, killSession } from './executor.js';
import { gitDispatch } from './git.js';
import { saveConfig, loadConfig, type ResolvedConfig } from './config.js';

const DAEMON_VERSION = '0.1.0';
const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;

/**
 * Long-lived WebSocket client that dials the FastOwl backend, handshakes,
 * and handles inbound requests. Sends unsolicited `session.data` and
 * `session.close` events back up.
 *
 * Reconnects with exponential backoff. On reconnect, already-running
 * sessions are *not* re-advertised — the backend treats them as
 * orphaned (a fresh agent is spawned for any in-flight task).
 */
export class DaemonWsClient {
  private ws: WebSocket | null = null;
  private reconnectMs = INITIAL_RECONNECT_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(private config: ResolvedConfig) {}

  start(): void {
    this.connect();
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect(): void {
    if (this.shuttingDown) return;

    const url = toWsUrl(this.config.backendUrl) + '/daemon-ws';
    // Send the token in the URL so the backend can authorize before
    // accepting the upgrade. The hello message then confirms identity
    // and swaps pairing → device token if needed.
    const token = this.config.deviceToken ?? this.config.pairingToken;
    if (!token) {
      console.error('daemon: no token configured; aborting');
      process.exit(1);
    }
    const withToken = `${url}?token=${encodeURIComponent(token)}`;

    console.log(`daemon: connecting to ${url}`);
    const ws = new WebSocket(withToken);
    this.ws = ws;

    ws.on('open', () => {
      console.log('daemon: ws open, sending hello');
      this.reconnectMs = INITIAL_RECONNECT_MS;
      const hello: DaemonHello = {
        kind: 'hello',
        pairingToken: this.config.pairingToken,
        deviceToken: this.config.deviceToken,
        daemonVersion: DAEMON_VERSION,
        hostOs: os.platform(),
        hostArch: os.arch(),
        hostname: os.hostname(),
      };
      ws.send(encodeDaemonMessage(hello));
    });

    ws.on('message', (raw) => {
      let msg: DaemonMessage;
      try {
        msg = decodeDaemonMessage(raw.toString());
      } catch (err) {
        console.error('daemon: bad message from server:', err);
        return;
      }
      void this.handleMessage(msg);
    });

    ws.on('close', (code, reason) => {
      console.log(`daemon: ws closed code=${code} reason=${reason}`);
      this.ws = null;
      if (code === DAEMON_CLOSE_UNAUTHORIZED) {
        console.error('daemon: unauthorized — clearing device token and aborting');
        // Don't reconnect on auth failure. Operator should `fastowl-daemon`
        // with a fresh --pairing-token.
        process.exit(2);
      }
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('daemon: ws error:', err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
    console.log(`daemon: reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private async handleMessage(msg: DaemonMessage): Promise<void> {
    switch (msg.kind) {
      case 'hello_ack':
        this.handleHelloAck(msg);
        return;
      case 'request':
        await this.handleRequest(msg);
        return;
      case 'response':
        // Daemon only receives responses to requests it sent. We don't
        // currently send any; ignore for now.
        return;
      case 'event':
        // Backend doesn't push events to daemon; ignore for forward-compat.
        return;
      case 'hello':
        // Would be strange — servers don't hello us. Ignore.
        return;
    }
  }

  private handleHelloAck(ack: DaemonHelloAck): void {
    console.log(`daemon: paired with environmentId=${ack.environmentId}`);
    // On first successful pairing, the backend returns a long-lived
    // device token. Persist it so subsequent boots skip the pairing step.
    if (ack.deviceToken && ack.deviceToken !== this.config.deviceToken) {
      const existing = loadConfig();
      saveConfig({
        backendUrl: this.config.backendUrl,
        ...existing,
        deviceToken: ack.deviceToken,
      });
      this.config = { ...this.config, deviceToken: ack.deviceToken, pairingToken: undefined };
    }
  }

  private async handleRequest(req: DaemonRequest): Promise<void> {
    let response: DaemonResponse;
    try {
      const data = await this.dispatch(req);
      response = { kind: 'response', id: req.id, ok: true, data };
    } catch (err) {
      response = {
        kind: 'response',
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.send(response);
  }

  private async dispatch(req: DaemonRequest): Promise<unknown> {
    const p = req.payload;
    switch (p.op) {
      case 'ping':
        return { pong: true };
      case 'exec':
        return exec(p.command, p.cwd);
      case 'spawn_interactive':
        spawnInteractive(
          p.sessionId,
          p.command,
          { cwd: p.cwd, rows: p.rows, cols: p.cols },
          {
            onData: (sessionId, data) =>
              this.emit({
                type: 'session.data',
                sessionId,
                dataBase64: data.toString('base64'),
              }),
            onClose: (sessionId, exitCode) =>
              this.emit({
                type: 'session.close',
                sessionId,
                exitCode,
              }),
          }
        );
        return { started: true };
      case 'write_session':
        writeSession(p.sessionId, Buffer.from(p.dataBase64, 'base64'));
        return { written: true };
      case 'kill_session':
        killSession(p.sessionId);
        return { killed: true };
      case 'git': {
        const handler = gitDispatch[p.method];
        if (!handler) throw new Error(`unknown git method: ${p.method}`);
        return handler(p.args, p.cwd);
      }
    }
  }

  private emit(payload: DaemonEventPayload): void {
    this.send({ kind: 'event', payload });
  }

  private send(msg: DaemonMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeDaemonMessage(msg));
  }
}

function toWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return 'wss://' + httpUrl.slice('https://'.length);
  if (httpUrl.startsWith('http://')) return 'ws://' + httpUrl.slice('http://'.length);
  return httpUrl;
}
