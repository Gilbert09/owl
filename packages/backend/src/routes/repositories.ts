import { Router } from 'express';
import { DB } from '../db/index.js';
import { prMonitorService } from '../services/prMonitor.js';

export function repositoryRoutes(db: DB): Router {
  const router = Router();

  // List watched repositories for a workspace
  router.get('/', (req, res) => {
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }

    const repos = prMonitorService.getWatchedRepos(workspaceId);

    res.json({
      success: true,
      data: repos,
    });
  });

  // Add a watched repository
  router.post('/', (req, res) => {
    const { workspaceId, owner, repo, url } = req.body;

    if (!workspaceId || !owner || !repo) {
      return res.status(400).json({
        success: false,
        error: 'workspaceId, owner, and repo are required',
      });
    }

    try {
      const watched = prMonitorService.addWatchedRepo(workspaceId, owner, repo, url);
      res.json({
        success: true,
        data: watched,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  // Remove a watched repository
  router.delete('/:id', (req, res) => {
    const { id } = req.params;

    try {
      prMonitorService.removeWatchedRepo(id);
      res.json({
        success: true,
        data: null,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  // Force a poll refresh
  router.post('/poll', async (_req, res) => {
    try {
      await prMonitorService.forcePoll();
      res.json({
        success: true,
        data: { message: 'Poll triggered' },
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  return router;
}
