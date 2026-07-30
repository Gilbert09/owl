import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The browser app's build.
 *
 * Env: `import.meta.env.VITE_*`, NOT a `define` of `process.env.*`. Vite's
 * `define` entries are "defined as globals during dev and statically replaced
 * during build" — so a `define` of `process.env.TALYN_API_URL` reaches the dev
 * browser unsubstituted and throws on the missing `process` global. (Verified
 * with a spike before this app existed.) `@talyn/client` reads no env at all —
 * hosts inject it through `configureApiClient` — so the surface is just this
 * app's own entrypoint.
 */
const REQUIRED = [
  'VITE_TALYN_API_URL',
  'VITE_TALYN_SUPABASE_URL',
  'VITE_TALYN_SUPABASE_ANON_KEY',
] as const;

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');

  if (command === 'build' && mode === 'production') {
    // The desktop's "empty → throw at runtime" is a tolerable local-dev
    // failure. On a public URL it's a white screen for every visitor, so fail
    // the build instead.
    const missing = REQUIRED.filter((k) => !(process.env[k] ?? env[k]));
    if (missing.length) {
      throw new Error(
        `Refusing to build the web app without: ${missing.join(', ')}. ` +
          'Set them as Vercel project environment variables.'
      );
    }
    // The bundle is world-readable. The anon key and the PostHog key are
    // publishable by design; a service_role key pasted into the wrong Vercel
    // variable would not be. Cheap insurance against that copy-paste.
    for (const key of REQUIRED) {
      const value = process.env[key] ?? env[key] ?? '';
      if (value.includes('service_role')) {
        throw new Error(`${key} looks like a service_role secret — refusing to build.`);
      }
    }
  }

  // Identify the build without needing another env var set by hand. Vite's
  // config runs in Node, so process.env is genuinely available HERE (unlike
  // in browser code, which is the whole reason the app reads import.meta.env).
  // Vercel sets VERCEL_GIT_COMMIT_SHA; Actions sets GITHUB_SHA.
  // `??` is wrong here: these arrive as EMPTY STRINGS rather than unset.
  // `vercel build --prebuilt` runs after our own checkout, so Vercel injects
  // VERCEL_GIT_COMMIT_SHA with no value — and `??` only falls through on
  // null/undefined, so the version shipped as "web/" with no SHA at all.
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
      // paywall gate. `web/<sha>` can never parse as an old desktop semver,
      // so the fail-closed gate always enforces for this client.
      'import.meta.env.VITE_TALYN_BUILD_SHA': JSON.stringify(sha),
    },
    build: {
      outDir: 'dist',
      // Emitted for PostHog symbolication but never served — see deploy-web.yml.
      sourcemap: 'hidden',
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 5173 },
  };
});
