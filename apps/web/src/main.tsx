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
import './lib/apiClient';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initAnalytics } from './lib/analytics';

// Before first render, so session replay and autocapture cover the whole
// session. No-op unless VITE_TALYN_POSTHOG_KEY was set at build time.
initAnalytics();

const container = document.getElementById('root') as HTMLElement;
createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
