import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The operator console's build. A fork of apps/web's, and the constraints it
 * documents apply here identically.
 *
 * Env: `import.meta.env.VITE_*`, NOT a `define` of `process.env.*`. Vite's
 * `define` entries are "defined as globals during dev and statically replaced
 * during build" — so a `define` of `process.env.TALYN_API_URL` reaches the dev
 * browser unsubstituted and throws on the missing `process` global. The
 * desktop's webpack EnvironmentPlugin pattern does not port.
 */
const REQUIRED = [
  'VITE_TALYN_API_URL',
  'VITE_TALYN_SUPABASE_URL',
  'VITE_TALYN_SUPABASE_ANON_KEY',
] as const;

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');

  if (command === 'build' && mode === 'production') {
    // A white screen on a public URL is much worse than the desktop's
    // runtime throw, so fail the build rather than ship a broken bundle.
    const missing = REQUIRED.filter((k) => !(process.env[k] ?? env[k]));
    if (missing.length) {
      throw new Error(
        `Refusing to build the admin console without: ${missing.join(', ')}. ` +
          'Set them as Vercel project environment variables.'
      );
    }
    // The bundle is world-readable. The anon key is publishable by design; a
    // service_role key pasted into the wrong Vercel variable would not be —
    // and on THIS app that key would sit next to a cross-tenant console.
    for (const key of REQUIRED) {
      const value = process.env[key] ?? env[key] ?? '';
      if (value.includes('service_role')) {
        throw new Error(`${key} looks like a service_role secret — refusing to build.`);
      }
    }
  }

  // `??` is wrong here: these arrive as EMPTY STRINGS rather than unset.
  // `vercel build --prebuilt` runs after our own checkout, so Vercel injects
  // VERCEL_GIT_COMMIT_SHA with no value — and `??` only falls through on
  // null/undefined, so the web app once shipped as "web/" with no SHA at all.
  // Here the cost is worse than cosmetic: without a SHA you cannot tell which
  // build performed a mutation recorded in the audit log.
  const sha =
    [
      process.env.VITE_TALYN_BUILD_SHA,
      process.env.VERCEL_GIT_COMMIT_SHA,
      process.env.GITHUB_SHA,
      env.VITE_TALYN_BUILD_SHA,
    ]
      .find((v) => typeof v === 'string' && v.trim() !== '')
      ?.slice(0, 7) ?? 'dev';

  return {
    plugins: [react()],
    define: {
      // Feeds CLIENT_VERSION → X-Talyn-Client-Version → the backend's
      // paywall gate. `admin/<sha>` can never parse as a desktop semver, so
      // the fail-closed gate always enforces for this client.
      'import.meta.env.VITE_TALYN_BUILD_SHA': JSON.stringify(sha),
    },
    build: {
      outDir: 'dist',
      sourcemap: 'hidden',
    },
    // 5174, not 5173: apps/web sets `strictPort: true` on 5173, so sharing it
    // is a hard startup failure rather than a silent fallback — and running
    // both at once is the normal case while porting a panel across.
    server: { port: 5174, strictPort: true },
    preview: { port: 5174 },
  };
});
