import fs from 'fs';
import path from 'path';
import url from 'url';

/**
 * Resolve the daemon's own version string for the hello message.
 *
 * Shape: `<pkgVersion>+<shortSha>` when we have a real build, or
 * `<pkgVersion>-dev` when running under `tsx src/index.ts` with no
 * version.json beside the install.
 *
 * At real-install time, the install script (`scripts/install-daemon.sh`)
 * writes a `version.json` beside the compiled daemon containing
 *   `{ sha, pkgVersion, builtAt }`
 * so the daemon picks the SHA it was actually built from rather than
 * whatever main-tip is now. The build-binary.sh script does the same
 * for pre-compiled binaries using GITHUB_SHA / git rev-parse.
 *
 * Returned string is bounded and safe to log.
 */
export function resolveDaemonVersion(): string {
  const pkgVersion = readPkgVersion() ?? '0.0.0';
  const sha = readBuildSha();
  if (!sha) return `${pkgVersion}-dev`;
  return `${pkgVersion}+${sha.slice(0, 7)}`;
}

function readPkgVersion(): string | null {
  // Walk up from the module location to find the daemon package.json.
  // Handles both `dist/version.js` (installed) and `src/version.ts`
  // (dev via tsx) layouts.
  try {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, '../package.json'),
      path.resolve(here, '../../package.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (typeof raw.version === 'string') return raw.version;
      }
    }
  } catch {
    // swallow — fall back to unknown
  }
  return null;
}

function readBuildSha(): string | null {
  // 1. Env var overrides — useful for CI builds and dev runs where
  //    you want to test the staleness path without a version.json.
  const envSha =
    process.env.FASTOWL_DAEMON_SHA ||
    process.env.GITHUB_SHA ||
    '';
  if (envSha) return envSha;

  // 2. version.json next to the daemon install. The install script
  //    writes this with the resolved git SHA at clone time.
  try {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, '../version.json'),
      path.resolve(here, '../../version.json'),
      path.resolve(process.cwd(), 'version.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (typeof raw.sha === 'string' && raw.sha.length > 0) return raw.sha;
      }
    }
  } catch {
    // swallow
  }
  return null;
}
