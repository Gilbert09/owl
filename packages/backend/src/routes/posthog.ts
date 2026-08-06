import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import {
  getPostHogCodeClient,
  getPostHogCodeCredentials,
  storePostHogCodeCredentials,
  removePostHogCodeCredentials,
} from '../services/posthogCode/credentials.js';
import { PostHogCodeClient } from '../services/posthogCode/client.js';
import {
  completeAuthorization,
  consumeState,
  startAuthorization,
} from '../services/posthogCode/oauth.js';
import { isPostHogOAuthEnabled } from '../services/posthogCode/oauthConfig.js';
import { ensureCloudEnvironment } from '../services/cloudProviders/environment.js';
import { renderCallbackPage } from '../services/callbackPage.js';
import { getWebAppUrl, webAppUrl } from '../services/webApp.js';
import type { ApiResponse } from '@talyn/shared';

/** Mirrors `PostHogCodeStatus` in @talyn/client (the shape both front ends read). */
interface PostHogCodeStatusPayload {
  connected: boolean;
  projectId?: string;
  host?: string;
  authMethod?: 'personal_api_key' | 'oauth';
  /** OAuth only: the grant died and the user has to reconnect. */
  needsReauth?: boolean;
  /** Whether this deployment can offer the OAuth flow at all. */
  oauthAvailable?: boolean;
}

/**
 * Which front end started a flow. The desktop renderer loads from file://, so
 * its requests carry either no Origin or an opaque one; the browser app's Origin
 * is exactly WEB_APP_URL. Recorded server-side at start time rather than taken
 * from the callback, so it only ever selects between "render a page" and
 * "redirect to the WEB_APP_URL constant" — never a caller-supplied destination.
 */
function originClient(req: Request): 'web' | 'desktop' {
  const webApp = getWebAppUrl();
  return webApp && req.headers.origin === webApp ? 'web' : 'desktop';
}

/**
 * Routes hit by PostHog's browser redirect at the end of the OAuth flow — no
 * auth header available. The single-use state row is the entire security model
 * here, exactly as with the GitHub App callback.
 */
export function posthogPublicRoutes(): Router {
  const router = Router();

  // Deliberately tighter than the global API limiter: this endpoint spends an
  // authorization code, and a state token is the only thing standing in front of
  // it, so brute-forcing states should be expensive.
  const oauthRateLimit = rateLimit({
    windowMs: 10 * 60_000,
    max: 20,
    message: 'Too many OAuth requests — slow down.',
  });

  router.get('/oauth/callback', oauthRateLimit, async (req, res) => {
    const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

    /**
     * End the flow the way the client that started it needs. `client` comes from
     * the state row (server-recorded); before we have a row, fall back to the
     * Origin sniff, which for a browser redirect means "desktop" — the safe
     * default, since it renders a page rather than redirecting anywhere.
     */
    const finish = (
      client: 'web' | 'desktop',
      opts: { ok: boolean; message: string; status?: number }
    ) => {
      if (client === 'web') {
        const target = webAppUrl('/settings', {
          posthog: opts.ok ? 'connected' : 'error',
          ...(opts.ok ? {} : { message: opts.message }),
        });
        if (target) return res.redirect(302, target);
      }
      return res
        .status(opts.status ?? 200)
        .type('html')
        .send(renderCallbackPage({ ok: opts.ok, product: 'PostHog', message: opts.message }));
    };

    if (error) {
      return finish(originClient(req), {
        ok: false,
        status: 400,
        message: error_description || error || 'PostHog returned an error.',
      });
    }
    if (!code || !state) {
      return finish(originClient(req), {
        ok: false,
        status: 400,
        message: 'Missing code or state.',
      });
    }

    // Single-use: the lookup deletes the row, so a replayed callback (or a second
    // tab) finds nothing and the code can only be spent once.
    const pending = await consumeState(state);
    if (!pending) {
      return finish(originClient(req), {
        ok: false,
        status: 400,
        message: 'That connection attempt has expired — start again from Talyn.',
      });
    }

    try {
      const result = await completeAuthorization({ code, state: pending });
      // Connecting auto-provisions the cloud environment marker, matching the
      // personal-API-key path — without it the workspace has credentials but no
      // environment to resolve a provider through.
      await ensureCloudEnvironment(result.userId, 'posthog_code');
      return finish(pending.client, {
        ok: true,
        message: `Talyn can now run cloud tasks in PostHog project ${result.projectId}.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[posthog:oauth] callback failed:', message);
      return finish(pending.client, { ok: false, status: 400, message });
    }
  });

  return router;
}

/**
 * Per-workspace PostHog Code (cloud tasks) credentials.
 *
 * Two ways to connect, and both stay supported: OAuth (the default when this
 * deployment is configured for it) and a personal API key. The key is write-only
 * over the API — `GET /status` never returns it or any OAuth token, only presence
 * plus the non-secret project id / host / auth method.
 */
export function posthogRoutes(): Router {
  const router = Router();

  router.get('/status', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const creds = await getPostHogCodeCredentials(workspaceId);
    res.json({
      success: true,
      data: {
        connected: Boolean(creds),
        projectId: creds?.projectId,
        host: creds?.host,
        // Which auth path this workspace is on, and whether the OAuth grant has
        // died. The Settings card needs both: an existing personal-API-key
        // install must keep seeing its own card, not an invitation to migrate.
        authMethod: creds?.authMethod,
        needsReauth: creds?.reauthRequired ?? false,
        oauthAvailable: isPostHogOAuthEnabled(),
      },
    } as ApiResponse<PostHogCodeStatusPayload>);
  });

  /**
   * Begin the OAuth flow: mint a PKCE state row and hand back the URL to open.
   *
   * The caller opens it (system browser for desktop, same tab for web) and the
   * public `/oauth/callback` above finishes the job — so the token exchange never
   * touches the client, and no PostHog credential ever reaches a renderer.
   */
  router.post('/oauth/start', async (req, res) => {
    const { workspaceId, host, projectId } = req.body as {
      workspaceId?: string;
      host?: string;
      projectId?: string;
    };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    if (!isPostHogOAuthEnabled()) {
      return res.status(400).json({
        success: false,
        error: 'Connecting with PostHog is not available on this deployment — use a personal API key.',
      });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const { authorizeUrl } = await startAuthorization({
      workspaceId,
      userId: assertUser(req).id,
      host,
      client: originClient(req),
      // Only ever a pre-selection on PostHog's own consent screen, and only
      // honoured there if the user actually has access to it.
      projectIdHint: projectId,
    });
    res.json({ success: true, data: { authorizeUrl } } as ApiResponse<{ authorizeUrl: string }>);
  });

  router.put('/config', async (req, res) => {
    const { workspaceId, apiKey, projectId, host } = req.body as {
      workspaceId?: string;
      apiKey?: string;
      projectId?: string;
      host?: string;
    };
    if (!workspaceId || !apiKey || !projectId) {
      return res.status(400).json({
        success: false,
        error: 'workspaceId, apiKey and projectId are required',
      });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    // Validate before persisting so a bad key never gets stored.
    const resolvedHost = host?.replace(/\/+$/, '') || 'https://us.posthog.com';
    try {
      await new PostHogCodeClient(apiKey, projectId, resolvedHost).ping();
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: `Could not authenticate with PostHog: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

    try {
      await storePostHogCodeCredentials(workspaceId, { apiKey, projectId, host: resolvedHost });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Most likely TALYN_TOKEN_KEY isn't set — surface it as a clean
      // 500 instead of letting the throw take down the dev process.
      console.error('[posthog] failed to store credentials:', msg);
      return res.status(500).json({
        success: false,
        error: `Could not store credentials: ${msg}`,
      });
    }

    // Connecting the integration auto-provisions the cloud environment
    // (users don't add it manually). One per user is enough — it's a
    // secret-free marker; the per-workspace credentials above are what
    // actually authorise a run.
    await ensureCloudEnvironment(assertUser(req).id, 'posthog_code');

    res.json({
      success: true,
      data: {
        connected: true,
        projectId,
        host: resolvedHost,
        authMethod: 'personal_api_key',
        needsReauth: false,
        oauthAvailable: isPostHogOAuthEnabled(),
      } satisfies PostHogCodeStatusPayload,
    });
  });

  router.post('/test', async (req, res) => {
    const { workspaceId } = req.body as { workspaceId?: string };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const client = await getPostHogCodeClient(workspaceId);
    if (!client) {
      return res.json({ success: true, data: { connected: false, error: 'Not configured' } });
    }
    try {
      await client.ping();
      res.json({ success: true, data: { connected: true } });
    } catch (err) {
      res.json({
        success: true,
        data: { connected: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  router.delete('/config', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    await removePostHogCodeCredentials(workspaceId);
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}
