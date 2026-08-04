/**
 * Build-time env validation for the browser app.
 *
 * A standalone module with NO Vite imports, so a unit test can exercise it
 * without dragging esbuild into jsdom — which matters, because this is the
 * check that has already failed once in production and needs to stay tested.
 */
const REQUIRED = [
  'VITE_TALYN_API_URL',
  'VITE_TALYN_SUPABASE_URL',
  'VITE_TALYN_SUPABASE_ANON_KEY',
] as const;

/**
 * Refuse to build with env that is present but unusable.
 *
 * Exported and tested (`src/__tests__/buildEnv.test.ts`) because the first
 * version of this check — "is it non-empty?" — passed on a build that shipped
 * a white screen, which is the exact outcome it exists to prevent.
 *
 * The value that got through was Vercel's `[SENSITIVE]` placeholder: an env
 * var marked Sensitive cannot be decrypted by `vercel pull`, so the CLI writes
 * that literal string and the bundle bakes it in. `isSupabaseConfigured()` then
 * sees two non-empty strings, returns true, and `createClient("[SENSITIVE]")`
 * throws "Invalid supabaseUrl" during the first render.
 *
 * So: presence is not enough. Check the value is the KIND of thing it claims
 * to be.
 */
export function assertUsableBuildEnv(read: (key: string) => string | undefined): void {
  const problems: string[] = [];

  for (const key of REQUIRED) {
    const value = (read(key) ?? '').trim();

    if (!value) {
      problems.push(`${key} is empty`);
      continue;
    }
    // Vercel's placeholder for an env var marked "Sensitive". Unmark it in the
    // project settings — a build cannot read a sensitive variable.
    if (value === '[SENSITIVE]') {
      problems.push(
        `${key} is Vercel's "[SENSITIVE]" placeholder — the variable is marked Sensitive, ` +
          'so `vercel pull` cannot read it. Unmark it in the Vercel project settings.'
      );
      continue;
    }
    // The bundle is world-readable. The anon key is publishable by design; a
    // service_role key pasted into the wrong variable would not be.
    if (value.includes('service_role')) {
      problems.push(`${key} looks like a service_role secret`);
      continue;
    }
    if (URL_KEYS.has(key) && !isHttpUrl(value)) {
      problems.push(`${key} is not an http(s) URL (got ${JSON.stringify(value.slice(0, 40))})`);
    }
  }

  if (problems.length) {
    throw new Error(
      `Refusing to build the web app:\n  - ${problems.join('\n  - ')}\n` +
        'Set these as Vercel project environment variables (Production scope, NOT Sensitive).'
    );
  }
}

const URL_KEYS = new Set<string>(['VITE_TALYN_API_URL', 'VITE_TALYN_SUPABASE_URL']);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
