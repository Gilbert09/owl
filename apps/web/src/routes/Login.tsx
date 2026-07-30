import { useState } from 'react';
import { Github } from 'lucide-react';
import { useAuth } from '../components/auth/AuthProvider';
import { isSupabaseConfigured } from '../lib/supabase';

export function Login() {
  const { signInWithGitHub } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await signInWithGitHub();
    // On success the tab has already navigated to GitHub, so reaching here at
    // all means the flow failed to start.
    if (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-background px-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="font-display text-2xl font-semibold">Talyn</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Mission control for your pull requests.
        </p>

        {!isSupabaseConfigured() ? (
          <p className="mt-8 rounded-md border border-destructive/40 p-4 text-sm text-destructive">
            Auth is not configured for this build — VITE_TALYN_SUPABASE_URL and
            VITE_TALYN_SUPABASE_ANON_KEY are missing.
          </p>
        ) : (
          <button
            onClick={onClick}
            disabled={busy}
            className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Github className="h-4 w-4" />
            {busy ? 'Redirecting…' : 'Continue with GitHub'}
          </button>
        )}

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
