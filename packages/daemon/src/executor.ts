import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { ExecResult } from '@fastowl/shared';

/**
 * Local execution primitives. The daemon is always "on" the machine it
 * serves, so local == native child_process. No ssh2 here —
 * if a user wants a remote machine, they install a daemon there.
 *
 * Sessions are tracked in-memory. On daemon restart, sessions are
 * orphaned; the backend surfaces this as `session.close` via the
 * reconnect-is-a-fresh-state contract.
 */

const streamSessions = new Map<string, ChildProcessWithoutNullStreams>();

/**
 * Extra env vars the WS client asks us to inject into every child we
 * spawn — primarily `FASTOWL_API_URL` pointing at the daemon's local
 * proxy server. We also unset `FASTOWL_AUTH_TOKEN` so the CLI doesn't
 * pick up a stale token from the daemon's shell: auth is supplied
 * entirely by the proxy path.
 */
let childEnvOverrides: Record<string, string | undefined> = {};

export function setChildEnv(overrides: Record<string, string | undefined>): void {
  childEnvOverrides = overrides;
}

function buildChildEnv(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') merged[k] = v;
  }
  for (const [k, v] of Object.entries(childEnvOverrides)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  // Always scrub — children should go through the daemon's proxy, not
  // use any inherited user JWT. The daemon holds a device token on the
  // WS side; that's the only credential that should live on this host.
  delete merged.FASTOWL_AUTH_TOKEN;
  return merged;
}

export interface SessionEvents {
  onData: (sessionId: string, data: Buffer) => void;
  onStderr?: (sessionId: string, data: Buffer) => void;
  onClose: (sessionId: string, exitCode: number) => void;
}

/**
 * Run a one-shot command and buffer its stdout/stderr. Used by
 * gitService and any non-interactive backend flow. `cwd` is optional;
 * missing means the daemon's working directory (usually $HOME).
 */
export async function exec(
  command: string,
  cwd?: string
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', command], {
      cwd,
      env: buildChildEnv(),
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf-8');
    });
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf-8');
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    proc.on('error', (err) => {
      resolve({ stdout, stderr: stderr + (err.message ?? ''), code: -1 });
    });
  });
}

/**
 * Non-PTY streaming spawn. Used by the structured renderer to run
 * `claude -p --output-format stream-json` without TTY-escape
 * contamination in the output. stdin / stdout / stderr are plain
 * pipes; the backend consumes stdout as JSONL and reads stderr as
 * synthetic `system/stderr` events.
 *
 * `initialStdinBase64` (optional): bytes to push onto stdin
 * immediately after spawn — e.g. the seed user message in
 * interactive stream-json mode. `keepStdinOpen: false` closes stdin
 * right after the seed write so the child exits after one turn.
 */
export function streamSpawn(
  sessionId: string,
  binary: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    keepStdinOpen: boolean;
    initialStdinBase64?: string;
  },
  events: SessionEvents
): void {
  if (streamSessions.has(sessionId)) {
    throw new Error(`session ${sessionId} already exists`);
  }

  const childEnv: NodeJS.ProcessEnv = buildChildEnv();
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) childEnv[k] = v;
  }

  const child = spawn(binary, args, {
    cwd: opts.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  streamSessions.set(sessionId, child);

  if (opts.initialStdinBase64) {
    child.stdin.write(Buffer.from(opts.initialStdinBase64, 'base64'));
  }
  if (!opts.keepStdinOpen) {
    child.stdin.end();
  }

  child.stdout.on('data', (b: Buffer) => events.onData(sessionId, b));
  child.stderr.on('data', (b: Buffer) => events.onStderr?.(sessionId, b));
  child.on('exit', (code) => {
    streamSessions.delete(sessionId);
    events.onClose(sessionId, code ?? 0);
  });
  child.on('error', (err) => {
    // Surface spawn errors as an stderr chunk + exit, matching what
    // the backend's in-process handler would see.
    events.onStderr?.(sessionId, Buffer.from(err.message, 'utf-8'));
    streamSessions.delete(sessionId);
    events.onClose(sessionId, 1);
  });
}

/**
 * Half-close stdin for a streaming session. The child finalises in-
 * flight work and exits cleanly (code 0). Use for graceful end of
 * an interactive conversation; use `killSession` for abort.
 */
export function closeStreamInput(sessionId: string): void {
  const child = streamSessions.get(sessionId);
  if (!child || !child.stdin || child.stdin.destroyed) return;
  child.stdin.end();
}

/** Write bytes to a session's stdin. No-op if the session was already killed. */
export function writeSession(sessionId: string, data: Buffer): void {
  const child = streamSessions.get(sessionId);
  if (child && child.stdin && !child.stdin.destroyed) {
    child.stdin.write(data);
  }
}

/** Terminate a session. Emits the matching `session.close` event. */
export function killSession(sessionId: string): void {
  const child = streamSessions.get(sessionId);
  if (!child) return;
  try { child.kill('SIGTERM'); } catch {
    // Already dead.
  }
}

/** For tests + shutdown. */
export function shutdownAllSessions(): void {
  for (const [, child] of streamSessions) {
    try { child.kill('SIGTERM'); } catch {
      // ignore
    }
  }
  streamSessions.clear();
}
