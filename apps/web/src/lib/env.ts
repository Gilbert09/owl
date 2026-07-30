/**
 * Build-time config.
 *
 * `import.meta.env.VITE_*`, NOT `process.env.*`. Vite's `define` entries are
 * "defined as globals during dev and statically replaced during build", so a
 * `define` of `process.env.TALYN_API_URL` reaches the dev browser
 * unsubstituted and throws on the missing `process` global — the desktop's
 * webpack EnvironmentPlugin pattern does not port. `vite.config.ts` fails a
 * production build outright when any of these is empty.
 */
export const SUPABASE_URL = import.meta.env.VITE_TALYN_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = import.meta.env.VITE_TALYN_SUPABASE_ANON_KEY ?? '';
export const API_URL = import.meta.env.VITE_TALYN_API_URL ?? 'http://localhost:4747';
export const POSTHOG_KEY = import.meta.env.VITE_TALYN_POSTHOG_KEY ?? '';
export const POSTHOG_HOST =
  import.meta.env.VITE_TALYN_POSTHOG_HOST ?? 'https://us.i.posthog.com';

/**
 * Namespaced on purpose. This becomes `X-Talyn-Client-Version`, which the
 * backend's paywall gate parses (services/billing/clientGate.ts). That gate is
 * fail-closed and only exempts a bare `X.Y.Z` below its floor — a `web/<sha>`
 * value can never be mistaken for an old desktop semver, so the web app is
 * always enforced.
 */
export const CLIENT_VERSION = `web/${import.meta.env.VITE_TALYN_BUILD_SHA ?? 'dev'}`;

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
