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
  buildFailingChecksBlockReason,
  decide,
  unsignedCommitsBlockReason,
} from '../../services/mergeQueue/decide.js';
import type {
  Action,
  Decision,
  DecisionContext,
  EntrySnapshot,
  PrSnapshot,
} from '../../services/mergeQueue/types.js';
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

describe('decide — fix-run accounting and the attempts budget', () => {
  it('increments attempts when a terminal fix run left the PR blocked, then re-fires', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1', fixTaskAccounted: false, fixAttempts: 0 }),
      conflictingPr(),
      ctx({ fixTaskState: 'terminal' })
    );
    const acct = transitions(d)[0]!;
    expect(acct.set?.fixAttempts).toBe(1);
    expect(acct.set?.fixTaskAccounted).toBe(true);
    expect(fixRun(d)).toBeTruthy(); // budget left → next run fires
    expect(d.verdict).toBe('hold');
  });

  it('blocks after MAX_ATTEMPTS consecutive failed fix runs and notifies once with the reason', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't3', fixTaskAccounted: false, fixAttempts: 2 }),
      conflictingPr(),
      ctx({ fixTaskState: 'terminal' })
    );
    const t = transitions(d)[0]!;
    expect(t.to).toBe('blocked');
    expect(t.blockedCode).toBe('attempts_exhausted');
    expect(t.blockedReason).toBe('merge conflicts with the base branch');
    expect(kinds(d)).toContain('notify_blocked');
    expect(fixRun(d)).toBeUndefined();
    expect(d.verdict).toBe('advance');
  });

  it('does not re-notify or churn writes on re-evaluation while already blocked', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'attempts_exhausted', fixAttempts: 3, fixTaskId: 't3' }),
      conflictingPr(),
      ctx()
    );
    expect(d.actions).toEqual([]);
    expect(d.verdict).toBe('advance');
  });

  it('does not reset the attempt counter on a transient clean reading (cap-evasion)', () => {
    // Clean reading: the blocked entry falls through to the merge path — but
    // attempts stay at 3. If the merge then bounces and the PR re-reads
    // blocked, the hard cap below re-settles it without a 4th run.
    const clean = decide(
      entry({ status: 'blocked', blockedCode: 'attempts_exhausted', fixAttempts: 3 }),
      cleanPr(),
      ctx()
    );
    expect(kinds(clean)).toContain('verify_live_then_merge');
    expect(transitions(clean).some((t) => t.set?.fixAttempts === 0)).toBe(false);
  });

  it('never fires past the retry budget, even after a failed-merge flap downgraded the status', () => {
    const d = decide(entry({ status: 'queued', fixAttempts: 3 }), conflictingPr(), ctx());
    expect(fixRun(d)).toBeUndefined();
    const t = lastTransition(d)!;
    expect(t.to).toBe('blocked');
    expect(t.blockedCode).toBe('attempts_exhausted');
    expect(kinds(d)).not.toContain('notify_blocked'); // silent re-settle — R8 already notified
    expect(d.verdict).toBe('advance');
  });

  it('re-arms a blocked PR that reads clean and merges it', () => {
    const d = decide(
      entry({ status: 'blocked', blockedCode: 'attempts_exhausted', fixAttempts: 3 }),
      cleanPr(),
      ctx()
    );
    expect(kinds(d)).toContain('verify_live_then_merge');
    expect(d.verdict).toBe('hold');
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

  it('accounts the just-finished run against its own push so the cap still bites', () => {
    const d = decide(
      entry({ status: 'fixing', fixTaskId: 't1', fixTaskAccounted: false, fixAttempts: 2, headSha: 'sha1' }),
      conflictAt('sha2'),
      ctx({ fixTaskState: 'terminal', maxAttempts: 3 })
    );
    expect(kinds(d)).toContain('adopt_head');
    expect(kinds(d)).not.toContain('reset_budgets');
    const acct = transitions(d).find((t) => t.set?.fixTaskAccounted);
    expect(acct?.set?.fixAttempts).toBe(3); // 2 → 3 (NOT reset to 0)
    expect(fixRun(d)).toBeFalsy(); // budget spent → blocked, not re-fired
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
        fixAttempts: 2,
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
      entry({ status: 'queued', fixAttempts: 3, automergeArmedBy: 'user' }),
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

    it('still updates a BEHIND branch before submitting', () => {
      const d = decide(
        entry(),
        pr({ mergeStateStatus: 'BEHIND' }, { reviewDecision: 'APPROVED' }),
        ctx({ externalGate: 'confirmed', updateBranchAvailable: true })
      );
      expect(kinds(d)).toEqual(['update_branch']);
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

    it('still remediates a settled blocker while submitted — the provider would hold it forever', () => {
      const d = decide(
        submitted(),
        trunkPr('trunk-not-ready', { mergeStateStatus: 'DIRTY' }, {
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

    it('outranks a stale label the provider has moved past', () => {
      const d = decide(
        submitted({ externalState: 'testing' }),
        trunkPr('trunk-testing'),
        ctx({ externalGate: 'confirmed', externalQueue: observed('merged') })
      );
      expect(recorded(d)).toBe('merged');
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

    it('ejects on a failure the provider reports in its comment, not in a label', () => {
      const d = decide(
        commented(longAgo),
        cleanPr(),
        ctx({ externalGate: 'confirmed', externalQueue: observed('failed') })
      );
      expect(transitions(d).map((t) => t.event.code)).toContain('external_queue_ejected');
      expect(kinds(d)).toContain('submit_external');
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
    it('requeues and resubmits when the provider fails the PR within budget', () => {
      const d = decide(submitted(), trunkPr('trunk-failed'), ctx({ externalGate: 'confirmed' }));
      const eject = transitions(d).find((t) => t.event.code === 'external_queue_ejected')!;
      expect(eject.to).toBe('queued');
      expect(eject.set?.externalSubmitVia).toBeNull();
      expect(kinds(d)).toContain('submit_external');
    });

    it('treats a pending-failure label as an ejection too', () => {
      const d = decide(submitted(), trunkPr('trunk-pending-failure'), ctx({ externalGate: 'confirmed' }));
      expect(transitions(d).map((t) => t.event.code)).toContain('external_queue_ejected');
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

    it('blocks (self-healing) once the resubmit budget is spent', () => {
      const d = decide(submitted({ submitAttempts: 3 }), trunkPr('trunk-failed'), ctx({ externalGate: 'confirmed' }));
      const t = lastTransition(d)!;
      expect(t.to).toBe('blocked');
      expect(t.blockedCode).toBe('external_queue_rejected');
      expect(t.blockedReason).toContain('rejected this PR 3×');
      expect(kinds(d)).toContain('notify_blocked');
      // A Talyn-armed auto-merge must not survive the block — it would re-submit
      // the PR behind the queue's back.
      expect(kinds(d)).toContain('disarm_automerge');
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
