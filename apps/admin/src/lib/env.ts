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
 * fail-closed and only exempts a bare `X.Y.Z` below its floor — an
 * `admin/<sha>` value can never be mistaken for an old desktop semver, so this
 * client is always enforced. The `dev` fallback is equally unparseable, so the
 * gate stays closed even on a build with no SHA.
 */
export const CLIENT_VERSION = `admin/${import.meta.env.VITE_TALYN_BUILD_SHA ?? 'dev'}`;

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/** A local dev build rather than the deployed console. See hooks/useIsDevBuild. */
export const IS_DEV_BUILD = import.meta.env.DEV;

/**
 * The version string surfaced in the sidebar. Continuously deployed, so the
 * build SHA is the only meaningful identifier — and the one the audit log's
 * rows should be readable against.
 */
export const APP_VERSION = CLIENT_VERSION;

/**
 * The backend host, for the environment badge.
 *
 * This console has destructive cross-tenant mutations, so "which backend am I
 * pointed at" needs to be legible at a glance rather than inferable from the
 * URL bar. Returns the host, or the raw value if it will not parse.
 */
export function apiHost(): string {
  try {
    return new URL(API_URL).host;
  } catch {
    return API_URL;
  }
}

/** The one backend where a mistake is a production incident. */
export const PRODUCTION_API_HOST = 'prod.talyn.dev';

export function isProductionApi(): boolean {
  return apiHost() === PRODUCTION_API_HOST;
}
