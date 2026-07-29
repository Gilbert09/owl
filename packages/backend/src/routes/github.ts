import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { githubService } from '../services/github.js';
import { prMonitorService } from '../services/prMonitor.js';
import {
  isGitHubAppConfigured,
  buildUserAuthUrl,
  buildInstallUrl,
  appInstallationsPageUrl,
  exchangeUserCode,
  fetchInstallation,
  fetchInstallationRepos,
  fetchUserInstallations,
} from '../services/githubApp.js';
import { getPoolDbClient } from '../db/client.js';
import { githubInstallations } from '../db/schema.js';
import {
  handleAccessError,
  requireWorkspaceAccess,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { debugBus } from '../services/debugBus.js';
import { getWebAppUrl, webAppUrl } from '../services/webApp.js';
import type { Request } from 'express';
import type { ApiResponse } from '@talyn/shared';

// OAuth flows don't run more than a few times per user per hour. 20 per
// 10 minutes per IP is generous for legitimate retries and blunts brute-
// force attempts at guessing state tokens on /callback.
const oauthRateLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 20,
  message: 'Too many OAuth requests — slow down.',
});

// Store pending OAuth states (in production, use Redis or similar).
// Keyed by the opaque state token; records which user started the flow
// for which workspace so the public /callback can't be hijacked.
const pendingOAuthStates = new Map<
  string,
  {
    workspaceId: string;
    userId: string;
    expiresAt: number;
    /**
     * Which front end started the flow. Recorded server-side rather than
     * encoded in the state string so it can't be tampered with — and it only
     * ever selects between "render a page" and "redirect to the WEB_APP_URL
     * constant", never a caller-supplied destination.
     */
    client: OAuthClient;
  }
>();

type OAuthClient = 'web' | 'desktop';

/**
 * The desktop renderer loads from file://, so its requests carry either no
 * Origin or an opaque one; the browser app's Origin is exactly WEB_APP_URL.
 * That's enough to know where to send the user at the end of the flow, and
 * it needs no cooperation from the client.
 */
function originClient(req: Request): OAuthClient {
  const webApp = getWebAppUrl();
  return webApp && req.headers.origin === webApp ? 'web' : 'desktop';
}

setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingOAuthStates) {
    if (data.expiresAt < now) pendingOAuthStates.delete(state);
  }
}, 60000);

/**
 * Routes hit by GitHub's browser redirect — no auth header available.
 * The state-token lookup is the entire security model here; any request
 * without a matching pending state is rejected.
 */
export function githubPublicRoutes(): Router {
  const router = Router();

  // GitHub App user-authorization redirect. The connect button sends the user
  // through `/login/oauth/authorize`, so we get `code` + `state` (and, on a
  // first-install redirect, `installation_id`). We exchange the code for the
  // user-to-server token, discover the user's installation(s), persist them,
  // store the workspace integration, then kick a bulk refresh.
  router.get('/app/callback', oauthRateLimit, async (req, res) => {
    const { code, state, installation_id, error, error_description } = req.query;

    /**
     * End the flow in whichever way suits the client that started it.
     *
     * The desktop opened this in the system browser, so there's nowhere to
     * send the user — render a page and let them close the tab (the app
     * re-polls its GitHub status on focus). The browser app is in THIS tab,
     * so leaving them on the API origin strands them; send them home.
     *
     * `status` only applies to the rendered page. A redirect is a successful
     * hop regardless of what it's reporting, and carries the outcome in the
     * query string for the app to surface.
     */
    const finish = (
      client: OAuthClient,
      opts: { ok: boolean; message: string; status?: number }
    ) => {
      if (client === 'web') {
        // Path and origin are ours; only `message` comes from outside, and
        // URL serialisation escapes it. Never a caller-supplied destination.
        const target = webAppUrl('/settings', {
          github: opts.ok ? 'connected' : 'error',
          ...(opts.ok ? {} : { message: opts.message }),
        });
        if (target) return res.redirect(302, target);
      }
      return res
        .status(opts.status ?? 200)
        .type('html')
        .send(renderCallbackPage({ ok: opts.ok, message: opts.message }));
    };

    if (error) {
      // No state yet (or it's unusable), so fall back to the Origin sniff.
      return finish(originClient(req), {
        ok: false,
        status: 400,
        message:
          (error_description as string) || (error as string) || 'GitHub App error',
      });
    }
    if (!code || !state) {
      return finish(originClient(req), {
        ok: false,
        status: 400,
        message: 'Missing code or state',
      });
    }
    const [workspaceId, stateToken] = (state as string).split(':');
    const pendingState = pendingOAuthStates.get(stateToken);
    if (!pendingState || pendingState.workspaceId !== workspaceId) {
      return finish(originClient(req), {
        ok: false,
        status: 400,
        message: 'Invalid install state — try again from Talyn',
      });
    }
    const { userId, client } = pendingState;
    pendingOAuthStates.delete(stateToken);

    try {
      const installCount = await completeAppConnection(
        workspaceId,
        code as string,
        installation_id ? String(installation_id) : undefined
      );
      // New user: authorized, but the App isn't installed on any account yet.
      // Send them straight into the install flow (with a fresh state) so that,
      // once they install, GitHub returns here with installation_id and the
      // connection completes. We only do this on the pure-authorize hop (no
      // installation_id) so a genuine "installed nothing" return doesn't loop.
      if (installCount === 0 && !installation_id) {
        const newState = uuid();
        pendingOAuthStates.set(newState, {
          workspaceId,
          userId,
          expiresAt: Date.now() + 10 * 60 * 1000,
          client,
        });
        return res.redirect(buildInstallUrl(`${workspaceId}:${newState}`));
      }
      return finish(
        client,
        installCount > 0
          ? { ok: true, message: 'GitHub connected!' }
          : {
              ok: true,
              message:
                'GitHub authorized, but no installation was completed. ' +
                `Install the FastOwl app (${appInstallationsPageUrl()}) on the org/user whose repos you want to track, then hit Connect again.`,
            }
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return finish(client, { ok: false, status: 500, message });
    }
  });

  return router;
}

/**
 * Finish connecting GitHub: exchange the OAuth code for the user-to-server
 * token, discover EVERY installation of the App the user can access (a user can
 * install it on their personal account + multiple orgs — data-plane reads then
 * resolve the right installation per repo owner), upsert each into the global
 * `github_installations` table, store the workspace integration (user token +
 * a primary installationId fallback), refresh the in-memory installation index,
 * and trigger a bulk refresh. Returns the number of installations found.
 */
async function completeAppConnection(
  workspaceId: string,
  code: string,
  installationIdHint: string | undefined
): Promise<number> {
  const userToken = await exchangeUserCode(code);
  const listed = await fetchUserInstallations(userToken.access_token).catch(() => []);

  // Union the listing with a fresh-install hint: right after an install, the
  // `/user/installations` listing can lag, so trust the installation_id GitHub
  // just handed us too.
  const ids = new Set(listed.map((i) => i.installationId));
  if (installationIdHint) ids.add(installationIdHint);

  const db = getPoolDbClient();
  const now = new Date();
  const listedById = new Map(listed.map((i) => [i.installationId, i]));
  for (const installationId of ids) {
    // Per-installation account + selected repos. The App-JWT fetch is the
    // source of truth for account + suspension; fall back to the listing.
    const info = await fetchInstallation(installationId).catch(() => null);
    const fallback = listedById.get(installationId);
    const accountLogin = info?.accountLogin ?? fallback?.accountLogin ?? 'unknown';
    const accountType = info?.accountType ?? fallback?.accountType ?? 'User';
    const repoFullNames = await fetchInstallationRepos(installationId).catch(() => []);
    await db
      .insert(githubInstallations)
      .values({
        installationId,
        accountLogin,
        accountType,
        repoFullNames,
        suspendedAt: info?.suspended ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: { accountLogin, accountType, repoFullNames, suspendedAt: info?.suspended ? now : null, updatedAt: now },
      });
  }

  const installations = [...ids];
  // Primary installation (fallback when a call's repo owner can't be resolved):
  // the hint from a first-install redirect, else the first discovered install.
  const primaryInstallationId = installationIdHint ?? installations[0];

  const nowMs = Date.now();
  await githubService.storeToken(
    workspaceId,
    userToken.access_token,
    userToken.token_type,
    userToken.scope,
    {
      ...(primaryInstallationId ? { installationId: primaryInstallationId } : {}),
      // Present only when the App has token expiry enabled — drives rotation.
      ...(userToken.refreshToken ? { refreshToken: userToken.refreshToken } : {}),
      ...(userToken.expiresInSec
        ? { accessTokenExpiresAt: nowMs + userToken.expiresInSec * 1000 }
        : {}),
      ...(userToken.refreshTokenExpiresInSec
        ? { refreshTokenExpiresAt: nowMs + userToken.refreshTokenExpiresInSec * 1000 }
        : {}),
    }
  );

  // Make the new installations resolvable by repo owner immediately.
  await githubService.refreshInstallationIndex();

  debugBus.recordEvent({
    service: 'github',
    action: 'github:connected',
    summary: `ws ${workspaceId.slice(0, 8)} connected — ${installations.length} installation(s)`,
    workspaceId,
  });

  // Fill the UI immediately rather than waiting for the first webhook.
  void prMonitorService.refreshWorkspaceNow(workspaceId).catch((err) => {
    console.error('[github] post-connect bulk refresh failed:', err);
  });
  return installations.length;
}

/**
 * Render the minimal callback landing page. The user's browser opened
 * the OAuth flow and GitHub redirects back here — we need to give them
 * *something* to look at before they close the tab. The desktop app
 * polls its GitHub status on focus, so there's no need for a deep link.
 */
function renderCallbackPage(opts: { ok: boolean; message: string }): string {
  const color = opts.ok ? '#16a34a' : '#dc2626';
  const title = opts.ok ? 'GitHub connected' : 'Connection failed';
  const safe = escapeHtml(opts.message);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Talyn — ${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #0b0b0f; color: #e5e7eb; display: grid; place-items: center;
           min-height: 100vh; margin: 0; }
    .card { background: #16161d; border: 1px solid #27272f; border-radius: 12px;
            padding: 32px 40px; max-width: 420px; text-align: center; }
    h1 { margin: 0 0 8px 0; font-size: 20px; color: ${color}; }
    p { margin: 0; color: #9ca3af; font-size: 14px; line-height: 1.5; }
    .hint { margin-top: 18px; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${safe}</p>
    <p class="hint">You can close this tab and return to Talyn.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Authenticated GitHub routes. Every endpoint takes a workspaceId (body or
 * query) and we verify the caller owns that workspace before touching the
 * stored integration tokens.
 */
export function githubRoutes(): Router {
  const router = Router();

  // Helper: pull workspaceId from body or query, verify ownership, or 4xx.
  async function gateWorkspace(
    req: import('express').Request,
    res: import('express').Response,
    source: 'body' | 'query' = 'query'
  ): Promise<string | null> {
    const workspaceId =
      source === 'body'
        ? (req.body?.workspaceId as string | undefined)
        : (req.query.workspaceId as string | undefined);
    if (!workspaceId) {
      res.status(400).json({ success: false, error: 'workspaceId is required' });
      return null;
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      handleAccessError(err, res);
      return null;
    }
    return workspaceId;
  }

  router.get('/status', async (req, res) => {
    const configured = githubService.isConfigured();

    if (!configured) {
      return res.json({
        success: true,
        data: {
          configured: false,
          connected: false,
          message: 'GitHub App not configured. Set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY (see docs/SETUP.md §3b).',
        },
      });
    }

    const workspaceId = req.query.workspaceId as string | undefined;
    if (workspaceId) {
      try {
        await requireWorkspaceAccess(req, workspaceId);
      } catch (err) {
        return handleAccessError(err, res);
      }
      const status = githubService.getConnectionStatus(workspaceId);
      return res.json({
        success: true,
        data: { configured: true, ...status },
      });
    }

    res.json({ success: true, data: { configured: true, connected: false } });
  });

  // GitHub App install URL. The public /app/callback validates the state token
  // before persisting anything.
  router.post('/app/install-url', oauthRateLimit, async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    if (!isGitHubAppConfigured()) {
      return res.status(400).json({ success: false, error: 'GitHub App not configured' });
    }
    const state = uuid();
    pendingOAuthStates.set(state, {
      workspaceId,
      userId: req.user!.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
      client: originClient(req),
    });
    try {
      // Two URLs, same single-use state:
      //  - installUrl: the user-authorization URL — always runs OAuth authorize →
      //    callback, whether or not the App is already installed. Used by Connect.
      //  - manageUrl: the App's installations/new page — where the user picks an
      //    account/org to install on (or adds repos to an existing install). Used
      //    by "install on another org" once already connected. With OAuth-on-
      //    install enabled it returns through the same callback, so completing it
      //    re-discovers every installation (including the new org).
      const installUrl = buildUserAuthUrl(`${workspaceId}:${state}`);
      // manageUrl needs the App slug; if it's unconfigured, fall back to the
      // generic installations page (no state — the install is still recorded via
      // the `installation` webhook) rather than failing the whole request and
      // breaking the connect button, which only needs installUrl.
      let manageUrl: string;
      try {
        manageUrl = buildInstallUrl(`${workspaceId}:${state}`);
      } catch {
        manageUrl = appInstallationsPageUrl();
      }
      res.json({ success: true, data: { installUrl, manageUrl, state } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    await githubService.removeToken(workspaceId, 'user disconnected via POST /github/disconnect');
    res.json({ success: true } as ApiResponse<void>);
  });

  router.get('/user', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const user = await githubService.getUser(workspaceId);
      res.json({ success: true, data: user });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // The GitHub App installations the connected user can access (one per
  // account/org). Drives the desktop's "is the App installed on this org?"
  // coverage banners + repo-picker hints.
  router.get('/installations', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const installations = await githubService.listInstallations(workspaceId);
      res.json({ success: true, data: installations });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.get('/repos', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const repos = await githubService.listRepositories(workspaceId);
      res.json({ success: true, data: repos });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // Everything the user can watch: their own repos + all their orgs'
  // repos, merged. Expensive (fans out across orgs) — the desktop caches
  // the result in localStorage and only re-hits this on explicit refresh.
  router.get('/all-repos', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const repos = await githubService.listAllAccessibleRepos(workspaceId);
      res.json({ success: true, data: repos });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // Orgs the user belongs to — drives the org-browse repo picker.
  router.get('/orgs', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const orgs = await githubService.listOrganizations(workspaceId);
      res.json({ success: true, data: orgs });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // Repos in a specific org. Lets the user watch repos in orgs they
  // belong to (e.g. public org repos) that don't surface in /user/repos.
  router.get('/orgs/:org/repos', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const repos = await githubService.listOrgRepositories(workspaceId, req.params.org);
      res.json({ success: true, data: repos });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // The PR-management surface (list / get / files / checks /
  // create / update / merge / review / comment) was removed in
  // Phase 7 — read paths moved to /pull-requests, write paths
  // are explicit "open on GitHub" deep-links. The internal
  // `githubService.createPullRequest` is still used by
  // openPullRequestForTask but no longer has its own HTTP route.

  router.get('/repos/:owner/:repo/branches', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    const { owner, repo } = req.params;
    const { per_page, page } = req.query;
    try {
      const branches = await githubService.listBranches(workspaceId, owner, repo, {
        per_page: per_page ? parseInt(per_page as string, 10) : undefined,
        page: page ? parseInt(page as string, 10) : undefined,
      });
      res.json({ success: true, data: branches });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  return router;
}
