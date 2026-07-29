// External merge queues (trunk.io, GitHub's native merge queue) — shared vocabulary.
//
// Some base branches are governed by a merge system Talyn can't merge past: a
// ruleset restricts who may UPDATE the ref and exempts only that system's app.
// posthog/posthog's `master` has been one since July 2026 (the "Trunk merge"
// ruleset), so the direct merge 405s with "Cannot update this protected ref".
//
// Talyn's queue still does the valuable half: take the PR to green (fix runs,
// branch updates, re-signs, check re-runs), SUBMIT it to that system, then
// track it there and re-fix if it gets ejected. This module is the shared
// vocabulary the backend pipeline and the desktop badges both read — trunk
// publishes its per-PR state as labels, which is the only signal either side
// gets.

/** Systems whose queue state we can read. */
export type ExternalQueueProvider = 'trunk';

/**
 * Where a submitted PR sits in the external queue. `failed`/`cancelled` are the
 * EJECTED states — the provider gave the PR back, and Talyn's queue takes over
 * again (fix run → resubmit).
 */
export type ExternalQueueState =
  | 'not_ready'
  | 'queued'
  | 'testing'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'merged';

export interface ExternalQueueStatus {
  provider: ExternalQueueProvider;
  state: ExternalQueueState;
  /** The label the state was read off — shown verbatim in tooltips. */
  label: string;
}

/**
 * Trunk's status labels, most-decisive first. Trunk churns these through a
 * PR's lifetime (not-ready → queued → testing → tests-passed → merged) and
 * occasionally leaves two on at once mid-transition, so the order here is the
 * tie-break: a terminal state always wins over an in-flight one.
 *
 * `(bisection)` variants exist for both queued and testing — trunk appends the
 * suffix while it bisects a failing batch. Matched by prefix, so they map to
 * the same state.
 */
const TRUNK_STATE_LABELS: Array<{ prefix: string; state: ExternalQueueState }> = [
  { prefix: 'trunk-merged', state: 'merged' },
  { prefix: 'trunk-failed', state: 'failed' },
  { prefix: 'trunk-pending-failure', state: 'failed' },
  { prefix: 'trunk-cancelled', state: 'cancelled' },
  { prefix: 'trunk-canceled', state: 'cancelled' },
  { prefix: 'trunk-tests-passed', state: 'passed' },
  { prefix: 'trunk-testing', state: 'testing' },
  { prefix: 'trunk-queued', state: 'queued' },
  { prefix: 'trunk-not-ready', state: 'not_ready' },
];

/**
 * Labels that SUBMIT a PR to trunk's queue. Only these are ever applied by
 * Talyn — the status labels above belong to trunk and applying one would lie
 * to it. Both are trunk's documented submit labels; which one a repo uses is
 * configured in the Trunk app, so we look for whichever exists on the repo.
 */
export const TRUNK_SUBMIT_LABELS = ['trunk-merge-queue-submit', 'trunk-merge'] as const;

/**
 * Marker trunk puts at the top of the instruction comment it posts on every PR
 * in a repo it manages ("Merging to `master` in this repository is managed by
 * Trunk"). Its presence is the most direct evidence there is that a third-party
 * queue owns the branch — trunk itself said so, on this PR.
 */
export const TRUNK_COMMENT_MARKER = '<!-- Trunk Merge -->';

/** The command trunk's instruction comment tells you to post. */
export const TRUNK_MERGE_COMMAND = '/trunk merge';

export interface ExternalQueueInstruction {
  provider: ExternalQueueProvider;
  /** Comment body that submits the PR to the queue. */
  command: string;
}

/**
 * Read the provider's own submit instruction off a PR's comments.
 *
 * This is the authoritative door, and it beats guessing: on posthog/posthog
 * trunk posts "To merge this pull request, check the box to the left or comment
 * `/trunk merge` below" — the checkbox lives inside trunk's own comment (only
 * its author should edit it), so the comment command is the one a third party
 * can safely use. Returns null when no provider has claimed the PR, which is
 * the answer for every repo that doesn't use one.
 */
export function externalQueueInstructionFromComments(
  bodies: Array<string | null | undefined>
): ExternalQueueInstruction | null {
  for (const body of bodies) {
    if (!body) continue;
    if (!body.includes(TRUNK_COMMENT_MARKER)) continue;
    // Only claim the command door if trunk actually offered it in this repo's
    // configuration — some setups are label- or checkbox-only.
    if (!body.toLowerCase().includes(TRUNK_MERGE_COMMAND)) continue;
    return { provider: 'trunk', command: TRUNK_MERGE_COMMAND };
  }
  return null;
}

/** Is `name` a label Talyn may apply to submit a PR to an external queue? */
export function isExternalQueueSubmitLabel(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (TRUNK_SUBMIT_LABELS as readonly string[]).includes(n);
}

/**
 * Read the external-queue state off a PR's labels. Returns null when no
 * external queue has touched the PR — which is also the answer for every PR in
 * every repo that doesn't use one.
 */
export function externalQueueStatusFromLabels(
  labels: string[] | undefined | null
): ExternalQueueStatus | null {
  if (!labels || labels.length === 0) return null;
  const normalized = labels.map((l) => ({ raw: l, lower: l.trim().toLowerCase() }));
  for (const { prefix, state } of TRUNK_STATE_LABELS) {
    const hit = normalized.find((l) => l.lower === prefix || l.lower.startsWith(`${prefix} `));
    if (hit) return { provider: 'trunk', state, label: hit.raw };
  }
  return null;
}

/** The provider handed the PR back — Talyn's queue owns it again. */
export function isExternalQueueEjected(state: ExternalQueueState): boolean {
  return state === 'failed' || state === 'cancelled';
}

/** Short human label for a badge. */
export function externalQueueStateLabel(state: ExternalQueueState): string {
  switch (state) {
    case 'not_ready':
      return 'Not ready';
    case 'queued':
      return 'Queued';
    case 'testing':
      return 'Testing';
    case 'passed':
      return 'Tests passed';
    case 'failed':
      return 'Failed in queue';
    case 'cancelled':
      return 'Cancelled in queue';
    case 'merged':
      return 'Merged';
  }
}

/** Display name of the system holding the PR. */
export function externalQueueProviderLabel(provider: ExternalQueueProvider): string {
  return provider === 'trunk' ? 'Trunk' : provider;
}
