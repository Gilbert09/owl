import { Router } from 'express';
import path from 'node:path';
import { prMonitorService } from '../services/prMonitor.js';
import {
  handleAccessError,
  requireRepositoryAccess,
  requireWorkspaceAccess,
} from '../middleware/auth.js';

/**
 * Normalize + validate a user-supplied local filesystem path. The path
 * will flow into `cwd` on git subprocesses, so we reject obvious
 * injection shapes (NUL, leading `-`, newlines) and require absolute,
 * post-normalize paths with no traversal residue.
 */
function validateLocalPath(raw: string): string {
  if (raw.includes('\0') || raw.includes('\n') || raw.includes('\r')) {
    throw new Error('localPath must not contain control characters');
  }
  if (raw.startsWith('-')) {
    throw new Error('localPath must not start with "-"');
  }
  const normalized = path.normalize(raw);
  if (!path.isAbsolute(normalized)) {
    throw new Error('localPath must be absolute');
  }
  if (normalized.split(path.sep).includes('..')) {
    throw new Error('localPath must not contain traversal segments');
  }
  return normalized;
}

export function repositoryRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const repos = await prMonitorService.getWatchedRepos(workspaceId);
    res.json({ success: true, data: repos });
  });

  router.post('/', async (req, res) => {
    const { workspaceId, owner, repo, url, localPath } = req.body;
    if (!workspaceId || !owner || !repo) {
      return res.status(400).json({
        success: false,
        error: 'workspaceId, owner, and repo are required',
      });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    let safeLocalPath: string | undefined;
    if (typeof localPath === 'string' && localPath.trim().length > 0) {
      try {
        safeLocalPath = validateLocalPath(localPath.trim());
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'invalid localPath';
        return res.status(400).json({ success: false, error: msg });
      }
    }
    try {
      const watched = await prMonitorService.addWatchedRepo(
        workspaceId,
        owner,
        repo,
        url,
        safeLocalPath
      );
      res.json({ success: true, data: watched });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      await requireRepositoryAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const { localPath } = req.body as { localPath?: string | null };
    // `null` explicitly clears; missing leaves as-is. Empty string
    // collapses to null so the repo reverts to "no local path".
    let normalised: string | null | undefined;
    if (localPath === undefined) {
      normalised = undefined;
    } else if (typeof localPath === 'string' && localPath.trim().length > 0) {
      try {
        normalised = validateLocalPath(localPath.trim());
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'invalid localPath';
        return res.status(400).json({ success: false, error: msg });
      }
    } else {
      normalised = null;
    }
    try {
      await prMonitorService.updateWatchedRepo(req.params.id, { localPath: normalised });
      res.json({ success: true, data: null });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await requireRepositoryAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const { id } = req.params;
    try {
      await prMonitorService.removeWatchedRepo(id);
      res.json({ success: true, data: null });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  // Force-poll is an infrastructure trigger; it refreshes PR state for
  // every watched repo across all users. No user scoping — but still auth
  // required (rate-limit + only valid users).
  router.post('/poll', async (_req, res) => {
    try {
      await prMonitorService.forcePoll();
      res.json({ success: true, data: { message: 'Poll triggered' } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}
