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

const container = document.getElementById('root') as HTMLElement;
createRoot(container).render(<App />);
