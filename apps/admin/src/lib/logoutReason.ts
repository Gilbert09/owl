/**
 * Why the session is about to end, attached to the `logged_out` analytics
 * event. During the 2026-07-07 mass-logout incident every `logged_out` row
 * had no reason, so we couldn't tell forced sign-outs from manual ones —
 * this closes that gap.
 *
 * The call site that triggers a sign-out tags the reason; the Analytics
 * component consumes it when the session actually disappears. A sign-out
 * nobody tagged means the Supabase client cleared the session on its own
 * (e.g. its auto-refresh was rejected at startup) — 'supabase_auto'.
 */
export type LogoutReason =
  | 'manual'
  | 'account_wiped'
  | 'api_401_refresh_rejected'
  | 'supabase_auto';

let pending: LogoutReason | null = null;

export function setLogoutReason(reason: LogoutReason): void {
  pending = reason;
}

export function consumeLogoutReason(): LogoutReason {
  const reason = pending ?? 'supabase_auto';
  pending = null;
  return reason;
}
