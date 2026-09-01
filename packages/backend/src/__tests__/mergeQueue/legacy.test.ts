// The payload a merge-queue entry leaves the backend as.
//
// This file used to cover a second shape too — the four-status blob emitted
// for desktop builds predating the v2 payload. That shim was retired on
// 2026-09-01; the rollup its status mapping performed now lives in
// @talyn/shared as `coarseQueueStatus`, for badges with room for one word, and
// is covered in externalMergeQueue.test.ts.

import { describe, it, expect } from 'vitest';
import { toPublicMergeQueue } from '../../services/mergeQueue/legacy.js';
import type { EntrySnapshot } from '../../services/mergeQueue/types.js';

function entry(o: Partial<EntrySnapshot> = {}): EntrySnapshot {
  return {
    id: 'mqe_1',
    status: 'queued',
    blockedCode: null,
    blockedReason: null,
    headSha: 'abcdef1234567890',
    fixAttempts: 0,
    rerunAttempts: 0,
    resignAttempts: 0,
    submitAttempts: 0,
    externalSubmitVia: null,
    externalSubmittedAt: null,
    externalState: null,
    fixTaskId: null,
    fixTaskAccounted: true,
    fixKind: null,
    signingCheckedSha: null,
    unsignedCount: null,
    automergeArmedBy: null,
    mergeMethod: 'squash',
    baseBranch: 'main',
    stackParentNumber: null,
    retargetAttempts: 0,
    ...o,
  };
}

/** Every status the engine can persist. */

describe('toPublicMergeQueue', () => {
  it('carries the stack parent while parked', () => {
    const payload = toPublicMergeQueue(
      entry({ status: 'awaiting_stack', stackParentNumber: 41 }),
      1
    );
    expect(payload).toMatchObject({ status: 'awaiting_stack', stackParentNumber: 41 });
  });

  it('still carries it after the retarget, when the branch link is gone', () => {
    // This is the whole reason the field is on the wire: once the PR has been
    // retargeted onto the real base, no client derivation can recover which PR
    // it used to be stacked on.
    const payload = toPublicMergeQueue(
      entry({ status: 'queued', baseBranch: 'main', stackParentNumber: 41, retargetAttempts: 1 }),
      1
    );
    expect(payload).toMatchObject({ stackParentNumber: 41 });
  });

  it('omits it entirely for a PR that was never stacked', () => {
    expect(toPublicMergeQueue(entry(), 1).stackParentNumber).toBeUndefined();
  });
});
