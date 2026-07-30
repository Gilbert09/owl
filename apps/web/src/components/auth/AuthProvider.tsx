import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signInWithGitHub: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Where to send the user back after sign-in, stashed across the redirect. */
const RETURN_TO_KEY = 'talyn:post-login-path';
/**
 * Marks that a sign-in is in flight across the OAuth redirect.
 *
 * The desktop can tell a fresh login from a restored session by watching its
 * userId go null → set, because its OAuth happens in the system browser and
 * the app never reloads. On web the redirect is a full page navigation, so
 * that in-memory transition is destroyed — without this marker `logged_in`
 * would never be captured at all. sessionStorage (not local) so it dies with
 * the tab rather than mislabelling a later session restore.
 */
const PENDING_LOGIN_KEY = 'talyn:pending-login';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setLoading(false);
      return;
    }
    const supabase = getSupabase();

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next ?? null);
    });

    // No deep-link subscription. The desktop bridges fastowl://auth-callback
    // from the main process and calls exchangeCodeForSession by hand; here
    // `detectSessionInUrl: true` reads ?code= off window.location itself,
    // exchanges it with the stored PKCE verifier, and strips the param.
    return () => listener.subscription.unsubscribe();
  }, []);

  async function signInWithGitHub(): Promise<{ error: string | null }> {
    if (!isSupabaseConfigured()) return { error: 'Supabase is not configured' };

    // Come back to wherever they were, not always the default panel.
    const { pathname, search } = window.location;
    if (pathname !== '/login' && pathname !== '/auth/callback') {
      sessionStorage.setItem(RETURN_TO_KEY, pathname + search);
    }
    sessionStorage.setItem(PENDING_LOGIN_KEY, '1');

    const { error } = await getSupabase().auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        // Deliberately NOT skipBrowserRedirect. The desktop sets it and hands
        // the URL to the main process to open in the system browser. Here we
        // let supabase-js navigate THIS tab: a same-tab navigation needs no
        // user activation, so it cannot be popup-blocked. The desktop's
        // window.open fallback fires after two awaits, by which point
        // activation is gone and Safari/Firefox block it — on the sign-in
        // screen, silently. Verified with a spike before this app existed.
      },
    });
    // On success the browser has already navigated away; only a failure to
    // *start* the flow returns here.
    return { error: error?.message ?? null };
  }

  async function signOut(): Promise<void> {
    if (!isSupabaseConfigured()) return;
    await getSupabase().auth.signOut();
  }

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    loading,
    signInWithGitHub,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * True exactly once, on the first identify after a sign-in this tab started.
 * A restored session returns false, so `logged_in` counts logins rather than
 * page loads.
 */
export function takePendingLogin(): boolean {
  const pending = sessionStorage.getItem(PENDING_LOGIN_KEY) === '1';
  if (pending) sessionStorage.removeItem(PENDING_LOGIN_KEY);
  return pending;
}

export function takeReturnPath(): string | null {
  const path = sessionStorage.getItem(RETURN_TO_KEY);
  if (path) sessionStorage.removeItem(RETURN_TO_KEY);
  return path;
}
