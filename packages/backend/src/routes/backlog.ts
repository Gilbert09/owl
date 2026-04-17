import { Router } from 'express';
import type {
  ApiResponse,
  BacklogItem,
  BacklogSource,
  CreateBacklogSourceRequest,
  UpdateBacklogSourceRequest,
} from '@fastowl/shared';
import { backlogService } from '../services/backlog/service.js';
import { continuousBuildScheduler } from '../services/continuousBuild.js';

export function backlogRoutes(): Router {
  const router = Router();

  router.get('/sources', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    const sources = await backlogService.listSources(workspaceId);
    res.json({ success: true, data: sources } as ApiResponse<BacklogSource[]>);
  });

  router.get('/sources/:id', async (req, res) => {
    const source = await backlogService.getSource(req.params.id);
    if (!source) {
      return res.status(404).json({ success: false, error: 'Source not found' });
    }
    res.json({ success: true, data: source } as ApiResponse<BacklogSource>);
  });

  router.post('/sources', async (req, res) => {
    const body = req.body as CreateBacklogSourceRequest;
    if (!body.workspaceId || !body.type || !body.config) {
      return res.status(400).json({
        success: false,
        error: 'workspaceId, type, config are required',
      });
    }
    const source = await backlogService.createSource(body);
    res.status(201).json({ success: true, data: source } as ApiResponse<BacklogSource>);
  });

  router.patch('/sources/:id', async (req, res) => {
    const body = req.body as UpdateBacklogSourceRequest;
    const updated = await backlogService.updateSource(req.params.id, body);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Source not found' });
    }
    res.json({ success: true, data: updated } as ApiResponse<BacklogSource>);
  });

  router.delete('/sources/:id', async (req, res) => {
    const ok = await backlogService.deleteSource(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: 'Source not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  router.post('/sources/:id/sync', async (req, res) => {
    try {
      const result = await backlogService.syncSource(req.params.id);
      res.json({ success: true, data: result } as ApiResponse<typeof result>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.get('/sources/:id/items', async (req, res) => {
    const items = await backlogService.listItems(req.params.id);
    res.json({ success: true, data: items } as ApiResponse<BacklogItem[]>);
  });

  router.get('/items', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    const items = await backlogService.listItemsForWorkspace(workspaceId);
    res.json({ success: true, data: items } as ApiResponse<BacklogItem[]>);
  });

  router.post('/schedule', async (req, res) => {
    const workspaceId = req.body?.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await continuousBuildScheduler.scheduleNext(workspaceId);
      res.json({ success: true } as ApiResponse<void>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}
