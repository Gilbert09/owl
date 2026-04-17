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

/**
 * Bootstraps the Supabase auth session and listens for changes. The deep-link
 * handler (`window.electron.auth.onCallback`) feeds access/refresh tokens in
 * when the system browser redirects back to fastowl://auth-callback.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      console.error('Supabase is not configured. Check FASTOWL_SUPABASE_URL / FASTOWL_SUPABASE_ANON_KEY.');
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

    // Bridge: main process forwards `fastowl://auth-callback#...` here.
    const off = window.electron?.auth?.onCallback(async (url: string) => {
      const params = parseHashFromUrl(url);
      const access_token = params.get('access_token');
      const refresh_token = params.get('refresh_token');
      if (access_token && refresh_token) {
        await supabase.auth.setSession({ access_token, refresh_token });
      }
    });

    return () => {
      listener.subscription.unsubscribe();
      off?.();
    };
  }, []);

  async function signInWithGitHub(): Promise<{ error: string | null }> {
    if (!isSupabaseConfigured()) {
      return { error: 'Supabase is not configured' };
    }
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: 'fastowl://auth-callback',
        skipBrowserRedirect: true,
      },
    });
    if (error) return { error: error.message };
    if (!data.url) return { error: 'No OAuth URL returned' };
    // Hand the URL off to the main process, which opens it in the user's
    // default browser. We can't `window.open` — Electron would render it
    // in-process and Supabase/GitHub's cookies wouldn't be available there.
    await window.electron?.auth?.openExternal(data.url);
    return { error: null };
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

/** Supabase returns tokens in the URL hash (not query), so parse that. */
function parseHashFromUrl(url: string): URLSearchParams {
  const hashIdx = url.indexOf('#');
  if (hashIdx < 0) return new URLSearchParams();
  return new URLSearchParams(url.slice(hashIdx + 1));
}
