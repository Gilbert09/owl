// Merge queue v2 — legacy WS/REST shape mapping.
//
// Old desktop builds (stores/pullRequests.ts) know exactly four queue
// statuses; the v2 pipeline keeps emitting that shape (and mirroring it into
// pull_requests.mergeQueueState for the REST list) alongside the richer
// `mergeQueue` payload, so no desktop build ever breaks during the rollout.
// Deleted with the blob columns in the cleanup push.

import type { EntrySnapshot, EntryStatus } from './types.js';

export type LegacyQueueStatus = 'waiting' | 'fixing' | 'merging' | 'blocked';

export function toLegacyStatus(status: EntryStatus): LegacyQueueStatus {
  switch (status) {
    case 'fixing':
      return 'fixing';
    case 'merging':
      return 'merging';
    case 'blocked':
    case 'blocked_manual':
      return 'blocked';
    default:
      // queued / awaiting_ci / awaiting_review / automerge_armed /
      // awaiting_external / awaiting_stack — all "waiting" to a v1-era
      // desktop, which is correct for every one of them.
      return 'waiting';
  }
}

/** The WS badge shape v1 emitted (status/attempts/position/reason). */
export function toLegacyPublicState(
  entry: EntrySnapshot,
  position: number
): { status: LegacyQueueStatus; attempts: number; position: number; reason?: string } {
  const status = toLegacyStatus(entry.status);
  return {
    status,
    attempts: entry.fixAttempts,
    position,
    ...(status === 'blocked' && entry.blockedReason ? { reason: entry.blockedReason } : {}),
  };
}

/**
 * The blob stored on pull_requests.mergeQueueState during the v2 window —
 * enough for the REST list's badge derivation and any v1-era reader.
 */
export function toLegacyStateBlob(entry: EntrySnapshot): Record<string, unknown> {
  return {
    status: toLegacyStatus(entry.status),
    attempts: entry.fixAttempts,
    accounted: entry.fixTaskAccounted,
    ...(entry.fixTaskId ? { lastFixTaskId: entry.fixTaskId } : {}),
    ...(entry.blockedReason ? { blockReason: entry.blockedReason } : {}),
  };
}

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
