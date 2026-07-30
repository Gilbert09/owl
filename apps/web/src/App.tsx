import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { Toaster } from './components/ui/toaster';
import { AuthCallback } from './routes/AuthCallback';
import { Login } from './routes/Login';
import { Shell } from './routes/Shell';
import { PANEL_PATHS } from './lib/routes';

/**
 * BrowserRouter, not the desktop's MemoryRouter.
 *
 * The desktop declares exactly one route and does all navigation through a
 * zustand `activePanel` enum, which is fine when there's no URL bar. In a
 * browser that costs you shareable links, the back button, and Cmd-R (which
 * would otherwise reset the whole app), so the panels get real paths — see
 * lib/routes.ts.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/*" element={<RequireAuth />} />
        </Routes>
        {/* Outside <Routes> so a toast survives navigation. */}
        <Toaster />
      </AuthProvider>
    </BrowserRouter>
  );
}

function RequireAuth() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;

  return (
    <Routes>
      {/* The desktop's default panel after onboarding. */}
      <Route index element={<Navigate to={PANEL_PATHS.my_prs} replace />} />
      {Object.values(PANEL_PATHS).map((path) => (
        <Route key={path} path={path.slice(1)} element={<Shell />} />
      ))}
      <Route path="*" element={<Navigate to={PANEL_PATHS.my_prs} replace />} />
    </Routes>
  );
}
