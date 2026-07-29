import { configureApiClient } from '@talyn/client';
import { getSupabase, isSupabaseConfigured } from './supabase';
import { setLogoutReason } from './logoutReason';

/**
 * The desktop's binding of the shared backend client.
 *
 * The transport itself — every route, the WS client, the 401-retry — lives in
 * `@talyn/client` so the desktop renderer and the browser app can't drift
 * apart on the backend contract. All that's left here is the two things only
 * this host knows: where the backend is (webpack `EnvironmentPlugin` bakes
 * `TALYN_*` in at build time) and how a session is stored (Supabase, behind
 * the Electron safeStorage bridge).
 *
 * Everything is re-exported below, so the ~40 files that `import { api, … }
 * from '../lib/api'` are unaffected by the move.
 */
configureApiClient({
  // Falls back to local dev so a fresh checkout Just Works.
  baseUrl: process.env.TALYN_API_URL || 'http://localhost:4747',
  // Baked at build time; 'dev' in unbuilt dev runs. The backend's paywall
  // exemption is fail-closed, so 'dev' enforces — which is correct, a build
  // off current main renders the upgrade flow fine.
  clientVersion: process.env.TALYN_APP_VERSION || 'dev',

  getAccessToken: async () => {
    if (!isSupabaseConfigured()) return null;
    const { data } = await getSupabase().auth.getSession();
    return data.session?.access_token ?? null;
  },

  /**
   * A 401 is NOT proof the session is dead — the 2026-07-07 mass logout was
   * the backend 401ing perfectly valid tokens while its Supabase check was
   * down. So instead of signing out on sight, ask the auth server for a fresh
   * access token:
   *   - refresh succeeds → session fine, caller retries the request once
   *   - auth server explicitly rejects the refresh token (4xx) → the session
   *     really is unrecoverable → sign out (local scope: a revocation call
   *     from a dead session would be rejected anyway)
   *   - refresh fails any other way (offline, 5xx, timeout) → transient;
   *     keep the session and let the request error surface
   * @talyn/client dedupes concurrent calls, so a burst of failing polls can't
   * stampede the single-use, rotating refresh token.
   */
  recoverSession: async () => {
    if (!isSupabaseConfigured()) return false;
    const { data, error } = await getSupabase().auth.refreshSession();
    if (data.session) return true;
    const status = (error as { status?: number } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      setLogoutReason('api_401_refresh_rejected');
      await getSupabase().auth.signOut({ scope: 'local' });
    }
    return false;
  },
});

export * from '@talyn/client';
