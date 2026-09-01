// Merge queue v2 — the public WS/REST payload.
//
// This file used to carry a second job: mapping every entry down to the
// four-status shape v1 emitted, and mirroring it into
// pull_requests.merge_queue_state, so desktop builds predating the v2 payload
// kept a working queue badge through the rollout. That shim was removed on
// 2026-09-01 — the v2 desktop surface shipped with the cutover, and 44 releases
// of a nightly auto-updating app have gone out since. `merge_queue_entries` is
// now the only source of queue state.

import type { EntrySnapshot } from './types.js';

/** The v2 payload richer clients render (new badges, budgets, head scope). */
export function toPublicMergeQueue(
  entry: EntrySnapshot,
  position: number
): Record<string, unknown> {
  return {
    status: entry.status,
    position,
    blockedCode: entry.blockedCode,
    reason: entry.blockedReason ?? undefined,
    /** Which flavor the in-flight fix run is — lets the UI label a 'fixing'
     *  entry as Re-signing vs Fixing and pick the matching budget. */
    fixKind: entry.fixKind ?? undefined,
    headShaShort: entry.headSha ? entry.headSha.slice(0, 7) : undefined,
    budgets: {
      fixRuns: [entry.fixAttempts, 3],
      checkReruns: [entry.rerunAttempts, 3],
      resigns: [entry.resignAttempts, 3],
    },
    autoMerge: entry.automergeArmedBy
      ? { armed: true, armedBy: entry.automergeArmedBy }
      : { armed: false },
    /** Merge stack: the PR this one is, or was, stacked on. The client derives
     *  stack membership itself from the open rows' branches; this is the piece
     *  it can't — the parent of a PR already retargeted off that branch. */
    stackParentNumber: entry.stackParentNumber ?? undefined,
    /** External merge queue (trunk.io / GitHub native): how the PR was handed
     *  over, how many submissions this head has spent, and where the provider
     *  itself says the PR is. `state` is the authoritative channel — read off
     *  the provider's own comment — and is present even when the submission
     *  bookkeeping isn't (a PR someone submitted outside Talyn). */
    external:
      entry.externalSubmitVia || entry.externalState
        ? {
            ...(entry.externalSubmitVia
              ? { via: entry.externalSubmitVia, submits: [entry.submitAttempts, 3] }
              : {}),
            ...(entry.externalState ? { state: entry.externalState } : {}),
          }
        : undefined,
  };
}
