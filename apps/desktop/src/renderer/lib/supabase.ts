import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  createAuthStorageAdapter,
  migrateLegacyAuthFromLocalStorage,
} from './authStorage';

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
  // Session lives behind Electron safeStorage (via the preload bridge),
  // not localStorage. Any pre-existing plaintext session from older
  // builds is copied across and wiped on first access.
  const bridge = window.electron?.auth?.storage;
  if (!bridge) {
    throw new Error(
      'Electron auth storage bridge missing — preload did not load. Rebuild the desktop app.'
    );
  }
  void migrateLegacyAuthFromLocalStorage(bridge, window.localStorage);
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false, // We handle the deep link ourselves.
      // PKCE gives us a `code` on the callback that we exchange for a
      // session server-side via the stored code_verifier. Drops the
      // implicit flow (access_token in URL hash) so a crafted deep link
      // can't fixate a session with attacker-supplied tokens.
      flowType: 'pkce',
      storage: createAuthStorageAdapter(bridge),
    },
  });
  return client;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
