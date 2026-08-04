import { Router } from 'express';
import type { ApiResponse } from '@talyn/shared';
import {
  getAdminTask,
  getAdminUser,
  getAdminWorkspace,
  listAdminTasks,
  listAdminUsers,
  listAdminWorkspaces,
} from '../../services/admin/queries.js';

/**
 * Cross-tenant product reads for the operator console.
 *
 * Mounted (via routes/admin/index.ts) BEFORE `ownerScope`, which is the only
 * reason any of this returns rows at all: under RLS these queries would come
 * back empty rather than erroring, so the console would look like a working
 * page with nothing in it. `routes/adminProduct.test.ts` asserts a read
 * returns ANOTHER owner's rows, which is the check that placement is real
 * rather than intended.
 *
 * Every query lives in services/admin/queries.ts — nothing here touches
 * Drizzle, so the egress test has exactly one file to assert against.
 */
export function adminProductRoutes(): Router {
  const router = Router();

  router.get('/users', async (req, res) => {
    const page = await listAdminUsers({
      q: req.query.q,
      plan: req.query.plan,
      admin: req.query.admin,
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({ success: true, data: page } as ApiResponse<typeof page>);
  });

  router.get('/users/:id', async (req, res) => {
    const user = await getAdminUser(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    res.json({ success: true, data: user } as ApiResponse<typeof user>);
  });

  router.get('/workspaces', async (req, res) => {
    const page = await listAdminWorkspaces({
      q: req.query.q,
      ownerId: req.query.ownerId,
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({ success: true, data: page } as ApiResponse<typeof page>);
  });

  router.get('/workspaces/:id', async (req, res) => {
    const workspace = await getAdminWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ success: false, error: 'Workspace not found' });
      return;
    }
    res.json({ success: true, data: workspace } as ApiResponse<typeof workspace>);
  });

  router.get('/tasks', async (req, res) => {
    const page = await listAdminTasks({
      ownerId: req.query.ownerId,
      workspaceId: req.query.workspaceId,
      status: req.query.status,
      provider: req.query.provider,
      host: req.query.host,
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({ success: true, data: page } as ApiResponse<typeof page>);
  });

  /**
   * One task. `?transcript=1` additionally returns the run's conversation log.
   *
   * That read is AUDITED (wired in the audit step) — it is another tenant's
   * agent conversation, the single most sensitive thing this console can
   * display, and recording the access is what makes displaying it defensible.
   * Without the flag the transcript blob never leaves Postgres.
   */
  router.get('/tasks/:id', async (req, res) => {
    const wantsTranscript = req.query.transcript === '1' || req.query.transcript === 'true';
    const task = await getAdminTask(req.params.id, { transcript: wantsTranscript });
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    res.json({ success: true, data: task } as ApiResponse<typeof task>);
  });

  return router;
}
