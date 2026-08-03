/**
 * Every URL the console has, in one place.
 *
 * The single source of truth: `App.tsx` builds its `<Route path=…>` from these
 * and `nav.ts` links to them, so a test can assert that every nav destination
 * is a real route without re-listing the route table (a re-listing drifts, and
 * a drifted test asserts nothing).
 *
 * This is the deliberate, weaker substitute for the product apps' compile-time
 * guarantee. There, `PANEL_PATHS ... satisfies Record<ActivePanel, string>`
 * makes a panel without a URL a `tsc` error. That construct is a flat map of
 * STATIC paths with an exact-string reverse lookup, and it cannot express
 * `/fleet/runs/:runId` — so this app trades it for params plus a runtime check.
 */
export const ROUTES = {
  login: '/login',
  authCallback: '/auth/callback',

  fleetHosts: '/fleet/hosts',
  fleetHost: '/fleet/hosts/:host',
  fleetRuns: '/fleet/runs',
  fleetRun: '/fleet/runs/:runId',
  fleetGoldens: '/fleet/goldens',
  fleetIncidents: '/fleet/incidents',

  users: '/product/users',
  user: '/product/users/:userId',
  workspaces: '/product/workspaces',
  workspace: '/product/workspaces/:workspaceId',
  tasks: '/product/tasks',
  task: '/product/tasks/:taskId',

  audit: '/audit',
  debug: '/debug',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

/** Where an authenticated operator lands. */
export const DEFAULT_ROUTE: RoutePath = ROUTES.fleetHosts;

/** Build a concrete URL from a parameterised route. */
export function routeTo(path: RoutePath, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_m, key: string) =>
    encodeURIComponent(params[key] ?? '')
  );
}
