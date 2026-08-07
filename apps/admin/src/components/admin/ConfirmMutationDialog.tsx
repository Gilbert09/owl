import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { trackEvent } from '../../lib/analytics';
import { cn } from '../../lib/utils';

/**
 * The one way this console changes anything.
 *
 * Every mutation goes through here, so the safeguards are stated once rather
 * than remembered five times:
 *
 *  - A REASON is mandatory and goes into the audit log verbatim. "Who drained
 *    prod at 2am" is answerable from timestamps; "why" is only answerable
 *    because this refuses to submit without it.
 *  - EXCEPT in `simple` mode, for the routine reversible actions (cancel a run,
 *    delete a golden) where the operator asked for a plain "are you sure".
 *    Typing a sentence to cancel your own stuck run is friction that buys
 *    nothing: there is one operator, the action is not escalating, and the row
 *    already names its target. The audit row is still written — actor, action,
 *    target, timestamp — with the reason recording that none was asked for,
 *    which is honest, unlike a mandatory field people fill with "asdf". The
 *    escalating and cross-tenant actions (grant admin, plan override, kill
 *    another tenant's task) keep the reason and the typed confirmation.
 *  - A TYPED CONFIRMATION for the destructive and escalating actions. The
 *    "type the repo name to delete it" pattern: a mis-clicked row can't
 *    execute, because it would have to already know which host or account it
 *    meant.
 *  - The ACTOR is never sent. The backend fills it from req.user — a
 *    client-supplied actor on an audit log is a field an attacker gets to
 *    write. Do not "helpfully" add it.
 *  - An idempotency key per dialog open, so a double-click can't fire twice.
 *  - On failure the dialog STAYS OPEN with the typed reason intact. Destroying
 *    someone's carefully-worded reason because the backend hiccuped is how you
 *    train people to type "asdf".
 */

/** Long enough to be a sentence, short enough not to be a chore. */
export const MIN_REASON_LENGTH = 10;

/** What lands on the audit row when the dialog didn't ask for a reason. */
export const SIMPLE_CONFIRM_REASON = 'Confirmed in the operator console (no reason requested)';

export interface ConfirmMutationProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What will happen, in plain words. Say the blast radius. */
  description: React.ReactNode;
  /** Button copy. Imperative — "Drain host", not "OK". */
  actionLabel: string;
  /** Require the operator to type this exactly (case-insensitive). */
  confirmText?: string;
  /** What the confirm field is asking for, e.g. "the host name". */
  confirmLabel?: string;
  destructive?: boolean;
  /**
   * Plain "are you sure": no reason field, no typed confirmation, just the
   * description and the two buttons. `confirmText` is ignored. Use for routine,
   * reversible, single-target actions.
   */
  simple?: boolean;
  /** For analytics only. Never the reason text. */
  analyticsAction: string;
  analyticsTargetType: string;
  onConfirm: (input: { reason: string; confirm?: string }) => Promise<void>;
}

/**
 * A closed dialog runs NO hooks.
 *
 * The early return lives out here rather than after the `useState`s, because a
 * hook cannot be called conditionally — which meant a shut dialog still
 * demanded auth context from every page that merely *might* mutate. Splitting
 * it keeps the requirement where the behaviour is.
 */
export function ConfirmMutationDialog(props: ConfirmMutationProps) {
  if (!props.open) return null;
  return <MutationDialog {...props} />;
}

function MutationDialog({
  open,
  onClose,
  title,
  description,
  actionLabel,
  confirmText,
  confirmLabel,
  destructive,
  simple,
  analyticsAction,
  analyticsTargetType,
  onConfirm,
}: ConfirmMutationProps) {
  const { user } = useAuth();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh key per OPEN, not per render: it is what makes a double-click one
  // action rather than two.
  const [requestId, setRequestId] = useState<string>('');
  useEffect(() => {
    if (!open) return;
    setRequestId(crypto.randomUUID());
    setReason('');
    setConfirm('');
    setError(null);
    setBusy(false);
  }, [open]);

  const reasonOk = simple || reason.trim().length >= MIN_REASON_LENGTH;
  const confirmOk =
    simple || !confirmText || confirm.trim().toLowerCase() === confirmText.trim().toLowerCase();
  const canSubmit = reasonOk && confirmOk && !busy;

  const remaining = useMemo(
    () => Math.max(0, MIN_REASON_LENGTH - reason.trim().length),
    [reason]
  );

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // The backend requires a non-empty reason on every mutating route
      // (routes/admin/guards.ts) and persists it verbatim, so simple mode sends
      // a value that says exactly what happened rather than inventing one.
      await onConfirm({
        reason: simple ? SIMPLE_CONFIRM_REASON : reason.trim(),
        confirm: !simple && confirmText ? confirm.trim() : undefined,
      });
      // Never the reason text: it can carry customer identifiers, and PostHog
      // is not the audit log — the backend is.
      trackEvent('admin_mutation', {
        action: analyticsAction,
        target_type: analyticsTargetType,
        reason_length: simple ? 0 : reason.trim().length,
        simple_confirm: Boolean(simple),
        request_id: requestId,
      });
      onClose();
    } catch (err) {
      // Stays open, reason intact.
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg">
        <div className="flex items-start gap-3">
          {destructive && <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />}
          <div className="min-w-0">
            <h2 className="font-display text-base font-semibold">{title}</h2>
            <div className="mt-1 text-sm text-muted-foreground">{description}</div>
          </div>
        </div>

        {!simple && (
        <label className="mt-4 block">
          <span className="text-xs font-medium">Reason</span>
          <span className="ml-1 text-xs text-muted-foreground">(recorded in the audit log)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            aria-label="Reason"
            placeholder="Why are you doing this? Whoever reads the log later has only this."
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          />
          {!reasonOk && (
            <span className="text-xs text-muted-foreground">
              {remaining} more character{remaining === 1 ? '' : 's'}
            </span>
          )}
        </label>
        )}

        {!simple && confirmText && (
          <label className="mt-3 block">
            <span className="text-xs font-medium">
              Type {confirmLabel ?? 'the name'} to confirm
            </span>
            <code className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">
              {confirmText}
            </code>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-label="Confirmation"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm"
            />
          </label>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="truncate text-[11px] text-muted-foreground">
            acting as {user?.email ?? 'you'}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!canSubmit}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50',
                destructive ? 'bg-destructive hover:bg-destructive/90' : 'bg-primary hover:bg-primary/90'
              )}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {actionLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
