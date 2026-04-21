import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Injected at webpack build time via EnvironmentPlugin — see
// .erb/configs/webpack.config.renderer.{dev,prod}.ts. Empty strings mean
// the operator forgot to set them in their shell env; we surface a loud
// runtime error instead of a silent "invalid URL" crash.
const SUPABASE_URL = process.env.FASTOWL_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.FASTOWL_SUPABASE_ANON_KEY || '';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      'FASTOWL_SUPABASE_URL and FASTOWL_SUPABASE_ANON_KEY must be set when the desktop app is built. See docs/SETUP.md.'
    );
  }
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Electron renderer's localStorage is persisted to disk — survives
      // app restarts. No need for custom safeStorage plumbing for MVP.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false, // We handle the deep link ourselves.
      // PKCE gives us a `code` on the callback that we exchange for a
      // session server-side via the stored code_verifier. Drops the
      // implicit flow (access_token in URL hash) so a crafted deep link
      // can't fixate a session with attacker-supplied tokens.
      flowType: 'pkce',
    },
  });
  return client;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
