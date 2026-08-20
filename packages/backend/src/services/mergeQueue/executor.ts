// Merge queue v2 — the action executor.
//
// Runs the decide → execute rounds for ONE entry. `decide` (pure) names the
// actions; this module performs them: CAS transitions with audit events,
// GitHub calls (merge / verify / re-run / signature probe), cloud fix-run
// dispatch, WS mirroring. Outcome-producing actions feed their result back
// into the context and re-invoke `decide`, bounded by MAX_DECIDE_ROUNDS.
//
// Concurrency contract: every persisted change is a CAS on entry.version. A
// lost CAS means another evaluation (other replica, newer trigger) got there
// first — this one drops its remaining actions and walks away. Nothing here
// may write state unconditionally except record_merged (GitHub having merged
// is ground truth that must never be lost to a version race).

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  buildMergeablePrompt,
  prNeedsFollowup,
  type PRMergeableSummary,
  type VisualReviewSettings,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  mergeQueueEntries,
  mergeQueueEvents,
  pullRequests as pullRequestsTable,
  tasks as tasksTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { githubService, MergeNotPermittedForAppError } from '../github.js';
import { fetchUnsignedCommitCount } from '../githubGraphql.js';
import { githubRateGate } from '../githubRateGate.js';
import { graphqlBudget } from '../graphqlBudget.js';
import { requiresSignedCommits, markSigningRequired } from '../repoSigning.js';
import {
  clearExternalMergeGate,
  getExternalMergeGate,
  getExternalQueueSubmitLabel,
  markExternalMergeGate,
} from '../repoMergeGate.js';
import { rememberedExternalQueueSubmitRoute } from '../externalQueueSubmitRoute.js';
import { submitToExternalQueue } from '../externalQueueSubmit.js';
import { readExternalQueueState } from '../externalQueueState.js';
import { noteInfraFailure, noteMerge, queueHealth } from '../repoQueueHealth.js';
import { classifyExternalQueueFailure } from '../externalQueueFailure.js';
import {
  finalizeRun as finalizeVisualReviewRun,
  gatingRunForPr as gatingVisualReviewRun,
} from '../visualReview.js';
import { prMonitorService } from '../prMonitor.js';
import { createCloudTask } from '../taskCreate.js';
import { TaskLimitError } from '../billing/entitlements.js';
import { ACTIVE_STATUSES, linkedTaskStatus, resolveCloudEnv } from '../prCloudFix.js';
import { workspacePromptTemplate } from '../promptTemplates.js';
import { emitPullRequestUpdated, emitMergeQueueBlocked } from '../websocket.js';
import { broadcastMergeQueuePositions, QUEUE_RESET_COLUMNS } from '../mergeQueueBroadcast.js';
import {
  classifyAutoMergeActor,
  disableAutoMerge,
  enableAutoMerge,
  getAutoMergeCapability,
} from '../githubAutoMerge.js';
import { debugBus } from '../debugBus.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { decide } from './decide.js';
import { toLegacyPublicState, toLegacyStateBlob, toPublicMergeQueue } from './legacy.js';
import {
  casTransition,
  rowToEntrySnapshot,
  type CasPatch,
  type EntryRow,
} from './store.js';
import type { StackParent } from './stack.js';
import {
  MAX_ATTEMPTS,
  MAX_DECIDE_ROUNDS,
  type Action,
  type DecisionContext,
  type EntrySnapshot,
  type FixKind,
  type MergeOutcome,
  type PrSnapshot,
  type RerunOutcome,
  type SubmitOutcome,
  type VisualReviewContext,
} from './types.js';

// Only the pull_requests columns an evaluation touches (egress rules — never
// the cursor columns, never autoMergeState).
export const PR_EVAL_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  repositoryId: pullRequestsTable.repositoryId,
  taskId: pullRequestsTable.taskId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  mergeQueued: pullRequestsTable.mergeQueued,
  lastSummary: pullRequestsTable.lastSummary,
} as const;

export type PrEvalRow = Pick<typeof pullRequestsTable.$inferSelect, keyof typeof PR_EVAL_COLUMNS>;

export interface EvaluateEntryInput {
  entry: EntryRow;
  pr: PrEvalRow;
  position: number;
  isHead: boolean;
  groupMergeInFlight: boolean;
  trigger: string;
  /** Resolved once per group walk — see resolveStackParents. */
  stackParent?: StackParent | null;
}

export interface EvaluateEntryResult {
  verdict: 'hold' | 'advance';
  /** Another writer won a CAS race — the group should re-schedule. */
  casLost?: boolean;
  /** The entry as this evaluation left it — the walk uses it to keep its
   *  merge-in-flight view current (an arm mid-walk must gate the siblings). */
  finalEntry?: EntrySnapshot;
  /**
   * The entry left this group for another base branch. The walk must schedule
   * an evaluation of `(repositoryId, movedToBase)` — nothing else will, because
   * every trigger for this entry keys on the base it just left.
   */
  movedToBase?: string;
}

export function buildPrSnapshot(pr: PrEvalRow): PrSnapshot {
  const summary = (pr.lastSummary ?? {}) as PRMergeableSummary & {
    headSha?: string;
    mergeStateStatus?: string;
    autoMergeBy?: string | null;
  };
  return {
    state: pr.state as PrSnapshot['state'],
    headSha: summary.headSha ?? '',
    mergeStateStatus: summary.mergeStateStatus ?? 'UNKNOWN',
    autoMergeEnabledBy: classifyAutoMergeActor(summary.autoMergeBy),
    summary: {
      url: summary.url ?? '',
      headBranch: summary.headBranch ?? '',
      baseBranch: summary.baseBranch ?? '',
      mergeable: summary.mergeable ?? 'UNKNOWN',
      reviewDecision: summary.reviewDecision ?? null,
      blockingReason: summary.blockingReason ?? 'unknown',
      checks: summary.checks ?? { total: 0, failed: 0, inProgress: 0 },
      unresolvedReviewThreads: summary.unresolvedReviewThreads ?? 0,
      // Identity of the failing-check SET — what lets `blockerSignature` tell
      // "fixed one, uncovered another" from "changed nothing". Left undefined
      // (never '') on summaries cached before it shipped: '' would claim
      // "nothing failing" and make two different failures look identical.
      failingChecksDigest: summary.failingChecksDigest,
      draft: summary.draft,
      // Load-bearing for external merge queues: trunk.io reports a submitted
      // PR's state ONLY as labels, so decide can't see the queue without them.
      labels: summary.labels ?? [],
    },
  };
}

/**
 * The workspace's visual-review settings. Absent reads as OFF: finalizing
 * rewrites a committed baseline, so the queue must never do it because a
 * settings row happened to be missing.
 */
async function visualReviewSettings(workspaceId: string): Promise<VisualReviewSettings> {
  const rows = await getDbClient()
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const settings = (rows[0]?.settings ?? {}) as { visualReview?: VisualReviewSettings };
  return settings.visualReview ?? {};
}

/**
 * Resolve the visual-review gate for a PR, or undefined when the question does
 * not apply (no PostHog credentials, lookup refused). `null` is a real answer —
 * "asked, nothing is gating" — and is what releases a parked entry.
 */
async function resolveVisualReviewContext(
  pr: PrEvalRow
): Promise<VisualReviewContext | null | undefined> {
  const settings = await visualReviewSettings(pr.workspaceId);
  // No `visualReview` settings at all = never ask. Without this the queue would
  // round-trip to PostHog for every blocked PR in every workspace that has
  // PostHog credentials — including the great majority of repos that have no
  // visual review and never will. Configuring the setting (even just
  // `{ autoApprove: false }`) is what turns the lookup on.
  if (Object.keys(settings).length === 0) return undefined;
  const summary = (pr.lastSummary ?? {}) as { headSha?: string };
  const run = await gatingVisualReviewRun(
    pr.workspaceId,
    pr.number,
    summary.headSha ?? '',
    settings.projectId
  );
  if (run === null) return null;
  return {
    runId: run.id,
    url: run.url,
    changed: run.changed + run.newCount,
    autoApprove: settings.autoApprove === true,
  };
}

/**
 * How stale an external-queue observation may be for THIS entry, or null when
 * the entry's decision doesn't depend on one. The webhook feed keeps the cache
 * warm, so this only bounds how long a MISSED delivery can mislead us — and
 * each case is bounded by how fast its answer can change:
 *
 * - Tracking a submission with no state yet (or an untouched submit box): the
 *   provider is expected to react in ~30s, and the wrong answer here BLOCKS the
 *   PR, so re-ask every minute until it speaks.
 * - Tracking a live provider state: the provider's next move is minutes-to-an-
 *   hour away (a trunk test cycle is ~40min) and every move edits its comment,
 *   so a 10-minute backstop costs nothing and catches a dropped delivery.
 * - Already blocked on the external queue: only a self-heal can come of it
 *   (R5c), which is not urgent — the same 10-minute backstop.
 * - Any OTHER entry on a gated base: the provider may hold a PR this entry
 *   knows nothing about (the author submitted it themselves), and R5d has to
 *   see that before it fires a run whose push ejects the PR. Same 10-minute
 *   backstop, and normally free — the caller only reaches this function when a
 *   gate exists, and on a gated repo trunk comments on every PR, so the
 *   webhook feed has almost always answered already.
 */
export function externalStateMaxAge(entry: EntrySnapshot): number | null {
  const AWAITING_ANSWER_MS = 60_000;
  const BACKSTOP_MS = 10 * 60_000;
  if (entry.status === 'awaiting_external') {
    return entry.externalState === null || entry.externalState === 'not_submitted'
      ? AWAITING_ANSWER_MS
      : BACKSTOP_MS;
  }
  if (entry.externalSubmitVia !== null) return AWAITING_ANSWER_MS;
  return BACKSTOP_MS;
}

async function buildBaseContext(
  entry: EntrySnapshot,
  pr: PrEvalRow,
  input: EvaluateEntryInput
): Promise<DecisionContext> {
  const accountKey = githubService.accountKeyFor(pr.workspaceId);
  const [ourFix, otherFix, signingRequired, cloudEnv] = await Promise.all([
    entry.fixTaskId ? linkedTaskStatus(entry.fixTaskId) : Promise.resolve(null),
    pr.taskId && pr.taskId !== entry.fixTaskId
      ? linkedTaskStatus(pr.taskId)
      : Promise.resolve(null),
    // Cached (1h) branch-protection probe; a probe failure reads as null and
    // decide proceeds — the merge's 403 safety net catches a real requirement.
    requiresSignedCommits(pr.workspaceId, pr.owner, pr.repo, entry.baseBranch).catch(() => null),
    resolveCloudEnv(pr.workspaceId),
  ]);
  const graphqlGateBlocked = githubRateGate.isBlocked(accountKey, 'graphql');
  const graphqlBudgetLow = graphqlBudget.shouldDefer(accountKey);
  // The capability probe is GraphQL (1h-cached per repo) — only worth asking
  // for the head entry, and never while GraphQL is gated or in the reserve.
  const autoMergeCapability =
    input.isHead && !graphqlGateBlocked && !graphqlBudgetLow
      ? await getAutoMergeCapability(pr.workspaceId, pr.owner, pr.repo, entry.mergeMethod)
      : 'unknown';
  // Is the base behind an external merge queue? Cached 1h (REST, no GraphQL
  // points) and sticky once an observed 405 confirms it — so this is a map
  // lookup on all but the first evaluation per repo+base per process.
  const externalGate = await getExternalMergeGate(
    pr.workspaceId,
    pr.owner,
    pr.repo,
    entry.baseBranch
  );
  // What the external queue itself says about this PR. Only asked for when a
  // gate exists AND the entry's fate depends on the answer; usually served from
  // the webhook-fed cache (the provider's every state change edits its comment,
  // which IS a delivery), so this is normally free.
  const externalMaxAge = externalGate ? externalStateMaxAge(entry) : null;
  const externalQueue =
    externalMaxAge === null
      ? undefined
      : await readExternalQueueState(
          pr.workspaceId,
          pr.owner,
          pr.repo,
          pr.number,
          externalMaxAge
        ).catch(() => null);
  // WHY did the queue's run fail? Only asked when it actually failed and the
  // provider linked the run, and memoised per job — so this is one REST call per
  // ejection, not one per evaluation. `null` (not asked / GitHub wouldn't say)
  // reads exactly like `unknown`: the failure is treated as real.
  const externalFailure =
    externalQueue?.state === 'failed'
      ? await classifyExternalQueueFailure(
          pr.workspaceId,
          pr.owner,
          pr.repo,
          externalQueue.failureUrl
        ).catch(() => null)
      : undefined;
  // Is a visual-review gate holding this PR? Asked ONLY when the PR has a
  // settled blocker (a green PR is not gated by anything) and the workspace has
  // PostHog credentials — otherwise this would be a PostHog round-trip on every
  // evaluation of every PR in every repo.
  const visualReview = prNeedsFollowup(pr.lastSummary as PRMergeableSummary)
    ? await resolveVisualReviewContext(pr).catch((err) => {
        console.warn(
          `[mergeQueueV2] visual-review lookup failed for ${pr.owner}/${pr.repo}#${pr.number}:`,
          err instanceof Error ? err.message : err
        );
        // Undefined = "not asked", so decide leaves the gate alone rather than
        // reading a lookup failure as "nothing is gating" and un-parking a PR.
        return undefined;
      })
    : undefined;
  // Is the queue itself broken across PRs? Read from an in-process tally fed by
  // the ejections this pipeline already observes, so it costs nothing and only
  // means anything on a gated base.
  const health = externalGate ? queueHealth(pr.owner, pr.repo, entry.baseBranch) : undefined;
  // Does a way to submit to that queue exist NOW? Asked ONLY for an entry the
  // ladder gave up on, so it costs nothing on any other path. "No mechanism" is
  // a verdict about the REPO's configuration and what Talyn could SEE of it —
  // never about the PR — which makes it the one block that can be falsified
  // without anything about the PR changing. It was false for every repo with
  // more than 100 labels until the label probe learned to paginate, and a
  // sticky `blocked_manual` meant a human had to requeue each PR the bug
  // touched. Both sources are cached (1h label probe, in-process command memo),
  // so this is a map lookup after the first evaluation per repo.
  // Both blocked statuses, so this can never drift out of step with the rule in
  // `decide` that reads it (which keys on the CODE, not the status).
  const submitDoorSought =
    externalGate !== null &&
    (entry.status === 'blocked_manual' || entry.status === 'blocked') &&
    entry.blockedCode === 'external_gate';
  const externalSubmitDoor = submitDoorSought
    ? ((await getExternalQueueSubmitLabel(pr.workspaceId, pr.owner, pr.repo).catch(
        () => null
      )) !== null ||
      rememberedExternalQueueSubmitRoute(pr.owner, pr.repo) !== null)
    : undefined;
  return {
    visualReview,
    nowIso: new Date().toISOString(),
    isHead: input.isHead,
    groupMergeInFlight: input.groupMergeInFlight,
    fixTaskState:
      ourFix === null ? 'none' : ACTIVE_STATUSES.has(ourFix) ? 'active' : 'terminal',
    otherLinkedTaskActive: otherFix !== null && ACTIVE_STATUSES.has(otherFix),
    signingRequired,
    autoMergeCapability,
    externalGate,
    ...(externalQueue !== undefined ? { externalQueue } : {}),
    ...(externalFailure !== undefined ? { externalFailure } : {}),
    ...(health !== undefined ? { queueHealth: health } : {}),
    ...(externalSubmitDoor !== undefined ? { externalSubmitDoor } : {}),
    updateBranchAvailable: true,
    cloudEnvAvailable: cloudEnv !== null,
    restGateBlocked: githubRateGate.isBlocked(accountKey, 'rest'),
    graphqlGateBlocked,
    graphqlBudgetLow,
    maxAttempts: MAX_ATTEMPTS,
    // A PR is never its own parent. A self-targeting summary can't exist on
    // GitHub, but a half-written one can, and a self-edge would park the entry
    // behind itself forever.
    ...(input.stackParent !== undefined
      ? {
          stackParent:
            input.stackParent && input.stackParent.pullRequestId === pr.id
              ? null
              : input.stackParent,
        }
      : {}),
  };
}

/**
 * Evaluate one entry to a settled verdict: run decide, perform its actions,
 * feed outcomes back, repeat. Never throws — a failure logs, ends the entry's
 * turn, and the reconciler retries.
 */
export async function evaluateEntry(input: EvaluateEntryInput): Promise<EvaluateEntryResult> {
  const { pr, position, trigger } = input;
  let entry = rowToEntrySnapshot(input.entry);
  let version = input.entry.version;
  const prSnap = buildPrSnapshot(pr);

  // Reconcile the denormalized group key BEFORE anything probes it. This has
  // to sit above buildBaseContext, which keys requiresSignedCommits and
  // getExternalMergeGate on entry.baseBranch — a retargeted PR probed against
  // its old base reads the protection rules of a branch it no longer targets.
  // Bail rather than continue: the whole decision context belongs to the base
  // we just left, and the new group's own walk will build a fresh one.
  const liveBase = prSnap.summary.baseBranch;
  if (liveBase && liveBase !== entry.baseBranch) {
    const ok = await casTransition(
      entry.id,
      version,
      { baseBranch: liveBase },
      {
        trigger,
        fromStatus: entry.status,
        toStatus: entry.status,
        code: 'base_branch_changed',
        message: `Base branch changed from ${entry.baseBranch} to ${liveBase} — moved to that queue group.`,
        detail: { from: entry.baseBranch, to: liveBase },
      }
    );
    if (!ok) return { verdict: 'advance', casLost: true };
    return {
      verdict: 'advance',
      movedToBase: liveBase,
      finalEntry: { ...entry, baseBranch: liveBase },
    };
  }

  const base = await buildBaseContext(entry, pr, input);
  const extras: Partial<DecisionContext> = {};

  for (let round = 0; round < MAX_DECIDE_ROUNDS; round++) {
    const decision = decide(entry, prSnap, { ...base, ...extras });
    let redecide = false;

    for (const action of decision.actions) {
      const applied = await performAction(action, {
        entry,
        version,
        pr,
        prSnap,
        position,
        trigger,
        base,
        extras,
      });
      if (applied.casLost) return { verdict: 'advance', casLost: true };
      if (applied.abort) {
        return { verdict: applied.abort, finalEntry: entry, movedToBase: applied.movedToBase };
      }
      if (applied.entry) entry = applied.entry;
      if (applied.versionDelta) version += applied.versionDelta;
      if (applied.redecide) {
        redecide = true;
        break; // decide must see the outcome before any later action runs
      }
    }
    if (!redecide) return { verdict: decision.verdict, finalEntry: entry };
  }
  console.warn(
    `[mergeQueueV2] decide/execute round overflow for entry ${entry.id} — advancing`
  );
  return { verdict: 'advance', finalEntry: entry };
}

interface ActionContext {
  entry: EntrySnapshot;
  version: number;
  pr: PrEvalRow;
  prSnap: PrSnapshot;
  position: number;
  trigger: string;
  /** The evaluation's base context (probe results, capabilities, gates). */
  base: DecisionContext;
  extras: Partial<DecisionContext>;
}

interface ActionOutcome {
  entry?: EntrySnapshot;
  versionDelta?: number;
  redecide?: boolean;
  casLost?: boolean;
  /** Stop the evaluation with this verdict (live pre-merge check failed). */
  abort?: 'hold' | 'advance';
  /** Paired with `abort`: the entry now belongs to a different base group. */
  movedToBase?: string;
}

async function performAction(action: Action, ctx: ActionContext): Promise<ActionOutcome> {
  switch (action.kind) {
    case 'transition':
      return applyTransition(action, ctx);
    case 'reset_budgets':
      return applyBudgetReset(action, ctx);
    case 'adopt_head':
      return applyAdoptHead(action, ctx);
    case 'verify_merged': {
      ctx.extras.verifiedMerged = await verifyMerged(ctx.pr);
      return { redecide: true };
    }
    case 'probe_signatures':
      return probeSignatures(ctx);
    case 'verify_live_then_merge':
      return verifyLiveThenMerge(ctx);
    case 'rerequest_failed_checks': {
      ctx.extras.rerunOutcome = await rerequestFailedChecks(ctx.pr);
      return { redecide: true };
    }
    case 'resolve_visual_review':
      return resolveVisualReview(action, ctx);
    case 'update_branch': {
      ctx.extras.updateBranchOutcome = await githubService.updatePullRequestBranch(
        ctx.pr.workspaceId,
        ctx.pr.owner,
        ctx.pr.repo,
        ctx.pr.number
      );
      return { redecide: true };
    }
    case 'retarget_base':
      return retargetBase(action, ctx);
    case 'fire_fix_run':
      return fireFixRun(action.resign, ctx, action.queueFailure);
    case 'record_merged': {
      await recordMerged(ctx.entry, ctx.pr);
      return {};
    }
    case 'refresh_snapshot': {
      await prMonitorService
        .refreshPr(ctx.pr.workspaceId, ctx.pr.owner, ctx.pr.repo, ctx.pr.number)
        .catch((err) => {
          console.warn(
            `[mergeQueueV2] snapshot refresh failed for ${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number}:`,
            err instanceof Error ? err.message : err
          );
        });
      return {};
    }
    case 'notify_blocked': {
      notifyBlocked(ctx.entry, ctx.pr);
      return {};
    }
    case 'mark_signing_required': {
      markSigningRequired(ctx.pr.workspaceId, ctx.pr.owner, ctx.pr.repo, ctx.entry.baseBranch);
      return {};
    }
    case 'arm_automerge':
      return armAutoMerge(ctx);
    case 'disarm_automerge':
      return disarmAutoMerge(ctx);
    case 'submit_external':
      return submitExternal(ctx);
    case 'mark_external_gate': {
      markExternalMergeGate(ctx.pr.workspaceId, ctx.pr.owner, ctx.pr.repo, ctx.entry.baseBranch);
      // decide already asked for a submit in the same round; make sure it sees
      // the confirmed gate rather than the 'suspected' the context was built
      // with (which would send the submit back to the direct merge).
      ctx.extras.externalGate = 'confirmed';
      debugBus.recordEvent({
        service: 'merge_queue',
        action: 'external-gate:confirmed',
        summary: `${ctx.pr.owner}/${ctx.pr.repo}@${ctx.entry.baseBranch} is behind an external merge queue`,
        workspaceId: ctx.pr.workspaceId,
        meta: { entryId: ctx.entry.id },
      });
      return {};
    }
  }
}

/**
 * Hand the PR to the external merge queue that owns its base branch (see
 * services/externalQueueSubmit.ts for the two doors and why they're ordered
 * that way).
 *
 * The one piece of policy that lives here: when the gate is only SUSPECTED and
 * GitHub refuses to arm because the PR is immediately mergeable, we take the
 * direct merge rather than the label. It's the cheapest way to find out whether
 * the gate applies to Talyn at all — and it lands the PR when it doesn't.
 */
async function submitExternal(ctx: ActionContext): Promise<ActionOutcome> {
  const settle = (outcome: SubmitOutcome): ActionOutcome => {
    ctx.extras.submitOutcome = outcome;
    // One aftermath at a time — a submit supersedes whatever merge attempt led
    // here (decide checks submitOutcome first).
    delete ctx.extras.mergeOutcome;
    return { redecide: true };
  };
  // `extras` wins: a mark_external_gate earlier in THIS evaluation upgrades the
  // base context's 'suspected' to 'confirmed'.
  const gate = ctx.extras.externalGate ?? ctx.base.externalGate;
  const nodeId = (ctx.pr.lastSummary as { nodeId?: string } | null)?.nodeId ?? null;

  const attempt = await submitToExternalQueue({
    workspaceId: ctx.pr.workspaceId,
    owner: ctx.pr.owner,
    repo: ctx.pr.repo,
    number: ctx.pr.number,
    nodeId,
    headSha: ctx.prSnap.headSha,
    mergeMethod: ctx.entry.mergeMethod,
    autoMergeArmedBy: ctx.prSnap.autoMergeEnabledBy,
    labelFallback: gate === 'confirmed',
  });

  switch (attempt.kind) {
    case 'submitted': {
      const how =
        attempt.via === 'comment'
          ? `"${attempt.command}"`
          : attempt.via === 'label'
            ? `"${attempt.label}"`
            : 'auto-merge';
      debugBus.recordEvent({
        service: 'merge_queue',
        action: 'external-queue:submitted',
        summary: `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number} submitted via ${how}`,
        workspaceId: ctx.pr.workspaceId,
        meta: {
          entryId: ctx.entry.id,
          via: attempt.via,
          ...(attempt.label ? { label: attempt.label } : {}),
          ...(attempt.command ? { command: attempt.command } : {}),
        },
      });
      return settle({
        kind: 'submitted',
        via: attempt.via,
        armedBy: attempt.armedBy,
        detail: attempt.command ?? attempt.label,
      });
    }
    case 'already_submitted':
      debugBus.recordEvent({
        service: 'merge_queue',
        action: 'external-queue:already-submitted',
        summary: `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number} is already ${attempt.state} in the queue`,
        workspaceId: ctx.pr.workspaceId,
        meta: { entryId: ctx.entry.id, state: attempt.state },
      });
      return settle({
        kind: 'already_submitted',
        state: attempt.state,
        evidence: attempt.evidence,
      });
    case 'clean_status':
      return settle({ kind: 'try_direct_merge' });
    case 'no_mechanism':
      return settle({ kind: 'unavailable', message: attempt.message });
    case 'retry':
      if (!nodeId) {
        // Row cached before nodeId shipped — refresh so the next evaluation can
        // arm. (The direct-merge path never needed it, so old rows lack it.)
        await prMonitorService
          .refreshPr(ctx.pr.workspaceId, ctx.pr.owner, ctx.pr.repo, ctx.pr.number)
          .catch(() => undefined);
      }
      return settle({ kind: 'retry', message: attempt.message });
  }
}

/**
 * Arm GitHub native auto-merge on the group head. On success the entry goes
 * `automerge_armed` and GitHub owns the merge moment (we observe it via the
 * closed webhook). Adoption: when the USER already armed it on github.com we
 * record that and arm nothing — and never disarm it.
 */
async function armAutoMerge(ctx: ActionContext): Promise<ActionOutcome> {
  if (ctx.prSnap.autoMergeEnabledBy === 'user') {
    return applyArmedTransition(ctx, 'user', 'Adopted the user-armed GitHub auto-merge.');
  }
  if (ctx.prSnap.autoMergeEnabledBy === 'talyn') {
    // GitHub already holds our arm (entry status drifted during remediation) —
    // re-sync the entry instead of re-arming.
    return applyArmedTransition(ctx, 'talyn', 'Re-synced: GitHub auto-merge already armed.');
  }
  const nodeId = (ctx.pr.lastSummary as { nodeId?: string } | null)?.nodeId;
  if (!nodeId) {
    // Rows cached before the nodeId field shipped — refresh fills it; wait as
    // awaiting_ci meanwhile (the direct-merge path still works).
    await ensureAwaitingCi(ctx, 'automerge_no_node_id', 'PR node id not cached yet — refreshing.');
    await prMonitorService
      .refreshPr(ctx.pr.workspaceId, ctx.pr.owner, ctx.pr.repo, ctx.pr.number)
      .catch(() => undefined);
    return {};
  }
  const result = await enableAutoMerge({
    workspaceId: ctx.pr.workspaceId,
    owner: ctx.pr.owner,
    repo: ctx.pr.repo,
    nodeId,
    mergeMethod: ctx.entry.mergeMethod,
    expectedHeadOid: ctx.prSnap.headSha,
  });
  if (result.armed) {
    debugBus.recordEvent({
      service: 'merge_queue',
      action: 'auto-merge:armed',
      summary: `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number} auto-merge armed`,
      workspaceId: ctx.pr.workspaceId,
      meta: { entryId: ctx.entry.id, headSha: ctx.prSnap.headSha },
    });
    return applyArmedTransition(ctx, 'talyn', 'GitHub auto-merge armed — merges when checks pass.');
  }
  switch (result.reason) {
    case 'clean_status':
      // The PR is immediately mergeable — nothing to wait for. Direct merge.
      return verifyLiveThenMerge(ctx);
    case 'head_mismatch':
      // A push landed mid-arm — the synchronize webhook re-evaluates with the
      // new head (and resets budgets); nothing else to do now.
      return ensureAwaitingCi(ctx, 'automerge_head_moved', 'Head moved while arming — re-evaluating.');
    case 'not_allowed':
      // Sticky-recorded by enableAutoMerge; the direct-merge path takes over.
      return ensureAwaitingCi(ctx, 'automerge_not_allowed', 'Repo refuses auto-merge — will direct-merge when checks pass.');
    default:
      return ensureAwaitingCi(ctx, 'automerge_arm_failed', `Arming failed (${result.message}) — will retry.`);
  }
}

async function applyArmedTransition(
  ctx: ActionContext,
  armedBy: 'talyn' | 'user',
  message: string
): Promise<ActionOutcome> {
  const next: EntrySnapshot = { ...ctx.entry, status: 'automerge_armed', automergeArmedBy: armedBy };
  const ok = await casTransition(
    ctx.entry.id,
    ctx.version,
    {
      status: 'automerge_armed',
      blockedCode: null,
      blockedReason: null,
      automergeArmedAt: new Date(),
      automergeArmedBy: armedBy,
      pendingDisarm: false,
      lastEvaluatedAt: new Date(),
    },
    {
      trigger: ctx.trigger,
      fromStatus: ctx.entry.status,
      toStatus: 'automerge_armed',
      code: armedBy === 'user' ? 'automerge_adopted' : 'automerge_armed',
      message,
      detail: { headSha: ctx.prSnap.headSha },
    }
  );
  if (!ok) return { casLost: true };
  await mirrorToPrRow(next, ctx.pr, ctx.position);
  return { entry: next, versionDelta: 1 };
}

async function ensureAwaitingCi(
  ctx: ActionContext,
  code: string,
  message: string
): Promise<ActionOutcome> {
  if (ctx.entry.status === 'awaiting_ci') return {};
  return applyTransition(
    { kind: 'transition', to: 'awaiting_ci', blockedCode: null, blockedReason: null, event: { code, message } },
    ctx
  );
}

/** Disarm a Talyn-armed auto-merge (never a user-armed one — decide guards). */
async function disarmAutoMerge(ctx: ActionContext): Promise<ActionOutcome> {
  const nodeId = (ctx.pr.lastSummary as { nodeId?: string } | null)?.nodeId;
  const ok = nodeId
    ? await disableAutoMerge({
        workspaceId: ctx.pr.workspaceId,
        owner: ctx.pr.owner,
        repo: ctx.pr.repo,
        nodeId,
      })
    : false;
  const cas = await casTransition(
    ctx.entry.id,
    ctx.version,
    {
      automergeArmedAt: null,
      automergeArmedBy: null,
      // A failed disarm is retried by the reconciler — never leave a
      // Talyn-armed auto-merge dangling on GitHub.
      pendingDisarm: !ok,
      lastEvaluatedAt: new Date(),
    },
    {
      trigger: ctx.trigger,
      fromStatus: ctx.entry.status,
      toStatus: ctx.entry.status,
      code: ok ? 'automerge_disarmed' : 'automerge_disarm_failed',
      message: ok ? 'GitHub auto-merge disarmed.' : 'Disarm failed — reconciler will retry.',
    }
  );
  if (!cas) return { casLost: true };
  debugBus.recordEvent({
    service: 'merge_queue',
    action: 'auto-merge:disarmed',
    ok,
    summary: `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number} auto-merge disarm ${ok ? 'ok' : 'FAILED (retrying)'}`,
    workspaceId: ctx.pr.workspaceId,
    meta: { entryId: ctx.entry.id },
  });
  return {
    entry: { ...ctx.entry, automergeArmedBy: null },
    versionDelta: 1,
  };
}

/**
 * Feed the cross-PR queue-health tally off the transitions the pipeline already
 * writes, rather than from a second observation path that could disagree with
 * the timeline. Only the two INFRASTRUCTURE codes count against the queue —
 * a failure Talyn could not classify stays the PR's own problem — and any
 * merge, however it was reached, clears the record.
 */
function noteQueueHealth(
  action: Extract<Action, { kind: 'transition' }>,
  ctx: ActionContext
): void {
  const { owner, repo, number } = ctx.pr;
  const base = ctx.entry.baseBranch;
  if (!base) return;
  if (action.to === 'merged') {
    noteMerge(owner, repo, base);
    return;
  }
  if (
    action.event.code === 'external_queue_infra_failure' ||
    action.event.code === 'external_queue_infra_exhausted'
  ) {
    noteInfraFailure(owner, repo, base, number);
  }
}

async function applyTransition(
  action: Extract<Action, { kind: 'transition' }>,
  ctx: ActionContext
): Promise<ActionOutcome> {
  noteQueueHealth(action, ctx);
  // `set` carries plain column writes straight through to the snapshot. Copy
  // every defined key rather than listing them: this used to be a hand-written
  // spread per field, and adding a column meant remembering four separate
  // places — the merge-stack columns were silently dropped exactly that way.
  const setEntries = Object.entries(action.set ?? {}).filter(([, v]) => v !== undefined);
  const next: EntrySnapshot = {
    ...ctx.entry,
    status: action.to,
    blockedCode: action.blockedCode ?? null,
    blockedReason: action.blockedReason ?? null,
    ...(Object.fromEntries(setEntries) as Partial<EntrySnapshot>),
  };
  // The DB shape differs from the snapshot in three places: two ISO strings
  // become Dates, and two writes carry an implicit "…At" stamp with them.
  const { lastError, lastErrorAt, externalSubmittedAt, externalState, automergeArmedBy } =
    action.set ?? {};
  const ok = await casTransition(
    ctx.entry.id,
    ctx.version,
    {
      ...(Object.fromEntries(
        setEntries.filter(
          ([k]) => !['lastError', 'lastErrorAt', 'externalSubmittedAt'].includes(k)
        )
      ) as CasPatch),
      status: action.to,
      blockedCode: next.blockedCode,
      blockedReason: next.blockedReason,
      ...(externalSubmittedAt !== undefined
        ? { externalSubmittedAt: externalSubmittedAt ? new Date(externalSubmittedAt) : null }
        : {}),
      ...(externalState !== undefined ? { externalStateAt: new Date() } : {}),
      ...(automergeArmedBy !== undefined
        ? { automergeArmedAt: automergeArmedBy ? new Date() : null }
        : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(lastErrorAt !== undefined ? { lastErrorAt: new Date(lastErrorAt) } : {}),
      ...(action.to === 'merging' ? { mergeStartedAt: new Date() } : {}),
      lastEvaluatedAt: new Date(),
    },
    {
      trigger: ctx.trigger,
      fromStatus: ctx.entry.status,
      toStatus: action.to,
      code: action.event.code,
      message: action.event.message,
      detail: action.event.detail,
    }
  );
  if (!ok) return { casLost: true };
  debugBus.recordEvent({
    service: 'merge_queue',
    action: `${ctx.entry.status}->${action.to}`,
    summary: `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number}: ${action.event.message}`,
    workspaceId: ctx.pr.workspaceId,
    meta: { entryId: ctx.entry.id, code: action.event.code, headSha: ctx.entry.headSha },
  });
  await mirrorToPrRow(next, ctx.pr, ctx.position);
  return { entry: next, versionDelta: 1 };
}

async function applyBudgetReset(
  action: Extract<Action, { kind: 'reset_budgets' }>,
  ctx: ActionContext
): Promise<ActionOutcome> {
  // A new head invalidates a `blocked` gate AND any external-queue submission
  // (the provider tested a commit that is no longer the head) — both funnel
  // back to `queued` for a fresh decision. Mirrors DecisionBuilder.resetBudgets.
  const reopens = ctx.entry.status === 'blocked' || ctx.entry.status === 'awaiting_external';
  const next: EntrySnapshot = {
    ...ctx.entry,
    headSha: action.newHeadSha,
    fixAttempts: 0,
    rerunAttempts: 0,
    resignAttempts: 0,
    submitAttempts: 0,
    // New code, new problems — what defeated a run on the old head says
    // nothing about this one. This is what makes 'no_progress' self-heal.
    seenSignatures: [],
    externalSubmitVia: null,
    externalSubmittedAt: null,
    externalState: null,
    signingCheckedSha: null,
    unsignedCount: null,
    ...(reopens ? { status: 'queued' as const, blockedCode: null, blockedReason: null } : {}),
  };
  const ok = await casTransition(
    ctx.entry.id,
    ctx.version,
    {
      headSha: action.newHeadSha,
      fixAttempts: 0,
      rerunAttempts: 0,
      resignAttempts: 0,
      submitAttempts: 0,
      seenSignatures: [],
      externalSubmitVia: null,
      externalSubmittedAt: null,
      externalState: null,
      signingCheckedSha: null,
      unsignedCount: null,
      ...(reopens ? { status: 'queued' as const, blockedCode: null, blockedReason: null } : {}),
      lastEvaluatedAt: new Date(),
    },
    {
      trigger: ctx.trigger,
      fromStatus: ctx.entry.status,
      toStatus: next.status,
      code: action.event.code,
      message: action.event.message,
      detail: action.event.detail,
    }
  );
  if (!ok) return { casLost: true };
  await mirrorToPrRow(next, ctx.pr, ctx.position);
  return { entry: next, versionDelta: 1 };
}

async function applyAdoptHead(
  action: Extract<Action, { kind: 'adopt_head' }>,
  ctx: ActionContext
): Promise<ActionOutcome> {
  // Only the head pointer moves — budgets and the fix-run link are preserved so
  // R8 can still account the in-flight run against the commits it just pushed.
  const next: EntrySnapshot = { ...ctx.entry, headSha: action.newHeadSha };
  const ok = await casTransition(
    ctx.entry.id,
    ctx.version,
    { headSha: action.newHeadSha, lastEvaluatedAt: new Date() },
    {
      trigger: ctx.trigger,
      fromStatus: ctx.entry.status,
      toStatus: ctx.entry.status,
      code: action.event.code,
      message: action.event.message,
      detail: action.event.detail,
    }
  );
  if (!ok) return { casLost: true };
  await mirrorToPrRow(next, ctx.pr, ctx.position);
  return { entry: next, versionDelta: 1 };
}

async function probeSignatures(ctx: ActionContext): Promise<ActionOutcome> {
  let count = 0;
  try {
    count = await fetchUnsignedCommitCount({
      workspaceId: ctx.pr.workspaceId,
      owner: ctx.pr.owner,
      repo: ctx.pr.repo,
      number: ctx.pr.number,
    });
  } catch (err) {
    // Our own check failed — don't block the merge on it; proceed as signed
    // (v1 semantics: the 403 safety net catches a real refusal).
    console.warn(
      `[mergeQueueV2] signature check failed for ${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number}:`,
      err instanceof Error ? err.message : err
    );
  }
  ctx.extras.unsignedCount = count;
  // Memoize per head — the probe runs at most once per (entry, head).
  const ok = await casTransition(
    ctx.entry.id,
    ctx.version,
    { signingCheckedSha: ctx.prSnap.headSha, unsignedCount: count },
    null
  );
  if (!ok) return { casLost: true };
  return {
    entry: { ...ctx.entry, signingCheckedSha: ctx.prSnap.headSha, unsignedCount: count },
    versionDelta: 1,
    redecide: true,
  };
}

/**
 * Merge stack: point the PR at its stack parent's base now that the parent has
 * landed, and move the entry into that group.
 *
 * On success this ABORTS the evaluation rather than redeciding. The whole
 * decision context — requiresSignedCommits, getExternalMergeGate,
 * getAutoMergeCapability — was probed against the base the PR just left, which
 * is a feature branch with no protection. The base it moves TO is the real
 * base, which is exactly where signing rules and external merge gates live.
 * Redeciding here would send a freshly-retargeted PR straight at a
 * trunk-gated master with an "unprotected" context. The new group's own walk
 * builds a fresh one.
 */
async function retargetBase(
  action: Extract<Action, { kind: 'retarget_base' }>,
  ctx: ActionContext
): Promise<ActionOutcome> {
  const { pr, entry } = ctx;

  // GitHub's own delete-branch auto-retarget may have beaten us here, and a
  // double-delivered webhook certainly can. Either way there is nothing to do
  // but move the entry.
  let landed = ctx.prSnap.summary.baseBranch === action.toBase;

  if (!landed) {
    // Burn nothing while the account is in a REST backoff — the retarget budget
    // counts attempts, and a rate-limited round is not an attempt.
    if (ctx.base.restGateBlocked) {
      ctx.extras.retargetOutcome = 'retry';
      return { redecide: true };
    }
    try {
      await githubService.updatePullRequest(pr.workspaceId, pr.owner, pr.repo, pr.number, {
        base: action.toBase,
      });
      landed = true;
    } catch (err) {
      // The PATCH may have landed and only the response been lost. Ask.
      const live = await githubService
        .getPullRequest(pr.workspaceId, pr.owner, pr.repo, pr.number)
        .catch(() => null);
      landed = (live as { base?: { ref?: string } } | null)?.base?.ref === action.toBase;
      if (!landed) {
        console.warn(
          `[mergeQueueV2] retarget ${pr.owner}/${pr.repo}#${pr.number} -> ${action.toBase} failed:`,
          err instanceof Error ? err.message : err
        );
        ctx.extras.retargetOutcome = 'error';
        return { redecide: true };
      }
    }
  }

  const patch: CasPatch = {
    baseBranch: action.toBase,
    status: 'queued',
    blockedCode: null,
    blockedReason: null,
    // Recorded HERE, not merely kept: a child whose parent merges before the
    // child is ever evaluated never parks, so it would otherwise have no
    // record of what it was stacked on. From here it reads "the PR this one
    // was stacked on" — which is what tells a later fix run that this branch
    // may still carry that PR's original commits after a squash-merge.
    stackParentNumber: action.parentNumber,
    retargetAttempts: entry.retargetAttempts + 1,
    // The PR faces a genuinely different base with genuinely different
    // problems; attempts spent fighting the old one shouldn't count. Same
    // reasoning as the new-head budget reset.
    fixAttempts: 0,
    rerunAttempts: 0,
    resignAttempts: 0,
    submitAttempts: 0,
    fixTaskAccounted: true,
    // Every memo below was probed against the OLD base. Signing requirements
    // and external merge gates live on the real base, so a stale memo here is
    // how a PR merges past a rule it was never checked against.
    signingCheckedSha: null,
    unsignedCount: null,
    externalSubmitVia: null,
    externalSubmittedAt: null,
    externalState: null,
    externalStateAt: null,
  };
  // Move the PR row's summary in the same breath. Without this the entry says
  // `main` while the row still says `feat-a`, and the next evaluation's
  // base-branch reconcile dutifully flips the entry BACK — a ping-pong that
  // burns the retarget budget until the entry blocks. refreshPr below would
  // normally fix it, but it is asynchronous and allowed to fail, so the two
  // must not be left disagreeing even briefly. Writes the one key; never reads
  // the blob back.
  await getDbClient()
    .update(pullRequestsTable)
    .set({
      lastSummary: sql`jsonb_set(coalesce(${pullRequestsTable.lastSummary}, '{}'::jsonb), '{baseBranch}', ${JSON.stringify(action.toBase)}::jsonb, true)`,
    })
    .where(eq(pullRequestsTable.id, pr.id));

  const ok = await casTransition(entry.id, ctx.version, patch, {
    trigger: ctx.trigger,
    fromStatus: entry.status,
    toStatus: 'queued',
    code: 'stack_retargeted',
    message: `#${action.parentNumber} merged — retargeted this PR from ${entry.baseBranch} to ${action.toBase}.`,
    detail: { from: entry.baseBranch, to: action.toBase, parent: action.parentNumber },
  });
  if (!ok) return { casLost: true };

  // The next evaluation must read the new base and its mergeStateStatus
  // (normally BEHIND, which the update-branch rule then handles).
  await prMonitorService
    .refreshPr(pr.workspaceId, pr.owner, pr.repo, pr.number, { resolveMergeable: true })
    .catch(() => undefined);

  return {
    abort: 'advance',
    movedToBase: action.toBase,
    versionDelta: 1,
    entry: {
      ...entry,
      baseBranch: action.toBase,
      status: 'queued',
      blockedCode: null,
      blockedReason: null,
      stackParentNumber: action.parentNumber,
      retargetAttempts: entry.retargetAttempts + 1,
    },
  };
}

async function verifyLiveThenMerge(ctx: ActionContext): Promise<ActionOutcome> {
  const db = getDbClient();
  // Last-moment live re-check: an evaluation resumed after a stall can be
  // acting on a snapshot from minutes ago, after the PR merged or the user
  // dequeued it. Never merge off a stale snapshot.
  const current = await db
    .select({ state: pullRequestsTable.state, mergeQueued: pullRequestsTable.mergeQueued })
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, ctx.pr.id))
    .limit(1);
  if (!current[0] || current[0].state !== 'open' || !current[0].mergeQueued) {
    return { abort: 'hold' };
  }
  // Persist 'merging' BEFORE the call — the crash marker verify-merged keys on.
  const transition = await applyTransition(
    {
      kind: 'transition',
      to: 'merging',
      blockedCode: null,
      blockedReason: null,
      event: { code: 'merge_attempt', message: 'Attempting the merge.' },
    },
    ctx
  );
  if (transition.casLost) return transition;
  const entry = transition.entry!;

  let outcome: MergeOutcome;
  try {
    const result = await githubService.mergePullRequest(
      ctx.pr.workspaceId,
      ctx.pr.owner,
      ctx.pr.repo,
      ctx.pr.number,
      { merge_method: entry.mergeMethod }
    );
    outcome = result.merged
      ? { kind: 'merged' }
      : { kind: 'not_merged', message: result.message || 'GitHub did not merge the pull request' };
  } catch (err) {
    outcome =
      err instanceof MergeNotPermittedForAppError
        ? { kind: 'refused_app', message: err.message }
        : { kind: 'error', message: err instanceof Error ? err.message : 'Merge failed' };
  }
  ctx.extras.mergeOutcome = outcome;
  // One aftermath at a time: this merge may have been the fallback for a submit
  // that couldn't arm, and decide checks submitOutcome first.
  delete ctx.extras.submitOutcome;
  if (outcome.kind === 'merged') {
    // The branch let us merge after all — drop any gate we'd recorded for it so
    // a relaxed ruleset doesn't leave the queue submitting forever.
    clearExternalMergeGate(ctx.pr.workspaceId, ctx.pr.owner, ctx.pr.repo, entry.baseBranch);
    // Until now `pr_merged` was captured ONLY by the desktop/web merge button,
    // so every merge the queue performed — the product's headline feature —
    // was invisible in analytics and the dashboard read a near-flat zero.
    // `source` splits the two paths; the manual button sends 'manual'.
    captureWorkspaceEvent(ctx.pr.workspaceId, 'pr_merged', {
      source: 'merge_queue',
      repo: `${ctx.pr.owner}/${ctx.pr.repo}`,
      pr_number: ctx.pr.number,
      merge_method: entry.mergeMethod,
    });
  }
  // The merging transition consumed one CAS version; the merge itself writes
  // no entry state (the aftermath rules do, next round).
  return { entry, versionDelta: 1, redecide: true };
}

/**
 * Clear a visual-review gate by finalizing its run.
 *
 * The one action in the queue that ships a change to someone's branch without a
 * cloud run behind it: finalize approves every pending diff and commits a new
 * baseline. Reached only when the workspace set `visualReview.autoApprove`.
 *
 * Every outcome is folded back into `extras` and redecided rather than written
 * here — the aftermath (wait for CI / retry / block) is a decision, and
 * decisions live in `decide`.
 */
async function resolveVisualReview(
  action: Extract<Action, { kind: 'resolve_visual_review' }>,
  ctx: ActionContext
): Promise<ActionOutcome> {
  const projectId = (await visualReviewSettings(ctx.pr.workspaceId)).projectId;
  const outcome = await finalizeVisualReviewRun(ctx.pr.workspaceId, action.runId, projectId);
  ctx.extras.visualReviewOutcome =
    outcome.kind === 'finalized'
      ? { kind: 'finalized' }
      : outcome.kind === 'stale' || outcome.kind === 'sha_mismatch'
        ? { kind: 'superseded' }
        : outcome.kind === 'retry'
          ? { kind: 'retry', message: outcome.message }
          : { kind: 'error', message: outcome.message };
  if (outcome.kind === 'finalized') {
    console.log(
      `[mergeQueueV2] finalized visual review ${action.runId} for ` +
        `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number} (${action.changed} snapshot(s))`
    );
  }
  return { redecide: true };
}

async function rerequestFailedChecks(pr: PrEvalRow): Promise<RerunOutcome> {
  try {
    return await githubService.rerequestFailedCheckRuns(
      pr.workspaceId,
      pr.owner,
      pr.repo,
      pr.number
    );
  } catch (err) {
    console.warn(
      `[mergeQueueV2] failed-check rerun for ${pr.owner}/${pr.repo}#${pr.number} errored:`,
      err instanceof Error ? err.message : err
    );
    return { errored: true };
  }
}

// Dispatch a cloud fix run "claim-first": CLAIM the entry (CAS status→fixing,
// fixTaskId=null) BEFORE creating the task, so N concurrent (cross-replica)
// evaluations racing at the same entry version collapse to exactly ONE claim —
// the losers bail before createCloudTask and start nothing. Then create the
// task and LINK it (second CAS). A crash between claim and link leaves the entry
// at fixing+null; the reconciler's 120s staleness sweep re-evaluates it and
// decide (which reads null fixTaskId as no active run) simply re-fires — natural
// recovery, no wedge. See the 2026-07-17 runaway + Session 72.
async function fireFixRun(
  resign: boolean,
  ctx: ActionContext,
  queueFailure?: { provider: string; evidence: string; failedChecks?: string[] }
): Promise<ActionOutcome> {
  const resolved = await resolveCloudEnv(ctx.pr.workspaceId);
  if (!resolved) {
    // decide gates on cloudEnvAvailable, but the env can disconnect between
    // context build and dispatch — hold as queued, burn nothing.
    return ensureQueuedDeferred(ctx, 'no_cloud_env', 'No connected cloud provider — deferring.');
  }
  const fixKind: FixKind = queueFailure ? 'queue_failure' : resign ? 'resign' : 'blockers';

  // Phase A — claim. Whoever wins this CAS owns the dispatch; concurrent
  // evaluations at the same version lose here and create no task. No
  // resignAttempts bump / no fixTaskId yet, so a TaskLimit deferral below can
  // roll back having burned nothing.
  const claimed: EntrySnapshot = {
    ...ctx.entry,
    status: 'fixing',
    blockedCode: null,
    blockedReason: null,
    fixTaskId: null,
    fixKind,
  };
  const claimOk = await casTransition(
    ctx.entry.id,
    ctx.version,
    {
      status: 'fixing',
      blockedCode: null,
      blockedReason: null,
      fixTaskId: null,
      fixKind,
      lastEvaluatedAt: new Date(),
    },
    {
      trigger: ctx.trigger,
      fromStatus: ctx.entry.status,
      toStatus: 'fixing',
      code: 'fix_run_claimed',
      message: resign ? 'Re-sign run claimed — dispatching.' : 'Fix run claimed — dispatching.',
    }
  );
  if (!claimOk) return { casLost: true };
  const claimedVersion = ctx.version + 1;

  // Phase B — create the cloud task (only the claim winner reaches here).
  const ref = `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number}`;
  const summary = ctx.prSnap.summary;
  const prTitle = (ctx.pr.lastSummary as { title?: string } | null)?.title ?? '';
  let created: { id: string };
  try {
    created = await createCloudTask({
      workspaceId: ctx.pr.workspaceId,
      type: 'pr_response',
      title: queueFailure
        ? `Fix ${ref} after a merge-queue failure`
        : `Get ${ref} mergeable (merge queue)`,
      description: queueFailure
        ? `Merge queue: ${queueFailure.provider} failed ${ref} ("${prTitle}") merged with its base while the branch itself is green — investigate the queue's failure and fix it.`
        : resign
          ? `Merge queue: re-sign ${ref} ("${prTitle}") — the base requires signed commits — and take it to a clean, mergeable state.`
          : `Merge queue: take ${ref} ("${prTitle}") to a clean, mergeable, up-to-date state.`,
      prompt: buildMergeablePrompt({
        owner: ctx.pr.owner,
        repo: ctx.pr.repo,
        number: ctx.pr.number,
        summary,
        provider: resolved.provider,
        resignCommits: resign,
        // Starts the run at the provider's failure output rather than the PR's
        // own (green) checks — see queueFailureRule.
        queueFailure,
        // The squash escape hatch. This entry was retargeted after the PR it
        // was stacked on merged, so its branch may still carry that PR's
        // original commits — a plain base merge conflicts or re-shows them.
        // Only an agent with a checkout can rebase them away.
        ...(ctx.entry.retargetAttempts > 0 && ctx.entry.stackParentNumber !== null
          ? {
              retargetedOnto: {
                base: summary.baseBranch,
                parentNumber: ctx.entry.stackParentNumber,
              },
            }
          : {}),
        template: await workspacePromptTemplate(ctx.pr.workspaceId, 'mergeable'),
      }),
      repositoryId: ctx.pr.repositoryId,
      assignedEnvironmentId: resolved.envId,
      pullRequestId: ctx.pr.id,
    });
  } catch (err) {
    if (err instanceof TaskLimitError) {
      // Free-plan concurrency limit — transient; a slot frees when a task ends
      // (the task:status trigger re-evaluates). Roll the claim back to queued
      // and burn NOTHING (no attempt was counted in Phase A).
      const reverted: EntrySnapshot = {
        ...claimed,
        status: 'queued',
        fixKind: null,
      };
      const revertOk = await casTransition(
        ctx.entry.id,
        claimedVersion,
        { status: 'queued', fixKind: null, lastEvaluatedAt: new Date() },
        {
          trigger: ctx.trigger,
          fromStatus: 'fixing',
          toStatus: 'queued',
          code: 'deferred_task_limit',
          message: 'Fix run deferred — free-plan task slots are full.',
        }
      );
      if (!revertOk) return { casLost: true };
      await mirrorToPrRow(reverted, ctx.pr, ctx.position);
      return { entry: reverted, versionDelta: 2 };
    }
    throw err;
  }

  // Phase C — link the created task to the claim.
  const linked: EntrySnapshot = {
    ...claimed,
    fixTaskId: created.id,
    fixTaskAccounted: false,
    ...(resign ? { resignAttempts: ctx.entry.resignAttempts + 1 } : {}),
  };
  const linkOk = await casTransition(
    ctx.entry.id,
    claimedVersion,
    {
      fixTaskId: created.id,
      fixTaskAccounted: false,
      ...(resign ? { resignAttempts: ctx.entry.resignAttempts + 1 } : {}),
      lastEvaluatedAt: new Date(),
    },
    {
      trigger: ctx.trigger,
      fromStatus: 'fixing',
      toStatus: 'fixing',
      code: resign ? 'resign_run_fired' : 'fix_run_fired',
      message: resign
        ? `Re-sign run dispatched (attempt ${ctx.entry.resignAttempts + 1}/${MAX_ATTEMPTS}).`
        : 'Cloud fix run dispatched.',
      detail: { taskId: created.id },
    }
  );
  if (!linkOk) {
    // A late evaluation re-claimed in the sub-second window between our claim
    // and this link. Our task is a duplicate: cancel it before the scheduler
    // dispatches it (created 'queued', dispatched async on the next tick), so
    // the vendor run never starts. The re-claimer owns the entry now.
    await cancelUndispatchedFixTask(created.id);
    return { casLost: true };
  }
  await mirrorToPrRow(linked, ctx.pr, ctx.position);
  return { entry: linked, versionDelta: 2 };
}

/** Cancel a just-created fix task that lost the entry claim, but only while it
 *  is still undispatched — if the scheduler already promoted it to in_progress
 *  in the microsecond window, leave it (the poller owns its lifecycle). */
async function cancelUndispatchedFixTask(taskId: string): Promise<void> {
  try {
    const now = new Date();
    await getDbClient()
      .update(tasksTable)
      .set({
        status: 'cancelled',
        result: {
          success: false,
          error: 'Duplicate merge-queue fix run — superseded by a concurrent dispatch.',
        },
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(tasksTable.id, taskId), inArray(tasksTable.status, ['queued', 'pending'])));
  } catch (err) {
    console.warn(`[mergeQueueV2] failed to cancel duplicate fix task ${taskId}:`, err);
  }
}

async function ensureQueuedDeferred(
  ctx: ActionContext,
  code: string,
  message: string
): Promise<ActionOutcome> {
  if (ctx.entry.status === 'queued') return {};
  return applyTransition(
    {
      kind: 'transition',
      to: 'queued',
      blockedCode: null,
      blockedReason: null,
      event: { code, message },
    },
    ctx
  );
}

/**
 * Ask GitHub (REST — `merged_at` is the canonical signal) whether the PR is
 * in fact merged. Best-effort: any failure reads as "not merged".
 */
async function verifyMerged(pr: PrEvalRow): Promise<boolean> {
  try {
    const live = await githubService.getPullRequest(pr.workspaceId, pr.owner, pr.repo, pr.number);
    return Boolean(live.merged_at || live.merged);
  } catch {
    return false;
  }
}

/**
 * The single success path: entry → merged (unconditional — GitHub having
 * merged is ground truth no version race may discard), PR row terminal,
 * queue mirror cleared, positions rebroadcast.
 */
async function recordMerged(entry: EntrySnapshot, pr: PrEvalRow): Promise<void> {
  const db = getDbClient();
  await db
    .update(pullRequestsTable)
    .set({ state: 'merged', mergedAt: new Date(), ...QUEUE_RESET_COLUMNS, updatedAt: new Date() })
    .where(eq(pullRequestsTable.id, pr.id));
  await db
    .update(mergeQueueEntries)
    .set({ status: 'merged', updatedAt: new Date() })
    .where(eq(mergeQueueEntries.id, entry.id));
  await db.insert(mergeQueueEvents).values({
    entryId: entry.id,
    fromStatus: entry.status,
    toStatus: 'merged',
    trigger: 'executor',
    code: 'merged',
    message: 'Merged.',
  });
  debugBus.recordEvent({
    service: 'merge_queue',
    action: 'merged',
    summary: `${pr.owner}/${pr.repo}#${pr.number} merged`,
    workspaceId: pr.workspaceId,
    meta: { entryId: entry.id },
  });
  emitPullRequestUpdated(pr.workspaceId, {
    id: pr.id,
    taskId: pr.taskId,
    repositoryId: pr.repositoryId,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    state: 'merged',
    lastSummary: pr.lastSummary as Record<string, unknown>,
    mergeQueued: false,
    mergeQueueState: null,
    mergeQueue: null,
  });
  await broadcastMergeQueuePositions(pr.workspaceId);
}

function notifyBlocked(entry: EntrySnapshot, pr: PrEvalRow): void {
  const summary = pr.lastSummary as { title?: string; url?: string } | null;
  emitMergeQueueBlocked(pr.workspaceId, {
    pullRequestId: pr.id,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    title: summary?.title ?? '',
    url: summary?.url ?? '',
    reason: entry.blockedReason ?? 'needs attention',
    attempts: entry.fixAttempts,
  });
}

/**
 * Mirror the entry into the legacy blob + emit the WS badge (legacy shape and
 * the v2 payload side by side). Keeps every desktop build live during the
 * rollout; deleted with the blob columns at cleanup.
 */
async function mirrorToPrRow(entry: EntrySnapshot, pr: PrEvalRow, position: number): Promise<void> {
  const db = getDbClient();
  const terminal = entry.status === 'merged' || entry.status === 'removed';
  await db
    .update(pullRequestsTable)
    .set(
      terminal
        ? { ...QUEUE_RESET_COLUMNS, updatedAt: new Date() }
        : { mergeQueueState: toLegacyStateBlob(entry), updatedAt: new Date() }
    )
    .where(eq(pullRequestsTable.id, pr.id));
  emitPullRequestUpdated(pr.workspaceId, {
    id: pr.id,
    taskId: pr.taskId,
    repositoryId: pr.repositoryId,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    state: pr.state,
    lastSummary: pr.lastSummary as Record<string, unknown>,
    mergeQueued: !terminal,
    mergeQueueState: terminal ? null : toLegacyPublicState(entry, position),
    mergeQueue: terminal ? null : toPublicMergeQueue(entry, position),
  });
}
