// Merge queue v2 — the pure decision function.
//
// Every branch of the old mergeQueueProcessor's processHead() lives here as an
// explicit rule over (entry, PR snapshot, context) → actions + verdict. The
// function does NO I/O and reads NO clocks, so the whole state machine is
// table-testable — decide.test.ts is the spec. The comments carry forward the
// production incidents that shaped each rule; do not strip them.
//
// Protocol: the executor performs the returned actions in order. Actions that
// produce data (verify_merged, probe_signatures, verify_live_then_merge,
// rerequest_failed_checks, update_branch) get their result folded into the
// context, and decide runs again — bounded by MAX_DECIDE_ROUNDS. The final
// round's verdict is the group-walk verdict.

import {
  prNeedsFollowup,
  mergeBlockerReason,
  externalQueueProviderLabel,
  externalQueueReason,
  externalQueueStateLabel,
  externalQueueStatusFromLabels,
  isExternalQueueSubmitLabel,
  isExternalQueueEjected,
  isExternalQueueHolding,
  type ExternalQueueStatus,
  type PRMergeableSummary,
} from '@talyn/shared';
import { MAX_INFRA_SUBMITS_PER_HEAD, MAX_RETARGETS } from './types.js';
import type {
  Action,
  BlockedCode,
  Decision,
  DecisionContext,
  EntrySnapshot,
  EntryStatus,
  EventDraft,
  PrSnapshot,
  VisualReviewContext,
} from './types.js';
import type { StackParent } from './stack.js';

export const DRAFT_BLOCK_REASON =
  'This PR is a draft — mark it ready for review and the merge queue will merge it automatically.';

export const EXTERNAL_GATE_BLOCK_REASON =
  'This branch is governed by an external merge queue or protected-ref rule Talyn ' +
  "can't bypass (GitHub's native merge queue, trunk.io, or a restrictive ruleset), " +
  'and there is no way to submit the PR to it automatically: the repo refuses ' +
  'GitHub auto-merge and defines no submit label. Merge it through that system, ' +
  'or remove it from the queue.';

/**
 * The queue's runner kept dying on this head. Says so plainly: the PR is not
 * the problem, and the next move belongs to whoever owns the CI, not to the
 * author staring at a green branch.
 */
export function externalQueueInfraReason(
  status: ExternalQueueStatus,
  detail: string,
  attempts: number
): string {
  const provider = externalQueueProviderLabel(status.provider);
  return (
    `${provider}'s merge queue failed this PR ${attempts} time(s) on its own CI ` +
    `infrastructure, not on anything in this PR (${detail}). Its checks are green ` +
    `on the branch, so there is nothing here to fix — re-queue it once the CI ` +
    `runners are healthy.`
  );
}

export function externalQueueRejectedReason(status: ExternalQueueStatus): string {
  const provider = externalQueueProviderLabel(status.provider);
  if (status.state === 'cancelled') {
    return (
      `${provider}'s merge queue cancelled this PR (${status.evidence}). Talyn won't ` +
      `resubmit a cancelled PR automatically — push a fix, or re-queue the PR to submit it again.`
    );
  }
  if (status.state === 'ejected') {
    return (
      `${provider}'s merge queue sent this PR back for the same reason twice on this ` +
      `commit (${status.evidence}) without ever testing it. Push a fix (the queue ` +
      `resubmits automatically on a new commit), or re-queue to retry now.`
    );
  }
  return (
    `${provider}'s merge queue sent this PR back for the same reason twice on this ` +
    `commit (${status.evidence}) — its tests fail when the PR is merged with the base, ` +
    `and nothing here changed that. Push a fix (the queue resubmits automatically on a ` +
    `new commit), or re-queue to retry now.`
  );
}

/**
 * The per-head submit budget is spent: the provider has taken this commit and
 * handed it back more times than the queue is willing to re-offer it.
 */
export function externalQueueBudgetSpentReason(
  status: ExternalQueueStatus,
  attempts: number
): string {
  const provider = externalQueueProviderLabel(status.provider);
  return (
    `${provider}'s merge queue has taken this commit and sent it back ${attempts} times ` +
    `(latest: ${status.evidence}). The queue stopped resubmitting it rather than keep ` +
    `spending queue cycles on an unchanged commit. Push a fix (that resets the budget ` +
    `automatically), or re-queue to retry now.`
  );
}

/**
 * Why the queue stopped. Deliberately names the blocker AND says the attempt
 * changed nothing — "3 attempts" told a user how many times we tried but never
 * what we learned, and the honest answer is that the same thing is still wrong.
 */
export function noProgressReason(pr: PrSnapshot): string {
  return (
    `${blockerReason(pr)}. A fix run already ran against this exact problem on this ` +
    `commit and left it unchanged, so the queue stopped rather than repeat it. ` +
    `Push a fix (that resets it automatically), or re-queue to try again.`
  );
}

/** The provider refuses to merge this PR at all — no fix run can move it. */
export function externalQueueRefusedReason(status: ExternalQueueStatus): string {
  const provider = externalQueueProviderLabel(status.provider);
  return (
    `${provider}'s merge queue says it cannot merge this PR: "${status.evidence}". ` +
    `That isn't something a fix run or a resubmit can change — resolve it in ${provider}, ` +
    `or remove the PR from the queue.`
  );
}

/**
 * A merge refusal Talyn can never satisfy by retrying or fixing: the base
 * branch requires merging through an external gate (GitHub's native merge
 * queue, a third-party queue like trunk.io, or a restrictive protected-ref
 * ruleset). GitHub 405s the direct merge with "Cannot update this protected
 * ref". This is only tested AFTER a clean-looking merge attempt was refused, so
 * the phrase unambiguously means an unbypassable gate here — a genuinely
 * fixable blocker (conflict, failing check, unsigned commits) is caught upstream
 * and never reaches the merge call.
 */
export function isExternalMergeGateError(message: string | undefined): boolean {
  return message !== undefined && /protected ref|merge queue/i.test(message);
}

/**
 * The blocked-badge reason for an App-refused merge over failing head checks,
 * matched to why the automatic re-run couldn't save it. Ported verbatim from
 * v1 — these strings are user-facing and the tests pin them.
 */
export function buildFailingChecksBlockReason(
  rerunReason: 'no-failing-check-runs' | 'needs-actions-permission' | 'not-rerequestable' | undefined,
  rerunAttempts: number,
  maxAttempts: number
): string {
  const preamble =
    `GitHub won't let the Talyn App merge while a check is failing on the head ` +
    `commit — even an "optional" one a human can merge past. `;
  if (rerunReason === 'needs-actions-permission') {
    return (
      preamble +
      `Talyn couldn't re-run it (the App needs the "Actions: Read & write" permission ` +
      `for GitHub-Actions checks). Re-run the check on GitHub and the queue will retry, ` +
      `or merge manually.`
    );
  }
  if (rerunReason === 'not-rerequestable') {
    return (
      preamble +
      `Talyn can't re-run this check (GitHub only lets the app that created it — or a ` +
      `human on github.com — re-run it), and the branch is already up to date with its ` +
      `base, so re-triggering the checks via a branch update wasn't possible either. ` +
      `Re-run the check on GitHub and the queue will retry, or merge manually.`
    );
  }
  if (rerunAttempts >= maxAttempts) {
    return (
      preamble +
      `Talyn re-ran the failing checks ${maxAttempts}× and they kept failing — fix the ` +
      `check (or merge manually on GitHub); the queue retries once it's green.`
    );
  }
  return (
    preamble +
    `Re-run or fix the failing check and the queue will retry automatically, or merge ` +
    `manually on GitHub.`
  );
}

export function unsignedCommitsBlockReason(maxAttempts: number): string {
  return (
    `The base branch requires signed commits and some commits on this PR are unsigned. ` +
    `Talyn tried to re-sign the branch ${maxAttempts}× and couldn't get every commit signed — ` +
    `sign the branch's commits (or merge manually on GitHub), then re-queue the PR.`
  );
}

// ── Snapshot predicates (ported from v1; exported for tests + executor) ──

export function mergeStateOf(pr: PrSnapshot): string {
  return (pr.mergeStateStatus || 'UNKNOWN').toUpperCase();
}

/**
 * GitHub can't merge a DRAFT PR — the merge API 405s. Detected from the
 * summary's `draft` flag OR `mergeStateStatus === 'DRAFT'` (belt and suspenders).
 */
export function isDraft(pr: PrSnapshot): boolean {
  return pr.summary.draft === true || mergeStateOf(pr) === 'DRAFT';
}

/**
 * Behind / blocked-by-out-of-date is a queue blocker that `prNeedsFollowup`
 * misses — it's exactly the state every sibling PR lands in after one merges
 * to the shared base.
 */
export function needsUpdate(pr: PrSnapshot): boolean {
  const s = mergeStateOf(pr);
  return s === 'BEHIND' || s === 'BLOCKED';
}

export function queueBlocked(pr: PrSnapshot): boolean {
  return prNeedsFollowup(pr.summary) || needsUpdate(pr);
}

/**
 * {@link queueBlocked}, made gate-aware — the version every rule inside
 * `decide` uses.
 *
 * A branch behind an external merge queue reports `mergeStateStatus = BLOCKED`
 * for **every** PR: the ruleset forbids updating the ref, so an approved,
 * green, conflict-free PR reads exactly like a broken one. (Verified the day
 * trunk.io went live on posthog/posthog: all 20 most-recently-updated open PRs
 * came back MERGEABLE + BLOCKED, approved ones included.) Counting that as a
 * blocker sent every ready PR down the remediation path and fired a paid cloud
 * fix run that could never help — the "blocker" is the ruleset.
 *
 * With a gate present, a bare BLOCKED IS the gate, so it doesn't block: the PR
 * is ready and belongs in the external queue. BEHIND doesn't block either, for
 * the same reason one step further on: an external merge queue exists precisely
 * to REMOVE the up-to-date requirement — trunk.io tests each PR against the
 * current base itself and merges from its own branch, so "behind master" is the
 * steady state of every open PR on a busy repo, not work to be done. Acting on
 * it was the 2026-08-18 runaway: master advances (constantly, on
 * posthog/posthog), every submitted PR reads BEHIND, each one falls out of the
 * `awaiting_external` short-circuit into remediation, updates its branch, and
 * the resulting new head resets its budgets via R2 — so the fix-run cap can
 * never be reached and each base advance buys another paid cloud run.
 *
 * Everything `prNeedsFollowup` covers still counts under a gate — conflicts,
 * requested changes, unresolved threads and failing REQUIRED checks are real
 * work no matter who performs the merge, and the provider will hold the PR at
 * "not ready" forever until they're fixed. Pending CI and a missing required
 * review are handled upstream (R7/R7b) and never reach here.
 */
function queueBlockedFor(pr: PrSnapshot, ctx: DecisionContext): boolean {
  if (prNeedsFollowup(pr.summary)) return true;
  if (ctx.externalGate !== null) return false;
  return needsUpdate(pr);
}

/**
 * The head commit still has queued / in-progress checks reporting. GitHub
 * surfaces such a PR as `mergeStateStatus = BLOCKED` — the same status it uses
 * for a *failed* required check — so `needsUpdate`/`queueBlocked` can't tell
 * "CI hasn't finished" apart from "CI failed" on their own.
 */
export function ciInFlight(pr: PrSnapshot): boolean {
  return (pr.summary.checks?.inProgress ?? 0) > 0;
}

/**
 * A *settled* reason the PR can't merge — one a remediation should act on now,
 * even if other checks are still running: conflicts, changes requested,
 * unresolved threads, or a failed REQUIRED check (all via `prNeedsFollowup`),
 * or BEHIND the base. Deliberately excludes a bare `BLOCKED`, which is what
 * GitHub reports while required checks are merely pending — that case must
 * wait for CI, not be treated as blocked.
 *
 * Gate-aware, for the reason spelled out on {@link queueBlockedFor}: under an
 * external merge queue, BEHIND is that queue's job, not a blocker Talyn should
 * act on. That matters more here than it does there, because this predicate is
 * what holds a submitted PR inside the `awaiting_external` short-circuit (R5b)
 * — counting BEHIND dropped a PR trunk.io was happily testing straight back
 * into remediation the moment master moved.
 */
function hasSettledBlockerFor(pr: PrSnapshot, ctx: DecisionContext): boolean {
  if (prNeedsFollowup(pr.summary)) return true;
  return mergeStateOf(pr) === 'BEHIND' && ctx.externalGate === null;
}

// ── Progress, not retries ──
//
// Remediation used to be capped at `maxAttempts` runs per head. That number was
// arbitrary and wrong in both directions: a PR clearing one blocker per run and
// landing on the fourth was declared blocked, while a PR whose runs changed
// nothing still burned three paid cloud runs first.
//
// What actually distinguishes "keep going" from "give up" is whether the last
// attempt CHANGED anything. So each completed remediation records a SIGNATURE of
// what is blocking the PR afterwards. A signature never seen on this head means
// the attempt moved the problem — continue. A signature already recorded means
// the attempt failed at something it already failed at — block.
//
// This terminates with no constant in it: the list only grows, and it can only
// grow as far as the PR has distinct ways of being blocked. A new head clears it
// (R2), exactly as it cleared the counters.

/**
 * What is blocking this PR, as a comparable token.
 *
 * `failingChecksDigest` is the load-bearing part: `checks.failed` alone reads
 * 4 → 4 whether the run fixed nothing or fixed one check and uncovered another,
 * and calling the second case "no progress" is precisely the judgement a retry
 * budget gets wrong. It is absent on summaries cached before it shipped and on
 * the by-branch fetch path, so `?? '?'` keeps those rows comparable on the
 * coarser fields rather than making every one of them look identical.
 */
export function blockerSignature(pr: PrSnapshot): string {
  const s = pr.summary;
  return [
    'fix',
    s.blockingReason,
    s.mergeable,
    mergeStateOf(pr),
    s.reviewDecision ?? '-',
    // FAILING count only — never `checks.total`, and never `inProgress`. Both
    // move on their own as a CI run registers and finishes jobs, and a
    // signature that drifts without the PR changing manufactures fake progress:
    // the bound here is "we have seen this before", so anything that churns on
    // its own makes it unreachable. A failure appearing or clearing IS a real
    // change and is meant to count.
    `failing=${s.checks?.failed ?? 0}`,
    `which=${s.failingChecksDigest ?? '?'}`,
    `threads=${s.unresolvedReviewThreads ?? 0}`,
  ].join('|');
}

/**
 * The same idea for an external merge queue, whose verdict is its own and says
 * nothing about the PR's local state — trunk fails a PR on the merge WITH the
 * base, which is green on the branch. Its evidence sentence names the checks
 * that failed, so it discriminates a repeat failure from a different one.
 *
 * Over `externalQueueReason`, not the raw sentence: trunk interpolates the
 * pusher and the batch PR into exactly the two reasons that repeat, so the raw
 * form made every ejection look novel and this bound unreachable.
 */
export function queueSignature(status: ExternalQueueStatus): string {
  const checks = (status.failedChecks ?? []).map((c) => c.toLowerCase()).sort().join(',');
  return ['queue', status.provider, status.state, externalQueueReason(status), checks].join('|');
}

/**
 * Is this entry in a state a STACK LINK put it in? Those are the verdicts that
 * must be released the moment the link stops resolving — they are all derived
 * from an edge, never from the PR itself.
 */
function isStackState(entry: EntrySnapshot): boolean {
  if (entry.status === 'awaiting_stack') return true;
  return (
    (entry.status === 'blocked' || entry.status === 'blocked_manual') &&
    (entry.blockedCode === 'stack_parent_abandoned' ||
      entry.blockedCode === 'stack_cycle' ||
      entry.blockedCode === 'stack_retarget_failed' ||
      entry.blockedCode === 'stack_retarget_loop')
  );
}

/** Has this exact problem already defeated a completed remediation on this head? */
export function signatureSeen(entry: EntrySnapshot, signature: string): boolean {
  // Defensive on the array itself: the column is nullable (every row written
  // before it shipped) and this predicate now gates the whole remediation path.
  // A throw here would abort the evaluation on every tick and wedge the entry —
  // a far worse failure than reading an unknown history as empty.
  return Array.isArray(entry.seenSignatures) && entry.seenSignatures.includes(signature);
}

/** The recorded history plus `signature`, tolerating a legacy null column. */
function withSignature(entry: EntrySnapshot, signature: string): string[] {
  const seen = Array.isArray(entry.seenSignatures) ? entry.seenSignatures : [];
  return [...seen, signature];
}

/**
 * The only obstacle is a missing required review: GitHub reports BLOCKED, no
 * settled blocker, no CI in flight, reviewDecision REVIEW_REQUIRED. No
 * remediation applies — an agent can't approve a PR — so the queue waits.
 * (v1 fired doomed fix runs at this state and blocked after 3 attempts.)
 */
export function awaitingRequiredReview(pr: PrSnapshot, ctx: DecisionContext): boolean {
  return (
    mergeStateOf(pr) === 'BLOCKED' &&
    !hasSettledBlockerFor(pr, ctx) &&
    !ciInFlight(pr) &&
    pr.summary.reviewDecision === 'REVIEW_REQUIRED'
  );
}

/**
 * A short, human reason a queued PR is blocked — for the notification + badge.
 * "Behind the base" is read off `mergeStateStatus`, which `mergeBlockerReason`
 * doesn't see, so it's special-cased here.
 */
export function blockerReason(pr: PrSnapshot): string {
  if (prNeedsFollowup(pr.summary)) return mergeBlockerReason(pr.summary);
  if (needsUpdate(pr)) return 'the branch is behind its base';
  return 'needs attention';
}

function checksFailing(summary: PRMergeableSummary): boolean {
  return (summary.checks?.failed ?? 0) > 0;
}

/**
 * Where the external merge queue says this PR is.
 *
 * TWO channels, and the ORDER is the whole point. `ctx.externalQueue` is read
 * off the provider's own PR comment, which trunk edits in place through the
 * lifecycle; labels are a config-dependent mirror of it. On posthog/posthog the
 * labels turned out to be neither reliable nor timely — seven PRs trunk was
 * actively testing carried no queue label at all, while PRs merged hours
 * earlier still carried `trunk-testing` — so reading labels FIRST made the
 * queue declare "never picked up" for PRs sitting happily in trunk's queue
 * (2026-07-29). Null from both means no external queue has said anything: the
 * answer for every PR in a repo that doesn't use one, and for a just-submitted
 * PR in the seconds before the provider reacts.
 */
export function externalQueueOf(pr: PrSnapshot, ctx?: DecisionContext): ExternalQueueStatus | null {
  return ctx?.externalQueue ?? externalQueueStatusFromLabels(pr.summary.labels);
}

/**
 * How long a submission may go unacknowledged before the queue stops believing
 * it, when the provider has said NOTHING either way. trunk reacts within ~30s
 * of accepting a PR (observed: 30s on #74353); 10 minutes is far beyond that
 * while still bounding how long a PR can sit on a submission that vanished.
 */
export const EXTERNAL_PICKUP_GRACE_MS = 10 * 60_000;

/**
 * Is the PR still in the external queue's hands?
 *
 * The provider's own answer settles it whenever there is one — including the
 * negative answer (`not_submitted`: trunk's submit checkbox is untouched, so it
 * does NOT have the PR). Only within the grace window is that negative treated
 * as "not yet", since we may be reading the comment between our command landing
 * and trunk reacting to it.
 *
 * With no provider answer at all it falls back to the door we used, because
 * each leaves a different trace: `auto_merge`/`label` leave state ON GitHub we
 * can re-read, so their absence means the submission was undone outside Talyn;
 * `comment` leaves nothing re-readable, so it's believed for the grace window
 * and no longer.
 */
function stillSubmitted(entry: EntrySnapshot, pr: PrSnapshot, ctx: DecisionContext): boolean {
  const ext = externalQueueOf(pr, ctx);
  if (ext && ext.state !== 'not_submitted') return !isExternalQueueEjected(ext.state);
  if (ext?.state === 'not_submitted') return withinPickupGrace(entry, ctx);
  if (entry.externalSubmitVia === 'auto_merge') return pr.autoMergeEnabledBy !== null;
  if (entry.externalSubmitVia === 'label') {
    return (pr.summary.labels ?? []).some(isExternalQueueSubmitLabel);
  }
  if (entry.externalSubmitVia === 'comment') return withinPickupGrace(entry, ctx);
  return false;
}

function withinPickupGrace(entry: EntrySnapshot, ctx: DecisionContext): boolean {
  if (!entry.externalSubmittedAt) return false;
  const age = Date.parse(ctx.nowIso) - Date.parse(entry.externalSubmittedAt);
  return Number.isFinite(age) && age < EXTERNAL_PICKUP_GRACE_MS;
}

export const EXTERNAL_PICKUP_FAILED_REASON =
  "Talyn posted the merge queue's own submit command on this PR and the queue never " +
  'picked it up — its submit checkbox is still untouched. It may not accept commands ' +
  'from an app — submit the PR in that system (e.g. tick the checkbox in its comment), ' +
  'or re-queue the PR to try again.';

// ── The decision function ──

/**
 * Decide what should happen to one queue entry, given the freshest PR snapshot
 * and the evaluation context. Pure: same inputs → same Decision.
 */
export function decide(entry: EntrySnapshot, pr: PrSnapshot, ctx: DecisionContext): Decision {
  const d = new DecisionBuilder(entry);

  // R0 — the PR left `open` underneath us. Close the entry out so it never
  // blocks the group; the next queued entry takes this turn.
  if (pr.state === 'merged') {
    d.transition('merged', {
      event: { code: 'pr_merged_externally', message: 'PR was merged outside the queue.' },
    });
    return d.done('advance');
  }
  if (pr.state === 'closed') {
    d.transition('removed', {
      event: { code: 'pr_closed', message: 'PR was closed without merging.' },
    });
    return d.done('advance');
  }
  // Terminal entries take no further actions (defensive — the group loader
  // excludes them).
  if (entry.status === 'merged' || entry.status === 'removed') return d.done('advance');

  // R0b — the external provider says it merged the PR. Terminal, and it has to
  // be honoured HERE rather than left to R0, because R0 keys on Talyn's OWN pr
  // row, which lags an external merge. In that lag the PR is the worst possible
  // shape to fall through on: its head branch is deleted, so GitHub answers
  // mergeable/UNKNOWN, which reads as a settled blocker — `stillSubmitted()` is
  // true (merged is not an ejection), so the awaiting_external branch declines
  // to short-circuit and remediation fires a PAID fix run. Every eager
  // evaluation of a gated group did it again: PostHog/posthog#75985 burned 10+
  // cloud runs, each concluding "this PR is already merged".
  //
  // `merged` is in neither isExternalQueueEjected nor isExternalQueueHolding —
  // it is the one provider state with no branch of its own, which is exactly
  // how it fell through every guard.
  const extMerged = externalQueueOf(pr, ctx);
  if (extMerged && extMerged.state === 'merged') {
    d.transition('merged', {
      set: { externalSubmitVia: null, externalSubmittedAt: null, externalState: 'merged' },
      event: {
        code: 'external_queue_merged',
        message: `${externalQueueProviderLabel(extMerged.provider)} merged this PR.`,
        detail: { evidence: extMerged.evidence, source: extMerged.source },
      },
    });
    return d.done('advance');
  }

  // R1 — merge aftermath: this evaluation's own merge attempt already ran.
  // Handled before everything else because the entry is mid-flow. The submit
  // aftermath comes first: a submit that fell back to the direct merge clears
  // its own outcome, so at most one of the two is ever live (see the executor).
  if (ctx.submitOutcome) return decideSubmitAftermath(d, pr, ctx);
  if (ctx.mergeOutcome) return decideMergeAftermath(d, pr, ctx);

  // R2 — a new head appeared: zero every per-head budget. THE self-healing
  // mechanic — fresh code deserves fresh budgets, and a headSha change is a
  // trustworthy, monotonic signal (unlike the transient clean readings that
  // v1's never-reset rule guarded against — see R8). `blocked` clears;
  // `blocked_manual` is sticky (App permission isn't head-dependent).
  if (
    entry.headSha &&
    pr.headSha &&
    entry.headSha !== pr.headSha &&
    entry.status !== 'blocked_manual'
  ) {
    // A head-SHA change normally means fresh EXTERNAL code, which deserves
    // fresh budgets. But the queue's OWN fix run pushes commits too — and
    // resetting the fix budget on those made the retry cap unreachable: fix →
    // push → new head → reset → fix … forever for any PR the agent can't land
    // (the 2026-07-17 runaway: thousands of duplicate fix runs). While a
    // fired-but-unaccounted fix run is in flight, attribute the new head to
    // THAT run: advance the pointer but keep the budget so R8 still counts the
    // attempt. A genuine external push (no unaccounted run) still resets.
    const causedByOurFixRun = entry.fixTaskId !== null && !entry.fixTaskAccounted;
    if (causedByOurFixRun) {
      d.adoptHead(pr.headSha);
    } else {
      d.resetBudgets(pr.headSha);
    }
  }

  // R3 — a persisted `merging` with no outcome in this evaluation means a
  // prior evaluation died between GitHub accepting the merge and our write
  // (wedged await, redeploy — the June 2026 incident: merged on GitHub at
  // 19:13 but the row read open/merging forever). Ask GitHub directly before
  // doing anything else; re-attempting the merge would just 405.
  if (d.entry.status === 'merging') {
    if (ctx.verifiedMerged === undefined) {
      d.act({ kind: 'verify_merged' });
      return d.done('hold');
    }
    if (ctx.verifiedMerged) {
      d.act({ kind: 'record_merged' });
      return d.done('hold');
    }
    // GitHub says still open — the attempt never landed. Re-arm and continue.
    d.transition('queued', {
      event: {
        code: 'merge_attempt_lost',
        message: 'A previous merge attempt did not land (GitHub reports the PR still open).',
      },
    });
  }

  // R4 — draft head. GitHub refuses to merge a draft (405). A draft reads as
  // not-queue-blocked, so without this the clean path would attempt a doomed
  // merge on every evaluation and hold the whole group. Surface it and ADVANCE
  // so ready PRs behind it keep draining. No notification — a draft isn't a
  // queue failure, just work the author hasn't finished.
  if (isDraft(pr)) {
    if (d.entry.status !== 'blocked' || d.entry.blockedCode !== 'draft') {
      d.transition('blocked', {
        blockedCode: 'draft',
        blockedReason: DRAFT_BLOCK_REASON,
        event: { code: 'draft', message: 'Draft PR — waiting for ready-for-review.' },
      });
    }
    return d.done('advance');
  }
  // Self-heal: no longer a draft — funnel straight back into the queue.
  if (d.entry.status === 'blocked' && d.entry.blockedCode === 'draft') {
    d.transition('queued', {
      event: { code: 'ready_for_review', message: 'PR marked ready for review.' },
    });
  }

  // R4b — MERGE STACK gate. The PR this one is based on hasn't landed yet, so
  // merging now would put it in the parent's branch instead of the real base.
  //
  // The placement is the whole design, because the group walk gives NO
  // protection here: parent and child live in different (repo, base) groups
  // and are walked by two independent, possibly concurrent evaluations, and
  // decideCleanPath never reads ctx.isHead. So the gate must be an
  // unconditional rule that consults nothing about mode, head-ness, or gates.
  //
  // Why here and not elsewhere:
  //   after R0/R0b — a child merged or closed underneath us must terminate,
  //                  never park.
  //   after R1     — never interrupt a merge/submit aftermath mid-flight.
  //   after R2     — budget resets keep working while parked.
  //   after R3     — CRITICAL. A persisted `merging` must hit verify_merged
  //                  first, or we strand a PR GitHub already merged.
  //   after R4     — a draft is more actionable to the author than "waiting".
  //   before R5..R11 — a parked child must never arm auto-merge, be submitted
  //                  to trunk (which refuses stacks outright), fire a fix run,
  //                  update its branch, or merge.
  if (ctx.stackParent !== undefined && ctx.stackParent !== null) {
    const parent = ctx.stackParent;
    const stacked = decideStackGate(d, pr, parent, ctx);
    if (stacked) return stacked;
  } else if (ctx.stackParent === null && isStackState(d.entry)) {
    // Self-heal: nothing owns this base any more — the parent landed and the
    // retarget already moved us, the parent PR was retargeted itself, or the
    // edge was never real. Every stack verdict is derived from a link that is
    // re-resolved each evaluation, so when the link goes the verdict must go
    // with it: a `blocked` reached from an edge that no longer exists has no
    // evidence left behind it and would otherwise sit there until a human
    // requeued. That is what stranded 30+ PostHog/posthog PRs on
    // "#69000 was closed without merging" (2026-08-18) — the parent was a
    // master → master PR the resolver should never have followed.
    d.transition('queued', {
      blockedCode: null,
      blockedReason: null,
      set: { stackParentNumber: null },
      event: {
        code: 'stack_parent_cleared',
        message: 'No PR owns this base branch any more — back in line.',
      },
    });
  }

  // R5 — auto-merge armed: GitHub owns the merge moment. If GitHub silently
  // disarmed it (draft conversion, base deleted, …) the snapshot shows no
  // armed request — re-arm the entry and fall through to a fresh decision.
  // While armed, a settled blocker still gets remediation (the run/update
  // works alongside; GitHub merges when everything is green).
  if (d.entry.status === 'automerge_armed') {
    if (pr.autoMergeEnabledBy === null) {
      d.transition('queued', {
        event: {
          code: 'automerge_disarmed_externally',
          message: 'GitHub auto-merge was disabled outside the queue — re-evaluating.',
        },
      });
      // fall through to the normal rules below
    } else if (!hasSettledBlockerFor(pr, ctx)) {
      return d.done('advance'); // armed and unobstructed — GitHub will merge it
    }
    // armed WITH a settled blocker: fall through so the remediation rules run.
  }

  // R5b — submitted to an external merge queue (trunk.io / GitHub's native
  // queue). That system owns the merge moment now; we track it off its own PR
  // comment (falling back to labels). Four outcomes: it merges (R0 closes us
  // out), it keeps working (wait), it REFUSES the PR outright (a human's
  // problem), or it EJECTS the PR back to us — which is where Talyn earns its
  // keep: fix the PR and resubmit, bounded by a per-head budget.
  if (d.entry.status === 'awaiting_external') {
    const ext = externalQueueOf(pr, ctx);
    // An ejection seen within the grace window of OUR OWN submission is very
    // likely the state we just resubmitted against — neither channel proves
    // the provider has reacted yet (its comment is edited in place, its labels
    // are relabelled in place), so a fresh read returns the pre-submit answer
    // for as long as it takes the provider to act. Acting on it would eject →
    // resubmit → eject, spending the whole per-head submit budget in a minute.
    // Waiting costs at most one grace window on a genuinely fast ejection.
    const staleEjection =
      ext !== null && isExternalQueueEjected(ext.state) && withinPickupGrace(d.entry, ctx);
    if (!staleEjection) d.observeExternalState(ext);
    if (ext && ext.state === 'rejected') {
      // The provider itself says it will never merge this PR (trunk on a
      // stacked PR: "our merge queue will be unable to merge this PR"). A fix
      // run can't unstack it and a resubmit would be ignored.
      d.transition('blocked_manual', {
        blockedCode: 'external_gate',
        blockedReason: externalQueueRefusedReason(ext),
        set: { externalSubmitVia: null, externalSubmittedAt: null },
        event: {
          code: 'external_queue_refused',
          message: `${externalQueueProviderLabel(ext.provider)} refuses to merge this PR.`,
          detail: { evidence: ext.evidence, source: ext.source },
        },
      });
      d.act({ kind: 'notify_blocked' });
      return d.done('advance');
    }
    if (ext && isExternalQueueEjected(ext.state) && !staleEjection) {
      const verdict = decideExternalEjection(d, pr, ext, ctx);
      if (verdict) return verdict;
      // null → requeued for a resubmit; fall through to the normal rules so a
      // PR that came back broken gets remediated before it goes round again.
    } else if (staleEjection || stillSubmitted(d.entry, pr, ctx)) {
      // In the queue's hands. While the provider is OBSERVED holding the PR,
      // hands off entirely — including a settled blocker.
      //
      // Remediating one meant firing a cloud run at a PR trunk was testing, and
      // that run's push is itself an ejection: "🚫 removed from the merge queue
      // because it was pushed to by @x. Please re-submit it in order to merge."
      // So the remediation destroyed the very queue cycle it was meant to
      // help — ~40 minutes of CI at PostHog — and it fired on the ordinary
      // shape of a reviewed PR, since `prNeedsFollowup` counts an unresolved
      // review thread, and bot reviewers leave those on nearly every PR.
      //
      // Waiting is not a deadlock: trunk ejects a PR it cannot merge on its
      // own ("waiting to become mergeable for too long … Submit it again once
      // it's ready"), and THAT is when remediation is both safe and useful.
      // The old comment's premise — that the provider holds a broken PR
      // forever — is not how trunk behaves.
      if (staleEjection || (ext && isExternalQueueHolding(ext.state))) return d.done('advance');
      // No positive observation, only our own record of having submitted (an
      // armed auto-merge, a label, a command inside its grace window). Nothing
      // says a queue is testing this PR right now, so a settled blocker still
      // deserves remediation — otherwise a PR whose provider never comments
      // parks forever.
      if (!hasSettledBlockerFor(pr, ctx)) return d.done('advance');
    } else if (d.entry.externalSubmitVia === 'comment') {
      // We posted the provider's own submit command and it never acknowledged
      // the PR. Resubmitting would just post the same comment again on someone
      // else's repo, so stop and say so — a human ticks the box, or re-queues.
      d.transition('blocked_manual', {
        blockedCode: 'external_gate',
        blockedReason: EXTERNAL_PICKUP_FAILED_REASON,
        set: { externalSubmitVia: null, externalSubmittedAt: null },
        event: {
          code: 'external_submit_ignored',
          message: 'The external merge queue never picked up the submit command Talyn posted.',
        },
      });
      d.act({ kind: 'notify_blocked' });
      return d.done('advance');
    } else {
      // Neither a provider label nor our submission survives: the arm was
      // disabled or the label removed outside Talyn. Take the PR back.
      d.transition('queued', {
        set: { externalSubmitVia: null, externalSubmittedAt: null },
        event: {
          code: 'external_submission_lost',
          message: 'The external queue submission was removed outside Talyn — re-evaluating.',
        },
      });
    }
  }

  // R5c — an external-queue block the provider itself now contradicts. The
  // blocked states here are all "we believe the queue doesn't have this PR",
  // and every one of them was reached from absent/ambiguous evidence: a
  // submission the provider never acknowledged, or an ejection. Seeing the
  // provider ACTIVELY holding the PR is stronger evidence than any of that, so
  // hand it back and resume tracking. This is also what un-sticks the entries
  // blocked by the label-only reading that predates the comment channel.
  if (
    (d.entry.status === 'blocked_manual' || d.entry.status === 'blocked') &&
    (d.entry.blockedCode === 'external_gate' || d.entry.blockedCode === 'external_queue_rejected')
  ) {
    const ext = externalQueueOf(pr, ctx);
    if (ext && isExternalQueueHolding(ext.state)) {
      const provider = externalQueueProviderLabel(ext.provider);
      d.transition('awaiting_external', {
        set: { externalState: ext.state },
        event: {
          code: 'external_queue_holding',
          message:
            `${provider}'s merge queue has this PR after all ` +
            `(${externalQueueStateLabel(ext.state).toLowerCase()}) — tracking it there.`,
          detail: { evidence: ext.evidence, source: ext.source },
        },
      });
      return d.done('advance');
    }
    // The provider is still saying it gave the PR back, but it is no longer
    // saying the SAME thing it was blocked on. The block is only ever as good
    // as the reading behind it, and the response differs sharply by state (a
    // `failed` is fixable from the queue's own output; a `cancelled` is not),
    // so a disagreement means the verdict was reached on evidence that no
    // longer holds. Hand the entry back to the ordinary rules with the fresh
    // state recorded.
    //
    // This converges: the transition persists what was just read, so the next
    // evaluation agrees and the heal cannot fire twice on one reading. It is
    // also what releases the PRs blocked by the classification bug — trunk's
    // "removed from the merge queue because it failed tests" parsed as
    // `cancelled` (terminal) instead of `failed` (fixable), and every entry it
    // hit would otherwise sit blocked until a human pushed (2026-08-18).
    if (
      ext &&
      d.entry.blockedCode === 'external_queue_rejected' &&
      isExternalQueueEjected(ext.state) &&
      d.entry.externalState !== ext.state
    ) {
      const provider = externalQueueProviderLabel(ext.provider);
      d.transition('queued', {
        blockedCode: null,
        blockedReason: null,
        set: { externalState: ext.state },
        event: {
          code: 'external_queue_state_changed',
          message:
            `${provider}'s merge queue now reports ` +
            `"${externalQueueStateLabel(ext.state).toLowerCase()}"` +
            (d.entry.externalState
              ? `, not "${externalQueueStateLabel(d.entry.externalState).toLowerCase()}"`
              : ' (nothing was recorded when this was blocked)') +
            ' — re-evaluating on the fresh reading.',
          detail: { evidence: ext.evidence, source: ext.source, state: ext.state },
        },
      });
      return d.done('advance');
    }
  }

  // R5d — the provider is holding a PR whose entry does not know it.
  //
  // R5b only protects an entry already parked in `awaiting_external`, so it
  // covers exactly one route into the queue: Talyn's own submit. Every other
  // route leaves the entry in `queued`/`awaiting_ci`/`blocked` while trunk has
  // the PR — the author commented `/trunk merge` themselves, the PR was queued
  // in Talyn after it was already submitted, or a submission was made from the
  // desktop merge button. Those entries walked straight into the remediation
  // and merge rules and did to a testing PR what R5b now refuses to: fire a
  // fix run that pushes (ejecting it), or re-post the submit command at a
  // queue that already has it.
  //
  // So the rule is stated on the PROVIDER's state rather than on ours: if it
  // is holding the PR, the entry belongs in `awaiting_external`, whatever it
  // currently says. Positive evidence only — `isExternalQueueHolding` excludes
  // every ejected and terminal state, so this can never park a PR the queue
  // has handed back.
  //
  // `blocked_manual` is exempt, and doesn't need the protection: it emits no
  // actions at all, so it cannot push or resubmit, and only a dequeue/requeue
  // is meant to clear it. Its external-queue codes still self-heal one rule up
  // (R5c), which is the case where the provider's state IS the evidence the
  // block was wrong.
  //
  // Gated bases only. Without a gate no external system owns this branch, and
  // `externalQueueOf` still answers off the PR's LABELS — which trunk leaves
  // behind: PostHog carries stale `trunk-testing` on PRs that merged hours ago.
  // Parking on one of those would wedge every entry in a repo where trunk was
  // switched off, with nothing left to un-wedge it.
  const providerHolding = ctx.externalGate ? externalQueueOf(pr, ctx) : null;
  if (
    d.entry.status !== 'awaiting_external' &&
    d.entry.status !== 'blocked_manual' &&
    providerHolding &&
    isExternalQueueHolding(providerHolding.state)
  ) {
    if (ctx.fixTaskState === 'active') {
      // A run dispatched before the provider took the PR is still going, and
      // its push will eject it — nothing here can un-push that. Parking now
      // would also strand the run's accounting, which lives in R8 below this
      // rule. Hold; the ejection path picks the PR up when it comes back.
      d.ensure('fixing');
      return d.done('hold');
    }
    d.transition('awaiting_external', {
      set: { externalState: providerHolding.state },
      event: {
        code: 'external_queue_holding',
        message:
          `${externalQueueProviderLabel(providerHolding.provider)}'s merge queue has this PR ` +
          `(${externalQueueStateLabel(providerHolding.state).toLowerCase()}) — tracking it there ` +
          'rather than acting on the PR underneath it.',
        detail: {
          evidence: providerHolding.evidence,
          source: providerHolding.source,
          from: d.entry.status,
        },
      },
    });
    return d.done('advance');
  }

  // R6 — active-run guard. Never fire a NEW run while one is already working
  // this PR: the queue's own fix run (fixTaskId) OR any other run linked via
  // pull_requests.taskId (a manual task, the keep-mergeable watcher) — which
  // v1 checked separately because taskId gets reassigned by other flows.
  const runActive = ctx.fixTaskState === 'active' || ctx.otherLinkedTaskActive;
  if (runActive && queueBlockedFor(pr, ctx) && hasSettledBlockerFor(pr, ctx)) {
    // An in-flight run only HOLDS BACK a PR with a SETTLED blocker — the
    // thing the run is actually fixing. A clean PR falls through to the merge
    // path, and a head whose only obstacle is in-flight CI falls through to
    // R7 so it can ARM auto-merge mid-run: cloud runs routinely overrun
    // (idle until turn-complete/auto-finalize) long after their fixes pushed,
    // and holding 'fixing' through that wasted the whole CI window.
    d.ensure('fixing');
    return d.done('hold');
  }
  if (runActive && !queueBlockedFor(pr, ctx) && checksFailing(pr.summary)) {
    // The run is working a head whose only obstacle is a check the App won't
    // merge past (not a genuine queue blocker). Don't re-attempt the doomed
    // App merge on top; advance so ready PRs behind it keep draining.
    d.ensure('fixing');
    return d.done('advance');
  }

  // R7 — CI still settling: required checks queued/in-progress, which GitHub
  // reports as mergeStateStatus=BLOCKED — the same status as a FAILED required
  // check. Without this guard, v1 fired a fix run and, after MAX_ATTEMPTS of
  // CI-still-not-green, declared the PR blocked — while CI had simply not
  // finished. Wait WITHOUT firing a run or counting an attempt, and ADVANCE so
  // a slow check on the head never freezes the ready PRs behind it. Only when
  // pending CI is the *sole* obstacle: a settled blocker still funnels into
  // the fix path below.
  if (ciInFlight(pr) && !hasSettledBlockerFor(pr, ctx)) {
    return decideCleanButWaitingOnCi(d, pr, ctx, runActive);
  }

  // R7b — only a required review is missing. An agent can't approve a PR, so
  // no remediation applies; wait and self-heal on the review webhook. (v1
  // funneled this into fix runs via the bare-BLOCKED branch of needsUpdate.)
  if (awaitingRequiredReview(pr, ctx)) {
    d.ensure('awaiting_review');
    return d.done('advance');
  }

  // R8 — account the last fix run now that it's terminal. We only ever
  // INCREMENT fixAttempts here — never reset on a momentary non-blocked
  // reading. The cached summary briefly reads mergeable/UNKNOWN right after a
  // fix run pushes commits (GitHub recomputes mergeability async), and
  // resetting on that transient lie is exactly what let v1 blow past
  // MAX_ATTEMPTS and fire fix runs forever. A genuinely-fixed PR merges below
  // and leaves the queue; budgets reset ONLY on a new head (R2) or requeue.
  if (d.entry.fixTaskId && !d.entry.fixTaskAccounted && !runActive) {
    const wasBlocked = d.entry.status === 'blocked';
    const stillBlocked = queueBlockedFor(pr, ctx);
    const signature = blockerSignature(pr);
    // Did this run move the problem? A signature we have already been left
    // with by a completed remediation means it did not — the run failed at
    // something it had failed at before, on the same head.
    const recurred = stillBlocked && signatureSeen(d.entry, signature);
    const attempts = stillBlocked ? d.entry.fixAttempts + 1 : d.entry.fixAttempts;
    const to: EntryStatus = recurred ? 'blocked' : d.entry.status;
    const justBlocked = !wasBlocked && to === 'blocked';
    d.transition(to, {
      blockedCode: justBlocked ? 'no_progress' : d.entry.blockedCode,
      blockedReason: justBlocked ? noProgressReason(pr) : d.entry.blockedReason,
      set: {
        fixAttempts: attempts,
        fixTaskAccounted: true,
        // Only RECORD a signature we are going to act on again. Recording the
        // recurrence too would be a no-op (it is already there), and recording
        // on a clean read would poison the list with a state that is not a
        // blocker at all.
        ...(stillBlocked && !recurred
          ? { seenSignatures: withSignature(d.entry, signature) }
          : {}),
      },
      event: {
        code: 'fix_run_accounted',
        message: !stillBlocked
          ? 'Fix run finished; PR reads clean.'
          : recurred
            ? `Fix run finished and the PR is blocked by the same thing as before (${blockerReason(pr)}) — no progress, stopping.`
            : `Fix run finished; the PR is still blocked but by a different problem (${blockerReason(pr)}) — continuing.`,
        detail: { taskId: d.entry.fixTaskId, attempt: attempts, signature },
      },
    });
    // Fire-once notification: the queue has stopped making progress and needs
    // a human (or a new push — R2 re-arms it).
    if (justBlocked) d.act({ kind: 'notify_blocked' });
  }

  // R8b — a check only a PERSON can clear. PostHog Visual Review diffs
  // screenshots against committed baselines and holds the gate red until
  // someone approves each change, so no code a fix run can write will ever
  // green it. Left to the ordinary rules it deadlocks: the run pushes a commit,
  // the commit triggers fresh CI, the fresh run carries the SAME unapproved
  // diffs (PostHog/posthog#83850 went round 11 times in two days).
  //
  // Placed AFTER R8 so a finished run is still accounted, and BEFORE R9 so an
  // entry already parked on `no_progress` or `awaiting_human_check` can still
  // be released by this — otherwise the blocked gate returns first and the PR
  // can never be un-stuck without a human.
  if (ctx.visualReview !== undefined && ctx.visualReview !== null) {
    const verdict = decideVisualReview(d, ctx.visualReview, ctx);
    if (verdict) return verdict;
  } else if (ctx.visualReview === null && d.entry.blockedCode === 'awaiting_human_check') {
    // Nothing is gating any more — approved by hand, superseded, or the check
    // went green. Same shape as the stack self-heal: the verdict was derived
    // from a live reading, so it dies with the reading.
    d.transition('queued', {
      blockedCode: null,
      blockedReason: null,
      event: {
        code: 'human_check_cleared',
        message: 'The visual review gate is no longer holding this PR — back in line.',
      },
    });
  }

  // R9 — blocked gates.
  if (d.entry.status === 'blocked_manual') {
    // Truly manual: GitHub refused the App with no failing check to blame.
    // A fix run cannot grant merge permission — dispatching one left v1
    // churning in 'fixing' and gating the whole group. Only dequeue/requeue
    // clears this.
    return d.done('advance');
  }
  if (d.entry.status === 'blocked') {
    const verdict = decideBlockedGate(d, pr, ctx);
    if (verdict) return verdict;
    // null → the gate self-healed; fall through to the clean/blocker paths.
  }

  // R10 — clean path: mergeable AND up-to-date → merge it.
  if (!queueBlockedFor(pr, ctx)) {
    return decideCleanPath(d, pr, ctx, runActive);
  }

  // R11 — settled blocker: conflict / changes / failing required CI /
  // unresolved threads / BEHIND. The recurrence guard comes first — the
  // absolute stop against dispatching a run at a problem a completed run has
  // already failed to move, even if a transient clean reading + a failed merge
  // flapped the status back to queued between R8 and here. R8 has already
  // notified when it first blocked, so re-settle the badge silently and hand
  // the turn to the next queued PR.
  if (signatureSeen(d.entry, blockerSignature(pr))) {
    if (d.entry.status !== 'blocked') {
      d.transition('blocked', {
        blockedCode: 'no_progress',
        blockedReason: d.entry.blockedReason ?? noProgressReason(pr),
        event: {
          code: 'no_progress',
          message:
            'This head is blocked by a problem a fix run already failed to move — ' +
            'waiting for a new push or requeue.',
        },
      });
    }
    return d.done('advance');
  }

  // BEHIND with no genuine followup work is one REST call, not a paid cloud
  // run: update the branch server-side (GitHub's "Update branch" button).
  // Fall back to the fix run when unavailable or conflicted.
  if (
    ctx.updateBranchAvailable &&
    mergeStateOf(pr) === 'BEHIND' &&
    !prNeedsFollowup(pr.summary)
  ) {
    if (ctx.updateBranchOutcome === undefined) {
      d.act({ kind: 'update_branch' });
      return d.done('hold');
    }
    if (ctx.updateBranchOutcome === 'ok') {
      d.transition('awaiting_ci', {
        event: {
          code: 'branch_updated',
          message: 'Merged the base into the head server-side — waiting for checks to re-run.',
        },
      });
      d.act({ kind: 'refresh_snapshot' });
      return d.done('advance');
    }
    // conflict/error → the update can't do it; fall through to the fix run.
  }

  // Fire the shared "get this PR mergeable" cloud run. A genuine blocker
  // holds the group while its fix runs — merging a same-base sibling first
  // would just re-conflict it. No connected provider / task limit defer
  // WITHOUT burning an attempt (executor contract on fire_fix_run) — and
  // can't advance either: same-workspace siblings can't dispatch either.
  if (!ctx.cloudEnvAvailable) {
    d.ensure('queued');
    return d.done('hold');
  }
  d.act({ kind: 'fire_fix_run', resign: false });
  return d.done('hold');
}

// ── Sub-deciders ──

/**
 * Head is clean except for in-flight CI. Plain wait (awaiting_ci) — or, when
 * native auto-merge is available and the signing gate passes, arm GitHub
 * auto-merge so the merge happens the instant checks go green, with zero
 * queue latency and immune to our budget.
 */
/**
 * The merge-stack gate (R4b). Returns a Decision when this entry belongs to a
 * stack and must not proceed on its own, or null to fall through to the normal
 * rules.
 *
 * Every branch that parks or blocks ADVANCES rather than holds, mirroring the
 * draft and awaiting-review rules: this entry can't merge, so it must not
 * consume its group's turn in ordered mode.
 */
function decideStackGate(
  d: DecisionBuilder,
  pr: PrSnapshot,
  parent: StackParent,
  ctx: DecisionContext
): Decision | null {
  // A base/head cycle: no member of the ring can ever be first, and no
  // remediation reaches it. Only the author can break it.
  if (parent.cycle) {
    if (d.entry.status !== 'blocked_manual' || d.entry.blockedCode !== 'stack_cycle') {
      d.transition('blocked_manual', {
        blockedCode: 'stack_cycle',
        blockedReason:
          `This PR is in a stack whose branches form a cycle (via #${parent.number}), ` +
          'so no PR in it can merge first. Retarget one of them to break the loop.',
        event: {
          code: 'stack_cycle',
          message: `Base/head cycle detected via #${parent.number}.`,
        },
      });
      d.act({ kind: 'notify_blocked' });
    }
    return d.done('advance');
  }

  if (parent.state === 'merged') {
    // The parent landed — move this PR onto the parent's base and let it
    // re-enter the normal flow from the new group.
    if (d.entry.retargetAttempts >= MAX_RETARGETS) {
      if (d.entry.blockedCode !== 'stack_retarget_loop') {
        d.transition('blocked_manual', {
          blockedCode: 'stack_retarget_loop',
          blockedReason:
            'This PR has been retargeted too many times while draining its stack. ' +
            'Retarget it by hand and requeue.',
          event: {
            code: 'stack_retarget_loop',
            message: `Retarget budget spent (${d.entry.retargetAttempts}/${MAX_RETARGETS}).`,
          },
        });
        d.act({ kind: 'notify_blocked' });
      }
      return d.done('advance');
    }
    if (ctx.retargetOutcome === 'error') {
      if (d.entry.blockedCode !== 'stack_retarget_failed') {
        d.transition('blocked', {
          blockedCode: 'stack_retarget_failed',
          blockedReason:
            `#${parent.number} merged, but GitHub refused to retarget this PR onto ` +
            `${parent.baseBranch}. Retarget it by hand, or push to retry.`,
          event: {
            code: 'stack_retarget_failed',
            message: `Retarget to ${parent.baseBranch} was refused.`,
          },
        });
        d.act({ kind: 'notify_blocked' });
      }
      return d.done('advance');
    }
    if (ctx.retargetOutcome === 'retry') {
      // Rate-gated. Stay parked and burn nothing; the reconciler comes back.
      d.ensure('awaiting_stack');
      return d.done('hold');
    }
    // A base we can't use is not a retarget — it's a broken chain. Retargeting
    // a PR onto its own head branch, or onto the base it already has, would
    // either 422 or loop.
    const toBase = parent.baseBranch;
    if (!toBase || toBase === d.entry.baseBranch || toBase === pr.summary.headBranch) {
      if (d.entry.blockedCode !== 'stack_retarget_failed') {
        d.transition('blocked_manual', {
          blockedCode: 'stack_retarget_failed',
          blockedReason:
            `#${parent.number} merged, but Talyn can't work out which branch this PR ` +
            'should target now. Retarget it by hand and requeue.',
          event: {
            code: 'stack_retarget_failed',
            message: `Unusable retarget target ${JSON.stringify(toBase)}.`,
          },
        });
        d.act({ kind: 'notify_blocked' });
      }
      return d.done('advance');
    }
    d.act({ kind: 'retarget_base', toBase, parentNumber: parent.number });
    return d.done('hold');
  }

  if (parent.state === 'closed') {
    // Abandoned stack. NEVER auto-retarget here: this PR's branch still
    // contains the closed parent's commits, so pointing it at the parent's
    // base would smuggle abandoned work into the base branch. `blocked`, not
    // `blocked_manual`, so reopening the parent self-heals it.
    if (d.entry.blockedCode !== 'stack_parent_abandoned') {
      d.transition('blocked', {
        blockedCode: 'stack_parent_abandoned',
        blockedReason:
          `#${parent.number} was closed without merging, and this PR is based on its ` +
          'branch. Retarget this PR, or reopen and merge that one.',
        event: {
          code: 'stack_parent_abandoned',
          message: `Stack parent #${parent.number} was closed without merging.`,
        },
      });
      d.act({ kind: 'notify_blocked' });
    }
    return d.done('advance');
  }

  // Parent still open — park. This covers the parent being blocked_manual and
  // the parent not being queued at all, and deliberately does NOT propagate
  // either downward: the parent already fires its own one-shot notification,
  // and the right shape is one loud blocked PR with N quiet parked ones. A
  // human merging the parent by hand resumes the whole stack.
  if (d.entry.status !== 'awaiting_stack' || d.entry.stackParentNumber !== parent.number) {
    d.transition('awaiting_stack', {
      set: { stackParentNumber: parent.number },
      event: {
        code: parent.entryStatus === null ? 'stack_parent_not_queued' : 'awaiting_stack',
        message:
          parent.entryStatus === null
            ? `Waiting for #${parent.number} — it is not in the merge queue, so it has to land another way.`
            : `Waiting for #${parent.number} to merge.`,
      },
    });
  }
  return d.done('advance');
}

function decideCleanButWaitingOnCi(
  d: DecisionBuilder,
  pr: PrSnapshot,
  ctx: DecisionContext,
  runActive: boolean
): Decision {
  // NOTE: no `!queueBlocked` here — pending required checks read as
  // mergeStateStatus=BLOCKED (which queueBlocked counts), and that is exactly
  // the state auto-merge exists to wait out. The caller's guard
  // (ciInFlight && !hasSettledBlocker) is the correct arm condition.
  //
  // Also no `!runActive`: an in-flight fix run must not delay the arm — cloud
  // runs routinely overrun (idle until turn-complete/auto-finalize) long
  // after their fixes are pushed, and holding 'fixing' meanwhile just wastes
  // the CI window. This mirrors the v1 rule that a clean PR direct-merges
  // even mid-run. If the run pushes again, the new head resets budgets and
  // the arm follows the PR (GitHub keeps it for write-access pushers; a
  // disarm re-arms via the snapshot event).
  // Gated base: arming auto-merge IS the submit primitive for both trunk.io and
  // GitHub's native queue, so route through submit_external — which also owns
  // the fallback when GitHub refuses to arm. No isHead / groupMergeInFlight
  // gating: the external queue does the ordering, and holding siblings behind
  // our own head would add its entire test cycle (~40min at PostHog) per PR.
  if (ctx.externalGate) {
    const signing = signingGateFor(d, pr, ctx, runActive);
    if (signing === 'clear') {
      d.act({ kind: 'submit_external' });
      return d.done('advance');
    }
    if (signing !== 'defer') return signing; // resign dispatched / blocked
    d.ensure('awaiting_ci');
    return d.done('advance');
  }

  const armable =
    ctx.isHead &&
    !ctx.groupMergeInFlight &&
    ctx.autoMergeCapability === 'available' &&
    d.entry.status !== 'automerge_armed';
  if (armable) {
    // Pre-arm signing gate: an armed PR with unsigned commits on a
    // signed-commits-required base waits on GitHub forever — arming would
    // silently wedge it. Same memo/defer discipline as the merge-path gate.
    const signing = signingGateFor(d, pr, ctx, runActive);
    if (signing === 'clear') {
      d.act({ kind: 'arm_automerge' });
      return d.done('advance');
    }
    if (signing !== 'defer') return signing; // resign dispatched / blocked
    // deferred (budget/gate) → plain wait below; arming can happen later.
  }
  d.ensure('awaiting_ci');
  return d.done('advance');
}

/**
 * The external queue handed the PR back. Returns a Decision when the entry
 * settles here (budget spent / cancelled), or null when it was requeued for
 * another attempt and evaluation should continue into the normal rules.
 *
 * `cancelled` is deliberately terminal-ish: someone (or the provider's own
 * operator flow) pulled the PR out on purpose, and immediately shoving it back
 * in would fight them. `failed` — the provider's tests went red merging this PR
 * with the base — is exactly what Talyn's fix runs exist for, so it resubmits
 * within the per-head budget.
 */
function decideExternalEjection(
  d: DecisionBuilder,
  pr: PrSnapshot,
  ext: ExternalQueueStatus,
  ctx: DecisionContext
): Decision | null {
  const provider = externalQueueProviderLabel(ext.provider);
  // Has the queue already sent this head back for this exact reason? Then
  // whatever we did last time did not work. A DIFFERENT reason is the queue
  // making progress through the PR's problems, and earns another go.
  const signature = queueSignature(ext);
  const recurred = signatureSeen(d.entry, signature);

  // The queue's own run died on INFRASTRUCTURE — it never reached a test, so
  // the failure is not about this PR at all (its checks are green on its
  // branch). Neither of the two responses below fits: the recurrence rule reads
  // a repeat as evidence the PR is at fault, and a fix run would spend a cloud
  // agent on a runner it cannot touch. The remedy for a broken runner is to go
  // round again, so that is what this does — bounded per head, because a runner
  // that is broken for good must eventually reach a human.
  if (ext.state === 'failed' && ctx.externalFailure?.kind === 'infrastructure') {
    const detail = ctx.externalFailure.detail;
    if (d.entry.submitAttempts < MAX_INFRA_SUBMITS_PER_HEAD) {
      // The signature is deliberately NOT recorded: it is not a reason this PR
      // can defeat, and recording it would make the NEXT failure — possibly a
      // real one — look like a repeat.
      d.transition('queued', {
        set: {
          externalSubmitVia: null,
          externalSubmittedAt: null,
          externalState: ext.state,
        },
        event: {
          code: 'external_queue_infra_failure',
          message:
            `${provider}'s queue run failed on CI infrastructure, not on this PR ` +
            `(${detail}) — resubmitting.`,
          detail: {
            evidence: ext.evidence,
            source: ext.source,
            attempts: d.entry.submitAttempts,
            failure: detail,
          },
        },
      });
      return null;
    }
    d.transition('blocked', {
      blockedCode: 'external_queue_rejected',
      blockedReason: externalQueueInfraReason(ext, detail, d.entry.submitAttempts),
      set: {
        externalSubmitVia: null,
        externalSubmittedAt: null,
        externalState: ext.state,
      },
      event: {
        code: 'external_queue_infra_exhausted',
        message:
          `${provider}'s queue kept dying on CI infrastructure (${detail}) across ` +
          `${d.entry.submitAttempts} submissions of this commit — stopping until the runners are fixed.`,
        detail: { evidence: ext.evidence, source: ext.source, failure: detail },
      },
    });
    d.act({ kind: 'notify_blocked' });
    return d.done('advance');
  }

  // Everything below here is a failure the queue attributes to THIS PR: the
  // infrastructure case was taken above, so a `failed` reaching this point
  // means the queue ran the tests and this commit lost.
  // A queue FAILURE is acted on the FIRST time, never resubmitted as-is.
  //
  // `failed` means the provider RAN the tests and this commit lost. Handing it
  // back unchanged asks the same question of the same code, and the answer
  // costs far more than one PR's CI: trunk batches, so a resubmit re-tests the
  // batch, bisects it to find the PR at fault again, and ejects again — with
  // every PR batched alongside it waiting through all of that. Requiring the
  // ejection to REPEAT before remediating bought one of those rounds for
  // nothing.
  //
  // A flake is the case this trades against, and it is the cheaper side: a
  // wasted cloud run is minutes, and `queueFailureRule` tells the run to report
  // that it found nothing rather than push a speculative change. The other
  // ejected states are untouched — nothing was learned about the code in a
  // "pushed to by @x" or a "waiting to become mergeable for too long", so those
  // still resubmit.
  //
  // The ordinary fix run works from the PR's own blockers, and such a PR has
  // none: its checks are green on its branch. What broke is the PR MERGED WITH
  // THE BASE, a state that exists only inside the queue, so the run is started
  // from the provider's failure output instead (fixKind 'queue_failure').
  //
  // Dispatched DIRECTLY, never by falling through to the ordinary rules, which
  // would resubmit it behind our back.
  //
  // Bounded by the same progress rule as everything else: the local blocker
  // signature this run will be judged on is recorded when it completes, so a PR
  // that keeps failing the same way stops rather than looping.
  if (
    ext.state === 'failed' &&
    !signatureSeen(d.entry, blockerSignature(pr)) &&
    ctx.cloudEnvAvailable
  ) {
    d.transition('queued', {
      set: {
        externalSubmitVia: null,
        externalSubmittedAt: null,
        externalState: ext.state,
        seenSignatures: withSignature(d.entry, signature),
      },
      event: {
        code: 'external_queue_failed_fixing',
        message:
          `${provider}'s merge queue tested this commit and failed it` +
          (ext.failedChecks?.length ? ` (${ext.failedChecks.join(', ')})` : '') +
          " — dispatching a run from the queue's failure output rather than resubmitting it.",
        detail: {
          evidence: ext.evidence,
          source: ext.source,
          state: ext.state,
          ...(ext.failedChecks?.length ? { failedChecks: ext.failedChecks } : {}),
        },
      },
    });
    d.act({ kind: 'disarm_automerge' });
    d.act({
      kind: 'fire_fix_run',
      resign: false,
      queueFailure: { provider, evidence: ext.evidence, failedChecks: ext.failedChecks },
    });
    return d.done('hold');
  }
  if (ext.state === 'cancelled' || recurred) {
  // Nothing left to dispatch: a deliberate cancellation, or a repeat the fix
  // run above has already been defeated by. Both are a human's call now.
  //
  // `cancelled` is excluded from remediation on purpose: somebody may have
  // pulled the PR out deliberately, and spending money to override that is
  // not a repair. Auto-merge is disarmed by the transition itself — a
  // half-fixed PR must not merge itself behind the queue's back.
  d.transition('blocked', {
    blockedCode: 'external_queue_rejected',
    blockedReason: externalQueueRejectedReason(ext),
    set: {
      externalSubmitVia: null,
      externalSubmittedAt: null,
      externalState: ext.state,
      ...(recurred ? {} : { seenSignatures: withSignature(d.entry, signature) }),
    },
    event: {
      code: 'external_queue_rejected',
      message:
        ext.state === 'cancelled'
          ? `${provider} cancelled this PR in its merge queue.`
          : `${provider} sent this PR back for the same reason twice and nothing here can move it — giving up until a new push.`,
      detail: { evidence: ext.evidence, source: ext.source, state: ext.state },
    },
  });
  d.act({ kind: 'notify_blocked' });
  return d.done('advance');
}

  // The per-head submit budget, which `submitAttempts` had counted since it
  // shipped without anything ever reading it — the `external_queue_rejected`
  // doc ("more times than the per-head budget allows") and the desktop's
  // "submits: n/3" both describe a cap that did not exist. The recurrence
  // guard above is reason-shaped and cannot bound a queue that ejects for a
  // DIFFERENT reason each round; this bounds the rounds themselves. Like every
  // other per-head budget it self-heals on a real push (R2), so a fresh commit
  // earns fresh submits.
  if (d.entry.submitAttempts >= ctx.maxAttempts) {
    d.transition('blocked', {
      blockedCode: 'external_queue_rejected',
      blockedReason: externalQueueBudgetSpentReason(ext, d.entry.submitAttempts),
      set: {
        externalSubmitVia: null,
        externalSubmittedAt: null,
        externalState: ext.state,
        seenSignatures: withSignature(d.entry, signature),
      },
      event: {
        code: 'external_queue_budget_spent',
        message:
          `${provider} sent this PR back ${d.entry.submitAttempts} times on this commit — ` +
          'not resubmitting it again until something changes.',
        detail: { evidence: ext.evidence, state: ext.state, attempts: d.entry.submitAttempts },
      },
    });
    d.act({ kind: 'notify_blocked' });
    return d.done('advance');
  }

  d.transition('queued', {
    set: {
      externalSubmitVia: null,
      externalSubmittedAt: null,
      externalState: ext.state,
      // Record the reason so a SECOND identical ejection is recognised as the
      // repeat it is. A different reason next time is progress and resubmits.
      seenSignatures: withSignature(d.entry, signature),
    },
    event: {
      code: 'external_queue_ejected',
      message: `${provider} ejected this PR (${externalQueueStateLabel(ext.state).toLowerCase()}) — re-evaluating before resubmitting.`,
      detail: { evidence: ext.evidence, attempts: d.entry.submitAttempts },
    },
  });
  return null;
}

/**
 * R8b's body — the visual-review gate.
 *
 * Returns a Decision when the gate owns this evaluation, or null to fall
 * through (the gate is handled and other blockers still deserve the ordinary
 * rules).
 */
function decideVisualReview(
  d: DecisionBuilder,
  vr: VisualReviewContext,
  ctx: DecisionContext
): Decision | null {
  const outcome = ctx.visualReviewOutcome;
  if (outcome) {
    if (outcome.kind === 'finalized') {
      // The baseline is committed and the gate is green. CI re-runs off the
      // new commit, so wait for it rather than racing a merge against a
      // check that has not reported yet.
      d.transition('awaiting_ci', {
        blockedCode: null,
        blockedReason: null,
        event: {
          code: 'visual_review_finalized',
          message: `Approved ${vr.changed} visual-review snapshot(s) and committed the baseline — waiting for checks.`,
          detail: { runId: vr.runId, url: vr.url },
        },
      });
      d.act({ kind: 'refresh_snapshot' });
      return d.done('advance');
    }
    if (outcome.kind === 'superseded') {
      // A newer run, or newer commits. Ordinary on an active branch — the next
      // evaluation resolves the current run and tries again. Burn nothing.
      d.ensure('queued');
      return d.done('advance');
    }
    if (outcome.kind === 'retry') {
      d.ensure('queued');
      return d.done('advance');
    }
    // Terminal for this head — a missing scope or a refused commit. Say
    // exactly what it was; this one is almost always a configuration answer.
    if (d.entry.blockedCode !== 'awaiting_human_check') {
      d.transition('blocked', {
        blockedCode: 'awaiting_human_check',
        blockedReason: `${visualReviewReason(vr)} Talyn tried to approve it and could not: ${outcome.message}`,
        event: {
          code: 'visual_review_failed',
          message: `Finalizing the visual review failed: ${outcome.message}`,
          detail: { runId: vr.runId, url: vr.url },
        },
      });
      d.act({ kind: 'notify_blocked' });
    }
    return d.done('advance');
  }

  if (vr.autoApprove) {
    d.act({ kind: 'resolve_visual_review', runId: vr.runId, url: vr.url, changed: vr.changed });
    return d.done('hold');
  }

  // Not opted in: park and name the run. Fire-once, so re-evaluating a parked
  // PR is silent. `blocked` rather than `blocked_manual` — the check going
  // green self-heals it, no requeue needed.
  if (d.entry.blockedCode !== 'awaiting_human_check') {
    d.transition('blocked', {
      blockedCode: 'awaiting_human_check',
      blockedReason: visualReviewReason(vr),
      event: {
        code: 'awaiting_visual_review',
        message: `Waiting on a human to review ${vr.changed} visual-review snapshot(s).`,
        detail: { runId: vr.runId, url: vr.url },
      },
    });
    d.act({ kind: 'notify_blocked' });
  }
  return d.done('advance');
}

function visualReviewReason(vr: VisualReviewContext): string {
  return (
    `PostHog Visual Review is holding this PR: ${vr.changed} snapshot(s) changed and need a ` +
    `person to approve them — no fix run can green that check. Review them at ${vr.url}.`
  );
}

/** Aftermath of this evaluation's own external-queue submit (ctx.submitOutcome). */
function decideSubmitAftermath(
  d: DecisionBuilder,
  pr: PrSnapshot,
  ctx: DecisionContext
): Decision {
  const outcome = ctx.submitOutcome!;
  if (outcome.kind === 'submitted') {
    const ext = externalQueueOf(pr, ctx);
    d.transition('awaiting_external', {
      set: {
        submitAttempts: d.entry.submitAttempts + 1,
        externalSubmitVia: outcome.via,
        externalSubmittedAt: ctx.nowIso,
        // Whatever the provider said BEFORE this submit is stale by definition
        // — the next observation replaces it, and until then the grace window
        // (externalSubmittedAt) is what holds the entry.
        externalState: null,
        // Record whose auto-merge arm carries the submission: the disarm
        // invariant un-submits ours when the entry later blocks, and never
        // touches one the user armed on github.com.
        ...(outcome.via === 'auto_merge' ? { automergeArmedBy: outcome.armedBy ?? 'talyn' } : {}),
      },
      event: {
        code: 'external_submitted',
        message:
          outcome.via === 'comment'
            ? `Submitted to the external merge queue by posting \`${outcome.detail ?? 'its submit command'}\`.`
            : outcome.via === 'label'
              ? 'Submitted to the external merge queue by applying its submit label.'
              : 'Submitted to the external merge queue by arming GitHub auto-merge.',
        detail: {
          via: outcome.via,
          attempt: d.entry.submitAttempts + 1,
          ...(outcome.detail ? { command: outcome.detail } : {}),
          ...(ext ? { providerState: ext.state } : {}),
        },
      },
    });
    return d.done('advance');
  }

  if (outcome.kind === 'already_submitted') {
    // Nothing was posted — the provider already had the PR. Track it there,
    // with what it just said recorded, exactly as a fresh submission would.
    d.transition('awaiting_external', {
      blockedCode: null,
      blockedReason: null,
      set: { externalState: outcome.state, externalSubmittedAt: ctx.nowIso },
      event: {
        code: 'external_already_submitted',
        message: `The external merge queue already has this PR (${outcome.evidence}) — tracking it there.`,
        detail: { state: outcome.state, evidence: outcome.evidence },
      },
    });
    return d.done('advance');
  }

  if (outcome.kind === 'try_direct_merge') {
    // The gate is only SUSPECTED (a branch-rules probe saw an `update` rule,
    // which can't tell whether Talyn's App is exempt) and GitHub says the PR is
    // immediately mergeable. One real merge settles it: it either lands, or the
    // 405 confirms the gate and the aftermath submits instead.
    d.act({ kind: 'verify_live_then_merge' });
    return d.done('hold');
  }

  if (outcome.kind === 'retry') {
    d.ensure('queued');
    return d.done('advance');
  }

  // No mechanism can submit this PR — the one case that still needs a human.
  d.transition('blocked_manual', {
    blockedCode: 'external_gate',
    blockedReason: EXTERNAL_GATE_BLOCK_REASON,
    set: { lastError: outcome.message, lastErrorAt: ctx.nowIso },
    event: {
      code: 'external_gate',
      message: 'Blocked by an external merge queue with no way to submit automatically.',
    },
  });
  d.act({ kind: 'notify_blocked' });
  return d.done('advance');
}

/**
 * Gates on the `blocked` status. Returns the Decision when the entry stays
 * gated, or null when the gate self-healed and evaluation should continue.
 */
function decideBlockedGate(
  d: DecisionBuilder,
  pr: PrSnapshot,
  ctx: DecisionContext
): Decision | null {
  const code = d.entry.blockedCode;

  if (code === 'unsigned_commits') {
    // Re-sign budget spent. Only a new head (R2) or requeue re-arms it — don't
    // re-poll signatures or re-attempt the doomed merge on every evaluation.
    return d.done('advance');
  }

  if (code === 'external_queue_rejected') {
    // The external queue kept rejecting this commit (or a human cancelled it).
    // A clean-looking snapshot means nothing here — the PR's OWN checks are
    // green; it's the merge WITH the base that fails — so never fall through to
    // a resubmit. Only a new head (R2) or a requeue re-arms it.
    return d.done('advance');
  }

  if (code === 'app_refused_checks') {
    if (checksFailing(pr.summary)) {
      // Proactively re-run the failing checks from the blocked state too — a
      // row blocked before the rerun budget existed (or before the App had
      // checks:write) would otherwise sit waiting for a human even though the
      // queue could get itself to green.
      if (d.entry.rerunAttempts < ctx.maxAttempts) {
        if (ctx.rerunOutcome === undefined) {
          d.act({ kind: 'rerequest_failed_checks' });
          return d.done('advance');
        }
        return applyRerunOutcome(d, ctx, 'advance');
      }
      return d.done('advance');
    }
    // The failing check GitHub refused us over has gone green (a rerun
    // passed, or a new head reset it) — the refusal condition is gone. Clear
    // the gate and the rerun budget (a fresh failure gets its own retries)
    // and fall through to a fresh merge attempt.
    d.transition('queued', {
      set: { rerunAttempts: 0 },
      event: {
        code: 'app_refusal_cleared',
        message: 'The failing check went green — retrying the merge.',
      },
    });
    return null;
  }

  if (code === 'no_progress' || code === 'attempts_exhausted') {
    // Remediation stopped moving the problem ('attempts_exhausted' is the same
    // state on entries blocked before the progress rule shipped) — wait for a
    // human or a new push. We do NOT auto-reset on a momentary clean reading
    // (the transient-UNKNOWN trap): a genuinely-clean blocked PR falls through
    // to the merge path below and leaves the queue; a still-blocked one waits
    // here.
    if (queueBlockedFor(pr, ctx)) return d.done('advance');
    return null; // clean → let it merge
  }

  // Unknown/legacy code with a live blocker — treat like attempts_exhausted.
  if (queueBlockedFor(pr, ctx)) return d.done('advance');
  return null;
}

/** Shared rerun-outcome accounting for both the blocked gate and the refusal path. */
function applyRerunOutcome(
  d: DecisionBuilder,
  ctx: DecisionContext,
  verdict: 'hold' | 'advance'
): Decision {
  const outcome = ctx.rerunOutcome;
  if (!outcome || 'errored' in outcome) {
    // The call itself threw — permission errors are typically static per head,
    // but a transient failure must not spend the budget.
    return d.done(verdict);
  }
  if (outcome.requested > 0) {
    const attempts = d.entry.rerunAttempts + 1;
    d.transition('awaiting_ci', {
      set: {
        rerunAttempts: attempts,
        lastError: `re-ran ${outcome.requested} failing check(s) (attempt ${attempts}/${ctx.maxAttempts})`,
        lastErrorAt: ctx.nowIso,
      },
      event: {
        code: 'rerun_fired',
        message: `Re-ran ${outcome.requested} failing check(s) — attempt ${attempts}/${ctx.maxAttempts}.`,
      },
    });
    // Re-running a check is background work — never gate the ready PRs
    // behind this head on it.
    d.act({ kind: 'refresh_snapshot' });
    return d.done('advance');
  }
  if (outcome.reason && outcome.reason !== 'no-failing-check-runs') {
    // Nothing could be re-run and nothing will change on a re-evaluation
    // (permission / check ownership are static for this head) — spend the
    // budget so we don't hammer GitHub, and put the precise cause on the badge.
    d.transition('blocked', {
      blockedCode: 'app_refused_checks',
      blockedReason: buildFailingChecksBlockReason(outcome.reason, ctx.maxAttempts, ctx.maxAttempts),
      set: { rerunAttempts: ctx.maxAttempts },
      event: {
        code: 'rerun_impossible',
        message: `Failing check can't be re-run by Talyn (${outcome.reason}).`,
      },
    });
  }
  return d.done(verdict);
}

type SigningGateResult = 'clear' | 'defer' | Decision;

/**
 * Signing gate for the merge/arm paths. On a base branch that REQUIRES signed
 * commits, GitHub refuses the App's merge while any commit is unsigned — so
 * detect it up front and re-sign via the fix task rather than attempting the
 * doomed merge (or arming an auto-merge that would wait forever).
 *
 * The probe result is memoized per head on the entry (a commit's signature
 * can't change without the sha changing), so it runs AT MOST once per
 * (entry, head) — v1 probed on every tick and drained the GraphQL budget.
 *
 * Returns 'clear' (safe to merge/arm), 'defer' (budget/gate — try later), or
 * a full Decision when it took over (re-sign dispatched or blocked).
 */
function signingGateFor(
  d: DecisionBuilder,
  pr: PrSnapshot,
  ctx: DecisionContext,
  runActive: boolean
): SigningGateResult {
  if (ctx.signingRequired === false) return 'clear';
  if (ctx.signingRequired === null) return 'clear'; // probe failed — the 403 net catches
  // NOTE: no runActive hold on the PROBE — it's memoized per (entry, head),
  // so probing during a run costs at most one GraphQL call per push, and
  // holding here kept signing repos from arming until an overrunning run
  // finalized. dispatchResign still guards runActive (never pile a second
  // run on an active one).
  const memoValid = d.entry.signingCheckedSha === pr.headSha && d.entry.unsignedCount !== null;
  const unsigned = memoValid ? d.entry.unsignedCount! : ctx.unsignedCount;
  if (unsigned === undefined) {
    // Need the signature fetch (GraphQL). If GraphQL is in a backoff it would
    // sleep behind waitIfBlocked, and if the point budget is in the reserve we
    // must not spend it here — defer to a later evaluation.
    if (ctx.graphqlGateBlocked || ctx.graphqlBudgetLow) return 'defer';
    d.act({ kind: 'probe_signatures' });
    return d.done('advance');
  }
  if (unsigned === 0) return 'clear';
  return dispatchResign(d, ctx, runActive);
}

/**
 * Fire a bounded re-sign fix run, or block once the budget is spent. Advances
 * the group so ready PRs behind the head keep draining while it re-signs.
 */
function dispatchResign(d: DecisionBuilder, ctx: DecisionContext, runActive: boolean): Decision {
  if (runActive) {
    d.ensure('fixing');
    return d.done('advance');
  }
  if (d.entry.resignAttempts < ctx.maxAttempts) {
    d.act({ kind: 'fire_fix_run', resign: true });
    return d.done('advance');
  }
  d.transition('blocked', {
    blockedCode: 'unsigned_commits',
    blockedReason: unsignedCommitsBlockReason(ctx.maxAttempts),
    set: {
      lastError: 'unsigned commits on a signed-commits-required branch',
      lastErrorAt: ctx.nowIso,
    },
    event: {
      code: 'resign_budget_spent',
      message: 'Re-sign budget spent — commits still unsigned.',
    },
  });
  d.act({ kind: 'notify_blocked' });
  return d.done('advance');
}

/** Clean path — mergeable AND up-to-date. Merge it (or defer safely). */
function decideCleanPath(
  d: DecisionBuilder,
  pr: PrSnapshot,
  ctx: DecisionContext,
  runActive: boolean
): Decision {
  // One merge in flight per (repo, base): if a sibling is merging or armed,
  // wait our turn — merging past an armed head would invalidate its CI. Not
  // when an external queue owns the base: it serializes (and batches) the
  // merges itself, so making PRs queue twice is pure latency.
  if (ctx.groupMergeInFlight && !ctx.externalGate) {
    d.ensure('queued');
    return d.done('hold');
  }
  // The merge PUT is REST; while REST is in a rate-limit backoff every call
  // would sleep behind waitIfBlocked — defer to a later evaluation.
  if (ctx.restGateBlocked) {
    d.ensure('queued');
    return d.done('hold');
  }
  const signing = signingGateFor(d, pr, ctx, runActive);
  if (signing !== 'clear' && signing !== 'defer') return signing;
  if (signing === 'defer') {
    d.ensure('queued');
    return d.done('advance');
  }
  // Gated base — the direct merge is doomed (confirmed) or unproven
  // (suspected). Hand the PR to the system that owns the branch instead; the
  // submit action falls back to the direct merge when the gate is only
  // suspected and GitHub says the PR could merge right now.
  if (ctx.externalGate) {
    d.act({ kind: 'submit_external' });
    return d.done('hold');
  }
  // The executor re-reads the entry + PR row live inside the group lock,
  // persists `merging` + merge_started_at, then attempts the REST merge —
  // never merging off a stale snapshot (a force-released wedged evaluation
  // can resume minutes later, after the PR merged or the user dequeued it).
  d.act({ kind: 'verify_live_then_merge' });
  return d.done('hold');
}

/** Aftermath of this evaluation's own merge attempt (ctx.mergeOutcome set). */
function decideMergeAftermath(d: DecisionBuilder, pr: PrSnapshot, ctx: DecisionContext): Decision {
  const outcome = ctx.mergeOutcome!;
  if (outcome.kind === 'merged') {
    d.act({ kind: 'record_merged' });
    return d.done('hold');
  }

  // Every failure shape first disambiguates "already merged": a lost response
  // on a merge that landed, a redeploy mid-merge, or an external merge —
  // GitHub 405s all of them, and re-attempting is doomed while the row never
  // leaves the head slot.
  if (ctx.verifiedMerged === undefined) {
    d.act({ kind: 'verify_merged' });
    return d.done('hold');
  }
  if (ctx.verifiedMerged) {
    d.act({ kind: 'record_merged' });
    return d.done('hold');
  }

  // An App-refused merge on a base we already suspect is gated IS the gate.
  // posthog/posthog answers Talyn's merge with a 403 refusing every App token
  // (its ruleset exempts only trunk's App) rather than the 405 "protected ref"
  // below — so without this, the refusal ladder (re-run checks → blocked_manual
  // app_refused_hard) swallowed a PR that just needed submitting.
  if (outcome.kind === 'refused_app' && ctx.externalGate !== null) {
    d.act({ kind: 'mark_external_gate' });
    d.transition('queued', {
      set: { lastError: outcome.message, lastErrorAt: ctx.nowIso },
      event: {
        code: 'external_merge_gate',
        message:
          'GitHub refused the App merge on a branch governed by an external merge queue — submitting the PR to it instead.',
      },
    });
    d.act({ kind: 'submit_external' });
    return d.done('hold');
  }

  if (outcome.kind === 'refused_app') {
    return decideAppRefusal(d, pr, ctx, outcome.message);
  }

  // External merge gate (trunk.io, GitHub's native queue, a restrictive
  // ruleset): GitHub 405s with "Cannot update this protected ref". Retrying or
  // firing a fix run can NEVER satisfy it — but SUBMITTING the PR to that
  // system can. Record the gate (sticky, so no later evaluation wastes another
  // doomed merge call), requeue, and submit in this same evaluation.
  if (isExternalMergeGateError(outcome.message)) {
    d.act({ kind: 'mark_external_gate' });
    d.transition('queued', {
      set: {
        lastError: outcome.message || 'Cannot update this protected ref',
        lastErrorAt: ctx.nowIso,
      },
      event: {
        code: 'external_merge_gate',
        message:
          'This branch is governed by an external merge queue — submitting the PR to it instead of merging.',
      },
    });
    d.act({ kind: 'submit_external' });
    return d.done('hold');
  }

  // not_merged (bounced: lost a race, now behind) or a real rejection (405
  // conflicts) — the cached mergeability was stale. Record the error, refetch
  // immediately so the real CONFLICTING/BEHIND state hits the cache + UI now,
  // and let the next evaluation funnel it into the fix path. Don't dequeue.
  d.transition('queued', {
    set: { lastError: outcome.message || 'GitHub did not merge the pull request', lastErrorAt: ctx.nowIso },
    event: {
      code: outcome.kind === 'not_merged' ? 'merge_bounced' : 'merge_failed',
      message: outcome.message || 'GitHub did not merge the pull request.',
    },
  });
  d.act({ kind: 'refresh_snapshot' });
  return d.done('hold');
}

/**
 * GitHub refused the App's tokens (installation AND user-to-server — both
 * count as the integration). Ladder: unsigned commits → re-sign;
 * failing checks → bounded re-run; otherwise block for a human.
 */
function decideAppRefusal(
  d: DecisionBuilder,
  pr: PrSnapshot,
  ctx: DecisionContext,
  message: string
): Decision {
  // Safety net for the signing case the proactive gate missed (a ruleset
  // probe the App couldn't read, or a race). If we can SEE unsigned commits,
  // the refusal is (at least partly) unsigned commits — re-sign, and record
  // the requirement so every future PR on this branch is handled proactively
  // (learn-from-403). Skip the lookup while GraphQL is gated — a later
  // evaluation re-derives it.
  if (!ctx.graphqlGateBlocked && ctx.unsignedCount === undefined) {
    d.act({ kind: 'probe_signatures' });
    return d.done('hold');
  }
  if ((ctx.unsignedCount ?? 0) > 0) {
    d.act({ kind: 'mark_signing_required' });
    const runActive = ctx.fixTaskState === 'active' || ctx.otherLinkedTaskActive;
    return dispatchResign(d, ctx, runActive);
  }

  const failing = checksFailing(pr.summary);
  if (failing && d.entry.rerunAttempts < ctx.maxAttempts) {
    if (ctx.rerunOutcome === undefined) {
      d.act({ kind: 'rerequest_failed_checks' });
      return d.done('hold');
    }
    const outcome = ctx.rerunOutcome;
    if (!('errored' in outcome) && outcome.requested > 0) {
      const attempts = d.entry.rerunAttempts + 1;
      d.transition('awaiting_ci', {
        set: {
          rerunAttempts: attempts,
          lastError:
            `GitHub refused the App merge over failing check(s); re-ran ` +
            `${outcome.requested} of them (attempt ${attempts}/${ctx.maxAttempts})`,
          lastErrorAt: ctx.nowIso,
        },
        event: {
          code: 'rerun_fired',
          message: `App merge refused; re-ran ${outcome.requested} failing check(s) — attempt ${attempts}/${ctx.maxAttempts}.`,
        },
      });
      // A rerun is background work — advance so ready PRs behind this head
      // keep draining (the CI guard holds it while the rerun reports).
      d.act({ kind: 'refresh_snapshot' });
      return d.done('advance');
    }
  }

  // Block and move on. The App can't merge THIS PR: a red check it won't
  // merge past, or a ruleset that excludes the App. A cloud fix run can't
  // grant merge permission — dispatching one here left v1 churning in
  // 'fixing' and gating the whole group. The app_refused_checks gate
  // self-heals the moment the checks go green; app_refused_hard waits for a
  // human (merge manually or requeue).
  const rerunReason =
    ctx.rerunOutcome && !('errored' in ctx.rerunOutcome) ? ctx.rerunOutcome.reason : undefined;
  const failedTerminally = failing && rerunReason && rerunReason !== 'no-failing-check-runs';
  const rerunAttempts = failedTerminally ? ctx.maxAttempts : d.entry.rerunAttempts;
  if (failing) {
    d.transition('blocked', {
      blockedCode: 'app_refused_checks',
      blockedReason: buildFailingChecksBlockReason(rerunReason, rerunAttempts, ctx.maxAttempts),
      set: { rerunAttempts, lastError: message, lastErrorAt: ctx.nowIso },
      event: {
        code: 'app_refused_checks',
        message: 'GitHub refused the App merge over failing check(s).',
      },
    });
  } else {
    d.transition('blocked_manual', {
      blockedCode: 'app_refused_hard',
      blockedReason: `${message} Merge manually on GitHub, or re-queue the PR to retry.`,
      set: { lastError: message, lastErrorAt: ctx.nowIso },
      event: {
        code: 'app_refused_hard',
        message: 'GitHub refused the App merge with no failing check to blame.',
      },
    });
  }
  d.act({ kind: 'notify_blocked' });
  return d.done('advance');
}

// ── Builder ──

/**
 * Accumulates actions while tracking the entry's would-be state, so later
 * rules see earlier rules' transitions (mirroring v1's in-place mutation of
 * the state blob) without decide ever touching the real row.
 */
class DecisionBuilder {
  readonly entry: EntrySnapshot;
  private readonly actions: Action[] = [];

  constructor(entry: EntrySnapshot) {
    this.entry = { ...entry };
  }

  act(action: Action): void {
    this.actions.push(action);
  }

  transition(
    to: EntryStatus,
    opts: {
      blockedCode?: BlockedCode | null;
      blockedReason?: string | null;
      set?: Extract<Action, { kind: 'transition' }>['set'];
      event: EventDraft;
    }
  ): void {
    // Invariant: a blocked entry must never keep a Talyn-armed auto-merge
    // live on GitHub — GitHub would merge it out of FIFO order the moment its
    // checks pass, behind the queue's back. Disarm BEFORE the transition.
    // (User-armed auto-merges are never ours to disarm.)
    // `awaiting_stack` needs the same treatment for the same reason, and it is
    // the one that actually bites: a parked child holding a Talyn arm gets
    // merged by GitHub INTO ITS PARENT'S BRANCH the instant its checks pass,
    // which is precisely what the merge stack exists to prevent.
    if (
      (to === 'blocked' || to === 'blocked_manual' || to === 'awaiting_stack') &&
      this.entry.automergeArmedBy === 'talyn'
    ) {
      this.actions.push({ kind: 'disarm_automerge' });
      this.entry.automergeArmedBy = null;
    }
    const blockedCode =
      to === 'blocked' || to === 'blocked_manual' ? (opts.blockedCode ?? null) : null;
    const blockedReason =
      to === 'blocked' || to === 'blocked_manual' ? (opts.blockedReason ?? null) : null;
    this.actions.push({
      kind: 'transition',
      to,
      blockedCode,
      blockedReason,
      ...(opts.set ? { set: opts.set } : {}),
      event: opts.event,
    });
    this.entry.status = to;
    this.entry.blockedCode = blockedCode;
    this.entry.blockedReason = blockedReason;
    if (opts.set) {
      if (opts.set.fixAttempts !== undefined) this.entry.fixAttempts = opts.set.fixAttempts;
      if (opts.set.rerunAttempts !== undefined) this.entry.rerunAttempts = opts.set.rerunAttempts;
      if (opts.set.resignAttempts !== undefined) this.entry.resignAttempts = opts.set.resignAttempts;
      if (opts.set.submitAttempts !== undefined) this.entry.submitAttempts = opts.set.submitAttempts;
      if (opts.set.externalSubmitVia !== undefined) {
        this.entry.externalSubmitVia = opts.set.externalSubmitVia;
      }
      if (opts.set.externalSubmittedAt !== undefined) {
        this.entry.externalSubmittedAt = opts.set.externalSubmittedAt;
      }
      if (opts.set.externalState !== undefined) {
        this.entry.externalState = opts.set.externalState;
      }
      if (opts.set.automergeArmedBy !== undefined) {
        this.entry.automergeArmedBy = opts.set.automergeArmedBy;
      }
      if (opts.set.fixTaskAccounted !== undefined) {
        this.entry.fixTaskAccounted = opts.set.fixTaskAccounted;
      }
      if (opts.set.signingCheckedSha !== undefined) {
        this.entry.signingCheckedSha = opts.set.signingCheckedSha;
      }
      if (opts.set.unsignedCount !== undefined) this.entry.unsignedCount = opts.set.unsignedCount;
      if (opts.set.stackParentNumber !== undefined) {
        this.entry.stackParentNumber = opts.set.stackParentNumber;
      }
      if (opts.set.retargetAttempts !== undefined) {
        this.entry.retargetAttempts = opts.set.retargetAttempts;
      }
    }
  }

  /**
   * Record where the external queue says the PR is, when that has MOVED. One
   * small write per provider transition (queued → testing → passed …), which
   * is what makes the desktop badge and the entry timeline show the provider's
   * real progress instead of a flat "submitted to queue".
   *
   * Never writes a null over a known state: "we didn't observe anything this
   * evaluation" is not the same as "the provider dropped the PR", and the
   * submission's own bookkeeping (externalSubmitVia/At) covers that case.
   */
  observeExternalState(ext: ExternalQueueStatus | null): void {
    if (!ext || ext.state === this.entry.externalState) return;
    this.transition(this.entry.status, {
      blockedCode: this.entry.blockedCode,
      blockedReason: this.entry.blockedReason,
      set: { externalState: ext.state },
      event: {
        code: 'external_state',
        message:
          `${externalQueueProviderLabel(ext.provider)}: ` +
          `${externalQueueStateLabel(ext.state).toLowerCase()} (${ext.evidence}).`,
        detail: { state: ext.state, source: ext.source },
      },
    });
  }

  /** Persist `status` only if it differs (v1's ensureStatus). */
  ensure(status: EntryStatus): void {
    if (this.entry.status === status) return;
    this.transition(status, {
      event: { code: 'status', message: `Status → ${status}.` },
    });
  }

  resetBudgets(newHeadSha: string): void {
    this.actions.push({
      kind: 'reset_budgets',
      newHeadSha,
      event: {
        code: 'new_head_reset',
        message: 'New head commit — progress history and re-run/re-sign budgets reset.',
        detail: { headSha: newHeadSha },
      },
    });
    this.entry.headSha = newHeadSha;
    this.entry.fixAttempts = 0;
    this.entry.rerunAttempts = 0;
    this.entry.resignAttempts = 0;
    this.entry.submitAttempts = 0;
    // New code, new problems: what defeated a run on the old head says nothing
    // about this one. This is what makes 'no_progress' self-heal on a push.
    this.entry.seenSignatures = [];
    this.entry.signingCheckedSha = null;
    this.entry.unsignedCount = null;
    // New code invalidates any external-queue submission: the provider tests
    // the commit it accepted, and it no longer exists as the head. Its last
    // reported state goes with it — it described the old commit.
    this.entry.externalSubmitVia = null;
    this.entry.externalState = null;
    if (this.entry.status === 'blocked' || this.entry.status === 'awaiting_external') {
      this.entry.status = 'queued';
      this.entry.blockedCode = null;
      this.entry.blockedReason = null;
    }
  }

  /** Advance the head pointer WITHOUT resetting budgets — the new head came
   *  from our own in-flight fix run, not an external push (see R2). */
  adoptHead(newHeadSha: string): void {
    this.actions.push({
      kind: 'adopt_head',
      newHeadSha,
      event: {
        code: 'head_advanced_by_fix',
        message: "New head from the queue's in-flight fix run — advancing without resetting budgets.",
        detail: { headSha: newHeadSha },
      },
    });
    this.entry.headSha = newHeadSha;
  }

  done(verdict: 'hold' | 'advance'): Decision {
    return { actions: this.actions, verdict };
  }
}
