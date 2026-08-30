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
// Tracked-open PRs that have fallen out of the user's authored/
// review-requested searches still need their summary kept current, but
// they're not the PRs the user is actively working — refresh them on a
// much slacker cadence so they don't add per-tick GraphQL load. The same
// slack TTL covers the cohort the user isn't currently looking at (e.g.
// review-requested PRs while they're on the "My PRs" tab).
//
// A MANUALLY WATCHED PR is exempt. It appears in none of the three searches,
// so it looks untracked to the poller — but the user added it on purpose to
// watch its CI, and it renders on the My PRs page. Five minutes of lag on the
// page they are staring at is the one thing they asked us not to do, so
// prMonitor's filterStale suppresses the `untracked` flag for those rows and
// isCohortActive below counts them into 'mine'.
const UNTRACKED_TTL_MS = 300_000;
const COOLDOWN_MS = 5_000;

// Which list the desktop is currently showing, per workspace. Drives
// "poll the cohort you're looking at hard, the other one slackly".
//   - 'mine'   → authored PRs are active, review-requested are background
//   - 'review' → vice versa
//   - 'all'    → both active (also the default before a client reports, so
//                a freshly-connected app isn't starved)
//   - 'none'   → GitHub panel not visible → both background
export type ActiveView = 'mine' | 'review' | 'all' | 'none';

// We key by `${workspaceId}:${prId}` so a single Map fits both the
// focus and cooldown signals without nested structures.
const focused = new Set<string>();
const cooldownUntil = new Map<string, number>();
const activeView = new Map<string, ActiveView>();

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
 * Record which list the desktop is showing for a workspace. Idempotent.
 */
export function setActiveView(workspaceId: string, view: ActiveView): void {
  activeView.set(workspaceId, view);
}

/**
 * The workspace's current view. Defaults to `'all'` when no client has
 * reported — we'd rather fully poll a workspace we know nothing about than
 * starve a freshly-connected app before its first report lands.
 */
export function getActiveView(workspaceId: string): ActiveView {
  return activeView.get(workspaceId) ?? 'all';
}

/**
 * Is this PR's cohort the one the user is currently looking at? An authored
 * PR is "active" under 'mine'/'all', a review-requested one under
 * 'review'/'all'. Under 'none' neither is active. A PR can be both authored
 * and review-requested (rare); either match counts. A manually watched PR
 * counts as 'mine' — that is the page it renders on.
 */
export function isCohortActive(
  workspaceId: string,
  pr: { authored: boolean; reviewRequested: boolean; watching?: boolean }
): boolean {
  const view = getActiveView(workspaceId);
  if (view === 'all') return true;
  if (view === 'none') return false;
  // 'mine' is the My PRs page, whose cohort is `authored || watching`.
  if (view === 'mine') return pr.authored || pr.watching === true;
  return pr.reviewRequested; // 'review'
}

/**
 * Returns the TTL `prMonitor.filterStale` should use for this PR.
 *   - Inside cooldown → effectively infinite (poll skips this PR
 *     until the cooldown expires); we surface that as a very large
 *     number rather than a sentinel so the caller's math stays
 *     monotonic.
 *   - Focused → FOCUSED_TTL_MS (wins over everything below, so opening the
 *     detail sheet refreshes promptly regardless of cohort/view).
 *   - Untracked (dropped out of the search) OR the cohort the user isn't
 *     currently viewing → UNTRACKED_TTL_MS (slack).
 *   - Otherwise (the active cohort, settled) → UNFOCUSED_TTL_MS.
 */
export function ttlFor(
  workspaceId: string,
  prId: string,
  opts: { cohortActive?: boolean; untracked?: boolean } = {}
): number {
  const k = key(workspaceId, prId);
  const cd = cooldownUntil.get(k);
  if (cd !== undefined) {
    if (cd > Date.now()) return Number.MAX_SAFE_INTEGER;
    cooldownUntil.delete(k); // cleanup expired entries on read
  }
  if (focused.has(k)) return FOCUSED_TTL_MS;
  if (opts.untracked || opts.cohortActive === false) return UNTRACKED_TTL_MS;
  return UNFOCUSED_TTL_MS;
}

/**
 * Whether `prId` is inside its post-refresh cooldown — the active-CI fast
 * loop checks this so it doesn't stomp a just-manual-refreshed PR.
 */
export function isInCooldown(workspaceId: string, prId: string): boolean {
  const cd = cooldownUntil.get(key(workspaceId, prId));
  return cd !== undefined && cd > Date.now();
}

/**
 * Test/admin helper. Empties every map.
 */
export function _resetPrFocus(): void {
  focused.clear();
  cooldownUntil.clear();
  activeView.clear();
}

export const PR_FOCUS_CONSTANTS = {
  FOCUSED_TTL_MS,
  UNFOCUSED_TTL_MS,
  UNTRACKED_TTL_MS,
  COOLDOWN_MS,
};
