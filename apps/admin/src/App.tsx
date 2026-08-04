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
import { UsersPage } from './routes/product/UsersPage';
import { UserDetailPage } from './routes/product/UserDetailPage';
import { WorkspacesPage } from './routes/product/WorkspacesPage';
import { WorkspaceDetailPage } from './routes/product/WorkspaceDetailPage';
import { TasksPage } from './routes/product/TasksPage';
import { TaskDetailPage } from './routes/product/TaskDetailPage';
import { AuditPage } from './routes/AuditPage';
import { HostsPage } from './routes/fleet/HostsPage';
import { HostDetailPage } from './routes/fleet/HostDetailPage';
import { RunsPage } from './routes/fleet/RunsPage';
import { RunDetailPage } from './routes/fleet/RunDetailPage';
import { GoldensPage } from './routes/fleet/GoldensPage';
import { IncidentsPage } from './routes/fleet/IncidentsPage';

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

            <Route path={ROUTES.fleetHosts} element={<HostsPage />} />
            <Route path={ROUTES.fleetHost} element={<HostDetailPage />} />
            <Route path={ROUTES.fleetRuns} element={<RunsPage />} />
            <Route path={ROUTES.fleetRun} element={<RunDetailPage />} />
            <Route path={ROUTES.fleetGoldens} element={<GoldensPage />} />
            <Route path={ROUTES.fleetIncidents} element={<IncidentsPage />} />

            <Route path={ROUTES.users} element={<UsersPage />} />
            <Route path={ROUTES.user} element={<UserDetailPage />} />
            <Route path={ROUTES.workspaces} element={<WorkspacesPage />} />
            <Route path={ROUTES.workspace} element={<WorkspaceDetailPage />} />
            <Route path={ROUTES.tasks} element={<TasksPage />} />
            <Route path={ROUTES.task} element={<TaskDetailPage />} />

            <Route path={ROUTES.audit} element={<AuditPage />} />
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
