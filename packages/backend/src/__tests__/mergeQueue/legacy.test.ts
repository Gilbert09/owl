// The two shapes a merge-queue entry leaves the backend as: the rich v2
// payload richer clients render, and the four-status blob v1-era desktop
// builds understand. Both are emitted on every broadcast, so a status added to
// the engine must land correctly in each — a build that doesn't know
// `awaiting_stack` has to read it as "waiting", not fall through to something
// that looks like a failure.

import { describe, it, expect } from 'vitest';
import { toLegacyStatus, toPublicMergeQueue } from '../../services/mergeQueue/legacy.js';
import type { EntrySnapshot, EntryStatus } from '../../services/mergeQueue/types.js';

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
const ALL_STATUSES: EntryStatus[] = [
  'queued',
  'awaiting_ci',
  'awaiting_review',
  'automerge_armed',
  'awaiting_external',
  'awaiting_stack',
  'fixing',
  'merging',
  'blocked',
  'blocked_manual',
  'merged',
  'removed',
];

describe('toLegacyStatus', () => {
  it('maps every engine status to one of the four a v1 desktop knows', () => {
    // Enumerated rather than spot-checked so a new status can't quietly fall
    // through to a value old builds render as something else.
    for (const status of ALL_STATUSES) {
      expect(['waiting', 'fixing', 'merging', 'blocked']).toContain(toLegacyStatus(status));
    }
  });

  it('reads a parked stack member as waiting, not blocked', () => {
    // It self-heals and needs no user action, so a blocked badge on an old
    // build would be actively misleading.
    expect(toLegacyStatus('awaiting_stack')).toBe('waiting');
  });
});

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
