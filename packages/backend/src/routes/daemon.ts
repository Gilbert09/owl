import { Router } from 'express';
import fs from 'fs';
import path from 'path';

/**
 * Resolve the backend's own daemon "latest version" string. We assume
 * daemon + backend are built from the same repo, so the backend's
 * deploy SHA is also the SHA of the daemon source the install script
 * would clone right now. In Railway, `RAILWAY_GIT_COMMIT_SHA` is set
 * automatically; locally you can export `FASTOWL_BUILD_SHA` if you
 * want the endpoint to return something truthful during dev.
 */
function resolveLatestDaemonVersion(): string {
  const sha =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.FASTOWL_BUILD_SHA ||
    process.env.GITHUB_SHA ||
    '';
  if (!sha) return 'dev';
  return sha.slice(0, 7);
}

/**
 * Public routes for provisioning the FastOwl daemon on a remote VM.
 * These are unauthenticated by design — they serve a static script that
 * takes a pairing token as input. The pairing token itself is the
 * credential, not the HTTP request.
 *
 * Flow:
 *   1. Desktop mints a one-shot pairing token via the authenticated
 *      `POST /api/v1/environments/:id/pairing-token` endpoint.
 *   2. Desktop (or the backend's SSH installer) runs on the VM:
 *        curl -fsSL <backend>/daemon/install.sh \
 *          | bash -s -- --backend-url <URL> --pairing-token <TOKEN>
 *   3. The script clones FastOwl, installs Node, builds the daemon,
 *      exchanges the pairing token for a long-lived device token, and
 *      sets up systemd/launchd.
 */

// The install script lives at `scripts/install-daemon.sh` in the repo
// root. At runtime the backend may be launched from `dist/routes/` or
// `packages/backend/`, so we try a few candidate paths.
function resolveInstallScriptPath(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../../../scripts/install-daemon.sh'),
    path.resolve(__dirname, '../../../scripts/install-daemon.sh'),
    path.resolve(process.cwd(), 'scripts/install-daemon.sh'),
    path.resolve(process.cwd(), '../../scripts/install-daemon.sh'),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch {
      // try next
    }
  }
  return null;
}

export function daemonPublicRoutes(): Router {
  const router = Router();

  router.get('/install.sh', (_req, res) => {
    const scriptPath = resolveInstallScriptPath();
    if (!scriptPath) {
      console.error('daemon install.sh: script not found on disk');
      return res.status(500).type('text/plain').send('install script unavailable');
    }
    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(scriptPath).pipe(res);
  });

  /**
   * Public endpoint returning the current "latest daemon version" —
   * the backend's own build SHA. Desktop and polling daemons read this
   * to decide whether they're stale. No auth: this is a public
   * constant tied to the deployed backend, not per-user data.
   */
  router.get('/latest-version', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: { version: resolveLatestDaemonVersion() },
    });
  });

  return router;
}
