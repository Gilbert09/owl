// Merge queue v2 — core types for the pure decision function.
//
// The v2 queue splits the old mergeQueueProcessor's four tangled concerns:
// membership/state (merge_queue_entries table), decision (the pure `decide`
// in ./decide.ts), execution (the action executor), and scheduling
// (webhook-triggered evaluation + a slow reconciler). Everything in this file
// is shared vocabulary between those layers, and none of it does I/O.

import type {
  ExternalQueueState,
  ExternalQueueStatus,
  PRMergeableSummary,
} from '@talyn/shared';
import type { StackParent } from './stack.js';

/** Stop auto-firing a given remediation after this many attempts per head. */
export const MAX_ATTEMPTS = 3;

/**
 * Upper bound on decide→execute rounds within one evaluation of one entry.
 * The longest legitimate chain is a suspected external gate settling itself:
 * submit → direct-merge fallback → verify-merged → gate confirmed + resubmit →
 * submitted = 5, and the App-refused ladder (merge → verify-merged → signature
 * probe → check re-run → final block) is also 5. Anything past this indicates a
 * decide/executor bug, not real work.
 */
export const MAX_DECIDE_ROUNDS = 8;

/**
 * Retarget actions allowed per entry, ever. In the normal case an entry
 * retargets exactly ONCE: its base is its parent's head, and when the parent
 * lands it moves straight to the parent's base. This is the backstop, and it
 * counts actions rather than successes so a PATCH that keeps failing is
 * bounded too. Deliberately NOT reset by a new head — a push that reset the
 * loop guard would defeat it.
 */
export const MAX_RETARGETS = 8;

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/**
 * v2 entry lifecycle. Unlike the old 4-status jsonb blob, every state is
 * explicit and every state has a defined exit:
 *
 * - `queued`           — in line; not head, or head awaiting its next action.
 * - `awaiting_ci`      — head; the only obstacle is checks still running.
 * - `awaiting_review`  — head; the only obstacle is a missing required review.
 *                        No remediation applies (an agent can't approve a PR);
 *                        self-heals on the review webhook. The old processor
 *                        fired doomed fix runs at this state.
 * - `automerge_armed`  — head; clean-but-awaiting-CI with GitHub native
 *                        auto-merge enabled. GitHub merges the instant checks
 *                        pass; we observe it via the closed webhook.
 * - `awaiting_stack`   — the entry is a member of a stack and the PR its base
 *                        branch belongs to has NOT merged yet. Nothing can be
 *                        done to it: merging would land it in its parent's
 *                        branch instead of the real base. Self-heals the moment
 *                        the parent lands, which retargets this PR onto the
 *                        parent's base and returns it to `queued`.
 * - `awaiting_external`— the base branch is behind an external merge gate
 *                        (trunk.io / GitHub's native queue) and the PR has been
 *                        SUBMITTED to it. That system owns the merge now; we
 *                        track its state off the PR's labels and take the PR
 *                        back if it gets ejected.
 * - `fixing`           — a cloud fix run (blockers or re-sign) is in flight.
 * - `merging`          — a direct REST merge call is in flight. Persisted
 *                        BEFORE the call so a crash mid-merge is recoverable
 *                        (verify-merged — the June 2026 incident).
 * - `blocked`          — can't proceed, but SELF-HEALING: re-evaluated on
 *                        every relevant event, and a new head resets budgets.
 * - `blocked_manual`   — truly manual (GitHub refuses the App's merge with no
 *                        failing check to blame). Only dequeue/requeue clears.
 * - `merged`/`removed` — terminal; kept as history for the timeline.
 */
export type EntryStatus =
  | 'queued'
  | 'awaiting_ci'
  | 'awaiting_review'
  | 'automerge_armed'
  | 'awaiting_external'
  | 'awaiting_stack'
  | 'fixing'
  | 'merging'
  | 'blocked'
  | 'blocked_manual'
  | 'merged'
  | 'removed';

/** Machine-readable cause carried by `blocked` / `blocked_manual`. */
export type BlockedCode =
  /** Draft PR — GitHub 405s a draft merge. Self-heals on ready_for_review. */
  | 'draft'
  /** Fix-run budget spent on this head. Self-heals on a new head (push).
   *  Superseded by 'no_progress'; still read on entries blocked before it. */
  | 'attempts_exhausted'
  /**
   * A remediation completed and left the PR blocked by a problem that had
   * already defeated a remediation on this head — recurring, and not something
   * the queue can fix. Self-heals on a new head (push), which clears the
   * signature list, or on a requeue. See `blockerSignature` in decide.ts.
   */
  | 'no_progress'
  /** Re-sign budget spent on a signed-commits-required base. Self-heals on a new head. */
  | 'unsigned_commits'
  /**
   * GitHub refused the App's merge over a failing head check (even an
   * "optional" one a human can merge past). Self-heals the moment the summary
   * shows no failing checks (a re-run went green, or a new head).
   */
  | 'app_refused_checks'
  /**
   * GitHub refused the App's merge with no failing check to blame — unknown,
   * unfixable cause (e.g. a ruleset that excludes the App). `blocked_manual`
   * only. A fix run cannot grant merge permission (the fix-run-churn incident),
   * so nothing is dispatched.
   */
  | 'app_refused_hard'
  /**
   * The base branch is governed by an EXTERNAL merge gate Talyn can't bypass
   * (GitHub's native merge queue, trunk.io, a protected-ref ruleset) AND no
   * submit mechanism is available: the repo refuses auto-merge and defines no
   * submit label. `blocked_manual` only — retrying or fixing can never satisfy
   * it; the PR must be handed to that system by a human. Only dequeue/requeue
   * clears it. When a submit mechanism DOES exist the queue submits instead,
   * and this code is never reached.
   */
  | 'external_gate'
  /**
   * The external queue took the PR and gave it back (trunk's `trunk-failed` /
   * `trunk-cancelled`) more times than the per-head budget allows. Self-heals
   * on a new head, like every other budget — a fresh push earns fresh submits.
   */
  | 'external_queue_rejected'
  /**
   * The PR this one is stacked on was CLOSED without merging. Retargeting onto
   * the abandoned parent's base would smuggle the parent's commits into the
   * base branch — the child's head still contains them — so the queue refuses
   * and hands it back. `blocked` rather than `blocked_manual`: it self-heals
   * if the parent is reopened.
   */
  | 'stack_parent_abandoned'
  /**
   * The base retarget after a stack parent merged was refused by GitHub. Self-
   * heals on a new head or a requeue, like every other `blocked`.
   */
  | 'stack_retarget_failed'
  /**
   * The stack's base/head links form a cycle, so no member can ever be first.
   * `blocked_manual` — only the author can break it.
   */
  | 'stack_cycle'
  /**
   * More retargets attempted on one entry than any real stack needs. A
   * retarget can only fire on a MERGED parent and moves the base one hop up a
   * finite chain, so this should be unreachable; it exists so a resolver bug
   * costs one blocked PR rather than an unbounded PATCH loop.
   */
  | 'stack_retarget_loop';

export type FixKind = 'blockers' | 'resign' | 'queue_failure';

/**
 * How a PR was handed to an external merge queue: the provider's own submit
 * command posted as a comment (trunk.io's `/trunk merge`), a submit label, or
 * GitHub native auto-merge (GitHub's own queue).
 */
export type ExternalSubmitVia = 'comment' | 'label' | 'auto_merge';

/** Mirror of a merge_queue_entries row, as the decision function sees it. */
export interface EntrySnapshot {
  id: string;
  status: EntryStatus;
  blockedCode: BlockedCode | null;
  blockedReason: string | null;
  /** Head the budgets below are scoped to. '' when not yet observed. */
  headSha: string;
  fixAttempts: number;
  rerunAttempts: number;
  resignAttempts: number;
  /** External-queue submissions spent on this head (ejected → resubmit). */
  submitAttempts: number;
  /**
   * Blocker signatures a COMPLETED remediation has already left this head with.
   * This — not the counters above — is what stops remediation: see the
   * "Progress, not retries" note in decide.ts. Always an array; a null column
   * (rows predating it) reads as empty.
   */
  seenSignatures: string[];
  /** How the current external submission was made; null when not submitted. */
  externalSubmitVia: ExternalSubmitVia | null;
  /**
   * When that submission was made (ISO). Only a fallback now that the
   * provider's comment is read directly (see `externalState`): it bounds how
   * long a submission is believed while the provider has said NOTHING at all.
   */
  externalSubmittedAt: string | null;
  /**
   * The provider's own last-observed answer for this PR — read off its comment
   * (authoritative) or its labels. Persisted so the desktop badge, the timeline
   * and a restarted backend all see where the PR actually is, rather than only
   * "we submitted it at some point".
   */
  externalState: ExternalQueueState | null;
  fixTaskId: string | null;
  /** Whether `fixTaskId`'s terminal result has been folded into fixAttempts. */
  fixTaskAccounted: boolean;
  fixKind: FixKind | null;
  /** Signature probe memo — valid only while it matches the current head. */
  signingCheckedSha: string | null;
  unsignedCount: number | null;
  /** Who armed GitHub auto-merge. We never disarm what we didn't arm. */
  automergeArmedBy: 'talyn' | 'user' | null;
  mergeMethod: MergeMethod;
  baseBranch: string;
  /** Merge stack: the PR this entry is parked behind. Display only. */
  stackParentNumber: number | null;
  /** Merge stack: retarget actions spent. See MAX_RETARGETS. */
  retargetAttempts: number;
}

/**
 * The PR as last observed, extracted from the pull_requests row. In v2 this
 * is fresh by construction on webhook-triggered evaluations (the trigger IS
 * the snapshot write); the reconciler refreshes stale ones before deciding.
 */
export interface PrSnapshot {
  state: 'open' | 'closed' | 'merged';
  /** Current head commit. '' when the summary predates headSha capture. */
  headSha: string;
  /** GitHub's mergeStateStatus (BEHIND/BLOCKED/CLEAN/DRAFT/…), uppercased. */
  mergeStateStatus: string;
  /** Who has GitHub auto-merge armed on the PR right now, if anyone. */
  autoMergeEnabledBy: 'talyn' | 'user' | null;
  summary: PRMergeableSummary;
}

export type MergeOutcome =
  /** GitHub merged it. */
  | { kind: 'merged' }
  /** GitHub accepted the request but didn't merge (e.g. lost a race, now behind). */
  | { kind: 'not_merged'; message: string }
  /** MergeNotPermittedForAppError — the App's tokens were refused. */
  | { kind: 'refused_app'; message: string }
  /** Any other rejection (405 conflicts, network, …). */
  | { kind: 'error'; message: string };

export type SubmitOutcome =
  /**
   * The PR is now in the external queue's hands. `armedBy` is set for the
   * auto-merge door and says whose arm carried the submission — we only ever
   * disarm (un-submit) one we armed ourselves.
   */
  | { kind: 'submitted'; via: ExternalSubmitVia; armedBy?: 'talyn' | 'user'; detail?: string }
  /**
   * GitHub refused to arm auto-merge because the PR is immediately mergeable
   * ("clean status") and the gate is only SUSPECTED — so the direct merge is
   * still worth one attempt (it settles whether the gate is real).
   */
  | { kind: 'try_direct_merge' }
  /** Gate is real and nothing can submit: no auto-merge, no submit label. */
  | { kind: 'unavailable'; message: string }
  /** Transient (head moved, API error) — retry on a later evaluation. */
  | { kind: 'retry'; message: string };

export type RerunOutcome =
  | {
      requested: number;
      reason?: 'no-failing-check-runs' | 'needs-actions-permission' | 'not-rerequestable';
    }
  /** The re-run call itself threw — budget must NOT be spent. */
  | { errored: true };

/**
 * Everything the decision function needs beyond the entry + PR snapshot.
 * Assembled by the evaluator/executor; `decide` itself never does I/O and
 * never reads clocks. Fields in the "I/O outcomes" group are absent until the
 * executor has performed the corresponding action within this evaluation,
 * then re-invoked `decide` with the result folded in.
 */
export interface DecisionContext {
  nowIso: string;
  /** This entry currently holds its (repo, base) group's turn. */
  isHead: boolean;
  /** A sibling entry in the group is `merging` or `automerge_armed`. */
  groupMergeInFlight: boolean;
  /** State of the queue's own fix run (`entry.fixTaskId`). */
  fixTaskState: 'active' | 'terminal' | 'none';
  /**
   * Another run is linked to the PR (`pull_requests.taskId` differs from our
   * fixTaskId and is active) — a manual task or the keep-mergeable watcher.
   * We never pile a queue run on top of it.
   */
  otherLinkedTaskActive: boolean;
  /** repoSigning probe result; null = unknown/probe failed (proceed; the 403 net catches). */
  signingRequired: boolean | null;
  /** Whether GitHub native auto-merge can be armed on this repo (Push E). */
  autoMergeCapability: 'available' | 'unavailable' | 'unknown';
  /**
   * The base branch is behind an external merge gate (trunk.io / GitHub's
   * native queue / a restrictive ruleset). 'confirmed' = learned from an
   * observed 405, so the direct merge is provably doomed and is skipped;
   * 'suspected' = a branch-rules probe saw an `update` rule, which can't see
   * bypass actors — so the queue still tries the direct merge once. See
   * services/repoMergeGate.ts.
   */
  externalGate: 'suspected' | 'confirmed' | null;
  /**
   * The external queue's own answer for this PR, freshly observed off its
   * comment (services/externalQueueState.ts). Undefined when the executor
   * didn't ask — no gate on this base, or the entry isn't tracking a
   * submission — and null when it asked and the provider has said nothing.
   * `decide` prefers it over the PR's labels, which trunk applies only in some
   * configurations and leaves stale in others.
   */
  externalQueue?: ExternalQueueStatus | null;
  /** Whether githubService.updateBranch exists/is enabled (Push E). */
  updateBranchAvailable: boolean;
  /** A cloud provider is connected for this workspace. */
  cloudEnvAvailable: boolean;
  /** githubRateGate.isBlocked(account, 'rest') — merge-critical calls would sleep. */
  restGateBlocked: boolean;
  /** githubRateGate.isBlocked(account, 'graphql') — probes would sleep. */
  graphqlGateBlocked: boolean;
  /** graphqlBudget.shouldDefer(account, 'queue') — points are scarce. */
  graphqlBudgetLow: boolean;
  maxAttempts: number;
  /**
   * The PR that owns this entry's base branch — the stack parent.
   *
   * `undefined` — the evaluator didn't resolve it (nothing to say).
   * `null`      — resolved, and no PR owns this base: the entry is a stack
   *               root, or it has already been retargeted onto a real branch.
   *
   * Derived per group walk, never persisted: the group key IS the base branch,
   * so one query answers it for every entry in the walk.
   */
  stackParent?: StackParent | null;
  /**
   * Outcome of a `retarget_base` action, folded back for the next round. Only
   * the failures reach decide — a SUCCESSFUL retarget aborts the evaluation
   * outright, because the whole context (signing, external gate, auto-merge
   * capability) was probed against the base the PR just left.
   */
  retargetOutcome?: 'error' | 'retry';

  // ── I/O outcomes (present only after the executor ran the action) ──
  /** Result of `verify_merged` — GitHub's canonical merged_at signal. */
  verifiedMerged?: boolean;
  /** Result of `probe_signatures` — unsigned commit count on the head. */
  unsignedCount?: number;
  /** Result of `verify_live_then_merge`. */
  mergeOutcome?: MergeOutcome;
  /** Result of `rerequest_failed_checks`. */
  rerunOutcome?: RerunOutcome;
  /** Result of `submit_external`. */
  submitOutcome?: SubmitOutcome;
  /** Result of `update_branch`. */
  updateBranchOutcome?: 'ok' | 'conflict' | 'error';
}

/** Draft of a merge_queue_events row; the executor stamps `at` + trigger. */
export interface EventDraft {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * What the executor should do, in order. Actions are granular and idempotent;
 * `transition` carries the full entry patch so the executor stays mechanical.
 */
export type Action =
  /** Persist entry changes (CAS-guarded) + append the audit event. */
  | {
      kind: 'transition';
      to: EntryStatus;
      blockedCode?: BlockedCode | null;
      blockedReason?: string | null;
      /** Extra column writes folded into the same CAS update. */
      set?: Partial<
        Pick<
          EntrySnapshot,
          | 'fixAttempts'
          | 'rerunAttempts'
          | 'resignAttempts'
          | 'submitAttempts'
          | 'seenSignatures'
          | 'externalSubmitVia'
          | 'externalSubmittedAt'
          | 'externalState'
          | 'automergeArmedBy'
          | 'fixTaskAccounted'
          | 'signingCheckedSha'
          | 'unsignedCount'
          | 'stackParentNumber'
          | 'retargetAttempts'
        >
      > & { lastError?: string; lastErrorAt?: string };
      event: EventDraft;
    }
  /**
   * A new head appeared — zero every per-head budget and clear the signing
   * memo. THE self-healing mechanic: fresh code gets fresh budgets. Never
   * applies to `blocked_manual` (App permission isn't head-dependent).
   */
  | { kind: 'reset_budgets'; newHeadSha: string; event: EventDraft }
  /**
   * A new head appeared that the queue's OWN in-flight fix run pushed — advance
   * the head pointer WITHOUT resetting budgets. Resetting on our own commits
   * made the retry cap unreachable (fix → push → new head → reset → fix …
   * forever); only genuine external pushes deserve fresh budgets. See R2.
   */
  | { kind: 'adopt_head'; newHeadSha: string; event: EventDraft }
  /**
   * Re-read the entry + PR row live (still open? still queued? version
   * unchanged?), persist `merging` + merge_started_at, then attempt the REST
   * merge. Aborts without merging if the live re-read fails. The outcome
   * comes back as ctx.mergeOutcome.
   */
  | { kind: 'verify_live_then_merge' }
  /** Ask GitHub (REST getPullRequest, merged_at) whether the PR is in fact merged. */
  | { kind: 'verify_merged' }
  /** Fetch the unsigned-commit count (GraphQL) and memoize it per head. */
  | { kind: 'probe_signatures' }
  /** POST re-runs for the head's failing check runs. Outcome → ctx.rerunOutcome. */
  | { kind: 'rerequest_failed_checks' }
  /** PUT update-branch — merge the base into the head server-side (Push E). */
  | { kind: 'update_branch' }
  /**
   * Merge stack: point the PR at `toBase` (REST PATCH), then move the entry
   * into that group. Fired only once the stack parent that owned the current
   * base has MERGED. Idempotent — a base that already reads `toBase` (GitHub's
   * own delete-branch auto-retarget beat us to it) skips the call.
   */
  | { kind: 'retarget_base'; toBase: string; parentNumber: number }
  /**
   * Create the "get this PR mergeable" cloud task. Executor contract:
   * fired → status 'fixing' + fixTaskId + fixTaskAccounted=false (+
   * resignAttempts+1 when resign); TaskLimitError or no cloud env →
   * ensure 'queued' and burn NOTHING (a slot frees when a task ends).
   */
  | {
      kind: 'fire_fix_run';
      resign: boolean;
      /**
       * Set when the PR is clean on its own branch but the external queue
       * failed it merged with trunk. The run has no local blocker to work
       * from, so it is started from the provider's failure output instead.
       */
      queueFailure?: { provider: string; evidence: string };
    }
  /** Enable GitHub auto-merge on the head (expectedHeadOid-guarded; Push E). */
  | { kind: 'arm_automerge' }
  /**
   * Hand the PR to the external merge queue governing the base branch: arm
   * GitHub auto-merge (trunk.io treats that as a submit, as does GitHub's own
   * queue) and, when GitHub refuses because the PR is already clean, apply the
   * repo's submit label instead. Outcome → ctx.submitOutcome.
   */
  | { kind: 'submit_external' }
  /** Learn-from-405: persist that this base is behind an external merge gate. */
  | { kind: 'mark_external_gate' }
  /** Disable a Talyn-armed auto-merge (never a user-armed one; Push E). */
  | { kind: 'disarm_automerge' }
  /** Learn-from-403: persist that this base requires signed commits. */
  | { kind: 'mark_signing_required' }
  /** The single success path: entry → merged, PR row terminal, positions rebroadcast. */
  | { kind: 'record_merged' }
  /** Force-refetch the PR summary now (post-failed-merge staleness fix). */
  | { kind: 'refresh_snapshot' }
  /** Fire the one-shot merge_queue:blocked notification (dedup is the executor's). */
  | { kind: 'notify_blocked' };

/**
 * One round's decision. `verdict` is the group-walk semantics carried over
 * verbatim from v1: `hold` — this entry is being actively worked and keeps
 * the group's turn; `advance` — it can't make progress right now, so the next
 * queued entry gets a go instead of sitting behind it.
 */
export interface Decision {
  actions: Action[];
  verdict: 'hold' | 'advance';
}
