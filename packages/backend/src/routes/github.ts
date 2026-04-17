import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { githubService } from '../services/github.js';
import type { ApiResponse } from '@fastowl/shared';

// Store pending OAuth states (in production, use Redis or similar)
const pendingOAuthStates = new Map<string, { workspaceId: string; expiresAt: number }>();

// Clean up expired states periodically
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingOAuthStates) {
    if (data.expiresAt < now) pendingOAuthStates.delete(state);
  }
}, 60000);

export function githubRoutes(): Router {
  const router = Router();

  router.get('/status', (req, res) => {
    const { workspaceId } = req.query;
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

    if (workspaceId) {
      const status = githubService.getConnectionStatus(workspaceId as string);
      return res.json({
        success: true,
        data: { configured: true, ...status },
      });
    }

    res.json({ success: true, data: { configured: true, connected: false } });
  });

  router.post('/connect', (req, res) => {
    const { workspaceId } = req.body;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    if (!githubService.isConfigured()) {
      return res.status(400).json({ success: false, error: 'GitHub OAuth not configured' });
    }

    const state = uuid();
    pendingOAuthStates.set(state, {
      workspaceId,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const authUrl = githubService.getAuthorizationUrl(workspaceId, state);
    res.json({ success: true, data: { authUrl, state } });
  });

  router.get('/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.redirect(
        `/?github_error=${encodeURIComponent(error_description as string || (error as string))}`
      );
    }

    if (!code || !state) {
      return res.redirect('/?github_error=missing_params');
    }

    const stateStr = state as string;
    const [workspaceId, stateToken] = stateStr.split(':');

    const pendingState = pendingOAuthStates.get(stateToken);
    if (!pendingState || pendingState.workspaceId !== workspaceId) {
      return res.redirect('/?github_error=invalid_state');
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
      res.redirect('/?github_connected=true');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.redirect(`/?github_error=${encodeURIComponent(message)}`);
    }
  });

  router.post('/disconnect', async (req, res) => {
    const { workspaceId } = req.body;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    await githubService.removeToken(workspaceId);
    res.json({ success: true } as ApiResponse<void>);
  });

  router.get('/user', async (req, res) => {
    const { workspaceId } = req.query;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      const user = await githubService.getUser(workspaceId as string);
      res.json({ success: true, data: user });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.get('/repos', async (req, res) => {
    const { workspaceId, per_page, page } = req.query;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      const repos = await githubService.listRepositories(workspaceId as string, {
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
    const { owner, repo } = req.params;
    const { workspaceId, state } = req.query;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      const pulls = await githubService.listPullRequests(
        workspaceId as string,
        owner,
        repo,
        { state: state as 'open' | 'closed' | 'all' }
      );
      res.json({ success: true, data: pulls });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.get('/repos/:owner/:repo/pulls/:number/checks', async (req, res) => {
    const { owner, repo, number } = req.params;
    const { workspaceId } = req.query;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      const pr = await githubService.getPullRequest(
        workspaceId as string,
        owner,
        repo,
        parseInt(number, 10)
      );
      const checks = await githubService.getCheckRuns(
        workspaceId as string,
        owner,
        repo,
        pr.head.sha
      );
      res.json({ success: true, data: checks });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.get('/repos/:owner/:repo/pulls/:number', async (req, res) => {
    const { owner, repo, number } = req.params;
    const { workspaceId } = req.query;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      const pr = await githubService.getPullRequest(
        workspaceId as string,
        owner,
        repo,
        parseInt(number, 10)
      );
      res.json({ success: true, data: pr });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.get('/repos/:owner/:repo/pulls/:number/files', async (req, res) => {
    const { owner, repo, number } = req.params;
    const { workspaceId } = req.query;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      const files = await githubService.getPRFiles(
        workspaceId as string,
        owner,
        repo,
        parseInt(number, 10)
      );
      res.json({ success: true, data: files });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.post('/repos/:owner/:repo/pulls', async (req, res) => {
    const { owner, repo } = req.params;
    const { workspaceId, title, head, base, body, draft } = req.body;
    if (!workspaceId || !title || !head || !base) {
      return res.status(400).json({
        success: false,
        error: 'workspaceId, title, head, and base are required',
      });
    }
    try {
      const pr = await githubService.createPullRequest(
        workspaceId,
        owner,
        repo,
        { title, head, base, body, draft }
      );
      res.json({ success: true, data: pr });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.patch('/repos/:owner/:repo/pulls/:number', async (req, res) => {
    const { owner, repo, number } = req.params;
    const { workspaceId, title, body, state, base } = req.body;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
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
    const { owner, repo, number } = req.params;
    const { workspaceId, commit_title, commit_message, merge_method } = req.body;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
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
    const { owner, repo, number } = req.params;
    const { workspaceId, body, event, comments } = req.body;
    if (!workspaceId || !event) {
      return res.status(400).json({
        success: false,
        error: 'workspaceId and event are required',
      });
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
    const { owner, repo, number } = req.params;
    const { workspaceId, body } = req.body;
    if (!workspaceId || !body) {
      return res.status(400).json({ success: false, error: 'workspaceId and body are required' });
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
    const { owner, repo } = req.params;
    const { workspaceId, per_page, page } = req.query;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      const branches = await githubService.listBranches(workspaceId as string, owner, repo, {
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
