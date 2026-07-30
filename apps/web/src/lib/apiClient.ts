import { configureApiClient } from '@talyn/client';
import { API_URL, CLIENT_VERSION } from './env';
import { getSupabase, isSupabaseConfigured } from './supabase';

/**
 * The browser app's binding of the shared backend client.
 *
 * The transport itself — every route, the WS client, the 401 retry — lives in
 * `@talyn/client`, shared with the desktop so the two can't drift apart on the
 * backend contract. Only the host-specific bits live here.
 *
 * Imported for side effect from main.tsx, before anything renders.
 */
configureApiClient({
  baseUrl: API_URL,
  clientVersion: CLIENT_VERSION,

  getAccessToken: async () => {
    if (!isSupabaseConfigured()) return null;
    const { data } = await getSupabase().auth.getSession();
    return data.session?.access_token ?? null;
  },

  /**
   * A 401 is NOT proof the session is dead — the 2026-07-07 mass logout was
   * the backend 401ing perfectly valid tokens while its Supabase check was
   * down. Refresh first; sign out only when the auth server explicitly
   * rejects the refresh token, and treat offline/5xx/timeout as transient.
   * @talyn/client dedupes concurrent calls, so a burst of failing polls can't
   * stampede the single-use rotating refresh token.
   */
  recoverSession: async () => {
    if (!isSupabaseConfigured()) return false;
    const { data, error } = await getSupabase().auth.refreshSession();
    if (data.session) return true;
    const status = (error as { status?: number } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      await getSupabase().auth.signOut({ scope: 'local' });
    }
    return false;
  },
});
