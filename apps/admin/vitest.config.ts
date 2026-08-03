import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate from vite.config.ts on purpose: that one refuses to load without
// the VITE_TALYN_* build vars (deliberately — a production build must not
// silently ship a broken bundle), and tests should not need deploy config.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
