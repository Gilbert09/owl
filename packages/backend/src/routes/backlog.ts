import { Router } from 'express';
import type {
  ApiResponse,
  BacklogItem,
  BacklogSource,
  CreateBacklogSourceRequest,
  UpdateBacklogSourceRequest,
} from '@fastowl/shared';
import { DB } from '../db/index.js';
import { backlogService } from '../services/backlog/service.js';
import { continuousBuildScheduler } from '../services/continuousBuild.js';

export function backlogRoutes(_db: DB): Router {
  const router = Router();

  // List sources for a workspace
  router.get('/sources', (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    const sources = backlogService.listSources(workspaceId);
    res.json({ success: true, data: sources } as ApiResponse<BacklogSource[]>);
  });

  // Get one source
  router.get('/sources/:id', (req, res) => {
    const source = backlogService.getSource(req.params.id);
    if (!source) {
      return res.status(404).json({ success: false, error: 'Source not found' });
    }
    res.json({ success: true, data: source } as ApiResponse<BacklogSource>);
  });

  // Create source
  router.post('/sources', (req, res) => {
    const body = req.body as CreateBacklogSourceRequest;
    if (!body.workspaceId || !body.type || !body.config) {
      return res
        .status(400)
        .json({ success: false, error: 'workspaceId, type, config are required' });
    }
    const source = backlogService.createSource(body);
    res.status(201).json({ success: true, data: source } as ApiResponse<BacklogSource>);
  });

  // Update source
  router.patch('/sources/:id', (req, res) => {
    const body = req.body as UpdateBacklogSourceRequest;
    const updated = backlogService.updateSource(req.params.id, body);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Source not found' });
    }
    res.json({ success: true, data: updated } as ApiResponse<BacklogSource>);
  });

  // Delete source
  router.delete('/sources/:id', (req, res) => {
    const ok = backlogService.deleteSource(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: 'Source not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  // Sync source — re-read file and upsert items
  router.post('/sources/:id/sync', async (req, res) => {
    try {
      const result = await backlogService.syncSource(req.params.id);
      res.json({ success: true, data: result } as ApiResponse<typeof result>);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // List items in a source
  router.get('/sources/:id/items', (req, res) => {
    const items = backlogService.listItems(req.params.id);
    res.json({ success: true, data: items } as ApiResponse<BacklogItem[]>);
  });

  // List items across the workspace
  router.get('/items', (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    const items = backlogService.listItemsForWorkspace(workspaceId);
    res.json({ success: true, data: items } as ApiResponse<BacklogItem[]>);
  });

  // Manually kick the Continuous Build scheduler for a workspace
  router.post('/schedule', async (req, res) => {
    const workspaceId = req.body?.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await continuousBuildScheduler.scheduleNext(workspaceId);
      res.json({ success: true } as ApiResponse<void>);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
