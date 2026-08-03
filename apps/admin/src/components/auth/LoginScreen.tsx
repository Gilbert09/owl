import { useState } from 'react';
import { useAuth } from './AuthProvider';
import { isSupabaseConfigured } from '../../lib/supabase';
import { BlinkingOwl } from '../widgets/BlinkingOwl';
import { EnvironmentBadge } from '../layout/EnvironmentBadge';

/**
 * Sign-in for the operator console.
 *
 * The GitHub button goes through `signInWithGitHub`, which is a FULL-PAGE
 * REDIRECT (no `skipBrowserRedirect`) — the desktop's `window.open` fallback
 * fires after two awaits, has lost user activation by then, and gets blocked
 * silently by Safari and Firefox. A same-tab navigation cannot be popup-
 * blocked.
 *
 * The copy says "operators" up front so a customer who lands here knows they
 * are in the wrong place before signing in, rather than after.
 */
export function LoginScreen() {
  const { signInWithGitHub } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = isSupabaseConfigured();

  async function onClick() {
    setError(null);
    setBusy(true);
    const res = await signInWithGitHub();
    if (res.error) setError(res.error);
    setBusy(false);
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        <div className="space-y-2 text-center">
          <div className="flex justify-center pb-1">
            <BlinkingOwl />
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Talyn Admin</h1>
          <p className="text-sm text-muted-foreground">
            Operator access only. Sign in with the GitHub account on the admin allow-list.
          </p>
          {/* Which backend, before you sign in — the same reason it is in the
              sidebar, but it matters most here: the sign-in you are about to
              do is against whichever Supabase project this build points at. */}
          <div className="flex justify-center pt-1">
            <EnvironmentBadge />
          </div>
        </div>

        {!configured && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            Supabase isn't configured in this build. Set{' '}
            <code>VITE_TALYN_SUPABASE_URL</code> and{' '}
            <code>VITE_TALYN_SUPABASE_ANON_KEY</code> and redeploy.
          </div>
        )}

        <button
          type="button"
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onClick}
          disabled={busy || !configured}
        >
          {busy ? 'Redirecting…' : 'Sign in with GitHub'}
        </button>

        {error && <div className="text-sm text-destructive">{error}</div>}
      </div>
    </div>
  );
}
