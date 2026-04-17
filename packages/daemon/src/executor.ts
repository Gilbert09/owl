import { spawn } from 'child_process';
import * as pty from 'node-pty';
import os from 'os';
import type { ExecResult } from '@fastowl/shared';

/**
 * Local execution primitives. The daemon is always "on" the machine it
 * serves, so local == native child_process + node-pty. No ssh2 here —
 * if a user wants a remote machine, they install a daemon there.
 *
 * Sessions are tracked in-memory. On daemon restart, sessions are
 * orphaned; the backend surfaces this as `session.close` via the
 * reconnect-is-a-fresh-state contract.
 */

const ptySessions = new Map<string, pty.IPty>();

export interface SessionEvents {
  onData: (sessionId: string, data: Buffer) => void;
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
      env: process.env,
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
 * Spawn an interactive PTY that survives across requests. `sessionId`
 * is chosen by the backend (usually the agent id) — subsequent writes
 * and kills address the session by that id. Output flows as async
 * `session.data` events.
 */
export function spawnInteractive(
  sessionId: string,
  command: string,
  opts: { cwd?: string; rows?: number; cols?: number } = {},
  events: SessionEvents
): void {
  if (ptySessions.has(sessionId)) {
    throw new Error(`session ${sessionId} already exists`);
  }

  const shell =
    os.platform() === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/bash';
  // Wrap the command so users see the same behaviour as the old backend
  // path: start a login shell, run the command, keep the shell open so
  // the user can continue typing after the command exits.
  const args =
    os.platform() === 'win32'
      ? ['/c', command]
      : ['-c', `${command}; exec bash`];

  const pt = pty.spawn(shell, args, {
    name: 'xterm-color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: opts.cwd,
    env: process.env as Record<string, string>,
  });
  ptySessions.set(sessionId, pt);

  pt.onData((d) => {
    events.onData(sessionId, Buffer.from(d, 'utf-8'));
  });
  pt.onExit(({ exitCode }) => {
    ptySessions.delete(sessionId);
    events.onClose(sessionId, exitCode ?? 0);
  });
}

/** Write bytes to a session's stdin. No-op if the session was already killed. */
export function writeSession(sessionId: string, data: Buffer): void {
  const pt = ptySessions.get(sessionId);
  if (!pt) return;
  pt.write(data.toString('utf-8'));
}

/** Terminate a session. Emits the matching `session.close` event. */
export function killSession(sessionId: string): void {
  const pt = ptySessions.get(sessionId);
  if (!pt) return;
  try {
    pt.kill();
  } catch {
    // Already dead; onExit handler cleans up the map entry.
  }
}

/** For tests + shutdown. */
export function shutdownAllSessions(): void {
  for (const [, pt] of ptySessions) {
    try {
      pt.kill();
    } catch {
      // ignore
    }
  }
  ptySessions.clear();
}
