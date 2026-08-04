import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { NAV_GROUPS } from '../lib/nav';
import { DEFAULT_ROUTE, ROUTES, routeTo } from '../lib/routes';

/**
 * Every sidebar link goes somewhere real.
 *
 * This is the RUNTIME REPLACEMENT for a compile-time guarantee this app gives
 * up on purpose. The product apps declare `PANEL_PATHS ... satisfies
 * Record<ActivePanel, string>`, so a panel with no URL fails `tsc`. Typing
 * `NavItem.to` as `RoutePath` recovers half of that — a link to a URL that does
 * not exist will not compile — but it cannot tell whether the route is actually
 * MOUNTED in App.tsx. An unmounted path silently matches the `*` fallback and
 * redirects, which looks to an operator like the link is broken rather than
 * missing.
 */

// The real pages fetch on mount. A never-resolving promise keeps every page
// in its loading state, which is exactly what this test wants: it is asking
// "is the route mounted", not "does the page render data".
const pending = () => new Promise(() => {});
vi.mock('../lib/api', () => ({
  api: {
    ws: { connect: vi.fn(), disconnect: vi.fn() },
    admin: {
      fleet: {
        hosts: pending,
        host: pending,
        runs: pending,
        run: pending,
        events: pending,
        goldens: pending,
        incidents: pending,
      },
      users: { list: pending, get: pending },
      workspaces: { list: pending, get: pending },
      tasks: { list: pending, get: pending },
      audit: { list: pending },
    },
  },
}));

// Both gates pass through: this file is about routing, and the gates have
// their own tests. Mocking them keeps a routing failure from being reported
// as an auth failure.
vi.mock('../components/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ session: { user: {} }, loading: false, user: { email: 'op@talyn.dev' }, signOut: vi.fn() }),
  takePendingLogin: () => false,
  takeReturnPath: () => null,
}));
vi.mock('../components/auth/AdminGate', () => ({
  AdminGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { default: App } = await import('../App');

/**
 * Render at a URL and return the PAGE heading.
 *
 * Scoped to `<main>` deliberately: the sidebar contains every nav label, so a
 * whole-body text assertion would pass for a page that never rendered — the
 * first version of this test "proved" the run-detail route existed by matching
 * the word "Runs" in the sidebar.
 */
function renderAt(path: string): string {
  window.history.pushState({}, '', path);
  render(<App />);
  return document.querySelector('main h1')?.textContent ?? '';
}

afterEach(cleanup);

describe('nav table', () => {
  it('has no duplicate destinations', () => {
    // Two entries on one route is always a mistake — one of them is the
    // rename that did not finish.
    const tos = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to));
    expect(new Set(tos).size).toBe(tos.length);
  });

  it('has no duplicate ids (they are React keys and PostHog data-attrs)', () => {
    const ids = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lands on a route that is itself in the nav', () => {
    // Otherwise the console opens with no sidebar entry highlighted, reading
    // as though nothing is selected.
    const tos = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to));
    expect(tos).toContain(DEFAULT_ROUTE);
  });

  it('links only to routes with no path parameters', () => {
    // A nav item pointing at `/product/users/:userId` would navigate to that
    // literal string.
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(item.to, `${item.label} links to a parameterised route`).not.toContain(':');
      }
    }
  });
});

describe('routes are mounted', () => {
  const navItems = NAV_GROUPS.flatMap((g) => g.items);

  it.each(navItems.map((i) => [i.label, i.to] as const))(
    '%s (%s) renders its own page, not the fallback redirect',
    (label, to) => {
      // `toContain`, because a real page's <h1> may carry a status pill
      // alongside the title.
      expect(renderAt(to)).toContain(label);
    }
  );

  it.each([
    // A real page titles itself after the thing it is showing, so the
    // expected heading IS the path parameter — which incidentally proves the
    // param was parsed rather than the route matching by accident.
    ['a host detail', routeTo(ROUTES.fleetHost, { host: 'hetzner-64' }), 'hetzner-64'],
    ['a run detail', routeTo(ROUTES.fleetRun, { runId: 'talyn-abc' }), 'talyn-abc'],
    ['a user detail', routeTo(ROUTES.user, { userId: 'user-1' }), 'User'],
    ['a workspace detail', routeTo(ROUTES.workspace, { workspaceId: 'ws-1' }), 'Workspace'],
    ['a task detail', routeTo(ROUTES.task, { taskId: 'task-1' }), 'Task'],
  ])('%s route is mounted', (_label, path, heading) => {
    // Drill-ins are ROUTES, not modals — an operator's commonest act is
    // pasting a run id into Slack, and a modal has no URL. So each one has to
    // actually resolve rather than fall through to the redirect.
    expect(renderAt(path)).toContain(heading);
  });

  it('redirects an unknown path to the default route', () => {
    expect(renderAt('/nonsense')).toBe('Hosts');
  });

  it('redirects / to the default route', () => {
    expect(renderAt('/')).toBe('Hosts');
  });
});

describe('routeTo', () => {
  it('substitutes params', () => {
    expect(routeTo(ROUTES.fleetRun, { runId: 'talyn-1' })).toBe('/fleet/runs/talyn-1');
  });

  it('encodes values so an id with a slash cannot forge a path segment', () => {
    expect(routeTo(ROUTES.fleetHost, { host: 'a/b' })).toBe('/fleet/hosts/a%2Fb');
  });
});
