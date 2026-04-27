/**
 * Per-PR focus + post-refresh cooldown registry.
 *
 * Adaptive-polling lives here. Two signals the prMonitor reads each
 * tick to decide whether a PR is stale enough to re-fetch:
 *
 *   1. Focus: a desktop client posted /pull-requests/:id/focus, so
 *      that PR (and its repo) gets the tighter TTL (30 s vs 60 s).
 *      Modeled on supacode's `focusedWorktreeId` concept — the user
 *      cares more about the PR they're looking at right now.
 *
 *   2. Cooldown: a manual /refresh just fetched fresh state. Skip
 *      the next 5 s of poll-driven refetches so user-initiated
 *      action doesn't get stomped by a racing scheduled refresh.
 *
 * Pure in-memory; intentionally not persisted. The desktop re-
 * announces focus on reconnect (subscribes are already cleared on
 * WS reconnect anyway), and cooldown is short enough that loss on
 * backend restart is irrelevant.
 */

const FOCUSED_TTL_MS = 30_000;
const UNFOCUSED_TTL_MS = 60_000;
const COOLDOWN_MS = 5_000;

// We key by `${workspaceId}:${prId}` so a single Map fits both the
// focus and cooldown signals without nested structures.
const focused = new Set<string>();
const cooldownUntil = new Map<string, number>();

function key(workspaceId: string, prId: string): string {
  return `${workspaceId}:${prId}`;
}

/**
 * Mark `prId` as focused for `workspaceId`. Idempotent.
 */
export function setFocused(workspaceId: string, prId: string): void {
  focused.add(key(workspaceId, prId));
}

/**
 * Clear focus for `prId` (the desktop deselected it / closed the
 * detail panel). Idempotent.
 */
export function clearFocused(workspaceId: string, prId: string): void {
  focused.delete(key(workspaceId, prId));
}

/**
 * Mark `prId` as just-refreshed — the next `COOLDOWN_MS` of poll
 * checks treat it as fresh regardless of `last_polled_at`.
 */
export function markRefreshed(workspaceId: string, prId: string): void {
  cooldownUntil.set(key(workspaceId, prId), Date.now() + COOLDOWN_MS);
}

/**
 * Returns the TTL `prMonitor.filterStale` should use for this PR.
 *   - Inside cooldown → effectively infinite (poll skips this PR
 *     until the cooldown expires); we surface that as a very large
 *     number rather than a sentinel so the caller's math stays
 *     monotonic.
 *   - Focused → FOCUSED_TTL_MS.
 *   - Otherwise → UNFOCUSED_TTL_MS.
 */
export function ttlFor(workspaceId: string, prId: string): number {
  const k = key(workspaceId, prId);
  const cd = cooldownUntil.get(k);
  if (cd !== undefined) {
    if (cd > Date.now()) return Number.MAX_SAFE_INTEGER;
    cooldownUntil.delete(k); // cleanup expired entries on read
  }
  return focused.has(k) ? FOCUSED_TTL_MS : UNFOCUSED_TTL_MS;
}

/**
 * Test/admin helper. Empties every map.
 */
export function _resetPrFocus(): void {
  focused.clear();
  cooldownUntil.clear();
}

export const PR_FOCUS_CONSTANTS = {
  FOCUSED_TTL_MS,
  UNFOCUSED_TTL_MS,
  COOLDOWN_MS,
};
