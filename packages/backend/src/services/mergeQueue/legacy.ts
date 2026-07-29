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
      // awaiting_external — all "waiting" to a v1-era desktop.
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
    /** External merge queue (trunk.io / GitHub native): how the PR was handed
     *  over and how many submissions this head has spent. The queue STATE
     *  itself comes from the PR's labels, which the desktop already has. */
    external: entry.externalSubmitVia
      ? { via: entry.externalSubmitVia, submits: [entry.submitAttempts, 3] }
      : undefined,
  };
}
