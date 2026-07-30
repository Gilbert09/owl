import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, takeReturnPath } from '../components/auth/AuthProvider';

/**
 * Landing route for Supabase's OAuth redirect.
 *
 * `detectSessionInUrl: true` does the exchange, so this mostly waits for the
 * session to appear and then gets out of the way. It exists as its own route
 * for two reasons: the redirect target has to be an exact URL on Supabase's
 * allowlist, and `detectSessionInUrl` fires on ANY page load carrying a
 * `?code=` param — keeping that to one dedicated path means no other route
 * can accidentally trigger an exchange.
 *
 * The explicit error handling matters because detectSessionInUrl swallows
 * failures into a console warning. Without this, "GitHub said no" would be an
 * indefinite spinner.
 */
export function AuthCallback() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const providerError = params.get('error_description') || params.get('error');
    if (providerError) {
      setError(providerError);
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(true), 15_000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (session) navigate(takeReturnPath() ?? '/prs', { replace: true });
  }, [session, navigate]);

  if (error || timedOut) {
    return (
      <Centered>
        <h1 className="font-display text-lg font-semibold text-destructive">
          Sign-in failed
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {error ?? 'The sign-in did not complete. Please try again.'}
        </p>
        <button
          onClick={() => navigate('/login', { replace: true })}
          className="mt-5 rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
        >
          Back to sign in
        </button>
      </Centered>
    );
  }

  return (
    <Centered>
      <p className="text-sm text-muted-foreground">
        {loading ? 'Signing you in…' : 'Finishing sign-in…'}
      </p>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background px-6 text-center">
      <div>{children}</div>
    </div>
  );
}
