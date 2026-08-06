import { Express, NextFunction, Request, Response } from 'express';
import { workspaceRoutes } from './workspaces.js';
import { environmentRoutes } from './environments.js';
import { taskRoutes } from './tasks.js';
import { githubRoutes, githubPublicRoutes } from './github.js';
import { posthogRoutes, posthogPublicRoutes } from './posthog.js';
import { cloudProviderRoutes } from './cloudProviders.js';
import { repositoryRoutes } from './repositories.js';
import { skillRoutes } from './skills.js';
import { pullRequestRoutes } from './pullRequests.js';
import { debugRoutes } from './debug.js';
import { fleetPublicRoutes, fleetRoutes } from './fleet.js';
import { adminRoutes } from './admin/index.js';
import { userRoutes } from './users.js';
import { billingRoutes } from './billing.js';
import { mcpTokenRoutes } from './mcpTokens.js';
import { mcpRoutes } from '../mcp/transport.js';
import { requireMcpToken } from '../mcp/requireMcpToken.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, wrapAsyncRoutes } from '../middleware/asyncHandler.js';
import { MergeQueueLimitError, TaskLimitError } from '../services/billing/entitlements.js';
import { ownerScope } from '../middleware/ownerScope.js';
import { rateLimit } from '../middleware/rateLimit.js';

export function setupRoutes(app: Express): void {
  const api = '/api/v1';

  // Broad per-IP ceiling over the whole API. The desktop client is
  // poll-happy — its densest legitimate consumer is the Debug panel's 3s
  // snapshot (~20 req/min) plus WS-driven refetch bursts on reconnect, so
  // real usage peaks around ~100 req/min from one IP. 1000/min is ~10x that
  // headroom: it never touches a normal desktop but stops a runaway client
  // or scripted abuse from monopolising the backend. (GitHub webhooks mount
  // on the app BEFORE these routes and are not affected.)
  app.use(
    `${api}`,
    rateLimit({
      windowMs: 60_000,
      max: 1000,
      message: 'Too many API requests — slow down.',
    })
  );

  // Every router is wrapped so async handler rejections flow into the
  // arity-4 error middleware below (Express 4 doesn't catch them itself —
  // an unwrapped rejection is a hung request + an unhandledRejection).
  const mount = wrapAsyncRoutes;

  // Public routes: the GitHub OAuth callback is hit by GitHub's browser
  // redirect, not by our authenticated desktop client, so it must stay
  // unauth'd. State-token validation inside the handler prevents CSRF.
  app.use(`${api}/github`, mount(githubPublicRoutes()));

  // PostHog's OAuth redirect lands here at the end of the connect flow — a
  // browser hop with no Authorization header, so it mounts alongside the GitHub
  // callback rather than behind requireAuth. The single-use PKCE state row
  // (posthog_oauth_states) is what authenticates it.
  app.use(`${api}/posthog`, mount(posthogPublicRoutes()));

  // Fleet hosts PUSH their state here every ~15s. The caller is fleetd — a
  // daemon on bare metal with no Supabase session — so this mounts before
  // requireAuth and authenticates with the shared FLEET_REPORT_TOKEN instead.
  // The direction matters: the backend never dials a fleet host to ask, because
  // that would mean a hosted PaaS holding an inbound path to every machine
  // running untrusted code.
  app.use(`${api}/fleet`, mount(fleetPublicRoutes()));

  // The hosted MCP endpoint authenticates with a personal MCP token (not a
  // Supabase JWT), so it mounts BEFORE requireAuth with its own gate. The
  // tool handlers call the authenticated REST API below over loopback with
  // internal-proxy headers, so owner scoping still applies end-to-end.
  // Every auth attempt on this mount is a DB round-trip (token lookup), so a
  // tighter per-IP limiter sits in FRONT of the gate: 300/min (5/s sustained)
  // is far above what a legitimate MCP client's tool-call cadence needs, but
  // stops an unauthenticated brute force from turning into a DB hammer.
  app.use(
    `${api}/mcp`,
    rateLimit({
      windowMs: 60_000,
      max: 300,
      message: 'Too many MCP requests — slow down.',
    }),
    asyncHandler(requireMcpToken),
    mount(mcpRoutes())
  );

  // Everything below is authenticated. The middleware populates req.user
  // and refuses requests without a valid Supabase JWT.
  app.use(`${api}`, asyncHandler(requireAuth));

  // Per-USER fair-use limit, on top of the per-IP ceiling above. IP alone
  // gets both directions wrong once there's a browser client: a whole office
  // behind one NAT egress shares a bucket they didn't individually fill,
  // while a single runaway user on a home connection never touches it. Same
  // 1000/min budget, now applied to the entity it was reasoned about — one
  // client peaks around 100 req/min, so this is ~10x headroom for a user
  // with several windows or tabs open.
  //
  // NOTE: the per-IP ceiling above is still 1000/min and is deliberately
  // NOT raised here. It bounds UNAUTHENTICATED work, and the expensive path
  // it protects is the legacy HS256 branch in verifyTokenAndGetUser, which
  // makes an outbound Supabase call per attempt. Revisit it (together with
  // that branch) when app.talyn.dev actually has NAT'd users — raising it
  // speculatively would widen that hole for no present gain.
  app.use(
    `${api}`,
    rateLimit({
      windowMs: 60_000,
      max: 1000,
      keyFn: (req) => req.user?.id ?? req.ip ?? 'unknown',
      message: 'Too many API requests — slow down.',
    })
  );

  // Developer-only internals view (requests, polling, WebSocket). Global,
  // not workspace-scoped — see routes/debug.ts. Mounted BEFORE the owner-scope
  // middleware so it stays a cross-tenant operator surface (and so it never
  // runs inside an owner-scoped transaction).
  app.use(`${api}/debug`, mount(debugRoutes()));

  // The host registry's read side. Admin-only (enforced inside), cross-tenant,
  // and mounted alongside debug for the same reason: it is an operator surface,
  // not a workspace one.
  app.use(`${api}/fleet`, mount(fleetRoutes()));

  // The operator console's API (admin.talyn.dev): the debug surface, fleet
  // operations, cross-tenant product admin, and the audit trail. Admin-gated
  // inside (except GET /admin/me, which answers {admin:false} rather than 403
  // so the console can render a "not an operator" screen).
  //
  // Pre-ownerScope with debug and fleet, and for a sharper reason than either:
  // every read here is deliberately cross-tenant, and ownerScope would not
  // error on them — it would silently return zero rows, which is the worst
  // available failure for a console whose job is to show what is happening
  // across the whole deployment.
  //
  // Its own per-user ceiling on top of the global one. A console page fans out
  // over hosts and polls, so its floor is higher than a product client's, but
  // it is still one human clicking: 300/min is generous for that and well
  // under anything that looks like a script.
  app.use(
    `${api}/admin`,
    rateLimit({
      windowMs: 60_000,
      max: 300,
      keyFn: (req) => req.user?.id ?? req.ip ?? 'unknown',
      message: 'Too many admin requests — slow down.',
    }),
    mount(adminRoutes())
  );

  // Account-level self-service (wipe). Pre-ownerScope: deletes the caller's
  // own users row, which RLS blocks from the authenticated role; handlers
  // hard-scope every query to req.user.id instead. See routes/users.ts.
  app.use(`${api}/users`, mount(userRoutes()));

  // Billing (plan status / checkout / portal). Pre-ownerScope on purpose:
  // checkout + portal block on Polar's API, and an owner-scoped transaction
  // would pin a pooled connection for that whole round-trip. Hard-scoped to
  // req.user.id. See routes/billing.ts.
  app.use(`${api}/billing`, mount(billingRoutes()));

  // Owner-scoped DB enforcement for the data routers below: runs each request
  // inside a transaction that drops to the `authenticated` role so Postgres RLS
  // filters every query to req.user (see db/scope.ts).
  app.use(`${api}`, ownerScope);

  app.use(`${api}/workspaces`, mount(workspaceRoutes()));
  app.use(`${api}/environments`, mount(environmentRoutes()));
  app.use(`${api}/tasks`, mount(taskRoutes()));
  app.use(`${api}/github`, mount(githubRoutes()));
  // Generic cloud-provider surface (list + credential CRUD). The
  // `/posthog` routes remain as a back-compat alias for the existing
  // desktop Settings card.
  app.use(`${api}/cloud-providers`, mount(cloudProviderRoutes()));
  app.use(`${api}/posthog`, mount(posthogRoutes()));
  app.use(`${api}/repositories`, mount(repositoryRoutes()));
  app.use(`${api}/pull-requests`, mount(pullRequestRoutes()));
  app.use(`${api}/skills`, mount(skillRoutes()));
  // Personal MCP-token management (mint/list/revoke). The tokens authenticate
  // the `/mcp` endpoint mounted above.
  app.use(`${api}/mcp-tokens`, mount(mcpTokenRoutes()));

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
  });

  app.use(apiErrorHandler);
}

/**
 * Terminal API error middleware. Arity-4 is load-bearing: Express only
 * treats a middleware as an error handler when it declares exactly four
 * parameters. Exported so route tests exercise the same status/code mapping
 * production uses.
 */
export function apiErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    console.error('API Error:', err);
    next(err);
    return;
  }
  // Central mapping for the free-plan gates — task creation/reactivation
  // paths throw TaskLimitError, the merge-queue toggle throws
  // MergeQueueLimitError, and both land here so the 402 + code contract
  // lives in exactly one place. Expected traffic, not an error — no
  // console spam.
  if (err instanceof TaskLimitError || err instanceof MergeQueueLimitError) {
    res.status(402).json({ success: false, error: err.message, code: err.code });
    return;
  }
  console.error('API Error:', err);
  res.status(500).json({ success: false, error: err.message });
}
