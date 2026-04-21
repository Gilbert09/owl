import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'node:path';
import type { ExecResult } from '@fastowl/shared';

/**
 * Normalize + sanity-check a caller-supplied cwd. The daemon trusts the
 * paired backend, but cwd values thread through `spawn()` which inherits
 * the daemon's privileges, so obvious misuse (traversal residue, leading
 * `-`, NUL, CR/LF) is rejected at the boundary. `undefined` is allowed —
 * it means "use daemon's default cwd" (usually $HOME).
 */
function assertSafeCwd(cwd: string | undefined): void {
  if (cwd === undefined) return;
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cwd must be a non-empty string when provided');
  }
  if (cwd.includes('\0') || cwd.includes('\n') || cwd.includes('\r')) {
    throw new Error('cwd must not contain control characters');
  }
  if (cwd.startsWith('-')) {
    throw new Error('cwd must not start with "-"');
  }
  const normalized = path.normalize(cwd);
  if (!path.isAbsolute(normalized)) {
    throw new Error('cwd must be absolute');
  }
  if (normalized.split(path.sep).includes('..')) {
    throw new Error('cwd must not contain traversal segments');
  }
}

/**
 * Binaries the backend is allowed to spawn via stream_spawn. This is a
 * defense-in-depth allowlist; the daemon already only accepts commands
 * from the paired backend. Bare names only — no paths. Binaries are
 * looked up on $PATH by spawn().
 */
const ALLOWED_STREAM_BINARIES = new Set<string>([
  'claude',
  'bash',
  'sh',
  'node',
  'npm',
  'npx',
  'python3',
  'python',
  'git',
  'fastowl',
]);

/**
 * Binaries allowed by the `run` op — one-shot argv-based commands used
 * for backend plumbing (git ops, reading files, one-shot claude CLI).
 * Keep this smaller than the stream allowlist; `bash`/`sh` are
 * intentionally excluded because callers that reach for them are
 * effectively reopening the old shell-string exec surface.
 */
const ALLOWED_RUN_BINARIES = new Set<string>(['git', 'claude', 'cat']);

function assertBareBinaryName(binary: string): void {
  if (typeof binary !== 'string' || binary.length === 0) {
    throw new Error('binary must be a non-empty string');
  }
  if (binary.includes('/') || binary.includes('\\')) {
    throw new Error('binary must be a bare name (no path separators)');
  }
  if (binary.includes('\0') || binary.includes('\n') || binary.includes('\r')) {
    throw new Error('binary must not contain control characters');
  }
}

function assertAllowedStreamBinary(binary: string): void {
  assertBareBinaryName(binary);
  if (!ALLOWED_STREAM_BINARIES.has(binary)) {
    throw new Error(`binary not in stream_spawn allowlist: ${binary}`);
  }
}

function assertAllowedRunBinary(binary: string): void {
  assertBareBinaryName(binary);
  if (!ALLOWED_RUN_BINARIES.has(binary)) {
    throw new Error(`binary not in run allowlist: ${binary}`);
  }
}

/**
 * Local execution primitives. The daemon is always "on" the machine it
 * serves, so local == native child_process. No ssh2 here —
 * if a user wants a remote machine, they install a daemon there.
 *
 * Sessions are tracked in-memory. On daemon restart, sessions are
 * orphaned; the backend surfaces this as `session.close` via the
 * reconnect-is-a-fresh-state contract.
 */

interface StreamSession {
  child: ChildProcessWithoutNullStreams;
  /** ms since epoch when the session was spawned. */
  startedAt: number;
}

const streamSessions = new Map<string, StreamSession>();

/**
 * Snapshot of every child still running. Used by the WS client to
 * tell the backend which sessions are alive on reconnect, so a
 * backend restart doesn't blanket-fail the corresponding tasks.
 */
export function listActiveSessions(): Array<{
  sessionId: string;
  pid: number;
  startedAt: number;
}> {
  const out: Array<{ sessionId: string; pid: number; startedAt: number }> = [];
  for (const [sessionId, session] of streamSessions) {
    const pid = session.child.pid;
    if (pid !== undefined) {
      out.push({ sessionId, pid, startedAt: session.startedAt });
    }
  }
  return out;
}

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
 * Run a binary with a strict argv array — no shell, no interpolation.
 * Used by both the daemon's own git helpers and the backend's `run`
 * op (via wsClient). `binary` is checked against the `run` allowlist
 * when the caller is external (backend RPC); daemon-internal callers
 * pass `{ external: false }` to reuse the helper for any binary.
 * `stdinBase64` bytes, if present, are written to the child and stdin
 * is closed. Stdout/stderr are buffered as UTF-8.
 */
export async function run(
  binary: string,
  args: string[],
  opts: { cwd?: string; stdinBase64?: string; external?: boolean } = {}
): Promise<ExecResult> {
  assertSafeCwd(opts.cwd);
  if (opts.external) {
    assertAllowedRunBinary(binary);
  } else {
    assertBareBinaryName(binary);
  }
  const stdio: ('ignore' | 'pipe')[] =
    opts.stdinBase64 !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
  return new Promise((resolve) => {
    const proc = spawn(binary, args, {
      cwd: opts.cwd,
      env: buildChildEnv(),
      stdio,
    });

    if (opts.stdinBase64 !== undefined && proc.stdin) {
      proc.stdin.write(Buffer.from(opts.stdinBase64, 'base64'));
      proc.stdin.end();
    }

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf-8');
    });
    proc.stderr?.on('data', (b: Buffer) => {
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
  assertAllowedStreamBinary(binary);
  assertSafeCwd(opts.cwd);

  const childEnv: NodeJS.ProcessEnv = buildChildEnv();
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) childEnv[k] = v;
  }

  const child = spawn(binary, args, {
    cwd: opts.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  streamSessions.set(sessionId, { child, startedAt: Date.now() });

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
  const session = streamSessions.get(sessionId);
  if (!session || !session.child.stdin || session.child.stdin.destroyed) return;
  session.child.stdin.end();
}

/** Write bytes to a session's stdin. No-op if the session was already killed. */
export function writeSession(sessionId: string, data: Buffer): void {
  const session = streamSessions.get(sessionId);
  if (session && session.child.stdin && !session.child.stdin.destroyed) {
    session.child.stdin.write(data);
  }
}

/** Terminate a session. Emits the matching `session.close` event. */
export function killSession(sessionId: string): void {
  const session = streamSessions.get(sessionId);
  if (!session) return;
  try { session.child.kill('SIGTERM'); } catch {
    // Already dead.
  }
}

/** For tests + shutdown. */
export function shutdownAllSessions(): void {
  for (const [, session] of streamSessions) {
    try { session.child.kill('SIGTERM'); } catch {
      // ignore
    }
  }
  streamSessions.clear();
}
