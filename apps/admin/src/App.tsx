import { type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { AdminGate } from './components/auth/AdminGate';
import { LoginScreen } from './components/auth/LoginScreen';
import { AuthCallback } from './routes/AuthCallback';
import { AdminLayout } from './components/layout/AdminLayout';
import { StartingSpinner } from './components/StartingSpinner';
import { Analytics } from './components/Analytics';
import { DEFAULT_ROUTE, ROUTES } from './lib/routes';
import { Placeholder } from './routes/Placeholder';

/**
 * Plain react-router, deliberately — NOT the product apps' zustand store plus
 * `usePanelUrlSync`.
 *
 * That hook's own docblock gives its reasons, and every one of them is absent
 * here: there is no desktop twin to stay source-compatible with, no onboarding
 * wizard, and no debug-mode toggle to bounce off (this console is where the
 * debug panel moves TO). The load-bearing one is the last: `useWorkspaceStore`
 * exists because ~40 product components need `currentWorkspaceId`. An admin
 * console is cross-tenant by definition, so there is no ambient selection to
 * hold — and a global store with no job is a race waiting to happen, which is
 * exactly what that hook's docblock records happening.
 *
 * `PANEL_PATHS` also cannot express what this app needs. It is a flat map of
 * static paths (`as const satisfies Record<ActivePanel, string>`) with an
 * exact-string reverse lookup; this app has `/fleet/runs/:runId` and
 * `?status=&host=` filter state. Retrofitting params means either abandoning
 * the `satisfies` guarantee or running two routing systems side by side.
 *
 * What we give up is the compile-time guarantee that every nav entry has a
 * MOUNTED route (typing `NavItem.to` as `RoutePath` recovers half of it).
 * `__tests__/sidebarNav.test.tsx` is the runtime replacement.
 *
 * One flat `<Routes>` rather than a nested one, so every path here is absolute
 * and matches `ROUTES` character for character — a nested router would make
 * these relative and quietly break that correspondence.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Analytics />
        <Routes>
          <Route path={ROUTES.login} element={<LoginScreen />} />
          <Route path={ROUTES.authCallback} element={<AuthCallback />} />

          {/* The console. RequireAuth and AdminGate wrap the LAYOUT, so a
              refusal renders instead of it — no page mounts, no query fires,
              and useWsConnection (inside AdminLayout) never opens a socket. */}
          <Route
            element={
              <RequireAuth>
                <AdminGate>
                  <AdminLayout />
                </AdminGate>
              </RequireAuth>
            }
          >
            <Route path="/" element={<Navigate to={DEFAULT_ROUTE} replace />} />

            <Route path={ROUTES.fleetHosts} element={<Placeholder title="Hosts" />} />
            <Route path={ROUTES.fleetHost} element={<Placeholder title="Host" />} />
            <Route path={ROUTES.fleetRuns} element={<Placeholder title="Runs" />} />
            <Route path={ROUTES.fleetRun} element={<Placeholder title="Run" />} />
            <Route path={ROUTES.fleetGoldens} element={<Placeholder title="Goldens" />} />
            <Route path={ROUTES.fleetIncidents} element={<Placeholder title="Incidents" />} />

            <Route path={ROUTES.users} element={<Placeholder title="Users" />} />
            <Route path={ROUTES.user} element={<Placeholder title="User" />} />
            <Route path={ROUTES.workspaces} element={<Placeholder title="Workspaces" />} />
            <Route path={ROUTES.workspace} element={<Placeholder title="Workspace" />} />
            <Route path={ROUTES.tasks} element={<Placeholder title="Tasks" />} />
            <Route path={ROUTES.task} element={<Placeholder title="Task" />} />

            <Route path={ROUTES.audit} element={<Placeholder title="Audit log" />} />
            {/* ROUTES.debug is mounted in the same change that moves the panel
                out of apps/web and apps/desktop. */}

            <Route path="*" element={<Navigate to={DEFAULT_ROUTE} replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <StartingSpinner />;
  if (!session) return <Navigate to={ROUTES.login} replace />;
  return <>{children}</>;
}
