import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { githubService } from '../services/github.js';
import {
  handleAccessError,
  requireWorkspaceAccess,
} from '../middleware/auth.js';
import type { ApiResponse } from '@fastowl/shared';

// Store pending OAuth states (in production, use Redis or similar).
// Keyed by the opaque state token; records which user started the flow
// for which workspace so the public /callback can't be hijacked.
const pendingOAuthStates = new Map<
  string,
  { workspaceId: string; userId: string; expiresAt: number }
>();

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

  router.get('/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).type('html').send(
        renderCallbackPage({
          ok: false,
          message: (error_description as string) || (error as string) || 'GitHub OAuth error',
        })
      );
    }

    if (!code || !state) {
      return res.status(400).type('html').send(
        renderCallbackPage({ ok: false, message: 'Missing code or state parameter' })
      );
    }

    const stateStr = state as string;
    const [workspaceId, stateToken] = stateStr.split(':');

    const pendingState = pendingOAuthStates.get(stateToken);
    if (!pendingState || pendingState.workspaceId !== workspaceId) {
      return res.status(400).type('html').send(
        renderCallbackPage({ ok: false, message: 'Invalid OAuth state — try again from FastOwl' })
      );
    }

    pendingOAuthStates.delete(stateToken);

    try {
      const tokenData = await githubService.exchangeCodeForToken(code as string);
      await githubService.storeToken(
        workspaceId,
        tokenData.access_token,
        tokenData.token_type,
        tokenData.scope
      );
      res.type('html').send(renderCallbackPage({ ok: true, message: 'GitHub connected!' }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).type('html').send(renderCallbackPage({ ok: false, message }));
    }
  });

  return router;
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
  <title>FastOwl — ${escapeHtml(title)}</title>
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
    <p class="hint">You can close this tab and return to FastOwl.</p>
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
          message: 'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
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

  router.post('/connect', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    if (!githubService.isConfigured()) {
      return res.status(400).json({ success: false, error: 'GitHub OAuth not configured' });
    }

    const state = uuid();
    pendingOAuthStates.set(state, {
      workspaceId,
      userId: req.user!.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const authUrl = githubService.getAuthorizationUrl(workspaceId, state);
    res.json({ success: true, data: { authUrl, state } });
  });

  router.post('/disconnect', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    await githubService.removeToken(workspaceId);
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

  router.get('/repos', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    const { per_page, page } = req.query;
    try {
      const repos = await githubService.listRepositories(workspaceId, {
        per_page: per_page ? parseInt(per_page as string, 10) : undefined,
        page: page ? parseInt(page as string, 10) : undefined,
      });
      res.json({ success: true, data: repos });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.get('/repos/:owner/:repo/pulls', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    const { owner, repo } = req.params;
    const { state } = req.query;
    try {
      const pulls = await githubService.listPullRequests(workspaceId, owner, repo, {
        state: state as 'open' | 'closed' | 'all',
      });
      res.json({ success: true, data: pulls });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.get('/repos/:owner/:repo/pulls/:number/checks', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    const { owner, repo, number } = req.params;
    try {
      const pr = await githubService.getPullRequest(workspaceId, owner, repo, parseInt(number, 10));
      const checks = await githubService.getCheckRuns(workspaceId, owner, repo, pr.head.sha);
      res.json({ success: true, data: checks });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.get('/repos/:owner/:repo/pulls/:number', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    const { owner, repo, number } = req.params;
    try {
      const pr = await githubService.getPullRequest(workspaceId, owner, repo, parseInt(number, 10));
      res.json({ success: true, data: pr });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.get('/repos/:owner/:repo/pulls/:number/files', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    const { owner, repo, number } = req.params;
    try {
      const files = await githubService.getPRFiles(workspaceId, owner, repo, parseInt(number, 10));
      res.json({ success: true, data: files });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.post('/repos/:owner/:repo/pulls', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    const { owner, repo } = req.params;
    const { title, head, base, body, draft } = req.body;
    if (!title || !head || !base) {
      return res.status(400).json({
        success: false,
        error: 'title, head, and base are required',
      });
    }
    try {
      const pr = await githubService.createPullRequest(workspaceId, owner, repo, {
        title,
        head,
        base,
        body,
        draft,
      });
      res.json({ success: true, data: pr });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.patch('/repos/:owner/:repo/pulls/:number', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    const { owner, repo, number } = req.params;
    const { title, body, state, base } = req.body;
    try {
      const pr = await githubService.updatePullRequest(
        workspaceId,
        owner,
        repo,
        parseInt(number, 10),
        { title, body, state, base }
      );
      res.json({ success: true, data: pr });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.put('/repos/:owner/:repo/pulls/:number/merge', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    const { owner, repo, number } = req.params;
    const { commit_title, commit_message, merge_method } = req.body;
    try {
      const result = await githubService.mergePullRequest(
        workspaceId,
        owner,
        repo,
        parseInt(number, 10),
        { commit_title, commit_message, merge_method }
      );
      res.json({ success: true, data: result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.post('/repos/:owner/:repo/pulls/:number/reviews', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    const { owner, repo, number } = req.params;
    const { body, event, comments } = req.body;
    if (!event) {
      return res.status(400).json({ success: false, error: 'event is required' });
    }
    try {
      const review = await githubService.createPRReview(
        workspaceId,
        owner,
        repo,
        parseInt(number, 10),
        { body, event, comments }
      );
      res.json({ success: true, data: review });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.post('/repos/:owner/:repo/pulls/:number/comments', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    const { owner, repo, number } = req.params;
    const { body } = req.body;
    if (!body) {
      return res.status(400).json({ success: false, error: 'body is required' });
    }
    try {
      const comment = await githubService.createPRComment(
        workspaceId,
        owner,
        repo,
        parseInt(number, 10),
        body
      );
      res.json({ success: true, data: comment });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

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
