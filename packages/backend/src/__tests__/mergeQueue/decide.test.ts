// Decision-table tests for the merge queue v2 pure core.
//
// These port the edge-case semantics of mergeQueueProcessor.test.ts (the 89
// hard-won cases) onto decide(). Pipeline-level behavior (group concurrency,
// broadcasts, advisory locks, freshness refetch, watchdog) is covered by the
// evaluator integration suite, not here — decide is pure, so every case is
// (entry, pr, ctx) → actions + verdict.

import { describe, expect, it } from 'vitest';
import type { PRMergeableSummary } from '@talyn/shared';
import {
  DRAFT_BLOCK_REASON,
  blockerSignature,
  buildFailingChecksBlockReason,
  decide,
  queueSignature,
  unsignedCommitsBlockReason,
} from '../../services/mergeQueue/decide.js';
import { MAX_INFRA_SUBMITS_PER_HEAD } from '../../services/mergeQueue/types.js';
import type {
  Action,
  Decision,
  DecisionContext,
  EntrySnapshot,
  PrSnapshot,
} from '../../services/mergeQueue/types.js';
import type { StackParent } from '../../services/mergeQueue/stack.js';
import type { ExternalQueueState } from '@talyn/shared';

const NOW = '2026-07-16T12:00:00.000Z';

function entry(o: Partial<EntrySnapshot> = {}): EntrySnapshot {
  return {
    id: 'mqe_1',
    status: 'queued',
    blockedCode: null,
    blockedReason: null,
    headSha: 'sha1',
    fixAttempts: 0,
    rerunAttempts: 0,
    resignAttempts: 0,
    submitAttempts: 0,
    seenSignatures: [],
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

function summary(o: Partial<PRMergeableSummary> = {}): PRMergeableSummary {
  return {
    url: 'https://github.com/o/r/pull/1',
    headBranch: 'feat',
    baseBranch: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    blockingReason: 'mergeable',
    checks: { total: 3, failed: 0, inProgress: 0 },
    unresolvedReviewThreads: 0,
    ...o,
  };
}

function pr(o: Partial<PrSnapshot> = {}, s: Partial<PRMergeableSummary> = {}): PrSnapshot {
  return {
    state: 'open',
    headSha: 'sha1',
    mergeStateStatus: 'CLEAN',
    autoMergeEnabledBy: null,
    summary: summary(s),
    ...o,
  };
}

const cleanPr = () => pr();
const conflictingPr = () =>
  pr({ mergeStateStatus: 'DIRTY' }, { mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' });
const behindPr = () => pr({ mergeStateStatus: 'BEHIND' });
/** Required checks still running — GitHub reports BLOCKED for this. */
const ciRunningPr = () =>
  pr({ mergeStateStatus: 'BLOCKED' }, { blockingReason: 'blocked', checks: { total: 3, failed: 0, inProgress: 2 } });
const draftPr = () => pr({ mergeStateStatus: 'DRAFT' }, { draft: true });
/** Clean/mergeable but a NON-required check is red (App-refusal territory). */
const optionalFailPr = () =>
  pr({}, { blockingReason: 'checks_failed_optional', checks: { total: 3, failed: 1, inProgress: 0 } });

function ctx(o: Partial<DecisionContext> = {}): DecisionContext {
  return {
    nowIso: NOW,
    isHead: true,
    groupMergeInFlight: false,
    fixTaskState: 'none',
    otherLinkedTaskActive: false,
    signingRequired: false,
    autoMergeCapability: 'unavailable',
    externalGate: null,
    updateBranchAvailable: false,
    cloudEnvAvailable: true,
    restGateBlocked: false,
    graphqlGateBlocked: false,
    graphqlBudgetLow: false,
    maxAttempts: 3,
    ...o,
  };
}

const kinds = (d: Decision) => d.actions.map((a) => a.kind);
type Transition = Extract<Action, { kind: 'transition' }>;
const transitions = (d: Decision) => d.actions.filter((a): a is Transition => a.kind === 'transition');
const lastTransition = (d: Decision) => transitions(d).at(-1);
const fixRun = (d: Decision) =>
  d.actions.find((a): a is Extract<Action, { kind: 'fire_fix_run' }> => a.kind === 'fire_fix_run');

describe('decide — clean path', () => {
  it('merges a clean queued head (verify-live-then-merge, holding the group)', () => {
    const d = decide(entry(), cleanPr(), ctx());
    expect(kinds(d)).toEqual(['verify_live_then_merge']);
    expect(d.verdict).toBe('hold');
  });

  it('records the merge on a merged outcome, without a refetch', () => {
    const d = decide(entry({ status: 'merging' }), cleanPr(), ctx({ mergeOutcome: { kind: 'merged' } }));
    expect(kinds(d)).toEqual(['record_merged']);
    expect(d.verdict).toBe('hold');
  });

  it('defers (queued, hold) while the REST rate gate is blocked', () => {
    const d = decide(entry(), cleanPr(), ctx({ restGateBlocked: true }));
    expect(kinds(d)).not.toContain('verify_live_then_merge');
    expect(d.verdict).toBe('hold');
  });

  it('waits its turn (hold, no merge) while a sibling merge/arm is in flight', () => {
    const d = decide(entry(), cleanPr(), ctx({ groupMergeInFlight: true }));
    expect(kinds(d)).not.toContain('verify_live_then_merge');
    expect(d.verdict).toBe('hold');
  });

  it('merges a now-clean PR even while its fix run is still in flight', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1', fixTaskAccounted: false }),
      cleanPr(),
      ctx({ fixTaskState: 'active' })
    );
    expect(kinds(d)).toContain('verify_live_then_merge');
    expect(d.verdict).toBe('hold');
  });
});

describe('decide — merge aftermath', () => {
  it('verifies before believing a merged:false bounce', () => {
    const d = decide(
      entry({ status: 'merging' }),
      cleanPr(),
      ctx({ mergeOutcome: { kind: 'not_merged', message: 'Base branch was modified' } })
    );
    expect(kinds(d)).toEqual(['verify_merged']);
    expect(d.verdict).toBe('hold');
  });

  it('records the merge when GitHub returns merged:false but the PR is in fact merged', () => {
    const d = decide(
      entry({ status: 'merging' }),
      cleanPr(),
      ctx({ mergeOutcome: { kind: 'not_merged', message: 'x' }, verifiedMerged: true })
    );
    expect(kinds(d)).toEqual(['record_merged']);
  });

  it('keeps a bounced PR queued and refetches (stale mergeability)', () => {
    const d = decide(
      entry({ status: 'merging' }),
      cleanPr(),
      ctx({ mergeOutcome: { kind: 'not_merged', message: 'Base branch was modified' }, verifiedMerged: false })
    );
    const t = lastTransition(d)!;
    expect(t.to).toBe('queued');
    expect(t.set?.lastError).toContain('Base branch was modified');
    expect(kinds(d)).toContain('refresh_snapshot');
    expect(d.verdict).toBe('hold');
  });

  it('keeps a PR queued and refetches when the merge throws (e.g. 405 conflicts)', () => {
    const d = decide(
      entry({ status: 'merging' }),
      cleanPr(),
      ctx({ mergeOutcome: { kind: 'error', message: 'Pull Request has merge conflicts' }, verifiedMerged: false })
    );
    expect(lastTransition(d)!.to).toBe('queued');
    expect(kinds(d)).toContain('refresh_snapshot');
  });

  it('records the merge when the attempt throws 405 but GitHub says merged', () => {
    const d = decide(
      entry({ status: 'merging' }),
      cleanPr(),
      ctx({ mergeOutcome: { kind: 'error', message: '405' }, verifiedMerged: true })
    );
    expect(kinds(d)).toEqual(['record_merged']);
  });

  it('learns the gate and submits (never retries/fixes) on a "Cannot update this protected ref" refusal', () => {
    const d = decide(
      entry({ status: 'merging' }),
      cleanPr(),
      ctx({
        mergeOutcome: { kind: 'error', message: 'Cannot update this protected ref' },
        verifiedMerged: false,
      })
    );
    const t = lastTransition(d)!;
    expect(t.to).toBe('queued');
    expect(t.set?.lastError).toContain('protected ref');
    // Records the gate so no later evaluation burns another doomed merge, then
    // hands the PR to the system that owns the branch.
    expect(kinds(d)).toEqual(['mark_external_gate', 'transition', 'submit_external']);
    // Retrying or fixing can never satisfy a protected-ref refusal.
    expect(kinds(d)).not.toContain('refresh_snapshot');
    expect(kinds(d)).not.toContain('fire_fix_run');
    expect(d.verdict).toBe('hold');
  });

  it('treats a native/third-party merge-queue refusal the same way', () => {
    const d = decide(
      entry({ status: 'merging' }),
      cleanPr(),
      ctx({
        mergeOutcome: { kind: 'error', message: 'Merge queue is required for this branch' },
        verifiedMerged: false,
      })
    );
    expect(kinds(d)).toContain('mark_external_gate');
    expect(kinds(d)).toContain('submit_external');
  });

  it('still verifies-merged first — a protected-ref message on an already-merged PR records the merge', () => {
    const d = decide(
      entry({ status: 'merging' }),
      cleanPr(),
      ctx({
        mergeOutcome: { kind: 'error', message: 'Cannot update this protected ref' },
        verifiedMerged: true,
      })
    );
    expect(kinds(d)).toEqual(['record_merged']);
  });

  it('does NOT mistake an ordinary conflict for an external gate (stays queued, refetches)', () => {
    const d = decide(
      entry({ status: 'merging' }),
      cleanPr(),
      ctx({
        mergeOutcome: { kind: 'error', message: 'Pull Request has merge conflicts' },
        verifiedMerged: false,
      })
    );
    expect(lastTransition(d)!.to).toBe('queued');
    expect(kinds(d)).toContain('refresh_snapshot');
  });
});

describe('decide — verify-merged recovery (crashed mid-merge)', () => {
  it('asks GitHub first when found in status=merging with no outcome (the June 2026 wedge)', () => {
    const d = decide(entry({ status: 'merging' }), cleanPr(), ctx());
    expect(kinds(d)).toEqual(['verify_merged']);
    expect(d.verdict).toBe('hold');
  });

  it('records the merge when GitHub confirms it', () => {
    const d = decide(entry({ status: 'merging' }), cleanPr(), ctx({ verifiedMerged: true }));
    expect(kinds(d)).toEqual(['record_merged']);
  });

  it('proceeds normally on re-entry when GitHub says still open', () => {
    const d = decide(entry({ status: 'merging' }), cleanPr(), ctx({ verifiedMerged: false }));
    // re-armed to queued, then the clean path merges again
    expect(transitions(d)[0]!.to).toBe('queued');
    expect(kinds(d)).toContain('verify_live_then_merge');
  });
});

describe('decide — settled blockers fire the fix run', () => {
  it('fires a cloud fix run for a conflicting PR instead of merging', () => {
    const d = decide(entry(), conflictingPr(), ctx());
    expect(fixRun(d)).toEqual({ kind: 'fire_fix_run', resign: false });
    expect(kinds(d)).not.toContain('verify_live_then_merge');
    expect(d.verdict).toBe('hold');
  });

  it('funnels a BEHIND PR into the same fix path (the post-merge race)', () => {
    const d = decide(entry(), behindPr(), ctx());
    expect(fixRun(d)).toBeTruthy();
    expect(d.verdict).toBe('hold');
  });

  it('still fires the fix path for a BEHIND PR even while its CI is in flight', () => {
    const d = decide(
      entry(),
      pr({ mergeStateStatus: 'BEHIND' }, { checks: { total: 3, failed: 0, inProgress: 1 } }),
      ctx()
    );
    expect(fixRun(d)).toBeTruthy();
  });

  it('holds as queued without firing when the workspace has no cloud env', () => {
    const d = decide(entry(), conflictingPr(), ctx({ cloudEnvAvailable: false }));
    expect(fixRun(d)).toBeUndefined();
    expect(d.verdict).toBe('hold');
  });
});

describe('decide — update-branch beats a paid fix run for BEHIND', () => {
  it('updates the branch server-side when available and nothing else is wrong', () => {
    const d = decide(entry(), behindPr(), ctx({ updateBranchAvailable: true }));
    expect(kinds(d)).toEqual(['update_branch']);
    expect(d.verdict).toBe('hold');
  });

  it('waits on CI after a successful update', () => {
    const d = decide(entry(), behindPr(), ctx({ updateBranchAvailable: true, updateBranchOutcome: 'ok' }));
    expect(lastTransition(d)!.to).toBe('awaiting_ci');
    expect(kinds(d)).toContain('refresh_snapshot');
    expect(d.verdict).toBe('advance');
  });

  it('falls back to the fix run when the update conflicts', () => {
    const d = decide(entry(), behindPr(), ctx({ updateBranchAvailable: true, updateBranchOutcome: 'conflict' }));
    expect(fixRun(d)).toBeTruthy();
  });

  it('never uses update-branch when genuine followup work exists (conflicts)', () => {
    const d = decide(entry(), conflictingPr(), ctx({ updateBranchAvailable: true }));
    expect(kinds(d)).not.toContain('update_branch');
    expect(fixRun(d)).toBeTruthy();
  });
});

describe('decide — CI in flight waits without burning anything', () => {
  it('waits (no fire, no merge, no block) while the head CI is still in flight', () => {
    const d = decide(entry(), ciRunningPr(), ctx());
    expect(fixRun(d)).toBeUndefined();
    expect(kinds(d)).not.toContain('verify_live_then_merge');
    expect(lastTransition(d)!.to).toBe('awaiting_ci');
    expect(d.verdict).toBe('advance');
  });

  it('does not count an attempt for a PR still running CI after a fix run', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1', fixTaskAccounted: false }),
      ciRunningPr(),
      ctx({ fixTaskState: 'terminal' })
    );
    const t = lastTransition(d)!;
    expect(t.to).toBe('awaiting_ci');
    expect(t.set?.fixAttempts).toBeUndefined();
    expect(d.verdict).toBe('advance');
  });
});

describe('decide — awaiting a required review (no doomed fix runs)', () => {
  it('waits as awaiting_review when only a required review is missing', () => {
    const d = decide(
      entry(),
      pr({ mergeStateStatus: 'BLOCKED' }, { blockingReason: 'blocked', reviewDecision: 'REVIEW_REQUIRED' }),
      ctx()
    );
    expect(fixRun(d)).toBeUndefined();
    expect(lastTransition(d)!.to).toBe('awaiting_review');
    expect(d.verdict).toBe('advance');
  });

  it('still fixes CHANGES_REQUESTED (a settled blocker, not a review wait)', () => {
    const d = decide(
      entry(),
      pr({ mergeStateStatus: 'BLOCKED' }, { blockingReason: 'changes_requested', reviewDecision: 'CHANGES_REQUESTED' }),
      ctx()
    );
    expect(fixRun(d)).toBeTruthy();
  });
});

describe('decide — active-run guard', () => {
  it('does not fire or merge while a fix run is in flight on a blocked PR', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1' }),
      conflictingPr(),
      ctx({ fixTaskState: 'active' })
    );
    expect(fixRun(d)).toBeUndefined();
    expect(d.verdict).toBe('hold');
  });

  it('does not fire a duplicate while another linked run is active (taskId reassigned)', () => {
    const d = decide(entry(), conflictingPr(), ctx({ otherLinkedTaskActive: true }));
    expect(fixRun(d)).toBeUndefined();
    expect(lastTransition(d)!.to).toBe('fixing');
    expect(d.verdict).toBe('hold');
  });

  it('advances past a head whose only obstacle is a non-required check a run is already working', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1' }),
      optionalFailPr(),
      ctx({ fixTaskState: 'active' })
    );
    expect(kinds(d)).not.toContain('verify_live_then_merge');
    expect(d.verdict).toBe('advance');
  });
});

describe('decide — fix-run accounting bounded by PROGRESS, not a retry count', () => {
  const sigOf = (snapshot: PrSnapshot) => blockerSignature(snapshot);

  it('records the blocker signature and re-fires when a run leaves a NEW problem', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1', fixTaskAccounted: false, fixAttempts: 0 }),
      conflictingPr(),
      ctx({ fixTaskState: 'terminal' })
    );
    const acct = transitions(d)[0]!;
    expect(acct.set?.fixAttempts).toBe(1);
    expect(acct.set?.fixTaskAccounted).toBe(true);
    expect(acct.set?.seenSignatures).toEqual([sigOf(conflictingPr())]);
    expect(fixRun(d)).toBeTruthy();
    expect(d.verdict).toBe('hold');
  });

  // THE point of the rewrite: a PR clearing one blocker per run used to be
  // declared blocked on the 4th, however well it was going.
  it('keeps going indefinitely while each run changes what is blocking the PR', () => {
    let e = entry({ status: 'fixing', fixTaskId: 't1', fixTaskAccounted: false });
    // Ten runs, each leaving a different number of failing checks.
    for (let i = 0; i < 10; i++) {
      const snapshot = pr(
        { mergeStateStatus: 'BLOCKED' },
        {
          blockingReason: 'checks_failed',
          checks: { total: 20, failed: 20 - i, inProgress: 0 },
          failingChecksDigest: `d${i}`,
        }
      );
      const d = decide(e, snapshot, ctx({ fixTaskState: 'terminal' }));
      expect(fixRun(d)).toBeTruthy();
      const acct = transitions(d)[0]!;
      e = entry({
        status: 'fixing',
        fixTaskId: `t${i + 2}`,
        fixTaskAccounted: false,
        fixAttempts: acct.set?.fixAttempts ?? 0,
        seenSignatures: acct.set?.seenSignatures ?? e.seenSignatures,
      });
    }
    expect(e.fixAttempts).toBe(10);
    expect(e.seenSignatures).toHaveLength(10);
  });

  it('blocks the moment a run reproduces a problem it already failed at', () => {
    const stuck = conflictingPr();
    const d = decide(
      entry({
        status: 'fixing',
        fixTaskId: 't2',
        fixTaskAccounted: false,
        fixAttempts: 1,
        seenSignatures: [sigOf(stuck)],
      }),
      stuck,
      ctx({ fixTaskState: 'terminal' })
    );
    const t = transitions(d)[0]!;
    expect(t.to).toBe('blocked');
    expect(t.blockedCode).toBe('no_progress');
    expect(t.blockedReason).toContain('merge conflicts with the base branch');
    expect(t.blockedReason).toContain('left it unchanged');
    expect(kinds(d)).toContain('notify_blocked');
    expect(fixRun(d)).toBeUndefined();
    expect(d.verdict).toBe('advance');
    // Already recorded — don't grow the list with a duplicate.
    expect(t.set?.seenSignatures).toBeUndefined();
  });

  it('does not record a signature when the run left the PR clean', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1', fixTaskAccounted: false }),
      cleanPr(),
      ctx({ fixTaskState: 'terminal' })
    );
    const acct = transitions(d)[0]!;
    expect(acct.set?.seenSignatures).toBeUndefined();
    expect(acct.set?.fixAttempts).toBe(0);
  });

  it('does not re-notify or churn writes on re-evaluation while already blocked', () => {
    const d = decide(
      entry({
        status: 'blocked',
        blockedCode: 'no_progress',
        seenSignatures: [sigOf(conflictingPr())],
        fixTaskId: 't3',
      }),
      conflictingPr(),
      ctx()
    );
    expect(d.actions).toEqual([]);
    expect(d.verdict).toBe('advance');
  });

  it('never fires at a known-dead problem, even after a failed-merge flap downgraded the status', () => {
    const d = decide(
      entry({ status: 'queued', seenSignatures: [sigOf(conflictingPr())] }),
      conflictingPr(),
      ctx()
    );
    expect(fixRun(d)).toBeUndefined();
    const t = lastTransition(d)!;
    expect(t.to).toBe('blocked');
    expect(t.blockedCode).toBe('no_progress');
    expect(kinds(d)).not.toContain('notify_blocked'); // silent re-settle — R8 already notified
    expect(d.verdict).toBe('advance');
  });

  // A flapped status must not wipe the history the block was reached on.
  it('does not clear the signature history on a transient clean reading', () => {
    const clean = decide(
      entry({
        status: 'blocked',
        blockedCode: 'no_progress',
        seenSignatures: [sigOf(conflictingPr())],
      }),
      cleanPr(),
      ctx()
    );
    expect(kinds(clean)).toContain('verify_live_then_merge');
    expect(transitions(clean).some((t) => t.set?.seenSignatures?.length === 0)).toBe(false);
  });

  it('re-arms a blocked PR that reads clean and merges it', () => {
    const d = decide(
      entry({
        status: 'blocked',
        blockedCode: 'no_progress',
        seenSignatures: [sigOf(conflictingPr())],
      }),
      cleanPr(),
      ctx()
    );
    expect(kinds(d)).toContain('verify_live_then_merge');
    expect(d.verdict).toBe('hold');
  });

  // The bound is "have we seen this before", so a signature that drifts on its
  // own would make it unreachable — and check totals drift constantly as a CI
  // run registers jobs.
  it('ignores check counts that move on their own (total, in-progress)', () => {
    const withCounts = (total: number, inProgress: number) =>
      pr(
        { mergeStateStatus: 'DIRTY' },
        {
          mergeable: 'CONFLICTING',
          blockingReason: 'merge_conflicts',
          checks: { total, failed: 2, inProgress },
          failingChecksDigest: 'same',
        }
      );
    expect(sigOf(withCounts(10, 0))).toBe(sigOf(withCounts(280, 74)));
  });

  it('still treats a NEW failure as a change', () => {
    const failing = (n: number, digest: string) =>
      pr(
        { mergeStateStatus: 'BLOCKED' },
        {
          blockingReason: 'checks_failed',
          checks: { total: 20, failed: n, inProgress: 0 },
          failingChecksDigest: digest,
        }
      );
    expect(sigOf(failing(2, 'ab'))).not.toBe(sigOf(failing(3, 'abc')));
  });

  it('tells "fixed one thing, uncovered another" apart from "changed nothing"', () => {
    const four = (digest: string) =>
      pr(
        { mergeStateStatus: 'BLOCKED' },
        {
          blockingReason: 'checks_failed',
          checks: { total: 10, failed: 4, inProgress: 0 },
          failingChecksDigest: digest,
        }
      );
    // Same COUNT, different checks — a retry budget calls this no progress.
    expect(sigOf(four('aaa'))).not.toBe(sigOf(four('bbb')));
    expect(sigOf(four('aaa'))).toBe(sigOf(four('aaa')));
  });

  // Rows written before the column shipped read as null, not [].
  it('treats a legacy null signature list as no history rather than throwing', () => {
    const legacy = { ...entry({ status: 'queued' }), seenSignatures: undefined } as never;
    const d = decide(legacy, conflictingPr(), ctx());
    expect(fixRun(d)).toBeTruthy();
  });
});

describe('decide — new head resets budgets (self-healing)', () => {
  it('zeroes budgets and unblocks when a new head appears on a blocked entry', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'attempts_exhausted', fixAttempts: 3, headSha: 'sha1' }),
      pr({ headSha: 'sha2', mergeStateStatus: 'DIRTY' }, { mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' }),
      ctx()
    );
    expect(kinds(d)).toContain('reset_budgets');
    expect(fixRun(d)).toBeTruthy(); // fresh budget → fix run fires again
  });

  it('clears the signing memo with the budgets', () => {
    const d = decide(
      entry({ headSha: 'sha1', signingCheckedSha: 'sha1', unsignedCount: 2, resignAttempts: 3 }),
      pr({ headSha: 'sha2' }),
      ctx({ signingRequired: true })
    );
    expect(kinds(d)).toContain('reset_budgets');
    // memo cleared → the gate needs a fresh probe for the new head
    expect(kinds(d)).toContain('probe_signatures');
  });

  it('does NOT reset a blocked_manual entry (App permission is not head-dependent)', () => {
    const d = decide(
      entry({ status: 'blocked_manual', blockedCode: 'app_refused_hard', headSha: 'sha1' }),
      pr({ headSha: 'sha2' }),
      ctx()
    );
    expect(kinds(d)).not.toContain('reset_budgets');
    expect(d.actions).toEqual([]);
    expect(d.verdict).toBe('advance');
  });
});

// The 2026-07-17 runaway: a "get mergeable" fix run PUSHES commits, which
// changes the head SHA. Treating that as an external push reset the fix budget,
// so the retry cap could never bite — fix → push → new head → reset → fix …
// forever, dispatching thousands of duplicate runs. The head only earns fresh
// budgets when the change was NOT authored by an in-flight (unaccounted) run.
describe('decide — a head pushed by our OWN fix run does NOT reset budgets', () => {
  const conflictAt = (headSha: string) =>
    pr({ headSha, mergeStateStatus: 'DIRTY' }, { mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' });

  it('adopts the head (no reset, no new run) while our unaccounted run is still active', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1', fixTaskAccounted: false, fixAttempts: 1, headSha: 'sha1' }),
      conflictAt('sha2'),
      ctx({ fixTaskState: 'active' })
    );
    expect(kinds(d)).toContain('adopt_head');
    expect(kinds(d)).not.toContain('reset_budgets');
    expect(fixRun(d)).toBeFalsy(); // an active run holds — never fire a second on top
  });

  it('accounts the just-finished run against its own push so the recurrence still bites', () => {
    // The run pushed a commit, so the head moved — but it pushed a fix that did
    // NOT change what is blocking the PR. Adopting the head must not wipe the
    // history, or the same dead end reads as a fresh start on every push.
    const d = decide(
      entry({
        status: 'fixing',
        fixTaskId: 't1',
        fixTaskAccounted: false,
        headSha: 'sha1',
        seenSignatures: [blockerSignature(conflictAt('sha2'))],
      }),
      conflictAt('sha2'),
      ctx({ fixTaskState: 'terminal' })
    );
    expect(kinds(d)).toContain('adopt_head');
    expect(kinds(d)).not.toContain('reset_budgets');
    const acct = transitions(d).find((t) => t.set?.fixTaskAccounted);
    expect(acct?.to).toBe('blocked');
    expect(acct?.blockedCode).toBe('no_progress');
    expect(fixRun(d)).toBeFalsy();
  });

  it('still resets on a genuine external push once the fix run is accounted', () => {
    const d = decide(
      entry({
        status: 'blocked',
        blockedCode: 'attempts_exhausted',
        fixTaskId: 't1',
        fixTaskAccounted: true,
        fixAttempts: 3,
        headSha: 'sha1',
      }),
      conflictAt('sha2'),
      ctx({ fixTaskState: 'terminal' })
    );
    expect(kinds(d)).toContain('reset_budgets');
    expect(kinds(d)).not.toContain('adopt_head');
    expect(fixRun(d)).toBeTruthy(); // fresh budget → retry the now-external head
  });
});

describe('decide — draft head', () => {
  it('does NOT attempt a merge; blocks with the draft reason and advances', () => {
    const d = decide(entry(), draftPr(), ctx());
    const t = lastTransition(d)!;
    expect(t.to).toBe('blocked');
    expect(t.blockedCode).toBe('draft');
    expect(t.blockedReason).toBe(DRAFT_BLOCK_REASON);
    expect(kinds(d)).not.toContain('verify_live_then_merge');
    expect(kinds(d)).not.toContain('notify_blocked'); // a draft isn't a failure
    expect(d.verdict).toBe('advance');
  });

  it('detects a draft via mergeStateStatus even without the draft flag', () => {
    const d = decide(entry(), pr({ mergeStateStatus: 'DRAFT' }), ctx());
    expect(lastTransition(d)!.blockedCode).toBe('draft');
  });

  it('does not churn writes on re-evaluations while still a draft', () => {
    const d = decide(entry({ status: 'blocked', blockedCode: 'draft', blockedReason: DRAFT_BLOCK_REASON }), draftPr(), ctx());
    expect(d.actions).toEqual([]);
    expect(d.verdict).toBe('advance');
  });

  it('merges once the PR is marked ready for review (self-heals)', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'draft', blockedReason: DRAFT_BLOCK_REASON }),
      cleanPr(),
      ctx()
    );
    expect(transitions(d)[0]!.to).toBe('queued');
    expect(kinds(d)).toContain('verify_live_then_merge');
  });

  it('a draft overrides an app-refusal residue so un-drafting funnels back to the merge path', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'app_refused_checks', rerunAttempts: 3 }),
      draftPr(),
      ctx()
    );
    expect(lastTransition(d)!.blockedCode).toBe('draft');
  });
});

describe('decide — App-refused merge (MergeNotPermittedForAppError)', () => {
  const refused = (o: Partial<DecisionContext> = {}) =>
    ctx({ mergeOutcome: { kind: 'refused_app', message: 'Merge not permitted for GitHub App.' }, verifiedMerged: false, ...o });

  it('probes signatures first (the learn-from-403 net)', () => {
    const d = decide(entry({ status: 'merging' }), optionalFailPr(), refused());
    expect(kinds(d)).toEqual(['probe_signatures']);
    expect(d.verdict).toBe('hold');
  });

  it('re-signs (not hard-blocks) when unsigned commits are visible after a refusal', () => {
    const d = decide(entry({ status: 'merging' }), cleanPr(), refused({ unsignedCount: 2 }));
    expect(kinds(d)).toContain('mark_signing_required');
    expect(fixRun(d)).toEqual({ kind: 'fire_fix_run', resign: true });
    expect(d.verdict).toBe('advance');
  });

  it('skips the signature lookup while GraphQL is gated and continues the ladder', () => {
    const d = decide(entry({ status: 'merging' }), optionalFailPr(), refused({ graphqlGateBlocked: true }));
    expect(kinds(d)).not.toContain('probe_signatures');
    expect(kinds(d)).toContain('rerequest_failed_checks');
  });

  it('re-runs the failing checks instead of blocking', () => {
    const d = decide(entry({ status: 'merging' }), optionalFailPr(), refused({ unsignedCount: 0 }));
    expect(kinds(d)).toEqual(['rerequest_failed_checks']);
    expect(d.verdict).toBe('hold');
  });

  it('waits on CI (awaiting_ci) after a successful re-run, advancing the group', () => {
    const d = decide(
      entry({ status: 'merging' }),
      optionalFailPr(),
      refused({ unsignedCount: 0, rerunOutcome: { requested: 2 } })
    );
    const t = lastTransition(d)!;
    expect(t.to).toBe('awaiting_ci');
    expect(t.set?.rerunAttempts).toBe(1);
    expect(kinds(d)).toContain('refresh_snapshot');
    expect(d.verdict).toBe('advance');
  });

  it('blocks with the ownership explanation when the check cannot be re-run via API', () => {
    const d = decide(
      entry({ status: 'merging' }),
      optionalFailPr(),
      refused({ unsignedCount: 0, rerunOutcome: { requested: 0, reason: 'not-rerequestable' } })
    );
    const t = lastTransition(d)!;
    expect(t.to).toBe('blocked');
    expect(t.blockedCode).toBe('app_refused_checks');
    expect(t.blockedReason).toBe(buildFailingChecksBlockReason('not-rerequestable', 3, 3));
    expect(t.set?.rerunAttempts).toBe(3); // spent — ownership is static per head
    expect(kinds(d)).toContain('notify_blocked');
    expect(d.verdict).toBe('advance');
  });

  it('blocks with the actions-permission hint when an Actions check cannot be re-run', () => {
    const d = decide(
      entry({ status: 'merging' }),
      optionalFailPr(),
      refused({ unsignedCount: 0, rerunOutcome: { requested: 0, reason: 'needs-actions-permission' } })
    );
    expect(lastTransition(d)!.blockedReason).toBe(
      buildFailingChecksBlockReason('needs-actions-permission', 3, 3)
    );
  });

  it('blocks with the exhausted reason once the rerun budget is spent', () => {
    const d = decide(entry({ status: 'merging', rerunAttempts: 3 }), optionalFailPr(), refused({ unsignedCount: 0 }));
    const t = lastTransition(d)!;
    expect(t.to).toBe('blocked');
    expect(t.blockedCode).toBe('app_refused_checks');
    expect(t.blockedReason).toBe(buildFailingChecksBlockReason(undefined, 3, 3));
    expect(kinds(d)).not.toContain('fire_fix_run'); // never churn a fix run on a refusal
  });

  it('does not spend the rerun budget when the re-run call itself errored', () => {
    const d = decide(
      entry({ status: 'merging', rerunAttempts: 1 }),
      optionalFailPr(),
      refused({ unsignedCount: 0, rerunOutcome: { errored: true } })
    );
    const t = lastTransition(d)!;
    expect(t.to).toBe('blocked');
    expect(t.set?.rerunAttempts).toBe(1); // unchanged — transient failure
  });

  it('hard-blocks (blocked_manual) when refused with no failing check to blame', () => {
    const d = decide(entry({ status: 'merging' }), cleanPr(), refused({ unsignedCount: 0 }));
    const t = lastTransition(d)!;
    expect(t.to).toBe('blocked_manual');
    expect(t.blockedCode).toBe('app_refused_hard');
    expect(t.blockedReason).toContain('Merge manually on GitHub');
    expect(kinds(d)).toContain('notify_blocked');
    expect(fixRun(d)).toBeUndefined(); // a fix run cannot grant merge permission
    expect(d.verdict).toBe('advance');
  });

  it('blocked_manual stays until requeue — even when the PR reads clean', () => {
    const d = decide(entry({ status: 'blocked_manual', blockedCode: 'app_refused_hard' }), cleanPr(), ctx());
    expect(d.actions).toEqual([]);
    expect(d.verdict).toBe('advance');
  });
});

describe('decide — blocked(app_refused_checks) self-drive and self-heal', () => {
  it('re-runs failing checks from an already-blocked row (pre-permission rows self-drive)', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'app_refused_checks', rerunAttempts: 0 }),
      optionalFailPr(),
      ctx()
    );
    expect(kinds(d)).toContain('rerequest_failed_checks');
    expect(d.verdict).toBe('advance');
  });

  it('accounts a fired re-run from the blocked state', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'app_refused_checks', rerunAttempts: 1 }),
      optionalFailPr(),
      ctx({ rerunOutcome: { requested: 1 } })
    );
    const t = lastTransition(d)!;
    expect(t.to).toBe('awaiting_ci');
    expect(t.set?.rerunAttempts).toBe(2);
  });

  it('stops re-running once the budget is spent', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'app_refused_checks', rerunAttempts: 3 }),
      optionalFailPr(),
      ctx()
    );
    expect(d.actions).toEqual([]);
    expect(d.verdict).toBe('advance');
  });

  it('self-heals and merges the moment the failing check goes green', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'app_refused_checks', rerunAttempts: 3 }),
      cleanPr(),
      ctx()
    );
    const t = transitions(d)[0]!;
    expect(t.to).toBe('queued');
    expect(t.set?.rerunAttempts).toBe(0); // a fresh failure gets its own retries
    expect(kinds(d)).toContain('verify_live_then_merge');
    expect(d.verdict).toBe('hold');
  });
});

describe('decide — signed-commits gate', () => {
  it('does NOT probe signatures on a repo that does not require signed commits', () => {
    const d = decide(entry(), cleanPr(), ctx({ signingRequired: false }));
    expect(kinds(d)).toEqual(['verify_live_then_merge']);
  });

  it('probes once per head when signing is required and no memo exists', () => {
    const d = decide(entry(), cleanPr(), ctx({ signingRequired: true }));
    expect(kinds(d)).toEqual(['probe_signatures']);
    expect(d.verdict).toBe('advance');
  });

  it('merges normally when every commit is signed', () => {
    const d = decide(entry(), cleanPr(), ctx({ signingRequired: true, unsignedCount: 0 }));
    expect(kinds(d)).toContain('verify_live_then_merge');
  });

  it('uses the per-head memo instead of re-probing', () => {
    const d = decide(
      entry({ signingCheckedSha: 'sha1', unsignedCount: 0 }),
      cleanPr(),
      ctx({ signingRequired: true })
    );
    expect(kinds(d)).not.toContain('probe_signatures');
    expect(kinds(d)).toContain('verify_live_then_merge');
  });

  it('re-signs (fix run) instead of attempting a doomed merge when commits are unsigned', () => {
    const d = decide(entry(), cleanPr(), ctx({ signingRequired: true, unsignedCount: 2 }));
    expect(fixRun(d)).toEqual({ kind: 'fire_fix_run', resign: true });
    expect(kinds(d)).not.toContain('verify_live_then_merge');
    expect(d.verdict).toBe('advance');
  });

  it('does not fire a second re-sign run while one is already in flight', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1', fixKind: 'resign' }),
      cleanPr(),
      ctx({ signingRequired: true, fixTaskState: 'active' })
    );
    expect(fixRun(d)).toBeUndefined();
    expect(d.verdict).toBe('advance');
  });

  it('defers the signing check (no probe, no merge) when the GraphQL budget is in reserve', () => {
    const d = decide(entry(), cleanPr(), ctx({ signingRequired: true, graphqlBudgetLow: true }));
    expect(kinds(d)).not.toContain('probe_signatures');
    expect(kinds(d)).not.toContain('verify_live_then_merge');
    expect(d.verdict).toBe('advance');
  });

  it('defers while GraphQL is in a rate-limit backoff', () => {
    const d = decide(entry(), cleanPr(), ctx({ signingRequired: true, graphqlGateBlocked: true }));
    expect(kinds(d)).not.toContain('probe_signatures');
    expect(kinds(d)).not.toContain('verify_live_then_merge');
  });

  it('blocks with the signing reason once the re-sign budget is spent', () => {
    const d = decide(
      entry({ resignAttempts: 3 }),
      cleanPr(),
      ctx({ signingRequired: true, unsignedCount: 1 })
    );
    const t = lastTransition(d)!;
    expect(t.to).toBe('blocked');
    expect(t.blockedCode).toBe('unsigned_commits');
    expect(t.blockedReason).toBe(unsignedCommitsBlockReason(3));
    expect(kinds(d)).toContain('notify_blocked');
    expect(d.verdict).toBe('advance');
  });

  it('blocked(unsigned_commits) stays gated until a new head', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'unsigned_commits', resignAttempts: 3 }),
      cleanPr(),
      ctx({ signingRequired: true })
    );
    expect(d.actions).toEqual([]);
    expect(d.verdict).toBe('advance');
  });

  it('a new head re-arms the signing flow (budgets + memo reset)', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'unsigned_commits', resignAttempts: 3, headSha: 'sha1', signingCheckedSha: 'sha1', unsignedCount: 1 }),
      pr({ headSha: 'sha2' }),
      ctx({ signingRequired: true })
    );
    expect(kinds(d)).toContain('reset_budgets');
    expect(kinds(d)).toContain('probe_signatures');
  });
});

describe('decide — GitHub native auto-merge', () => {
  it('arms auto-merge on the head when clean-but-awaiting-CI and capability is available', () => {
    const d = decide(entry(), ciRunningPr(), ctx({ autoMergeCapability: 'available' }));
    expect(kinds(d)).toContain('arm_automerge');
    expect(d.verdict).toBe('advance');
  });

  it('arms even while the fix run is still in flight — an overrunning task must not waste the CI window', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1', fixTaskAccounted: false }),
      ciRunningPr(),
      ctx({ autoMergeCapability: 'available', fixTaskState: 'active' })
    );
    expect(kinds(d)).toContain('arm_automerge');
  });

  it('arms mid-run on a signing repo too, once the head probes signed (memoized per head)', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1', signingCheckedSha: 'sha1', unsignedCount: 0 }),
      ciRunningPr(),
      ctx({ autoMergeCapability: 'available', fixTaskState: 'active', signingRequired: true })
    );
    expect(kinds(d)).toContain('arm_automerge');
  });

  it('falls back to awaiting_ci when the repo has auto-merge disabled', () => {
    const d = decide(entry(), ciRunningPr(), ctx({ autoMergeCapability: 'unavailable' }));
    expect(kinds(d)).not.toContain('arm_automerge');
    expect(lastTransition(d)!.to).toBe('awaiting_ci');
  });

  it('never arms a non-head entry', () => {
    const d = decide(entry(), ciRunningPr(), ctx({ autoMergeCapability: 'available', isHead: false }));
    expect(kinds(d)).not.toContain('arm_automerge');
  });

  it('never arms while a sibling merge/arm is in flight (one armed entry per group)', () => {
    const d = decide(entry(), ciRunningPr(), ctx({ autoMergeCapability: 'available', groupMergeInFlight: true }));
    expect(kinds(d)).not.toContain('arm_automerge');
  });

  it('runs the signing gate before arming (an armed unsigned PR would wedge silently)', () => {
    const d = decide(entry(), ciRunningPr(), ctx({ autoMergeCapability: 'available', signingRequired: true }));
    expect(kinds(d)).toEqual(['probe_signatures']);
  });

  it('re-signs instead of arming when the head has unsigned commits', () => {
    const d = decide(
      entry(),
      ciRunningPr(),
      ctx({ autoMergeCapability: 'available', signingRequired: true, unsignedCount: 1 })
    );
    expect(kinds(d)).not.toContain('arm_automerge');
    expect(fixRun(d)).toEqual({ kind: 'fire_fix_run', resign: true });
  });

  it('an armed, unobstructed head just waits for GitHub (no actions)', () => {
    const d = decide(
      entry({ status: 'automerge_armed', automergeArmedBy: 'talyn' }),
      pr({ mergeStateStatus: 'BLOCKED', autoMergeEnabledBy: 'talyn' }, { blockingReason: 'blocked', checks: { total: 3, failed: 0, inProgress: 1 } }),
      ctx({ autoMergeCapability: 'available' })
    );
    expect(d.actions).toEqual([]);
    expect(d.verdict).toBe('advance');
  });

  it('re-evaluates when GitHub silently disarmed the auto-merge', () => {
    const d = decide(
      entry({ status: 'automerge_armed', automergeArmedBy: 'talyn' }),
      ciRunningPr(), // autoMergeEnabledBy: null — GitHub bailed
      ctx({ autoMergeCapability: 'available' })
    );
    expect(transitions(d)[0]!.to).toBe('queued');
    expect(kinds(d)).toContain('arm_automerge'); // preconditions still hold → re-arm
  });

  it('remediates a settled blocker that appears while armed (BEHIND → fix path)', () => {
    const d = decide(
      entry({ status: 'automerge_armed', automergeArmedBy: 'talyn' }),
      pr({ mergeStateStatus: 'BEHIND', autoMergeEnabledBy: 'talyn' }),
      ctx({ autoMergeCapability: 'available' })
    );
    expect(fixRun(d)).toBeTruthy();
  });

  it('disarms a Talyn-armed auto-merge on ANY transition into blocked (never merge behind the queue)', () => {
    const d = decide(
      entry({
        status: 'fixing',
        fixTaskId: 't3',
        fixTaskAccounted: false,
        seenSignatures: [
          blockerSignature(
            pr(
              { mergeStateStatus: 'DIRTY', autoMergeEnabledBy: 'talyn' },
              { mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' }
            )
          ),
        ],
        automergeArmedBy: 'talyn',
      }),
      pr({ mergeStateStatus: 'DIRTY', autoMergeEnabledBy: 'talyn' }, { mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' }),
      ctx({ fixTaskState: 'terminal' })
    );
    const disarmIdx = kinds(d).indexOf('disarm_automerge');
    const blockIdx = d.actions.findIndex((a) => a.kind === 'transition' && a.to === 'blocked');
    expect(disarmIdx).toBeGreaterThanOrEqual(0);
    expect(blockIdx).toBeGreaterThan(disarmIdx); // disarm strictly before the block
  });

  it('never disarms a USER-armed auto-merge', () => {
    const d = decide(
      entry({
        status: 'queued',
        seenSignatures: [blockerSignature(conflictingPr())],
        automergeArmedBy: 'user',
      }),
      conflictingPr(),
      ctx()
    );
    expect(kinds(d)).not.toContain('disarm_automerge');
  });
});

describe('decide — external merge queue (trunk.io / GitHub native)', () => {
  /** A PR carrying trunk's status labels. */
  const trunkPr = (label: string, o: Partial<PrSnapshot> = {}, s: Partial<PRMergeableSummary> = {}) =>
    pr(o, { labels: [label, 'stamphog'], ...s });
  const submitted = (o: Partial<EntrySnapshot> = {}) =>
    entry({
      status: 'awaiting_external',
      externalSubmitVia: 'auto_merge',
      submitAttempts: 1,
      automergeArmedBy: 'talyn',
      ...o,
    });
  /**
   * Everything except the bookkeeping write that records where the provider
   * says the PR is. That write happens whenever the observed state MOVES (it's
   * what drives the desktop badge and the entry timeline) and is not itself
   * queue work, so the "does the queue leave this PR alone?" assertions filter
   * it out and check it separately.
   */
  const workActions = (d: Decision) =>
    d.actions.filter((a) => !(a.kind === 'transition' && a.event.code === 'external_state'));
  const recorded = (d: Decision) =>
    transitions(d).find((t) => t.event.code === 'external_state')?.set?.externalState ?? null;

  describe('submitting instead of merging', () => {
    it.each([['suspected'], ['confirmed']] as const)(
      'submits a clean PR to the external queue (%s gate) instead of merging it',
      (gate) => {
        const d = decide(entry(), cleanPr(), ctx({ externalGate: gate }));
        expect(kinds(d)).toEqual(['submit_external']);
        expect(kinds(d)).not.toContain('verify_live_then_merge');
      }
    );

    it('submits a PR whose only obstacle is in-flight CI, without waiting for auto-merge capability', () => {
      const d = decide(entry(), ciRunningPr(), ctx({ externalGate: 'confirmed' }));
      expect(kinds(d)).toEqual(['submit_external']);
      expect(d.verdict).toBe('advance');
    });

    it('submits even when it is NOT the group head and a sibling is in flight — the queue orders, not us', () => {
      const d = decide(
        entry(),
        cleanPr(),
        ctx({ externalGate: 'confirmed', isHead: false, groupMergeInFlight: true })
      );
      expect(kinds(d)).toEqual(['submit_external']);
    });

    it('still gates on signed commits before submitting (the provider merges, and the ruleset still applies)', () => {
      const d = decide(entry(), cleanPr(), ctx({ externalGate: 'confirmed', signingRequired: true }));
      expect(kinds(d)).toEqual(['probe_signatures']);
      expect(kinds(d)).not.toContain('submit_external');
    });

    it('never submits a blocked PR — it fixes it first', () => {
      const d = decide(entry(), conflictingPr(), ctx({ externalGate: 'confirmed' }));
      expect(kinds(d)).toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('submit_external');
    });

    it('never submits a draft', () => {
      const d = decide(entry(), draftPr(), ctx({ externalGate: 'confirmed' }));
      expect(kinds(d)).not.toContain('submit_external');
      expect(lastTransition(d)!.blockedCode).toBe('draft');
    });
  });

  describe('the whole-repo BLOCKED state a gate creates', () => {
    // The day trunk.io went live on posthog/posthog, EVERY open PR came back
    // MERGEABLE + BLOCKED — approved, green, conflict-free ones included —
    // because the ruleset forbids updating the ref. Reading that as a blocker
    // fired a paid fix run at every ready PR.
    const gateBlockedPr = (s: Partial<PRMergeableSummary> = {}) =>
      pr({ mergeStateStatus: 'BLOCKED' }, { blockingReason: 'blocked', reviewDecision: 'APPROVED', ...s });

    it('submits a ready-but-BLOCKED PR instead of firing a fix run at it', () => {
      const d = decide(entry(), gateBlockedPr(), ctx({ externalGate: 'confirmed' }));
      expect(kinds(d)).toEqual(['submit_external']);
      expect(kinds(d)).not.toContain('fire_fix_run');
    });

    it('keeps firing fix runs for the same state when there is NO gate (unchanged)', () => {
      const d = decide(entry(), gateBlockedPr(), ctx());
      expect(kinds(d)).toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('submit_external');
    });

    it.each([
      ['merge conflicts', { mergeable: 'CONFLICTING' as const, blockingReason: 'merge_conflicts' as const }],
      ['requested changes', { reviewDecision: 'CHANGES_REQUESTED' as const }],
      ['a failing required check', { blockingReason: 'checks_failed' as const, checks: { total: 3, failed: 1, inProgress: 0 } }],
      ['unresolved review threads', { unresolvedReviewThreads: 2 }],
    ])('still fixes %s under a gate — real work, whoever performs the merge', (_label, over) => {
      const d = decide(entry(), gateBlockedPr(over), ctx({ externalGate: 'confirmed' }));
      expect(kinds(d)).toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('submit_external');
    });

    // The 2026-08-18 runaway. Under a gate the external queue rebases and
    // tests against the current base itself, so "behind master" is the steady
    // state of every open PR on a busy repo — not work to be done. Updating
    // the branch produced a new head, R2 reset the fix budget on it, and the
    // next base advance bought another paid cloud run, forever.
    it('submits a BEHIND branch instead of updating it — the queue owns that', () => {
      const d = decide(
        entry(),
        pr({ mergeStateStatus: 'BEHIND' }, { reviewDecision: 'APPROVED' }),
        ctx({ externalGate: 'confirmed', updateBranchAvailable: true })
      );
      expect(kinds(d)).toEqual(['submit_external']);
      expect(kinds(d)).not.toContain('update_branch');
      expect(kinds(d)).not.toContain('fire_fix_run');
    });

    it('still updates a BEHIND branch when there is NO gate (unchanged)', () => {
      const d = decide(
        entry(),
        pr({ mergeStateStatus: 'BEHIND' }, { reviewDecision: 'APPROVED' }),
        ctx({ updateBranchAvailable: true })
      );
      expect(kinds(d)).toEqual(['update_branch']);
    });

    // The other half of the same runaway: BEHIND also dropped an already
    // submitted PR out of the awaiting_external short-circuit, so every base
    // advance pulled a PR trunk was happily testing back into remediation.
    it('keeps a submitted PR tracked when its base moves under it', () => {
      const d = decide(
        entry({
          status: 'awaiting_external',
          externalSubmitVia: 'comment',
          externalSubmittedAt: '2026-07-16T11:00:00.000Z',
          externalState: 'testing',
        }),
        pr({ mergeStateStatus: 'BEHIND' }, { reviewDecision: 'APPROVED' }),
        ctx({ externalGate: 'confirmed', updateBranchAvailable: true })
      );
      expect(d.verdict).toBe('advance');
      expect(kinds(d)).not.toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('update_branch');
    });

    // The gate exemption is narrow on purpose: it drops BEHIND, nothing else.
    it('still fixes a BEHIND PR that also has real work under a gate', () => {
      const d = decide(
        entry(),
        pr({ mergeStateStatus: 'BEHIND' }, { mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' }),
        ctx({ externalGate: 'confirmed', updateBranchAvailable: true })
      );
      expect(kinds(d)).toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('submit_external');
    });

    it('still waits for a missing required review rather than submitting', () => {
      const d = decide(
        entry(),
        gateBlockedPr({ reviewDecision: 'REVIEW_REQUIRED' }),
        ctx({ externalGate: 'confirmed' })
      );
      expect(lastTransition(d)!.to).toBe('awaiting_review');
      expect(kinds(d)).not.toContain('submit_external');
    });

    it('does not count a fix run as failed when the PR only reads BLOCKED afterwards', () => {
      const d = decide(
        entry({ fixTaskId: 't1', fixTaskAccounted: false, fixAttempts: 0 }),
        gateBlockedPr(),
        ctx({ externalGate: 'confirmed', fixTaskState: 'terminal' })
      );
      const accounting = transitions(d)[0]!;
      expect(accounting.set?.fixAttempts).toBe(0); // budget untouched
      expect(accounting.event.message).toContain('reads clean');
    });
  });

  describe('submit aftermath', () => {
    it('records the submission, the door it used, and spends one submit attempt', () => {
      const d = decide(
        entry(),
        cleanPr(),
        ctx({ externalGate: 'confirmed', submitOutcome: { kind: 'submitted', via: 'auto_merge', armedBy: 'talyn' } })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('awaiting_external');
      expect(t.set?.externalSubmitVia).toBe('auto_merge');
      expect(t.set?.submitAttempts).toBe(1);
      expect(t.set?.automergeArmedBy).toBe('talyn');
      expect(d.verdict).toBe('advance');
    });

    it('adopts a USER-armed auto-merge as the submission without claiming it as ours', () => {
      const d = decide(
        entry(),
        pr({ autoMergeEnabledBy: 'user' }),
        ctx({ externalGate: 'confirmed', submitOutcome: { kind: 'submitted', via: 'auto_merge', armedBy: 'user' } })
      );
      expect(lastTransition(d)!.set?.automergeArmedBy).toBe('user');
    });

    it('records a label submission without touching auto-merge bookkeeping', () => {
      const d = decide(
        entry(),
        cleanPr(),
        ctx({ externalGate: 'confirmed', submitOutcome: { kind: 'submitted', via: 'label' } })
      );
      const t = lastTransition(d)!;
      expect(t.set?.externalSubmitVia).toBe('label');
      expect(t.set?.automergeArmedBy).toBeUndefined();
    });

    it('falls back to one real merge attempt when the gate is only suspected', () => {
      const d = decide(
        entry(),
        cleanPr(),
        ctx({ externalGate: 'suspected', submitOutcome: { kind: 'try_direct_merge' } })
      );
      expect(kinds(d)).toEqual(['verify_live_then_merge']);
      expect(d.verdict).toBe('hold');
    });

    it('holds as queued (no attempt spent) on a transient submit failure', () => {
      const d = decide(
        entry({ status: 'awaiting_ci' }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', submitOutcome: { kind: 'retry', message: 'Head moved while submitting.' } })
      );
      expect(lastTransition(d)!.to).toBe('queued');
      expect(lastTransition(d)!.set?.submitAttempts).toBeUndefined();
    });

    // PostHog/posthog#84433: trunk had the PR ("✨ Submitted to Merge by
    // talyn-app[bot]"), but it had also REWRITTEN its instruction comment to say
    // so — which closed the command door, and with no submit label and no
    // auto-merge on a gated branch, every door was shut. The PR was reported as
    // needing manual intervention while sitting healthily in the queue.
    it('tracks the queue instead of blocking when the provider already has the PR', () => {
      const d = decide(
        entry(),
        cleanPr(),
        ctx({
          externalGate: 'confirmed',
          submitOutcome: {
            kind: 'already_submitted',
            state: 'queued',
            evidence: '✨ Submitted to Merge by talyn-app[bot]',
          },
        })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('awaiting_external');
      expect(t.set?.externalState).toBe('queued');
      expect(t.event.code).toBe('external_already_submitted');
      expect(t.blockedCode).toBeNull();
      expect(kinds(d)).not.toContain('notify_blocked');
      expect(d.verdict).toBe('advance');
    });

    it('blocks manually only when nothing can submit the PR', () => {
      const d = decide(
        entry(),
        cleanPr(),
        ctx({ externalGate: 'confirmed', submitOutcome: { kind: 'unavailable', message: 'no auto-merge, no label' } })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked_manual');
      expect(t.blockedCode).toBe('external_gate');
      expect(kinds(d)).toContain('notify_blocked');
    });
  });

  describe('while the provider holds the PR', () => {
    it.each([
      ['trunk-not-ready', 'not_ready'],
      ['trunk-queued', 'queued'],
      ['trunk-testing', 'testing'],
      ['trunk-tests-passed', 'passed'],
    ] as const)(
      'waits (no actions) while the provider reports %s',
      (label, state) => {
        const d = decide(submitted(), trunkPr(label), ctx({ externalGate: 'confirmed' }));
        expect(workActions(d)).toEqual([]);
        expect(recorded(d)).toBe(state);
        expect(d.verdict).toBe('advance');
      }
    );

    it('treats a bisection variant as the same state', () => {
      const d = decide(submitted(), trunkPr('trunk-testing (bisection)'), ctx({ externalGate: 'confirmed' }));
      expect(workActions(d)).toEqual([]);
      expect(recorded(d)).toBe('testing');
    });

    it('records the provider state only when it MOVES', () => {
      const d = decide(
        submitted({ externalState: 'testing' }),
        trunkPr('trunk-testing'),
        ctx({ externalGate: 'confirmed' })
      );
      expect(d.actions).toEqual([]);
    });

    it('waits in the gap before the provider has labelled the PR (auto-merge still armed)', () => {
      const d = decide(
        submitted(),
        pr({ autoMergeEnabledBy: 'talyn' }),
        ctx({ externalGate: 'confirmed' })
      );
      expect(d.actions).toEqual([]);
    });

    // A run's fix arrives as a PUSH, and trunk answers a push by ejecting the
    // PR ("removed from the merge queue because it was pushed to by @x"). So
    // remediating here does not fix the PR, it destroys the test cycle the PR
    // was in — and it fired on the ordinary shape of a reviewed PR, since an
    // unresolved review thread counts as a settled blocker.
    it.each([
      ['trunk-queued'],
      ['trunk-testing'],
      ['trunk-tests-passed'],
    ] as const)('does NOT push at a %s PR, even with a settled blocker', (label) => {
      const d = decide(
        submitted(),
        trunkPr(label, { mergeStateStatus: 'DIRTY' }, {
          mergeable: 'CONFLICTING',
          blockingReason: 'merge_conflicts',
        }),
        ctx({ externalGate: 'confirmed', updateBranchAvailable: true })
      );
      expect(kinds(d)).not.toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('update_branch');
      expect(kinds(d)).not.toContain('submit_external');
      expect(d.verdict).toBe('advance');
    });

    // ...but `not_ready` is the one holding state where standing down is a
    // deadlock, not patience. Trunk has the submission and has NOT added the
    // PR — "it will be added to the merge queue once all branch protection
    // rules pass". Nothing is running, so a push ejects nothing, and the branch
    // protection it is waiting on is exactly what the fix run produces. Read as
    // a cycle to protect, each side waits for the other: PostHog/posthog#84450
    // sat here 9½ hours with three required checks red.
    it('DOES remediate a not_ready PR — trunk is waiting on the blocker', () => {
      const d = decide(
        submitted(),
        trunkPr('trunk-not-ready', { mergeStateStatus: 'BLOCKED' }, {
          blockingReason: 'checks_failed',
          checks: { total: 10, passed: 7, failed: 3, inProgress: 0, skipped: 0 },
        }),
        ctx({ externalGate: 'confirmed' })
      );
      expect(kinds(d)).toContain('fire_fix_run');
    });

    it('leaves a not_ready PR alone when it has no blocker to remediate', () => {
      const d = decide(
        submitted(),
        trunkPr('trunk-not-ready'),
        ctx({ externalGate: 'confirmed' })
      );
      expect(workActions(d)).toEqual([]);
      expect(d.verdict).toBe('advance');
    });

    it('does NOT push at an unresolved review thread either — the everyday case', () => {
      const d = decide(
        submitted(),
        trunkPr('trunk-testing', {}, { unresolvedReviewThreads: 2 }),
        ctx({ externalGate: 'confirmed' })
      );
      expect(workActions(d)).toEqual([]);
    });

    // The stand-down is on OBSERVED holding, not on our own submission record:
    // with no answer from the provider, nothing says a queue is testing the PR,
    // and parking on that would strand it forever.
    it('still remediates a settled blocker when the provider has said nothing at all', () => {
      const d = decide(
        submitted(),
        pr({ autoMergeEnabledBy: 'talyn', mergeStateStatus: 'DIRTY' }, {
          mergeable: 'CONFLICTING',
          blockingReason: 'merge_conflicts',
        }),
        ctx({ externalGate: 'confirmed' })
      );
      expect(kinds(d)).toContain('fire_fix_run');
    });

    it('takes the PR back when the submission disappears outside Talyn', () => {
      const d = decide(
        submitted({ automergeArmedBy: null }),
        pr({ autoMergeEnabledBy: null }),
        ctx({ externalGate: 'confirmed' })
      );
      const t = transitions(d)[0]!;
      expect(t.to).toBe('queued');
      expect(t.event.code).toBe('external_submission_lost');
      // …and immediately resubmits, since the PR is clean.
      expect(kinds(d)).toContain('submit_external');
    });

    it('closes the entry out when the provider merges it', () => {
      const d = decide(submitted(), pr({ state: 'merged' }, { labels: ['trunk-merged'] }), ctx({ externalGate: 'confirmed' }));
      expect(lastTransition(d)!.to).toBe('merged');
    });
  });

  // The entry only reaches `awaiting_external` when TALYN submitted the PR.
  // Every other route into trunk's queue — the author commenting `/trunk merge`
  // themselves, a PR queued in Talyn after it was already submitted — left the
  // entry in `queued`, walking straight into the rules that push and merge.
  describe('the provider holds a PR the entry does not know about', () => {
    const holding = (state: ExternalQueueState) =>
      ({ provider: 'trunk', state, source: 'comment', evidence: 'trunk said so' }) as const;

    it.each([['queued'], ['testing'], ['passed'], ['not_ready']] as const)(
      'parks a plain queued entry rather than acting on a PR trunk reports as %s',
      (state) => {
        const d = decide(
          entry(),
          cleanPr(),
          ctx({ externalGate: 'confirmed', externalQueue: holding(state) })
        );
        expect(lastTransition(d)!.to).toBe('awaiting_external');
        expect(kinds(d)).not.toContain('submit_external');
        expect(kinds(d)).not.toContain('verify_live_then_merge');
      }
    );

    it('does not fire a fix run at a blocked entry the provider has picked up', () => {
      const d = decide(
        entry({ status: 'blocked', blockedCode: 'no_progress' }),
        conflictingPr(),
        ctx({ externalGate: 'confirmed', externalQueue: holding('testing') })
      );
      expect(kinds(d)).not.toContain('fire_fix_run');
      expect(lastTransition(d)!.to).toBe('awaiting_external');
    });

    it('holds without parking while our own run is still in flight — its push is already coming', () => {
      const d = decide(
        entry({ status: 'fixing', fixTaskId: 't1', fixTaskAccounted: false }),
        conflictingPr(),
        ctx({ externalGate: 'confirmed', externalQueue: holding('testing'), fixTaskState: 'active' })
      );
      expect(kinds(d)).not.toContain('fire_fix_run');
      expect(d.verdict).toBe('hold');
    });

    it('leaves an ejected PR to the ordinary rules — that is what the queue is for', () => {
      const d = decide(
        entry(),
        conflictingPr(),
        ctx({
          externalGate: 'confirmed',
          externalQueue: { provider: 'trunk', state: 'failed', source: 'comment', evidence: 'x' },
        })
      );
      expect(kinds(d)).toContain('fire_fix_run');
    });

    // Trunk leaves its labels behind — PostHog carries stale `trunk-testing`
    // on PRs that merged hours ago — so an ungated repo must never park on one.
    it('is inert on a repo with no gate at all, however the PR is labelled', () => {
      const d = decide(entry(), trunkPr('trunk-testing'), ctx());
      expect(kinds(d)).toContain('verify_live_then_merge');
    });
  });

  describe('resubmission is bounded', () => {
    /** Trunk names the pusher, so the sentence differs every single time. */
    const pushedBackBy = (who: string) =>
      ({
        provider: 'trunk',
        state: 'ejected',
        source: 'comment',
        evidence:
          'This pull request was removed from the merge queue because it was pushed to by ' +
          `@${who}. Please re-submit it in order to merge.`,
      }) as const;

    it('reads two push-ejections naming different people as the same reason', () => {
      expect(queueSignature(pushedBackBy('alice'))).toBe(queueSignature(pushedBackBy('bob')));
    });

    it('keeps telling a different failing check apart from a repeat of the same one', () => {
      const failed = (check: string) =>
        ({
          provider: 'trunk',
          state: 'failed',
          source: 'comment',
          evidence: `The required check \`${check}\` (Failure) has failed.`,
        }) as const;
      expect(queueSignature(failed('backend'))).not.toBe(queueSignature(failed('frontend')));
    });

    it('blocks instead of resubmitting when the queue repeats itself', () => {
      const d = decide(
        submitted({ seenSignatures: [queueSignature(pushedBackBy('alice'))] }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: pushedBackBy('bob') })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked');
      expect(t.blockedCode).toBe('external_queue_rejected');
      expect(kinds(d)).not.toContain('submit_external');
    });

    // `submitAttempts` was counted from the day it shipped and never read; the
    // `external_queue_rejected` doc and the desktop's `submits: n/3` both
    // promised a cap that did not exist. It bounds the untested ejections,
    // which are the only ones that still go round again.
    const pushedBack = {
      provider: 'trunk',
      state: 'ejected',
      source: 'comment',
      evidence: 'it was pushed to by @someone',
    } as const;

    it('stops resubmitting once the per-head submit budget is spent', () => {
      const d = decide(
        submitted({ submitAttempts: 3 }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', maxAttempts: 3, externalQueue: pushedBack })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked');
      expect(t.blockedCode).toBe('external_queue_rejected');
      expect(kinds(d)).toContain('notify_blocked');
    });

    it('still resubmits inside the budget', () => {
      const d = decide(
        submitted({ submitAttempts: 1 }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', maxAttempts: 3, externalQueue: pushedBack })
      );
      expect(transitions(d).map((t) => t.event.code)).toContain('external_queue_ejected');
      expect(kinds(d)).toContain('submit_external');
    });

    it('earns a fresh budget on a genuine new head', () => {
      const d = decide(
        submitted({ submitAttempts: 3, headSha: 'old' }),
        pr({ headSha: 'new' }),
        ctx({ externalGate: 'confirmed', maxAttempts: 3, externalQueue: pushedBack })
      );
      expect(kinds(d)).toContain('reset_budgets');
      expect(kinds(d)).toContain('submit_external');
    });
  });

  // Per-PR budgets cannot see that the QUEUE is the broken thing, so with a
  // backlog each entry rediscovers a dead runner alone. Trunk batches, so those
  // submissions lengthen the outage for the PRs already in the queue.
  describe('backing off a queue that looks broken across PRs', () => {
    const degraded = { state: 'degraded', prs: [11, 22, 33] } as const;

    it.each([['suspected'], ['confirmed']] as const)(
      'does not submit a clean PR into a degraded queue (%s gate)',
      (gate) => {
        const d = decide(entry(), cleanPr(), ctx({ externalGate: gate, queueHealth: degraded }));
        expect(kinds(d)).not.toContain('submit_external');
        const t = lastTransition(d)!;
        expect(t.to).toBe('blocked');
        expect(t.blockedCode).toBe('external_queue_unhealthy');
      }
    );

    it('does not submit one whose only obstacle is in-flight CI either', () => {
      const d = decide(
        entry(),
        ciRunningPr(),
        ctx({ externalGate: 'confirmed', queueHealth: degraded })
      );
      expect(kinds(d)).not.toContain('submit_external');
      expect(lastTransition(d)!.blockedCode).toBe('external_queue_unhealthy');
    });

    // The point of the feature is that it fires across many entries at once,
    // so one notification per PR would be the noise it exists to remove.
    it('never notifies — the reason carries it in the UI instead', () => {
      const d = decide(entry(), cleanPr(), ctx({ externalGate: 'confirmed', queueHealth: degraded }));
      expect(kinds(d)).not.toContain('notify_blocked');
      expect(lastTransition(d)!.blockedReason).toContain('unhealthy');
    });

    it('settles rather than re-blocking an entry it already blocked', () => {
      const d = decide(
        entry({ status: 'blocked', blockedCode: 'external_queue_unhealthy' }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', queueHealth: degraded })
      );
      expect(d.actions).toEqual([]);
      expect(d.verdict).toBe('advance');
    });

    // This gates SUBMISSION only. Fixing a PR is useful whenever the queue
    // recovers, and holding it back would waste the outage.
    it('still remediates a PR with a real blocker while the queue is sick', () => {
      const d = decide(
        entry(),
        conflictingPr(),
        ctx({ externalGate: 'confirmed', queueHealth: degraded })
      );
      expect(kinds(d)).toContain('fire_fix_run');
    });

    // Nothing about the entry caused this block and nothing about it can clear
    // it, so it must never wait for a push.
    it('releases the block and submits once the queue looks healthy again', () => {
      const d = decide(
        entry({ status: 'blocked', blockedCode: 'external_queue_unhealthy' }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', queueHealth: null })
      );
      expect(transitions(d).map((t) => t.event.code)).toContain('external_queue_recovered');
      expect(kinds(d)).toContain('submit_external');
    });

    it('leaves a PR the queue is already testing alone — it is past submitting', () => {
      const d = decide(
        submitted(),
        trunkPr('trunk-testing'),
        ctx({ externalGate: 'confirmed', queueHealth: degraded })
      );
      expect(lastTransition(d)?.blockedCode).not.toBe('external_queue_unhealthy');
      expect(d.verdict).toBe('advance');
    });

    it('is inert on a repo whose queue looks fine', () => {
      const d = decide(entry(), cleanPr(), ctx({ externalGate: 'confirmed', queueHealth: null }));
      expect(kinds(d)).toContain('submit_external');
    });
  });

  describe('GitHub refuses the App merge (how a gated branch actually answers)', () => {
    // posthog/posthog doesn't 405 "protected ref" — it 403s every App token,
    // because its ruleset exempts only trunk's App. Before this, that refusal
    // went down the App-refusal ladder and ended in blocked_manual.
    const refusal = { kind: 'refused_app' as const, message: 'GitHub refused to let the Talyn App merge' };

    it('learns the gate and submits, instead of running the App-refusal ladder', () => {
      const d = decide(
        entry({ status: 'merging' }),
        cleanPr(),
        ctx({ externalGate: 'suspected', mergeOutcome: refusal, verifiedMerged: false })
      );
      expect(kinds(d)).toEqual(['mark_external_gate', 'transition', 'submit_external']);
      expect(lastTransition(d)!.to).toBe('queued');
      expect(kinds(d)).not.toContain('probe_signatures');
      expect(kinds(d)).not.toContain('rerequest_failed_checks');
    });

    it('still runs the App-refusal ladder when no gate is suspected', () => {
      const d = decide(
        entry({ status: 'merging' }),
        cleanPr(),
        ctx({ mergeOutcome: refusal, verifiedMerged: false })
      );
      expect(kinds(d)).toContain('probe_signatures');
      expect(kinds(d)).not.toContain('submit_external');
    });

    it('still records a merge that actually landed, before anything else', () => {
      const d = decide(
        entry({ status: 'merging' }),
        cleanPr(),
        ctx({ externalGate: 'suspected', mergeOutcome: refusal, verifiedMerged: true })
      );
      expect(kinds(d)).toEqual(['record_merged']);
    });
  });

  describe('the comment door (the provider must acknowledge it)', () => {
    // A posted command leaves nothing on GitHub to re-read, so "submitted" is
    // believed for a grace window and then has to be proven by a queue label.
    const commented = (submittedAt: string) =>
      entry({
        status: 'awaiting_external',
        externalSubmitVia: 'comment',
        externalSubmittedAt: submittedAt,
        submitAttempts: 1,
      });
    const minutesBefore = (n: number) => new Date(Date.parse(NOW) - n * 60_000).toISOString();

    it('records the command and when it was posted', () => {
      const d = decide(
        entry(),
        cleanPr(),
        ctx({
          externalGate: 'confirmed',
          submitOutcome: { kind: 'submitted', via: 'comment', detail: '/trunk merge' },
        })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('awaiting_external');
      expect(t.set?.externalSubmitVia).toBe('comment');
      expect(t.set?.externalSubmittedAt).toBe(NOW);
      expect(t.event.message).toContain('/trunk merge');
    });

    it('waits inside the grace window while the provider has not labelled the PR yet', () => {
      const d = decide(commented(minutesBefore(2)), cleanPr(), ctx({ externalGate: 'confirmed' }));
      expect(d.actions).toEqual([]);
    });

    it('keeps waiting past the window once the provider HAS acknowledged the PR', () => {
      const d = decide(
        commented(minutesBefore(60)),
        trunkPr('trunk-queued'),
        ctx({ externalGate: 'confirmed' })
      );
      expect(workActions(d)).toEqual([]);
    });

    it('blocks — without re-posting — when the window passes with no acknowledgement', () => {
      const d = decide(commented(minutesBefore(30)), cleanPr(), ctx({ externalGate: 'confirmed' }));
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked_manual');
      expect(t.blockedCode).toBe('external_gate');
      expect(t.blockedReason).toContain('never picked it up');
      expect(kinds(d)).not.toContain('submit_external'); // no comment spam
      expect(kinds(d)).toContain('notify_blocked');
    });
  });

  describe("the provider's own comment (the authoritative channel)", () => {
    // 2026-07-29: trunk was testing seven PRs on posthog/posthog and had
    // labelled none of them, so the label-only reading concluded its `/trunk
    // merge` comment had been ignored and blocked all seven. The comment
    // channel is what decide now believes.
    const observed = (state: ExternalQueueState, evidence = 'trunk said so') =>
      ({ provider: 'trunk', state, source: 'comment', evidence }) as const;
    const commented = (submittedAt: string, o: Partial<EntrySnapshot> = {}) =>
      entry({
        status: 'awaiting_external',
        externalSubmitVia: 'comment',
        externalSubmittedAt: submittedAt,
        submitAttempts: 1,
        ...o,
      });
    const longAgo = new Date(Date.parse(NOW) - 60 * 60_000).toISOString();

    it('keeps waiting on an UNLABELLED PR the provider says it is testing', () => {
      const d = decide(
        commented(longAgo),
        cleanPr(), // no trunk labels at all — exactly #74552
        ctx({ externalGate: 'confirmed', externalQueue: observed('testing') })
      );
      expect(workActions(d)).toEqual([]);
      expect(recorded(d)).toBe('testing');
      expect(d.verdict).toBe('advance');
    });

    // PostHog/posthog#75985: trunk merged the PR, so its head branch was
    // deleted and GitHub started answering mergeable/UNKNOWN. `merged` is in
    // neither isExternalQueueEjected nor isExternalQueueHolding, so it matched
    // no branch: stillSubmitted() was true (not an ejection), the
    // awaiting_external short-circuit needs !hasSettledBlocker and UNKNOWN IS
    // one, and remediation fired a paid fix run. Gated groups evaluate eagerly,
    // so it did it again on every webhook — 10+ cloud runs, each concluding
    // "this PR is already merged".
    it('is TERMINAL when the provider merged the PR — never fires a fix run', () => {
      const mergedAndDeleted = trunkPr(
        'trunk-merged',
        { mergeStateStatus: 'UNKNOWN' },
        { mergeable: 'UNKNOWN', blockingReason: 'blocked' }
      );
      const d = decide(
        commented(longAgo),
        mergedAndDeleted,
        ctx({ externalGate: 'confirmed', externalQueue: observed('merged', 'merged successfully') })
      );
      expect(lastTransition(d)?.to).toBe('merged');
      expect(fixRun(d)).toBeUndefined();
      expect(kinds(d)).not.toContain('submit_external');
      expect(d.verdict).toBe('advance');
    });

    it('stays terminal even when Talyn\'s own PR row still reads open', () => {
      // The lag that made R0 useless here: our row says open, the provider
      // says merged. The provider is right.
      const d = decide(
        entry({ status: 'queued' }),
        trunkPr('trunk-merged', { state: 'open', mergeStateStatus: 'UNKNOWN' }, { mergeable: 'UNKNOWN' }),
        ctx({ externalGate: 'confirmed', externalQueue: observed('merged') })
      );
      expect(lastTransition(d)?.to).toBe('merged');
      expect(fixRun(d)).toBeUndefined();
    });

    it('outranks a stale label the provider has moved past', () => {
      // The label still says testing; the comment says merged. The comment
      // wins — and since merged is terminal, it closes the entry out rather
      // than merely recording the newer state.
      const d = decide(
        submitted({ externalState: 'testing' }),
        trunkPr('trunk-testing'),
        ctx({ externalGate: 'confirmed', externalQueue: observed('merged') })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('merged');
      expect(t.set?.externalState).toBe('merged');
    });

    it('blocks only on the provider SAYING it has no submission, past the grace window', () => {
      const d = decide(
        commented(longAgo),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: observed('not_submitted') })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked_manual');
      expect(t.blockedReason).toContain('never picked it up');
      expect(kinds(d)).not.toContain('submit_external'); // no comment spam
    });

    it('still waits out the grace window on an untouched submit box', () => {
      const d = decide(
        commented(new Date(Date.parse(NOW) - 2 * 60_000).toISOString()),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: observed('not_submitted') })
      );
      expect(workActions(d)).toEqual([]);
    });

    it("blocks manually when the provider refuses the PR outright — no fix run, no resubmit", () => {
      const d = decide(
        commented(longAgo),
        cleanPr(),
        ctx({
          externalGate: 'confirmed',
          externalQueue: observed('rejected', 'unable to merge this PR'),
        })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked_manual');
      expect(t.blockedCode).toBe('external_gate');
      expect(t.blockedReason).toContain('unable to merge this PR');
      expect(kinds(d)).toContain('notify_blocked');
      expect(kinds(d)).not.toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('submit_external');
    });

    it('does not re-eject on evidence that predates our own resubmission', () => {
      // Both channels are edited IN PLACE, so for the ~30s it takes the
      // provider to react, a fresh read still returns the state we already
      // resubmitted against. Acting on it would eject → resubmit → eject and
      // spend the whole per-head budget in a minute.
      const d = decide(
        commented(new Date(Date.parse(NOW) - 30_000).toISOString(), { submitAttempts: 1 }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: observed('failed') })
      );
      expect(d.actions).toEqual([]);
      expect(d.verdict).toBe('advance');
    });

    it('DOES eject once the grace window has passed without the provider moving on', () => {
      const d = decide(
        commented(longAgo, { submitAttempts: 1 }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: observed('cancelled') })
      );
      expect(lastTransition(d)!.blockedCode).toBe('external_queue_rejected');
    });

    it('acts on a failure the provider reports in its comment, not in a label', () => {
      const d = decide(
        commented(longAgo),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: observed('failed') })
      );
      expect(transitions(d).map((t) => t.event.code)).toContain('external_queue_failed_fixing');
      expect(kinds(d)).toContain('fire_fix_run');
    });

    it.each([['blocked_manual'], ['blocked']] as const)(
      'takes a %s entry back the moment the provider is seen holding the PR',
      (status) => {
        const d = decide(
          entry({
            status,
            blockedCode: status === 'blocked' ? 'external_queue_rejected' : 'external_gate',
            blockedReason: 'the old label-only reading gave up on this PR',
            submitAttempts: 3,
          }),
          cleanPr(),
          ctx({ externalGate: 'confirmed', externalQueue: observed('testing') })
        );
        const t = lastTransition(d)!;
        expect(t.to).toBe('awaiting_external');
        expect(t.set?.externalState).toBe('testing');
        expect(t.event.code).toBe('external_queue_holding');
        expect(d.verdict).toBe('advance');
      }
    );

    // PostHog/posthog#84471: R5d parked the entry ("trunk has this PR"), R11's
    // recurrence guard blocked it straight back ("a fix run already failed to
    // move this"), and the two rewrote the entry twice per evaluation — 100
    // events inside one minute. The block is about the PR, not the queue, so
    // the provider holding it is not evidence against it.
    it('does not fight the recurrence guard over a blocked entry', () => {
      const redPr = trunkPr('trunk-not-ready', { mergeStateStatus: 'BLOCKED' }, {
        blockingReason: 'checks_failed',
        checks: { total: 10, passed: 7, failed: 3, inProgress: 0, skipped: 0 },
      });
      const blockedEntry = entry({
        status: 'blocked',
        blockedCode: 'no_progress',
        blockedReason: 'a fix run already failed to move this',
        seenSignatures: [blockerSignature(redPr)],
      });
      const d = decide(
        blockedEntry,
        redPr,
        ctx({ externalGate: 'confirmed', externalQueue: observed('not_ready') })
      );
      expect(transitions(d)).toEqual([]);
      expect(workActions(d)).toEqual([]);
      expect(d.verdict).toBe('advance');
    });

    // The "no way to submit this automatically" block is the one verdict here
    // that is about the REPO rather than the PR, so it can stop being true with
    // nothing about the PR changing — as it did the moment the submit-label
    // probe learned to paginate. Without this it took a manual requeue per PR.
    it('retires the no-mechanism block once a submit door exists', () => {
      const d = decide(
        entry({
          status: 'blocked_manual',
          blockedCode: 'external_gate',
          blockedReason: 'no way to submit the PR automatically',
          submitAttempts: 1,
        }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalSubmitDoor: true })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('queued');
      expect(t.blockedCode).toBeNull();
      expect(t.event.code).toBe('external_submit_door_found');
    });

    it('keeps the block while no door exists', () => {
      const d = decide(
        entry({
          status: 'blocked_manual',
          blockedCode: 'external_gate',
          blockedReason: 'no way to submit the PR automatically',
          submitAttempts: 1,
        }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalSubmitDoor: false })
      );
      expect(transitions(d)).toEqual([]);
      expect(workActions(d)).toEqual([]);
    });

    // PostHog/posthog#82679: trunk refuses a submission from Talyn's App ("Only
    // users that are a part of this repo's Trunk organization … can submit"),
    // and DELETES the submit label as it does. That read as "the submission
    // vanished" — the one path with no budget on it — so Talyn re-applied the
    // label immediately: 61 label events and 38 provider comments in an hour,
    // one cycle every four seconds, on a shared repo.
    describe('a submission the provider keeps discarding', () => {
      const lost = (submitAttempts: number) =>
        decide(
          entry({
            status: 'awaiting_external',
            externalSubmitVia: 'label',
            externalSubmittedAt: longAgo,
            submitAttempts,
          }),
          cleanPr(),
          ctx({ externalGate: 'confirmed', externalQueue: null })
        );

      it('takes the PR back while the budget is unspent', () => {
        const d = lost(1);
        const t = lastTransition(d)!;
        expect(t.to).toBe('queued');
        expect(t.event.code).toBe('external_submission_lost');
      });

      it('stops instead of submitting again once the budget is spent', () => {
        const d = lost(3);
        const t = lastTransition(d)!;
        expect(t.to).toBe('blocked_manual');
        expect(t.event.code).toBe('external_submission_lost_exhausted');
        expect(kinds(d)).toContain('notify_blocked');
        expect(kinds(d)).not.toContain('submit_external');
        // The reason has to name the check a human can actually make.
        expect(t.blockedReason).toContain("Talyn's GitHub App");
      });
    });

    it('leaves an external block alone while the provider is NOT holding the PR', () => {
      for (const state of ['not_submitted', 'failed', 'cancelled', 'rejected'] as const) {
        const d = decide(
          entry({ status: 'blocked_manual', blockedCode: 'external_gate', submitAttempts: 3 }),
          cleanPr(),
          ctx({ externalGate: 'confirmed', externalQueue: observed(state) })
        );
        expect(lastTransition(d)?.to).not.toBe('awaiting_external');
      }
    });

    // An eject the provider invited a resubmit for is NOT a cancellation: it
    // goes round again on the ordinary budget instead of blocking on sight.
    it('requeues an `ejected` PR for a resubmit rather than blocking it', () => {
      const d = decide(
        commented(longAgo, { submitAttempts: 1 }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: observed('ejected') })
      );
      expect(transitions(d).map((t) => t.event.code)).toContain('external_queue_ejected');
      expect(kinds(d)).toContain('submit_external');
    });

    // PostHog/posthog#85338 + #85284: trunk's queue run died in "Apply postgres
    // and clickhouse migrations and setup dev" with "failed to bind host port
    // for 0.0.0.0:50052 … address already in use". The tests never ran, both
    // PRs were green on their own branches, and nothing a cloud agent could
    // write would have changed the outcome.
    describe('a queue run that died on CI infrastructure', () => {
      const infra = {
        kind: 'infrastructure' as const,
        detail: 'the "Apply postgres and clickhouse migrations and setup dev" step failed',
      };

      it('resubmits instead of spending a fix run', () => {
        const d = decide(
          commented(longAgo, { submitAttempts: 1 }),
          cleanPr(),
          ctx({
            externalGate: 'confirmed',
            externalQueue: observed('failed'),
            externalFailure: infra,
          })
        );
        const t = lastTransition(d)!;
        expect(t.to).toBe('queued');
        expect(t.event.code).toBe('external_queue_infra_failure');
        expect(kinds(d)).toContain('submit_external');
        expect(kinds(d)).not.toContain('fire_fix_run');
        expect(kinds(d)).not.toContain('notify_blocked');
        // The signature must NOT be recorded: an infrastructure death is not a
        // reason this PR can defeat, and recording it would make a LATER real
        // failure look like a repeat.
        expect(t.set?.seenSignatures).toBeUndefined();
      });

      it('keeps resubmitting when the same infrastructure failure repeats', () => {
        const failed = observed('failed');
        const d = decide(
          commented(longAgo, { submitAttempts: 2, seenSignatures: [queueSignature(failed)] }),
          cleanPr(),
          ctx({ externalGate: 'confirmed', externalQueue: failed, externalFailure: infra })
        );
        expect(lastTransition(d)!.event.code).toBe('external_queue_infra_failure');
        expect(kinds(d)).toContain('submit_external');
        expect(kinds(d)).not.toContain('fire_fix_run');
      });

      it('stops once this head has spent its infrastructure budget', () => {
        const d = decide(
          commented(longAgo, { submitAttempts: MAX_INFRA_SUBMITS_PER_HEAD }),
          cleanPr(),
          ctx({
            externalGate: 'confirmed',
            externalQueue: observed('failed'),
            externalFailure: infra,
          })
        );
        const t = lastTransition(d)!;
        expect(t.to).toBe('blocked');
        expect(t.blockedCode).toBe('external_queue_rejected');
        // The reason must not read like the PR broke something.
        expect(t.blockedReason).toContain('infrastructure');
        expect(t.blockedReason).toContain('nothing here to fix');
        expect(kinds(d)).toContain('notify_blocked');
        expect(kinds(d)).not.toContain('submit_external');
        expect(kinds(d)).not.toContain('fire_fix_run');
      });

      it.each([['unknown'], [null]] as const)(
        'leaves an ordinary queue failure alone when the verdict is %s',
        (kind) => {
          const failed = observed('failed');
          const d = decide(
            commented(longAgo, { seenSignatures: [queueSignature(failed)] }),
            cleanPr(),
            ctx({
              externalGate: 'confirmed',
              externalQueue: failed,
              externalFailure: kind === null ? null : { kind, detail: '' },
            })
          );
          // Unchanged behaviour: a repeat of a real failure escalates.
          expect(lastTransition(d)!.event.code).not.toBe('external_queue_infra_failure');
        }
      );
    });

    it('blocks an `ejected` PR only once the SAME ejection repeats', () => {
      const ejected = observed('ejected');
      const d = decide(
        commented(longAgo, { seenSignatures: [queueSignature(ejected)] }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: ejected })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked');
      expect(t.blockedCode).toBe('external_queue_rejected');
      expect(t.blockedReason).toContain('sent this PR back');
    });

    // The release valve for every entry blocked on a reading that has since
    // changed — including the ones the 2026-08-18 classification bug parked on
    // `cancelled` when trunk had actually said "failed tests".
    it('releases a block whose external reading no longer says what it did', () => {
      const d = decide(
        entry({
          status: 'blocked',
          blockedCode: 'external_queue_rejected',
          blockedReason: "Trunk's merge queue cancelled this PR",
          externalState: 'cancelled',
          submitAttempts: 3,
        }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: observed('failed') })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('queued');
      expect(t.blockedCode).toBeNull();
      expect(t.set?.externalState).toBe('failed');
      expect(t.event.code).toBe('external_queue_state_changed');
    });

    // Convergence: once the fresh state is persisted the heal must not fire
    // again, or a blocked entry would flap on every evaluation.
    it('does not re-release when the reading already matches what was blocked on', () => {
      const d = decide(
        entry({
          status: 'blocked',
          blockedCode: 'external_queue_rejected',
          externalState: 'cancelled',
          submitAttempts: 3,
        }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: observed('cancelled') })
      );
      expect(transitions(d).map((t) => t.event.code)).not.toContain(
        'external_queue_state_changed'
      );
    });

    it('leaves an unrelated blocked_manual alone even while the provider holds the PR', () => {
      const d = decide(
        entry({ status: 'blocked_manual', blockedCode: 'app_refused_hard' }),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: observed('testing') })
      );
      expect(d.actions).toEqual([]);
    });

    it('clears the recorded state on a new head — it described the old commit', () => {
      const d = decide(
        submitted({ headSha: 'old', externalState: 'testing' }),
        pr({ headSha: 'new' }),
        ctx({ externalGate: 'confirmed' })
      );
      expect(kinds(d)).toContain('reset_budgets');
      expect(kinds(d)).toContain('submit_external');
    });
  });

  describe('ejection', () => {
    // Resubmitting a commit the queue has already TESTED asks the same question
    // of the same code, and trunk batches: the answer costs a batch re-test, a
    // bisection to find this PR again, and every PR batched alongside it
    // waiting through both.
    it('dispatches a queue-failure run on the FIRST failure, without resubmitting', () => {
      const d = decide(submitted(), trunkPr('trunk-failed'), ctx({ externalGate: 'confirmed' }));
      expect(kinds(d)).toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('submit_external');
      const t = lastTransition(d)!;
      expect(t.to).toBe('queued');
      expect(t.set?.externalSubmitVia).toBeNull();
      expect(t.event.code).toBe('external_queue_failed_fixing');
    });

    it('treats a pending-failure label as a tested failure too', () => {
      const d = decide(submitted(), trunkPr('trunk-pending-failure'), ctx({ externalGate: 'confirmed' }));
      expect(kinds(d)).toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('submit_external');
    });

    it('fixes the PR first when it comes back genuinely broken', () => {
      const d = decide(
        submitted(),
        trunkPr('trunk-failed', {}, { blockingReason: 'checks_failed', checks: { total: 3, failed: 1, inProgress: 0 } }),
        ctx({ externalGate: 'confirmed' })
      );
      expect(kinds(d)).toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('submit_external');
    });

    /**
     * A queue FAILURE on a locally-clean PR is fixable, it just needs a
     * different starting point.
     *
     * This used to block once the resubmit budget was spent and wait for a
     * human to push. But the PR's checks are green — what failed is the PR
     * MERGED WITH TRUNK, which exists only inside the queue — so the run is
     * started from the provider's failure output instead of the PR's own state.
     * An ordinary fix run would re-read the green checks and conclude there was
     * nothing to do.
     */
    const failedBefore = queueSignature({
      provider: 'trunk',
      state: 'failed',
      source: 'label',
      evidence: 'trunk-failed',
    });

    // A flake is what this trades against, and it is the cheaper side: the run
    // costs minutes, and `queueFailureRule` tells it to report that it found
    // nothing rather than push a guess.
    it('records the reason it dispatched on, so a repeat is recognised', () => {
      const d = decide(submitted(), trunkPr('trunk-failed'), ctx({ externalGate: 'confirmed' }));
      expect(lastTransition(d)!.set?.seenSignatures).toContain(failedBefore);
    });

    it('still dispatches when the queue fails it the SAME way twice', () => {
      const d = decide(
        submitted({ seenSignatures: [failedBefore] }),
        trunkPr('trunk-failed'),
        ctx({ externalGate: 'confirmed' })
      );
      const fire = d.actions.find((a) => a.kind === 'fire_fix_run');
      expect(fire).toBeTruthy();
      expect(fire).toMatchObject({ resign: false, queueFailure: { provider: expect.any(String) } });
      // NEVER the resubmit path: the recurrence test is the only guard against
      // an eject → resubmit → eject loop.
      expect(kinds(d)).not.toContain('submit_external');
      // A Talyn-armed auto-merge must not survive this either — a half-fixed
      // PR would merge itself behind the queue's back.
      expect(kinds(d)).toContain('disarm_automerge');
      expect(lastTransition(d)!.event.code).toBe('external_queue_failed_fixing');
    });

    // An `ejected` state means the queue never tested the PR: a push landed on
    // it, or it waited too long to become mergeable. Nothing was learned about
    // the code, so those still go round again rather than paying for a run.
    it('resubmits an ejection the queue never tested, rather than dispatching', () => {
      const d = decide(
        submitted(),
        cleanPr(),
        ctx({
          externalGate: 'confirmed',
          externalQueue: {
            provider: 'trunk',
            state: 'ejected',
            source: 'comment',
            evidence: 'it was pushed to by @someone',
          },
        })
      );
      expect(kinds(d)).toContain('submit_external');
      expect(kinds(d)).not.toContain('fire_fix_run');
    });

    it('blocks (self-healing) once a fix run has already failed this local blocker', () => {
      const stuck = trunkPr('trunk-failed');
      const d = decide(
        submitted({ seenSignatures: [failedBefore, blockerSignature(stuck)] }),
        stuck,
        ctx({ externalGate: 'confirmed' })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked');
      expect(t.blockedCode).toBe('external_queue_rejected');
      expect(t.blockedReason).toContain('same reason twice');
      expect(kinds(d)).toContain('notify_blocked');
      expect(kinds(d)).toContain('disarm_automerge');
      expect(kinds(d)).not.toContain('fire_fix_run');
    });

    it('holds rather than dispatching when no cloud provider is connected', () => {
      const d = decide(
        submitted({ seenSignatures: [failedBefore] }),
        trunkPr('trunk-failed'),
        ctx({ externalGate: 'confirmed', cloudEnvAvailable: false })
      );
      expect(kinds(d)).not.toContain('fire_fix_run');
      expect(lastTransition(d)!.blockedCode).toBe('external_queue_rejected');
    });

    it('does NOT resubmit a cancelled PR — someone pulled it out on purpose', () => {
      const d = decide(submitted(), trunkPr('trunk-cancelled'), ctx({ externalGate: 'confirmed' }));
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked');
      expect(t.blockedCode).toBe('external_queue_rejected');
      expect(t.blockedReason).toContain('cancelled');
      expect(kinds(d)).not.toContain('submit_external');
    });

    it('never resubmits from the blocked gate, even when the PR itself reads clean', () => {
      const d = decide(
        entry({ status: 'blocked', blockedCode: 'external_queue_rejected', submitAttempts: 3 }),
        cleanPr(),
        ctx({ externalGate: 'confirmed' })
      );
      expect(d.actions).toEqual([]);
      expect(d.verdict).toBe('advance');
    });

    it('a new head clears the block and earns a fresh submit budget', () => {
      const d = decide(
        entry({
          status: 'blocked',
          blockedCode: 'external_queue_rejected',
          submitAttempts: 3,
          headSha: 'old',
        }),
        pr({ headSha: 'new' }),
        ctx({ externalGate: 'confirmed' })
      );
      const reset = d.actions.find((a) => a.kind === 'reset_budgets');
      expect(reset).toBeDefined();
      expect(kinds(d)).toContain('submit_external');
    });
  });
});

describe('decide — PR left open underneath us', () => {
  it('closes the entry out when the PR merged externally', () => {
    const d = decide(entry(), pr({ state: 'merged' }), ctx());
    expect(lastTransition(d)!.to).toBe('merged');
    expect(d.verdict).toBe('advance');
  });

  it('removes the entry when the PR closed without merging', () => {
    const d = decide(entry({ status: 'blocked', blockedCode: 'attempts_exhausted' }), pr({ state: 'closed' }), ctx());
    expect(lastTransition(d)!.to).toBe('removed');
    expect(d.verdict).toBe('advance');
  });
});

describe('decide — invariants', () => {
  const scenarios: Array<[string, EntrySnapshot, PrSnapshot, DecisionContext]> = [
    ['clean head', entry(), cleanPr(), ctx()],
    ['conflicting head', entry(), conflictingPr(), ctx()],
    ['draft head', entry(), draftPr(), ctx()],
    ['ci running', entry(), ciRunningPr(), ctx()],
    ['blocked manual', entry({ status: 'blocked_manual', blockedCode: 'app_refused_hard' }), cleanPr(), ctx()],
    ['signing probe', entry(), cleanPr(), ctx({ signingRequired: true })],
    ['app refusal', entry({ status: 'merging' }), optionalFailPr(), ctx({ mergeOutcome: { kind: 'refused_app', message: 'x' }, verifiedMerged: false, unsignedCount: 0 })],
  ];

  it('a merge is only ever attempted through verify_live_then_merge (never blind)', () => {
    for (const [, e, p, c] of scenarios) {
      const d = decide(e, p, c);
      // No decision both merges and fires a fix run — those are exclusive.
      const hasMerge = kinds(d).includes('verify_live_then_merge');
      const hasFix = kinds(d).includes('fire_fix_run');
      expect(hasMerge && hasFix).toBe(false);
    }
  });

  it('notify_blocked is always accompanied by a blocked/blocked_manual transition', () => {
    for (const [, e, p, c] of scenarios) {
      const d = decide(e, p, c);
      if (kinds(d).includes('notify_blocked')) {
        const t = lastTransition(d)!;
        expect(['blocked', 'blocked_manual']).toContain(t.to);
      }
    }
  });

  it('is deterministic — same inputs, same decision', () => {
    for (const [, e, p, c] of scenarios) {
      expect(decide(e, p, c)).toEqual(decide(e, p, c));
    }
  });
});

// R8b — the visual-review gate. Visual Review holds the check red until a
// PERSON approves each changed snapshot, so a fix run can never green it. Left
// to the ordinary rules the queue deadlocks: the run pushes a commit, CI
// re-runs, the fresh run carries the same unapproved diffs
// (PostHog/posthog#83850 went round 11 times in two days).
describe('decide — visual review gate', () => {
  const vr = (o: Partial<NonNullable<DecisionContext['visualReview']>> = {}) => ({
    runId: 'run-1',
    url: 'https://us.posthog.com/project/2/visual_review/runs/run-1',
    changed: 4,
    autoApprove: false,
    ...o,
  });
  /** Red required check — what a VR-gated PR actually looks like to us. */
  const gatedPr = () =>
    pr(
      { mergeStateStatus: 'BLOCKED' },
      { blockingReason: 'checks_failed', checks: { total: 280, failed: 2, inProgress: 0 } }
    );

  it('parks instead of firing a doomed fix run when auto-approve is off', () => {
    const d = decide(entry(), gatedPr(), ctx({ visualReview: vr() }));
    const t = lastTransition(d)!;
    expect(t.to).toBe('blocked');
    expect(t.blockedCode).toBe('awaiting_human_check');
    expect(t.blockedReason).toContain('4 snapshot(s) changed');
    expect(t.blockedReason).toContain('visual_review/runs/run-1');
    expect(kinds(d)).toContain('notify_blocked');
    expect(kinds(d)).not.toContain('fire_fix_run');
  });

  it('does not re-notify or churn while already parked', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'awaiting_human_check' }),
      gatedPr(),
      ctx({ visualReview: vr() })
    );
    expect(d.actions).toEqual([]);
  });

  it('releases the park when nothing is gating any more', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'awaiting_human_check', blockedReason: 'x' }),
      gatedPr(),
      ctx({ visualReview: null })
    );
    const t = transitions(d).find((x) => x.event.code === 'human_check_cleared')!;
    expect(t.to).toBe('queued');
    expect(t.blockedCode).toBeNull();
  });

  // A LOOKUP FAILURE must not read as "nothing is gating" — that would un-park
  // every gated PR on a PostHog blip and start the loop again.
  it('leaves a parked entry alone when the gate was not resolved at all', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'awaiting_human_check' }),
      gatedPr(),
      ctx({ visualReview: undefined })
    );
    expect(transitions(d).map((t) => t.event.code)).not.toContain('human_check_cleared');
  });

  describe('auto-approve opted in', () => {
    it('finalizes the run rather than parking or firing a fix run', () => {
      const d = decide(entry(), gatedPr(), ctx({ visualReview: vr({ autoApprove: true }) }));
      expect(d.actions).toEqual([
        { kind: 'resolve_visual_review', runId: 'run-1', url: vr().url, changed: 4 },
      ]);
      expect(d.verdict).toBe('hold');
    });

    it('waits for CI once the baseline is committed', () => {
      const d = decide(
        entry(),
        gatedPr(),
        ctx({
          visualReview: vr({ autoApprove: true }),
          visualReviewOutcome: { kind: 'finalized' },
        })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('awaiting_ci');
      expect(t.event.code).toBe('visual_review_finalized');
      expect(kinds(d)).toContain('refresh_snapshot');
    });

    it.each([['superseded'], ['retry']] as const)(
      'burns nothing on a %s outcome — the next evaluation retries',
      (kind) => {
        const d = decide(
          entry({ status: 'queued' }),
          gatedPr(),
          ctx({
            visualReview: vr({ autoApprove: true }),
            visualReviewOutcome:
              kind === 'retry' ? { kind, message: 'rate limited' } : { kind },
          })
        );
        expect(kinds(d)).not.toContain('fire_fix_run');
        expect(lastTransition(d)?.to).not.toBe('blocked');
      }
    );

    it('parks with the reason when finalizing is refused outright', () => {
      const d = decide(
        entry(),
        gatedPr(),
        ctx({
          visualReview: vr({ autoApprove: true }),
          visualReviewOutcome: { kind: 'error', message: 'needs visual_review:write' },
        })
      );
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked');
      expect(t.blockedCode).toBe('awaiting_human_check');
      expect(t.blockedReason).toContain('needs visual_review:write');
      expect(kinds(d)).toContain('notify_blocked');
    });
  });

  // The gate must be reachable from a PR the progress rule already gave up on,
  // or a PR that looped before this shipped can never be un-stuck.
  it('is reached even when the entry is already blocked on no_progress', () => {
    const d = decide(
      entry({
        status: 'blocked',
        blockedCode: 'no_progress',
        seenSignatures: [blockerSignature(gatedPr())],
      }),
      gatedPr(),
      ctx({ visualReview: vr({ autoApprove: true }) })
    );
    expect(kinds(d)).toContain('resolve_visual_review');
  });
});

// R4b — the merge stack gate. The group walk gives no protection here: parent
// and child live in different (repo, base) groups, are walked by two
// independent evaluations, and decideCleanPath never reads ctx.isHead. So this
// has to be an unconditional rule, and the ordering matrix below is what pins
// that it really is one.
describe('decide — merge stack', () => {
  function parent(o: Partial<StackParent> = {}): StackParent {
    return {
      pullRequestId: 'pr-parent',
      number: 41,
      headBranch: 'feat-a',
      baseBranch: 'main',
      state: 'open',
      entryStatus: 'queued',
      targetBase: 'main',
      depth: 1,
      cycle: false,
      ...o,
    };
  }
  /** The child: based on feat-a, otherwise perfectly mergeable. */
  const child = () => entry({ baseBranch: 'feat-a' });
  const childPr = () => pr({}, { headBranch: 'feat-b', baseBranch: 'feat-a' });

  // Every stack verdict is derived from a link that is re-resolved on each
  // evaluation. When the link stops resolving the verdict has no evidence left
  // behind it, so it must be released — otherwise a PR blocked on an edge that
  // was never real sits there until a human requeues, which is what stranded
  // 30+ PostHog/posthog PRs on "#69000 was closed without merging".
  describe('the link stops resolving', () => {
    it.each([
      ['awaiting_stack', null],
      ['blocked', 'stack_parent_abandoned'],
      ['blocked', 'stack_cycle'],
      ['blocked', 'stack_retarget_failed'],
      ['blocked_manual', 'stack_cycle'],
      ['blocked_manual', 'stack_retarget_loop'],
    ] as const)('releases a %s/%s entry back into the queue', (status, code) => {
      const d = decide(
        entry({
          baseBranch: 'feat-a',
          status,
          blockedCode: code,
          blockedReason: 'x',
          stackParentNumber: 41,
        }),
        childPr(),
        ctx({ stackParent: null })
      );
      const t = transitions(d).find((x) => x.event.code === 'stack_parent_cleared')!;
      expect(t.to).toBe('queued');
      expect(t.blockedCode).toBeNull();
      expect(t.set?.stackParentNumber).toBeNull();
    });

    it('leaves a NON-stack block alone when no parent resolves', () => {
      const d = decide(
        entry({ baseBranch: 'feat-a', status: 'blocked_manual', blockedCode: 'app_refused_hard' }),
        childPr(),
        ctx({ stackParent: null })
      );
      expect(transitions(d).map((t) => t.event.code)).not.toContain('stack_parent_cleared');
    });
  });

  describe('parent still open', () => {
    it('parks the child instead of merging it into its parent branch', () => {
      const d = decide(child(), childPr(), ctx({ stackParent: parent() }));

      expect(lastTransition(d)?.to).toBe('awaiting_stack');
      expect(lastTransition(d)?.set?.stackParentNumber).toBe(41);
      expect(kinds(d)).not.toContain('verify_live_then_merge');
      expect(kinds(d)).not.toContain('arm_automerge');
      expect(kinds(d)).not.toContain('fire_fix_run');
      expect(kinds(d)).not.toContain('update_branch');
    });

    it('ADVANCES — a parked child must not consume its group turn', () => {
      // Same reasoning as the draft and awaiting-review rules: this entry can
      // never merge, so holding would stall everything behind it.
      expect(decide(child(), childPr(), ctx({ stackParent: parent() })).verdict).toBe('advance');
    });

    it('disarms a Talyn auto-merge BEFORE parking', () => {
      // The one that actually bites: GitHub would merge the parked child into
      // its parent's branch the instant checks pass, behind the queue's back.
      const d = decide(
        entry({ baseBranch: 'feat-a', automergeArmedBy: 'talyn', status: 'automerge_armed' }),
        pr({ autoMergeEnabledBy: 'talyn' }, { headBranch: 'feat-b', baseBranch: 'feat-a' }),
        ctx({ stackParent: parent() })
      );

      expect(kinds(d).indexOf('disarm_automerge')).toBeLessThan(kinds(d).indexOf('transition'));
      expect(lastTransition(d)?.to).toBe('awaiting_stack');
    });

    it('never disarms a USER-armed auto-merge', () => {
      const d = decide(
        entry({ baseBranch: 'feat-a', automergeArmedBy: 'user' }),
        pr({ autoMergeEnabledBy: 'user' }, { headBranch: 'feat-b', baseBranch: 'feat-a' }),
        ctx({ stackParent: parent() })
      );

      expect(kinds(d)).not.toContain('disarm_automerge');
    });

    it('does not rewrite the entry once it is already parked on that PR', () => {
      const d = decide(
        entry({ baseBranch: 'feat-a', status: 'awaiting_stack', stackParentNumber: 41 }),
        childPr(),
        ctx({ stackParent: parent() })
      );

      expect(d.actions).toHaveLength(0);
    });

    it('re-parks when the parent PR changed', () => {
      const d = decide(
        entry({ baseBranch: 'feat-a', status: 'awaiting_stack', stackParentNumber: 7 }),
        childPr(),
        ctx({ stackParent: parent({ number: 41 }) })
      );

      expect(lastTransition(d)?.set?.stackParentNumber).toBe(41);
    });

    it('parks behind an unqueued parent, and says so in the timeline', () => {
      // Do not auto-block: "I'll land that one by hand" is a normal flow, and
      // the manual merge resumes the stack via the stack-advance trigger.
      const d = decide(
        child(),
        childPr(),
        ctx({ stackParent: parent({ entryStatus: null }) })
      );

      expect(lastTransition(d)?.to).toBe('awaiting_stack');
      expect(lastTransition(d)?.event.code).toBe('stack_parent_not_queued');
    });

    it('parks behind a blocked parent WITHOUT propagating the block', () => {
      // One loud blocked PR and N quiet parked ones — the parent fires its own
      // one-shot notification, and mirroring it N times is just noise.
      const d = decide(
        child(),
        childPr(),
        ctx({ stackParent: parent({ entryStatus: 'blocked_manual' }) })
      );

      expect(lastTransition(d)?.to).toBe('awaiting_stack');
      expect(kinds(d)).not.toContain('notify_blocked');
    });
  });

  describe('parent merged', () => {
    it('retargets onto the parent base and holds', () => {
      const d = decide(child(), childPr(), ctx({ stackParent: parent({ state: 'merged' }) }));

      const act = d.actions.find(
        (a): a is Extract<Action, { kind: 'retarget_base' }> => a.kind === 'retarget_base'
      );
      expect(act).toMatchObject({ toBase: 'main', parentNumber: 41 });
      expect(d.verdict).toBe('hold');
      expect(kinds(d)).not.toContain('verify_live_then_merge');
    });

    it('blocks rather than retargeting onto a base it already has', () => {
      const d = decide(
        entry({ baseBranch: 'main' }),
        pr({}, { headBranch: 'feat-b', baseBranch: 'main' }),
        ctx({ stackParent: parent({ state: 'merged', baseBranch: 'main' }) })
      );

      expect(kinds(d)).not.toContain('retarget_base');
      expect(lastTransition(d)?.blockedCode).toBe('stack_retarget_failed');
    });

    it('blocks rather than retargeting a PR onto its own head branch', () => {
      const d = decide(
        child(),
        childPr(),
        ctx({ stackParent: parent({ state: 'merged', baseBranch: 'feat-b' }) })
      );

      expect(kinds(d)).not.toContain('retarget_base');
      expect(lastTransition(d)?.blockedCode).toBe('stack_retarget_failed');
    });

    it('blocks on a refused retarget, and notifies', () => {
      const d = decide(
        child(),
        childPr(),
        ctx({ stackParent: parent({ state: 'merged' }), retargetOutcome: 'error' })
      );

      expect(lastTransition(d)?.to).toBe('blocked');
      expect(lastTransition(d)?.blockedCode).toBe('stack_retarget_failed');
      expect(kinds(d)).toContain('notify_blocked');
    });

    it('holds without burning budget when the retarget was rate-gated', () => {
      const d = decide(
        child(),
        childPr(),
        ctx({ stackParent: parent({ state: 'merged' }), retargetOutcome: 'retry' })
      );

      expect(d.verdict).toBe('hold');
      expect(kinds(d)).not.toContain('retarget_base');
      expect(lastTransition(d)?.to).toBe('awaiting_stack');
    });

    it('blocks_manual once the retarget budget is spent', () => {
      const d = decide(
        entry({ baseBranch: 'feat-a', retargetAttempts: 8 }),
        childPr(),
        ctx({ stackParent: parent({ state: 'merged' }) })
      );

      expect(lastTransition(d)?.to).toBe('blocked_manual');
      expect(lastTransition(d)?.blockedCode).toBe('stack_retarget_loop');
      expect(kinds(d)).not.toContain('retarget_base');
    });
  });

  describe('parent closed without merging', () => {
    it('blocks and never auto-retargets', () => {
      // The child's branch still contains the abandoned parent's commits, so
      // retargeting would smuggle them into the base branch.
      const d = decide(child(), childPr(), ctx({ stackParent: parent({ state: 'closed' }) }));

      expect(lastTransition(d)?.to).toBe('blocked');
      expect(lastTransition(d)?.blockedCode).toBe('stack_parent_abandoned');
      expect(kinds(d)).not.toContain('retarget_base');
      expect(kinds(d)).toContain('notify_blocked');
      expect(d.verdict).toBe('advance');
    });

    it('is blocked, not blocked_manual, so reopening the parent self-heals', () => {
      const d = decide(child(), childPr(), ctx({ stackParent: parent({ state: 'closed' }) }));
      expect(lastTransition(d)?.to).not.toBe('blocked_manual');
    });
  });

  it('blocks_manual on a base/head cycle', () => {
    const d = decide(child(), childPr(), ctx({ stackParent: parent({ cycle: true }) }));

    expect(lastTransition(d)?.to).toBe('blocked_manual');
    expect(lastTransition(d)?.blockedCode).toBe('stack_cycle');
    expect(d.verdict).toBe('advance');
  });

  it('self-heals a parked entry once nothing owns its base', () => {
    const d = decide(
      entry({ baseBranch: 'main', status: 'awaiting_stack', stackParentNumber: 41 }),
      pr(),
      ctx({ stackParent: null })
    );

    expect(transitions(d)[0]?.to).toBe('queued');
    expect(transitions(d)[0]?.set?.stackParentNumber).toBeNull();
  });

  it('is inert when the evaluator did not resolve a parent', () => {
    const d = decide(entry(), pr(), ctx({}));
    expect(kinds(d)).toContain('verify_live_then_merge');
  });

  // The gate must sit BELOW the terminal/aftermath/crash-recovery rules and
  // ABOVE everything that acts on the PR. One case per boundary.
  describe('rule ordering (every case has an open parent)', () => {
    const withParent = (o: Partial<DecisionContext> = {}) =>
      ctx({ stackParent: parent(), ...o });

    it('R0 wins: a child merged underneath us terminates, never parks', () => {
      const d = decide(child(), pr({ state: 'merged' }, { baseBranch: 'feat-a' }), withParent());
      expect(lastTransition(d)?.to).toBe('merged');
    });

    it('R0 wins: a child closed underneath us terminates', () => {
      const d = decide(child(), pr({ state: 'closed' }, { baseBranch: 'feat-a' }), withParent());
      expect(lastTransition(d)?.to).toBe('removed');
    });

    it('R3 wins: a persisted `merging` verifies first — never park a merged PR', () => {
      const d = decide(
        entry({ baseBranch: 'feat-a', status: 'merging' }),
        childPr(),
        withParent()
      );
      expect(kinds(d)).toContain('verify_merged');
      expect(lastTransition(d)?.to).not.toBe('awaiting_stack');
    });

    it('R4 wins: a draft reads as draft, which is the actionable message', () => {
      const d = decide(child(), pr({}, { baseBranch: 'feat-a', draft: true }), withParent());
      expect(lastTransition(d)?.blockedCode).toBe('draft');
    });

    it('beats R5b: a parked child is never submitted to an external queue', () => {
      // trunk.io refuses stacked PRs outright, so submitting one is a
      // guaranteed round trip to blocked_manual.
      const d = decide(child(), childPr(), withParent({ externalGate: 'confirmed' }));
      expect(kinds(d)).not.toContain('submit_external');
      expect(lastTransition(d)?.to).toBe('awaiting_stack');
    });

    it('is mode-agnostic: parks identically when not head and mid-merge', () => {
      const d = decide(
        child(),
        childPr(),
        withParent({ isHead: false, groupMergeInFlight: true })
      );
      expect(lastTransition(d)?.to).toBe('awaiting_stack');
    });

    it('beats R11: a parked child with a settled blocker fires no fix run', () => {
      const d = decide(
        child(),
        pr({ mergeStateStatus: 'DIRTY' }, {
          baseBranch: 'feat-a',
          mergeable: 'CONFLICTING',
          blockingReason: 'merge_conflicts',
        }),
        withParent()
      );
      expect(kinds(d)).not.toContain('fire_fix_run');
      expect(lastTransition(d)?.to).toBe('awaiting_stack');
    });
  });
});
