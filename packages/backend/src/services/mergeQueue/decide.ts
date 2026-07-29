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
  externalQueueStateLabel,
  externalQueueStatusFromLabels,
  isExternalQueueSubmitLabel,
  isExternalQueueEjected,
  isExternalQueueHolding,
  type ExternalQueueStatus,
  type PRMergeableSummary,
} from '@talyn/shared';
import type {
  Action,
  BlockedCode,
  Decision,
  DecisionContext,
  EntrySnapshot,
  EntryStatus,
  EventDraft,
  PrSnapshot,
} from './types.js';

export const DRAFT_BLOCK_REASON =
  'This PR is a draft — mark it ready for review and the merge queue will merge it automatically.';

export const EXTERNAL_GATE_BLOCK_REASON =
  'This branch is governed by an external merge queue or protected-ref rule Talyn ' +
  "can't bypass (GitHub's native merge queue, trunk.io, or a restrictive ruleset), " +
  'and there is no way to submit the PR to it automatically: the repo refuses ' +
  'GitHub auto-merge and defines no submit label. Merge it through that system, ' +
  'or remove it from the queue.';

export function externalQueueRejectedReason(
  status: ExternalQueueStatus,
  maxAttempts: number
): string {
  const provider = externalQueueProviderLabel(status.provider);
  if (status.state === 'cancelled') {
    return (
      `${provider}'s merge queue cancelled this PR (${status.evidence}). Talyn won't ` +
      `resubmit a cancelled PR automatically — push a fix, or re-queue the PR to submit it again.`
    );
  }
  return (
    `${provider}'s merge queue rejected this PR ${maxAttempts}× on this commit ` +
    `(${status.evidence}) — its tests fail when the PR is merged with the base. ` +
    `Push a fix (the queue resubmits automatically on a new commit), or re-queue to retry now.`
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
 * is ready and belongs in the external queue. Everything else still counts —
 * conflicts, requested changes, failing REQUIRED checks (`prNeedsFollowup`) and
 * BEHIND are real work no matter who performs the merge. Pending CI and a
 * missing required review are handled upstream (R7/R7b) and never reach here.
 */
function queueBlockedFor(pr: PrSnapshot, ctx: DecisionContext): boolean {
  if (prNeedsFollowup(pr.summary)) return true;
  if (mergeStateOf(pr) === 'BEHIND') return true;
  return mergeStateOf(pr) === 'BLOCKED' && ctx.externalGate === null;
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
 */
export function hasSettledBlocker(pr: PrSnapshot): boolean {
  return prNeedsFollowup(pr.summary) || mergeStateOf(pr) === 'BEHIND';
}

/**
 * The only obstacle is a missing required review: GitHub reports BLOCKED, no
 * settled blocker, no CI in flight, reviewDecision REVIEW_REQUIRED. No
 * remediation applies — an agent can't approve a PR — so the queue waits.
 * (v1 fired doomed fix runs at this state and blocked after 3 attempts.)
 */
export function awaitingRequiredReview(pr: PrSnapshot): boolean {
  return (
    mergeStateOf(pr) === 'BLOCKED' &&
    !hasSettledBlocker(pr) &&
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
    } else if (!hasSettledBlocker(pr)) {
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
      const verdict = decideExternalEjection(d, ext, ctx);
      if (verdict) return verdict;
      // null → requeued for a resubmit; fall through to the normal rules so a
      // PR that came back broken gets remediated before it goes round again.
    } else if (staleEjection || stillSubmitted(d.entry, pr, ctx)) {
      // In the queue's hands. A settled blocker still deserves remediation —
      // the provider will hold a conflicting PR at "not ready" forever — so
      // only an unobstructed PR short-circuits here.
      if (!hasSettledBlocker(pr)) return d.done('advance');
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
  }

  // R6 — active-run guard. Never fire a NEW run while one is already working
  // this PR: the queue's own fix run (fixTaskId) OR any other run linked via
  // pull_requests.taskId (a manual task, the keep-mergeable watcher) — which
  // v1 checked separately because taskId gets reassigned by other flows.
  const runActive = ctx.fixTaskState === 'active' || ctx.otherLinkedTaskActive;
  if (runActive && queueBlockedFor(pr, ctx) && hasSettledBlocker(pr)) {
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
  if (ciInFlight(pr) && !hasSettledBlocker(pr)) {
    return decideCleanButWaitingOnCi(d, pr, ctx, runActive);
  }

  // R7b — only a required review is missing. An agent can't approve a PR, so
  // no remediation applies; wait and self-heal on the review webhook. (v1
  // funneled this into fix runs via the bare-BLOCKED branch of needsUpdate.)
  if (awaitingRequiredReview(pr)) {
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
    let to: EntryStatus = d.entry.status;
    let attempts = d.entry.fixAttempts;
    if (queueBlockedFor(pr, ctx)) {
      attempts += 1;
      if (attempts >= ctx.maxAttempts) to = 'blocked';
    }
    const justBlocked = !wasBlocked && to === 'blocked';
    d.transition(to, {
      blockedCode: justBlocked ? 'attempts_exhausted' : d.entry.blockedCode,
      blockedReason: justBlocked ? blockerReason(pr) : d.entry.blockedReason,
      set: { fixAttempts: attempts, fixTaskAccounted: true },
      event: {
        code: 'fix_run_accounted',
        message: queueBlockedFor(pr, ctx)
          ? `Fix run finished but the PR is still blocked (attempt ${attempts}/${ctx.maxAttempts}).`
          : 'Fix run finished; PR reads clean.',
        detail: { taskId: d.entry.fixTaskId },
      },
    });
    // Fire-once notification: the queue exhausted its retries and needs a
    // human (or a new push — R2 re-arms it).
    if (justBlocked) d.act({ kind: 'notify_blocked' });
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
  // unresolved threads / BEHIND. Hard cap first — the absolute guard against
  // firing past the retry budget, even if a transient clean reading + failed
  // merge flapped the status back to queued. fixAttempts only ever increments
  // in R8 (which already notified at the cap), so re-settle the badge silently
  // and hand the turn to the next queued PR.
  if (d.entry.fixAttempts >= ctx.maxAttempts) {
    if (d.entry.status !== 'blocked') {
      d.transition('blocked', {
        blockedCode: 'attempts_exhausted',
        blockedReason: d.entry.blockedReason ?? blockerReason(pr),
        event: {
          code: 'attempts_exhausted',
          message: 'Fix-run budget spent on this head — waiting for a new push or requeue.',
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
  ext: ExternalQueueStatus,
  ctx: DecisionContext
): Decision | null {
  const provider = externalQueueProviderLabel(ext.provider);
  if (ext.state === 'cancelled' || d.entry.submitAttempts >= ctx.maxAttempts) {
    d.transition('blocked', {
      blockedCode: 'external_queue_rejected',
      blockedReason: externalQueueRejectedReason(ext, ctx.maxAttempts),
      set: { externalSubmitVia: null, externalSubmittedAt: null, externalState: ext.state },
      event: {
        code: 'external_queue_rejected',
        message:
          ext.state === 'cancelled'
            ? `${provider} cancelled this PR in its merge queue.`
            : `${provider} rejected this PR ${d.entry.submitAttempts}× on this commit — giving up until a new push.`,
        detail: { evidence: ext.evidence, source: ext.source, state: ext.state },
      },
    });
    d.act({ kind: 'notify_blocked' });
    return d.done('advance');
  }
  d.transition('queued', {
    set: { externalSubmitVia: null, externalSubmittedAt: null, externalState: ext.state },
    event: {
      code: 'external_queue_ejected',
      message: `${provider} ejected this PR (${externalQueueStateLabel(ext.state).toLowerCase()}) — re-evaluating before resubmitting.`,
      detail: { evidence: ext.evidence, attempts: d.entry.submitAttempts },
    },
  });
  return null;
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

  if (code === 'attempts_exhausted') {
    // Gave up after MAX_ATTEMPTS — wait for a human or a new push. We do NOT
    // auto-reset on a momentary clean reading (the transient-UNKNOWN trap): a
    // genuinely-clean blocked PR falls through to the merge path below and
    // leaves the queue; a still-blocked one waits here.
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
    if (
      (to === 'blocked' || to === 'blocked_manual') &&
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
        message: 'New head commit — fix/re-run/re-sign budgets reset.',
        detail: { headSha: newHeadSha },
      },
    });
    this.entry.headSha = newHeadSha;
    this.entry.fixAttempts = 0;
    this.entry.rerunAttempts = 0;
    this.entry.resignAttempts = 0;
    this.entry.submitAttempts = 0;
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
