import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from './env';

let client: SupabaseClient | null = null;

/**
 * The browser's Supabase client. Three deliberate differences from the
 * desktop's (apps/desktop/src/renderer/lib/supabase.ts):
 *
 *  - `detectSessionInUrl: true`. The desktop sets false and handles the
 *    `fastowl://auth-callback` deep link itself. Here supabase-js reads
 *    `?code=` off window.location, exchanges it with the verifier it stashed
 *    during signInWithOAuth, and strips the param via history.replaceState.
 *
 *  - `storage` is the localStorage default rather than the Electron
 *    safeStorage bridge. This IS a real security downgrade — the desktop
 *    keeps the refresh token where the renderer cannot read it, so an XSS
 *    there can't exfiltrate a session, and here it can. The mitigations are
 *    the strict CSP (vercel.json) and the sanitised markdown pipeline; see
 *    the Security section of the plan.
 *
 *  - No `migrateLegacyAuthFromLocalStorage`. On web the "bridge" IS
 *    localStorage, so that helper's setItem-then-removeItem on the same key
 *    would wipe the session on every page load.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  if (!isSupabaseConfigured()) {
    throw new Error(
      'VITE_TALYN_SUPABASE_URL and VITE_TALYN_SUPABASE_ANON_KEY must be set at build time.'
    );
  }
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // PKCE gives us a short-lived `code` on the callback that we exchange
      // using the stored verifier, so a crafted callback URL can't fixate a
      // session with attacker-supplied tokens.
      flowType: 'pkce',
    },
  });
  return client;
}

export { isSupabaseConfigured };
