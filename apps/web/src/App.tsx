import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Analytics } from './components/Analytics';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { LoginScreen } from './components/auth/LoginScreen';
import { MainLayout } from './components/layout/MainLayout';
import { OnboardingWizard } from './components/onboarding/OnboardingWizard';
import { StartingSpinner } from './components/StartingSpinner';
import { Toaster } from './components/ui/toaster';
import { useApiConnection, useInitialDataLoad } from './hooks/useApi';
import { useClosePopupAfterGithub } from './hooks/useClosePopupAfterGithub';
import { useWorkspaceStore } from './stores/workspace';
import { AuthCallback } from './routes/AuthCallback';
import { PANEL_PATHS } from './lib/routes';

/**
 * BrowserRouter, not the desktop's MemoryRouter.
 *
 * The desktop declares a single route and navigates entirely through the
 * store's `activePanel`, which is fine without an address bar. Here the panels
 * get real paths (lib/routes.ts) kept in step with the store by
 * hooks/usePanelUrlSync — so links are shareable, the back button works, and
 * Cmd-R (one keystroke away in a browser) doesn't reset the app.
 *
 * There is no MacDragOverlay and no backend-availability gate. The former is
 * for the macOS frameless title bar; the latter existed because the desktop
 * talks to a backend the user has to start themselves — here the backend is
 * simply a deployed service, and a failed request surfaces through the normal
 * error paths.
 */
export default function App() {
  // Before anything else: if this window is the GitHub-connect popup coming
  // back from the callback, close it rather than booting a second app inside
  // it. Outside the router — it depends only on the URL.
  useClosePopupAfterGithub();

  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/*" element={<RequireAuth />} />
        </Routes>
        {/* Outside <Routes> so a toast survives navigation. */}
        <Toaster />
        {/* Inside AuthProvider — it identifies off the session. */}
        <Analytics />
      </AuthProvider>
    </BrowserRouter>
  );
}

function RequireAuth() {
  const { session, loading } = useAuth();
  if (loading) return <StartingSpinner />;
  if (!session) return <Navigate to="/login" replace />;
  return <AuthedApp />;
}

function AuthedApp() {
  useApiConnection();
  const { loaded } = useInitialDataLoad();
  const onboardingComplete = useWorkspaceStore((s) => s.onboardingComplete);

  // Wait for the first data load to settle before deciding. Otherwise a
  // returning user on fresh localStorage (flag still false) would briefly
  // flash the wizard before the migration in useInitialDataLoad flips it.
  if (!loaded) return <StartingSpinner />;
  if (!onboardingComplete) return <OnboardingWizard />;

  // Every panel path renders the same layout; which panel shows is the
  // store's call, mirrored to the URL by usePanelUrlSync inside MainLayout.
  return (
    <Routes>
      <Route index element={<Navigate to={PANEL_PATHS.my_prs} replace />} />
      {Object.values(PANEL_PATHS).map((path) => (
        <Route key={path} path={path.slice(1)} element={<MainLayout />} />
      ))}
      <Route path="*" element={<Navigate to={PANEL_PATHS.my_prs} replace />} />
    </Routes>
  );
}
