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
      // LoginScreen renders its own visible warning when this is false —
      // no need to yell in the console (which the test runner flags).
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

    // Bridge: main process forwards `fastowl://auth-callback?...` here.
    // With flowType: 'pkce', Supabase returns a short-lived `code` that
    // we exchange for a session using the verifier it stashed during
    // signInWithOAuth — this verifies the callback came from a flow
    // we actually started and can't be replayed with stolen tokens.
    const off = window.electron?.auth?.onCallback(async (url: string) => {
      const code = extractCodeParam(url);
      if (!code) return;
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.error('auth: exchangeCodeForSession failed:', error.message);
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

/** PKCE callback returns `?code=…` on the query string. */
function extractCodeParam(url: string): string | null {
  try {
    // fastowl://auth-callback?code=... — URL parses custom schemes fine.
    const u = new URL(url);
    return u.searchParams.get('code');
  } catch {
    return null;
  }
}
