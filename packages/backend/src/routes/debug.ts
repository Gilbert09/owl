import { Router } from 'express';
import type { DebugCategory } from '@talyn/shared';
import { debugBus, type DebugOwnerFilter } from '../services/debugBus.js';
import { requireAdmin } from '../middleware/auth.js';

/**
 * The categories `?category=` accepts.
 *
 * Must stay in step with the `DebugCategory` union — an unlisted value here is
 * not rejected, it silently falls through to "no filter", so the panel's chip
 * appears to do nothing rather than to fail. `db` and `webhook` were missing
 * for exactly that reason: the UI had chips for both and clicking either
 * returned the unfiltered stream.
 */
const CATEGORIES: ReadonlySet<DebugCategory> = new Set<DebugCategory>([
  'http',
  'db',
  'polling',
  'websocket',
  'event',
  'webhook',
  'error',
]);

/** Parse the `owner` query param into a filter (account id | 'system' | undefined). */
function ownerFilter(raw: unknown): DebugOwnerFilter {
  if (typeof raw !== 'string' || raw === '' || raw === 'all') return undefined;
  return raw as DebugOwnerFilter;
}

/**
 * Developer-only debug surface — exposes the backend's internals (requests,
 * poll ticks, WS traffic) across every account, so it's gated to admins.
 * `requireAuth` is applied by the parent router; `requireAdmin` (below) limits
 * everything except `/access` to operators. The desktop Debug panel is also
 * gated behind a Settings toggle. Events can be filtered to one account via
 * `?owner=<id>` (or `system`).
 */
export function debugRoutes(): Router {
  const router = Router();

  // Whether the *current* user may see the debug surface — used by the desktop
  // to decide whether to show the panel at all. Auth-only, not admin-gated.
  router.get('/access', (req, res) => {
    res.json({ success: true, data: { admin: !!req.user?.isAdmin } });
  });

  // Everything below is operator-only.
  router.use(requireAdmin);

  // Buffered events — backfill for a panel that opens after activity started.
  router.get('/events', (req, res) => {
    const categoryRaw = req.query.category as string | undefined;
    const category =
      categoryRaw && CATEGORIES.has(categoryRaw as DebugCategory)
        ? (categoryRaw as DebugCategory)
        : undefined;
    const service = (req.query.service as string | undefined) || undefined;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

    const events = debugBus.getEvents({ category, service, limit, owner: ownerFilter(req.query.owner) });
    res.json({ success: true, data: events });
  });

  // Point-in-time view: poller states, counters, WS client count.
  router.get('/snapshot', (_req, res) => {
    res.json({ success: true, data: debugBus.snapshot() });
  });

  // Drop the buffer (and lifetime counters) for a clean view.
  router.delete('/events', (_req, res) => {
    debugBus.clear();
    res.json({ success: true, data: { cleared: true } });
  });

  return router;
}
