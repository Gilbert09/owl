import { createContext, useContext, type ReactNode } from 'react';
import { ShieldAlert, WifiOff } from 'lucide-react';
import type { AdminAccess, AdminCapability } from '@talyn/shared';
import { useAdminAccess } from '../../hooks/useAdminAccess';
import { useAuth } from './AuthProvider';
import { StartingSpinner } from '../StartingSpinner';
import { BlinkingOwl } from '../widgets/BlinkingOwl';

/**
 * THIS GATE IS COSMETIC. The security boundary is the server.
 *
 * Say it plainly so nobody later mistakes this component for the thing keeping
 * non-operators out, and "simplifies" the backend on that basis:
 *
 *   - `requireAdmin` (packages/backend/src/middleware/auth.ts) 403s every
 *     route under /api/v1/admin except /admin/me.
 *   - The WS side is gated separately — services/websocket.ts checks isAdmin
 *     both when fanning out `debug:event` and when handling `debug:filter` —
 *     so even a hand-crafted socket gets nothing.
 *   - `users.is_admin` is a real column, granted only via TALYN_ADMIN_EMAILS
 *     (promote-only, at login) or by hand in SQL. No route can self-promote.
 *
 * A non-admin who bookmarks this console and flips the gate in devtools sees a
 * shell where every single request 403s. That is the design, not a gap.
 *
 * What the gate IS for: nothing mounts behind it. On a refusal we render
 * instead of, not alongside, the layout — so no page component mounts, no
 * query fires, and the WS never connects. A non-operator's browser makes
 * exactly one authenticated request: the access check itself, which is the one
 * endpoint deliberately not admin-gated.
 */

const AccessContext = createContext<AdminAccess | null>(null);

/** The operator's access record. Only callable inside the gate. */
export function useAccess(): AdminAccess {
  const value = useContext(AccessContext);
  if (!value) throw new Error('useAccess() used outside AdminGate');
  return value;
}

/**
 * Whether this deploy permits a capability.
 *
 * Used to hide a button the server would refuse. It is the UI's COPY of the
 * answer — the server re-checks every one of these on the call itself — which
 * is exactly why it is safe for it to be wrong.
 */
export function useCapability(capability: AdminCapability): boolean {
  return useAccess().capabilities.includes(capability);
}

export function AdminGate({ children }: { children: ReactNode }) {
  const { state, access, error, retry } = useAdminAccess();

  if (state === 'checking') return <StartingSpinner />;
  if (state === 'error') return <AccessCheckFailed error={error} onRetry={retry} />;
  if (state === 'denied' || !access) return <NotAdminScreen />;

  return <AccessContext.Provider value={access}>{children}</AccessContext.Provider>;
}

/**
 * The server said no.
 *
 * Not an error — a signed-in customer landing here has done nothing wrong, so
 * the copy points them at the product rather than alarming them.
 */
export function NotAdminScreen() {
  const { user, signOut } = useAuth();
  return (
    <Centered>
      <div className="flex justify-center pb-2">
        <BlinkingOwl />
      </div>
      <ShieldAlert className="mx-auto h-6 w-6 text-muted-foreground" />
      <h1 className="mt-3 font-display text-lg font-semibold">Operators only</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This console is for the Talyn team.
        {user?.email ? ` You're signed in as ${user.email}.` : ''}
      </p>
      <div className="mt-5 flex items-center justify-center gap-3">
        <a
          href="https://app.talyn.dev"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Go to Talyn
        </a>
        <button
          onClick={() => void signOut()}
          className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
        >
          Sign out
        </button>
      </div>
    </Centered>
  );
}

/**
 * We never got an answer.
 *
 * Kept rigorously distinct from NotAdminScreen. Telling an operator "you are
 * not an operator" because the backend was restarting is both wrong and
 * alarming, and it is precisely the bug apps/web's offlineBanner test was
 * written to prevent elsewhere.
 */
export function AccessCheckFailed({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Centered>
      <WifiOff className="mx-auto h-6 w-6 text-muted-foreground" />
      <h1 className="mt-3 font-display text-lg font-semibold">Couldn't verify your access</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The backend didn't answer. This is not a sign that your access changed.
      </p>
      {error && (
        <p className="mt-2 break-words font-mono text-xs text-muted-foreground/80">{error}</p>
      )}
      <button
        onClick={onRetry}
        className="mt-5 rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
      >
        Try again
      </button>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background px-6 text-center">
      <div className="max-w-sm">{children}</div>
    </div>
  );
}
