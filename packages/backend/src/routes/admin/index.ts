import { Router } from 'express';
import type { AdminAccess, ApiResponse } from '@talyn/shared';
import { requireAdmin } from '../../middleware/auth.js';
import { debugRoutes } from '../debug.js';
import { adminCapabilities } from './guards.js';
import { adminProductRoutes } from './product.js';
import { adminAuditRoutes } from './audit.js';
import { adminFleetRoutes } from './fleet.js';

/**
 * The operator console's API (admin.talyn.dev).
 *
 * # Why a new router rather than growing /debug and /fleet
 *
 * Both of those are consumed by SHIPPED desktop builds, and there is no API
 * version negotiation — `X-Talyn-Client-Version` is identification only, and
 * nothing branches on it. Reshaping their responses breaks installs in the
 * field that nobody can force-update.
 *
 * `/api/v1/fleet` has a second reason: it already has a split personality.
 * `fleetPublicRoutes()` mounts BEFORE requireAuth with a shared bearer so a
 * daemon can report in; `fleetRoutes()` mounts after. Adding drain and
 * golden-GC into that file would put destructive mutations one mount-order
 * typo away from the unauthenticated router.
 *
 * One mount also means one place to hang the mutation rate limiter, the reason
 * gate, and the audit context, instead of three files that have to remember.
 *
 * # Mount position
 *
 * Mounted BEFORE `ownerScope` (see routes/index.ts). This is not a preference:
 * `withOwnerScope` runs the request inside a transaction that drops to the
 * `authenticated` role so Postgres RLS applies, and every read here is
 * deliberately cross-tenant. Mounted below it, they would not error — they
 * would silently return zero rows, which is the worst available failure for a
 * console whose job is to show you what is happening across the deployment.
 */
export function adminRoutes(): Router {
  const router = Router();

  /**
   * Who am I, and what does this deploy let me do.
   *
   * Auth-only, NOT admin-gated — it mirrors `GET /debug/access`. Answering
   * `{admin:false}` instead of 403 is what lets the console render "this is for
   * Talyn operators" rather than an error page, and it is the only endpoint
   * under /admin a non-operator's browser ever successfully calls.
   */
  router.get('/me', (req, res) => {
    const admin = !!req.user?.isAdmin;
    res.json({
      success: true,
      data: {
        admin,
        email: req.user?.email ?? null,
        // Only meaningful for an operator, and telling a non-operator what the
        // deploy permits is free reconnaissance.
        capabilities: admin ? adminCapabilities() : [],
      },
    } as ApiResponse<AdminAccess>);
  });

  // Everything below is operator-only.
  router.use(requireAdmin);

  /**
   * The debug surface, under the console's prefix.
   *
   * A SECOND instance of the same factory, deliberately: `/api/v1/debug/*`
   * stays byte-identical for desktop builds still asking for it, while the
   * console gets one coherent `/admin/...` prefix. Being a factory rather than
   * a singleton router is what makes this safe — the two instances have
   * separate middleware stacks, so `wrapAsyncRoutes` does not double-wrap.
   */
  router.use('/debug', debugRoutes());

  // Cross-tenant users / workspaces / tasks. Mounted at the router root
  // rather than under a `/product` prefix: the console's URLs are grouped for
  // navigation, but `/admin/users` reads better than `/admin/product/users`
  // and matches how /debug and /fleet already sit.
  // Fleet operations. Every read here proxies to fleetd over the private
  // link and DEGRADES rather than failing — see services/admin/fleetProxy.ts.
  router.use('/fleet', adminFleetRoutes());

  router.use(adminProductRoutes());

  router.use('/audit', adminAuditRoutes());

  return router;
}
