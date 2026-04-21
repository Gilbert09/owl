import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { listActiveSessions } from './executor.js';

const DEFAULT_DRAIN_TIMEOUT_SECONDS = 30;

/**
 * Walk up from the daemon's module location to find the FastOwl
 * monorepo root — identified by a package.json that declares the
 * workspace (`"workspaces"` array including `packages/daemon`).
 *
 * Returns null for compiled-binary daemons (no walkable source on
 * disk) — the caller refuses the update in that case.
 */
function findSourceRoot(): string | null {
  try {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 6; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const ws = raw?.workspaces;
        if (Array.isArray(ws) && ws.some((w: string) => w.includes('daemon'))) {
          return dir;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Run a shell command, stream output to our console, resolve with
 * the exit code. No throw — caller inspects the code.
 */
function runShell(command: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/**
 * Poll `listActiveSessions` until it's empty, or we hit the deadline.
 * Returns true if the drain succeeded.
 */
async function drainSessions(timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (listActiveSessions().length === 0) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return listActiveSessions().length === 0;
}

export interface PerformUpdateResult {
  newSha: string;
  message: string;
}

/**
 * Pull latest from origin, rebuild, and stamp version.json. On
 * success, caller is expected to `process.exit(0)` so systemd/launchd
 * restarts the daemon into the new binary.
 *
 * Source-install only (the layout `install-daemon.sh` produces).
 * Compiled-binary daemons — where the module has no walkable
 * package.json — throw with a clear message. (Self-update for the
 * binary case is on the roadmap; the rough shape is "download binary
 * from backend + atomic replace", which we haven't wired yet.)
 */
export async function performSelfUpdate(opts: {
  drainTimeoutSeconds?: number;
}): Promise<PerformUpdateResult> {
  const root = findSourceRoot();
  if (!root) {
    throw new Error(
      'Self-update is only supported for source-install daemons. ' +
        'Compiled binaries need to be replaced manually — re-run curl install.sh.'
    );
  }

  const drainOk = await drainSessions(
    opts.drainTimeoutSeconds ?? DEFAULT_DRAIN_TIMEOUT_SECONDS
  );
  if (!drainOk) {
    throw new Error(
      `daemon is busy — active sessions did not drain within ${opts.drainTimeoutSeconds ?? DEFAULT_DRAIN_TIMEOUT_SECONDS}s`
    );
  }

  // Sequential: fetch → reset → install → build. `reset --hard`
  // intentionally wipes any local edits on the VM install root —
  // hand-edits there are not a supported workflow.
  const script =
    'set -euo pipefail && ' +
    'git fetch origin main && ' +
    'git reset --hard origin/main && ' +
    'npm install --no-audit --no-fund && ' +
    'npm run build -w @fastowl/shared && ' +
    'npm run build -w @fastowl/daemon && ' +
    'SHA="$(git rev-parse HEAD)" && ' +
    'BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" && ' +
    'printf \'{"sha":"%s","builtAt":"%s"}\' "$SHA" "$BUILT_AT" ' +
    '> packages/daemon/version.json';

  const code = await runShell(script, root);
  if (code !== 0) {
    throw new Error(`self-update shell script failed with exit ${code}`);
  }

  const versionPath = path.join(root, 'packages/daemon/version.json');
  let newSha = 'unknown';
  try {
    const raw = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
    if (typeof raw.sha === 'string') newSha = raw.sha;
  } catch {
    // non-fatal
  }

  return {
    newSha: newSha.slice(0, 7),
    message: `Update applied — daemon will restart into ${newSha.slice(0, 7)}`,
  };
}
