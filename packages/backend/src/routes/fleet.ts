import { Router } from 'express';
import type { ApiResponse } from '@talyn/shared';
import { requireAdmin } from '../middleware/auth.js';
import {
  fleetReportTokenValid,
  listFleetHosts,
  recordFleetHostReport,
  type FleetHostReport,
  type FleetHostView,
} from '../services/fleetHosts.js';

/**
 * The fleet host registry's write side.
 *
 * Mounts BEFORE requireAuth, like the GitHub webhook and the MCP endpoint,
 * because the caller is a daemon with no Supabase session. It authenticates
 * with the shared `FLEET_REPORT_TOKEN` instead — the same secret fleetd is
 * already configured with, so a host that can report is a host somebody
 * deliberately gave the token to.
 *
 * Kept in its own router rather than added to the authenticated tree so the
 * auth boundary stays legible: everything under `${api}` after requireAuth has
 * a user, and this deliberately does not.
 */
export function fleetPublicRoutes(): Router {
  const router = Router();

  // A host's periodic snapshot. Idempotent: a repeated report is a no-op
  // write, which is what lets the sender be dumb about retries.
  router.post('/report', async (req, res) => {
    const presented = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!fleetReportTokenValid(presented)) {
      // Deliberately terse. An unauthenticated caller learns whether the
      // endpoint exists and nothing about why it refused — in particular not
      // whether a token is configured at all, which would tell an attacker
      // whether the door is merely locked or actually bricked up.
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }

    const report = req.body as FleetHostReport;
    if (!report?.host || typeof report.host !== 'string') {
      return res.status(400).json({ success: false, error: 'report is missing `host`' });
    }

    await recordFleetHostReport(report);
    return res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}

/**
 * The read side, for the Debug panel and any operator surface.
 *
 * Admin-only: a host list exposes the shape of every workspace's activity
 * across the whole deployment — in-flight run ids, counts, capacity — which is
 * the same reason routes/debug.ts is admin-only.
 */
export function fleetRoutes(): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get('/hosts', async (_req, res) => {
    const hosts = await listFleetHosts();
    res.json({ success: true, data: hosts } as ApiResponse<FleetHostView[]>);
  });

  return router;
}
