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
  /**
   * Sessions the daemon still has live child processes for. Populated
   * on reconnect so the backend (which may just have restarted) can
   * tell which tasks are actually still running vs genuinely dead.
   * Empty on first-ever connect; usually empty on normal reconnects
   * too (daemon was idle).
   *
   * See services/agent.ts cleanupStaleAgents — without this, backend
   * restart blanket-fails every in-progress task.
   */
  activeSessions?: Array<{
    sessionId: string;
    pid: number;
    /** ms since epoch when the child was spawned. */
    startedAt: number;
  }>;
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
// Requests flow in both directions. backend → daemon for execution
// commands (exec, spawn, git, …). daemon → backend for *proxied* REST
// calls that originated inside a task's child process — see
// `ProxyHttpRequest` below.

export type DaemonRequestPayload =
  | ExecRequest
  | StreamSpawnRequest
  | WriteSessionRequest
  | CloseStreamInputRequest
  | KillSessionRequest
  | GitCommandRequest
  | PingRequest
  | ProxyHttpRequest
  | UpdateDaemonRequest;

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

/**
 * Non-PTY spawn. The daemon runs `binary` with `args` via node's
 * `child_process.spawn` (pipes, not pseudo-TTY) so structured
 * stream-json output isn't contaminated by terminal control
 * sequences. Mirrored event stream: `session.data` on stdout,
 * `session.stderr` on stderr, `session.close` on exit.
 *
 * `keepStdinOpen: true` leaves stdin open after spawn so the backend
 * can send follow-up turns via `write_session`. `false` closes stdin
 * immediately (the daemon writes nothing to it).
 */
export interface StreamSpawnRequest {
  op: 'stream_spawn';
  sessionId: string;
  binary: string;
  args: string[];
  cwd?: string;
  /** Additional env vars merged over the daemon's own environment. */
  env?: Record<string, string>;
  keepStdinOpen: boolean;
  /** Optional seed write — bytes to push to stdin immediately on spawn. */
  initialStdinBase64?: string;
}

/**
 * Half-close the child's stdin. The child finalises any current work
 * and exits gracefully (code 0). Use this for "user ended the
 * conversation" flows; use `kill_session` for hard abort.
 */
export interface CloseStreamInputRequest {
  op: 'close_stream_input';
  sessionId: string;
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

/**
 * Ask the daemon to pull the latest FastOwl source, rebuild, and exit
 * (its OS-level supervisor — systemd on Linux, launchd on macOS —
 * restarts it into the new binary). Supported today only for
 * source-install daemons (the shape `install-daemon.sh` produces);
 * compiled-binary daemons return an error asking the user to re-run
 * the install script manually.
 *
 * Flow on the daemon side:
 *   1. Wait up to `drainTimeoutSeconds` for active sessions to close.
 *   2. Shell out to `git fetch && reset --hard && npm install && build`.
 *   3. Stamp `packages/daemon/version.json` with the new HEAD SHA.
 *   4. Respond `ok` and `process.exit(0)`.
 */
export interface UpdateDaemonRequest {
  op: 'update_daemon';
  /**
   * Seconds to wait for in-flight sessions to drain before forcing
   * through the update. Daemon rejects the request with a
   * "busy" error if the drain times out.
   */
  drainTimeoutSeconds?: number;
}

export interface UpdateDaemonResult {
  /** SHA the daemon is now built from (next restart loads this). */
  newSha: string;
  /** Short summary of what happened — shown verbatim in the desktop toast. */
  message: string;
}

/**
 * Proxied REST call originating inside a task's child process. The daemon
 * runs a tiny HTTP server on localhost; the spawned process talks to
 * that server (via `FASTOWL_API_URL=http://127.0.0.1:<port>`) instead
 * of hitting Railway directly. The daemon wraps the request in this
 * payload and forwards it over its authenticated WS; backend makes the
 * corresponding internal call on behalf of `env.owner_id`.
 *
 * No user JWT ever lives on the VM — the daemon's device token is the
 * only long-lived credential on that side.
 */
export interface ProxyHttpRequest {
  op: 'proxy_http_request';
  method: string;
  /** `/api/v1/tasks?workspaceId=...`. Absolute path, no origin. */
  path: string;
  /** Only request headers worth forwarding (content-type, accept, …).
   *  We deliberately drop hop-by-hop headers on both sides. */
  headers: Record<string, string>;
  /** Base64 body, empty string for no-body requests. */
  bodyBase64: string;
}

export interface ProxyHttpResult {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

// ---------- Events (daemon → backend) ----------

export type DaemonEventPayload =
  | SessionDataEvent
  | SessionStderrEvent
  | SessionCloseEvent
  | StatusChangeEvent;

export interface DaemonEvent {
  kind: 'event';
  payload: DaemonEventPayload;
}

export interface SessionDataEvent {
  type: 'session.data';
  sessionId: string;
  /** base64-encoded stdout bytes (PTY multiplex or non-PTY stdout). */
  dataBase64: string;
}

/**
 * Non-PTY stderr stream. Only emitted by `stream_spawn`-created
 * sessions — PTY sessions multiplex stderr into `session.data`.
 * Backend relays these to the structured renderer as synthetic
 * `system/stderr` events.
 */
export interface SessionStderrEvent {
  type: 'session.stderr';
  sessionId: string;
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
