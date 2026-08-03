import { createRoot } from 'react-dom/client';
// Bundled brand fonts (self-hosted, so font-src can stay 'self') — body Inter,
// display Space Grotesk, mono JetBrains.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './app.css';
// Imported for SIDE EFFECT, and it must come before anything that calls the
// API: it is the one configureApiClient() call, and @talyn/client throws a
// clear error if a request is made before it runs.
import './lib/apiClient';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initAnalytics } from './lib/analytics';

// Before first render. No-op unless VITE_TALYN_POSTHOG_KEY was set at build
// time. Note this console runs with autocapture and session replay OFF — see
// lib/analytics for why.
initAnalytics();

const container = document.getElementById('root') as HTMLElement;
createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
