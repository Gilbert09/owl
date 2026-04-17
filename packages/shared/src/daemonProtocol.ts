// Wire protocol between the hosted FastOwl backend and a local
// `@fastowl/daemon` that dials into it. Kept small and hand-rolled —
// no RPC framework — so the daemon binary stays lean and the code is
// easy to inspect.
//
// Model: the daemon opens an outbound WebSocket to `wss://<backend>/daemon-ws`
// with a token (pairing for first-time, device for subsequent). After
// the hello handshake, either side can send:
//   - `request` messages (backend → daemon or daemon → backend, with an id)
//   - `response` messages (reply to a request, matched by id)
//   - `event`    messages (unsolicited, no id)
//
// Framing is `JSON.stringify(envelope) + '\n'` over WS text frames.
// WS already frames for us, but keeping it line-delimited means the
// same protocol works over stdio later if we ever need it (e.g. for
// an embedded test daemon).

// ---------- Handshake ----------

/**
 * First message the daemon sends after the WS opens. Exactly one of
 * `pairingToken` or `deviceToken` must be set — pairing tokens are
 * one-shot and minted by the backend when the env is created; device
 * tokens are long-lived and returned to the daemon on successful pairing.
 */
export interface DaemonHello {
  kind: 'hello';
  /** Set on the daemon's very first connect. One-time use. */
  pairingToken?: string;
  /** Set on every reconnect after pairing. Persisted on the daemon side. */
  deviceToken?: string;
  daemonVersion: string;
  hostOs: 'darwin' | 'linux' | 'win32' | string;
  hostArch: 'x64' | 'arm64' | string;
  hostname: string;
}

/**
 * Backend's response to hello. If pairing succeeded, `deviceToken` is
 * returned exactly once — the daemon writes it to disk and uses it from
 * then on. On failure, the connection is closed with a reason.
 */
export interface DaemonHelloAck {
  kind: 'hello_ack';
  environmentId: string;
  /** Only present on first successful pairing. Store it, don't log it. */
  deviceToken?: string;
}

// ---------- Request/response ----------
//
// Requests flow backend → daemon (commands to execute) and the daemon
// answers. We don't currently have daemon-initiated requests; daemons
// only send events upward.

export type DaemonRequestPayload =
  | ExecRequest
  | SpawnInteractiveRequest
  | WriteSessionRequest
  | KillSessionRequest
  | GitCommandRequest
  | PingRequest;

export interface DaemonRequest {
  kind: 'request';
  id: string;
  payload: DaemonRequestPayload;
}

export interface DaemonResponse {
  kind: 'response';
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ---------- Individual request payloads ----------

export interface ExecRequest {
  op: 'exec';
  command: string;
  cwd?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SpawnInteractiveRequest {
  op: 'spawn_interactive';
  sessionId: string;
  command: string;
  cwd?: string;
  rows?: number;
  cols?: number;
}

export interface WriteSessionRequest {
  op: 'write_session';
  sessionId: string;
  /** base64-encoded bytes to write to the session's stdin. */
  dataBase64: string;
}

export interface KillSessionRequest {
  op: 'kill_session';
  sessionId: string;
}

export interface GitCommandRequest {
  op: 'git';
  /** Matches `gitService` methods so the switch is trivial. */
  method:
    | 'createTaskBranch'
    | 'checkoutBranch'
    | 'getCurrentBranch'
    | 'hasUncommittedChanges'
    | 'stashChanges'
    | 'getDiff'
    | 'deleteBranch';
  args: unknown[];
  cwd?: string;
}

export interface PingRequest {
  op: 'ping';
}

// ---------- Events (daemon → backend) ----------

export type DaemonEventPayload =
  | SessionDataEvent
  | SessionCloseEvent
  | StatusChangeEvent;

export interface DaemonEvent {
  kind: 'event';
  payload: DaemonEventPayload;
}

export interface SessionDataEvent {
  type: 'session.data';
  sessionId: string;
  /** base64-encoded PTY output bytes. */
  dataBase64: string;
}

export interface SessionCloseEvent {
  type: 'session.close';
  sessionId: string;
  exitCode: number;
}

export interface StatusChangeEvent {
  type: 'status';
  status: 'connected' | 'error' | 'disconnected';
  error?: string;
}

// ---------- Envelope (what actually flies over the wire) ----------

export type DaemonMessage =
  | DaemonHello
  | DaemonHelloAck
  | DaemonRequest
  | DaemonResponse
  | DaemonEvent;

export function encodeDaemonMessage(msg: DaemonMessage): string {
  return JSON.stringify(msg);
}

export function decodeDaemonMessage(text: string): DaemonMessage {
  const parsed = JSON.parse(text) as DaemonMessage;
  if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
    throw new Error('Invalid daemon message: missing kind');
  }
  return parsed;
}

// ---------- Close codes ----------
//
// WebSocket close codes 4000-4999 are app-reserved. We use them so the
// daemon can log a clear reason without having to parse a close message.

export const DAEMON_CLOSE_UNAUTHORIZED = 4401;
export const DAEMON_CLOSE_PAIRING_EXPIRED = 4402;
export const DAEMON_CLOSE_DUPLICATE_CONNECTION = 4409;
export const DAEMON_CLOSE_SERVER_SHUTDOWN = 4500;
