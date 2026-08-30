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
 * Namespaced on purpose: this becomes `X-Talyn-Client-Version`, and a
 * `web/<sha>` value says which client and which build without being mistakable
 * for a desktop release number. It carries no entitlement — the backend's
 * free-plan gates read nothing from it.
 */
export const CLIENT_VERSION = `web/${import.meta.env.VITE_TALYN_BUILD_SHA ?? 'dev'}`;

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/** A local dev build rather than the deployed app. See hooks/useIsDevBuild. */
export const IS_DEV_BUILD = import.meta.env.DEV;

/**
 * The version string surfaced in Settings → About. The desktop gets a real
 * semver from the packaged app; the web app is continuously deployed, so the
 * build SHA is the only meaningful identifier.
 */
export const APP_VERSION = CLIENT_VERSION;

/**
 * The `LocalSkillFile` shape the desktop reads from `~/.claude/skills`.
 * Declared here rather than imported from the desktop's `main/preload`, which
 * imports `electron`. The web app can never populate these — there is no
 * filesystem — but the type is still referenced by the shared skills code
 * paths, which always receive an empty list here.
 */
/**
 * False on the web: reading `~/.claude/skills` needs a filesystem. The UI
 * uses this to omit the "On this machine" group entirely rather than render a
 * group that is permanently empty. Platform and repo skills work normally.
 */
export const HAS_LOCAL_SKILLS = false;

export interface LocalSkillFile {
  dirName: string;
  /** Absolute path of SKILL.md on this machine. */
  path: string;
  size: number;
  mtimeMs: number;
  /** Raw file text; null when the file exceeds the size guard. */
  content: string | null;
}
