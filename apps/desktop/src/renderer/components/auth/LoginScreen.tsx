import { useState } from 'react';
import { useAuth } from './AuthProvider';
import { isSupabaseConfigured } from '../../lib/supabase';

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
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="w-full max-w-sm p-8 space-y-6 rounded-lg border bg-card shadow-sm">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">FastOwl</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to continue. Your tasks, workspaces, and environments stay on your account.
          </p>
        </div>

        {!configured && (
          <div className="p-3 rounded-md border border-destructive/50 bg-destructive/10 text-sm text-destructive">
            Supabase isn't configured in this build. Set <code>FASTOWL_SUPABASE_URL</code> and
            <code>FASTOWL_SUPABASE_ANON_KEY</code> then rebuild the desktop app.
          </div>
        )}

        <button
          type="button"
          className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onClick}
          disabled={busy || !configured}
        >
          {busy ? 'Opening browser…' : 'Sign in with GitHub'}
        </button>

        {error && (
          <div className="text-sm text-destructive">{error}</div>
        )}

        <p className="text-xs text-muted-foreground text-center">
          A browser window will open to authenticate you. You'll be returned to FastOwl automatically.
        </p>
      </div>
    </div>
  );
}
