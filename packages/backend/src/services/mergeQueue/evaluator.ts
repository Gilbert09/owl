// Merge queue v2 — the group evaluator.
//
// Evaluation is per-(repo, base) GROUP, triggered by events (fresh snapshot,
// check flush, task terminal, membership change) and by the reconciler. There
// is NO global tick and NO lock at all: distinct groups evaluate fully in
// parallel, a hung evaluation stalls only its own group (45s timeout), and
// concurrency safety — in-process AND cross-replica — is the CAS version on
// every entry write (see evaluateGroupOnce for why an advisory lock here was
// removed: it pinned a pool connection across GitHub calls and starved
// Supavisor under load).
//
// The walk itself carries v1's hard-won semantics verbatim: FIFO from the
// head, `hold` consumes the group's turn (one same-base merge in flight),
// `advance` skips past entries that can't make progress so a blocked head
// never gates the PRs behind it.

import { inArray } from 'drizzle-orm';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { pullRequests as pullRequestsTable } from '../../db/schema.js';
import { githubService } from '../github.js';
import { githubRateGate } from '../githubRateGate.js';
import { getExternalMergeGate } from '../repoMergeGate.js';
import { debugBus } from '../debugBus.js';
import {
  closeActiveEntry,
  computeEntryPositions,
  getMergeQueueMode,
  loadActiveGroup,
  touchEvaluated,
} from './store.js';
import { evaluateEntry, PR_EVAL_COLUMNS, type PrEvalRow } from './executor.js';
import { resolveStackParents } from './stack.js';

/** Hard bound on one group evaluation — a hung GitHub call must not hold the
 *  group's coalescing slot (or its advisory lock) for minutes. Abandoned work
 *  is harmless: every write is CAS-guarded and the reconciler retries. */
export const GROUP_EVALUATION_TIMEOUT_MS = 45_000;

interface GroupState {
  running: boolean;
  /** A trigger arrived mid-evaluation — run once more when this one ends. */
  dirty: boolean;
  triggers: Set<string>;
}

const groups = new Map<string, GroupState>();

/** Engine flag cache — triggers fire on every PR refresh, so don't pay a
 *  settings read per event. 5s TTL keeps cutover latency negligible. */

/**
 * Schedule an evaluation of one (repo, base) group. Coalescing: triggers for
 * a running group mark it dirty and it re-runs once at the end — a CI burst
 * of 30 check webhooks costs one extra evaluation, not 30.
 */
export function scheduleGroupEvaluation(
  repositoryId: string,
  baseBranch: string,
  trigger: string
): void {
  const key = `${repositoryId}|${baseBranch}`;
  const state = groups.get(key);
  if (state?.running) {
    state.dirty = true;
    state.triggers.add(trigger);
    return;
  }
  const fresh: GroupState = { running: true, dirty: false, triggers: new Set([trigger]) };
  groups.set(key, fresh);
  // ESCAPE THE OWNER SCOPE. A schedule call from a request handler would
  // otherwise propagate the request's scoped TRANSACTION handle (via
  // AsyncLocalStorage) into this detached evaluation — and by the time it
  // runs, that transaction has committed, so every query on it hangs until
  // the 45s timeout or dies with 25P02. The pipeline always runs on the pool.
  runWithoutScope(() => void runGroupLoop(key, repositoryId, baseBranch, fresh));
}

async function runGroupLoop(
  key: string,
  repositoryId: string,
  baseBranch: string,
  state: GroupState
): Promise<void> {
  try {
    // Loop while triggers keep arriving; each pass is one evaluation.
    do {
      state.dirty = false;
      const trigger = [...state.triggers].join('+') || 'unknown';
      state.triggers.clear();
      await evaluateGroupOnce(repositoryId, baseBranch, trigger);
    } while (state.dirty);
  } catch (err) {
    console.warn(
      `[mergeQueueV2] group evaluation failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
  } finally {
    groups.delete(key);
    // A trigger that landed between the last pass and the delete re-schedules
    // via its own scheduleGroupEvaluation call — nothing is lost (and the
    // reconciler backstops any race).
  }
}

/** Awaitable single evaluation — tests and direct callers that need the
 *  result settled before proceeding (the scheduled path is fire-and-forget).
 *  Scope-escaped like the scheduled path: the pipeline never runs on a
 *  request's transaction handle. */
export async function evaluateGroupNow(
  repositoryId: string,
  baseBranch: string,
  trigger: string
): Promise<void> {
  await runWithoutScope(() => evaluateGroupOnce(repositoryId, baseBranch, trigger));
}

async function evaluateGroupOnce(
  repositoryId: string,
  baseBranch: string,
  trigger: string
): Promise<void> {
  // NO advisory lock here — deliberately. The per-group lock this originally
  // held was a POOL TRANSACTION spanning the entire walk, which in eager mode
  // includes GitHub merge PUTs, signing/capability probes, and cloud-task
  // dispatches: tens of seconds per evaluation, evaluation after evaluation.
  // Under a real backlog that pinned enough Supavisor connections to starve
  // the pool (dbWatchdog probes >3s, webhook/sweep upserts stalling — the
  // 2026-07-17 stale-merged-rows incident). Cross-replica overlap during a
  // deploy doesn't need the lock for correctness: every pipeline write is a
  // CAS on entry.version (a losing evaluation stops at casLost), merges are
  // guarded by verify-live + verify-merged, and fix-run dispatch dedupes via
  // the shared task guards. Worst case, the seconds-long overlap wastes a few
  // duplicate reads.
  await withTimeout(
    walkGroup(repositoryId, baseBranch, trigger),
    GROUP_EVALUATION_TIMEOUT_MS,
    `${repositoryId}|${baseBranch}`
  );
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T | void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[mergeQueueV2] group ${label} evaluation timed out after ${ms}ms — abandoning`);
      debugBus.recordEvent({
        service: 'merge_queue',
        action: 'evaluation_timeout',
        ok: false,
        summary: `group ${label} evaluation timed out after ${Math.round(ms / 1000)}s`,
      });
      resolve();
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function walkGroup(repositoryId: string, baseBranch: string, trigger: string): Promise<void> {
  const db = getPoolDbClient();
  const entries = await loadActiveGroup(repositoryId, baseBranch, db);
  if (entries.length === 0) return;

  // One query for every PR row in the group (explicit projection).
  const prRows = await db
    .select(PR_EVAL_COLUMNS)
    .from(pullRequestsTable)
    .where(
      inArray(
        pullRequestsTable.id,
        entries.map((e) => e.pullRequestId)
      )
    );
  const prById = new Map<string, PrEvalRow>(prRows.map((r) => [r.id, r]));

  // While the group's GitHub account is in a REST backoff, every merge-path
  // call inside the walk would sleep behind waitIfBlocked — defer the whole
  // group to the reconciler instead (v1's between-heads deferral).
  const workspaceId = entries[0]!.workspaceId;
  // 'ordered' (default): FIFO, first hold consumes the group's turn, one
  // merge in flight per group. 'eager': every entry is its own head — clean
  // ones merge/arm immediately, blocked ones remediate concurrently, and the
  // walk never stops early. The decision engine is untouched; eager is purely
  // "evaluate each entry as a group of one".
  const mode = await getMergeQueueMode(workspaceId, db);
  // A base behind an external merge queue is ALWAYS eager, whatever the
  // workspace mode says: that system does the ordering and batching, so holding
  // sibling PRs behind our own head just adds its whole test cycle (~40min on
  // posthog/posthog) to every PR in the group for no serialization benefit.
  const sample = prRows[0];
  const externalGate = sample
    ? await getExternalMergeGate(workspaceId, sample.owner, sample.repo, baseBranch)
    : null;
  const eager = mode === 'eager' || externalGate !== null;
  const accountKey = githubService.accountKeyFor(workspaceId);
  if (githubRateGate.isBlocked(accountKey, 'rest')) {
    debugBus.recordEvent({
      service: 'merge_queue',
      action: 'group_deferred',
      summary: `group ${repositoryId}|${baseBranch} deferred — REST rate gate blocked`,
      workspaceId,
    });
    return;
  }

  // Who owns this group's base branch? One query for the whole walk — the
  // group key IS the base branch, so every entry here shares the answer. A
  // stack member's parent is what R4b parks it behind and retargets it off.
  const stackParents = await resolveStackParents(repositoryId, workspaceId, [baseBranch], db);
  const stackParent = stackParents.get(baseBranch) ?? null;

  const positions = computeEntryPositions(entries);
  const evaluated: string[] = [];
  // Entries that left this group mid-walk (their PR was retargeted). Their new
  // group must be scheduled explicitly — every trigger for them keys on the
  // base they just left, so nothing else would ever walk them again.
  const movedBases = new Set<string>();
  // A sibling counts as "merge in flight" while merging, while its entry is
  // armed, or while GitHub still holds ANY armed auto-merge on it (the
  // armedBy mirror can outlive the status during remediation) — merging past
  // it would invalidate the CI GitHub is about to merge on. Seeded from the
  // loaded rows and kept CURRENT during the walk: an earlier entry arming in
  // this very walk must gate the ones behind it.
  const inFlight = (e: { status: string; automergeArmedBy: string | null }) =>
    e.status === 'merging' || e.status === 'automerge_armed' || e.automergeArmedBy !== null;
  const inFlightIds = new Set(entries.filter(inFlight).map((e) => e.id));
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const pr = prById.get(entry.pullRequestId);
    if (!pr) {
      // PR row deleted under the entry (workspace/repo teardown mid-flight —
      // the FK cascade usually removes the entry with it, but a row deleted
      // via a path that didn't cascade leaves an orphan; close it out).
      await closeActiveEntry(
        entry.pullRequestId,
        'removed',
        { trigger, message: 'PR row disappeared — removing from the queue.', code: 'orphaned' },
        db
      );
      continue;
    }
    // Eager mode: no sibling gates a merge, and every entry may arm/merge as
    // if it were the head. GitHub still serializes the actual base updates —
    // a sibling that goes BEHIND after a merge just re-evaluates on its own
    // snapshot event.
    const groupMergeInFlight = eager ? false : [...inFlightIds].some((id) => id !== entry.id);
    let verdict: 'hold' | 'advance' = 'hold';
    try {
      const result = await evaluateEntry({
        entry,
        pr,
        position: positions.get(entry.id) ?? i + 1,
        isHead: eager || (evaluated.length === 0 && i === 0),
        groupMergeInFlight,
        trigger,
        stackParent,
      });
      if (result.casLost) {
        // Someone newer is writing this group — stop walking; their
        // evaluation (or the reconciler) owns it now.
        return;
      }
      verdict = result.verdict;
      if (result.movedToBase && result.movedToBase !== baseBranch) {
        movedBases.add(result.movedToBase);
      }
      if (result.finalEntry) {
        if (inFlight(result.finalEntry)) inFlightIds.add(entry.id);
        else inFlightIds.delete(entry.id);
      }
    } catch (err) {
      // One entry failing must never abort the group — log and end the turn.
      console.warn(
        `[mergeQueueV2] evaluation failed for ${pr.owner}/${pr.repo}#${pr.number}:`,
        err instanceof Error ? err.message : err
      );
    }
    evaluated.push(entry.id);
    // Ordered mode: the first 'hold' consumes the group's turn (one same-base
    // merge per evaluation). Eager mode: keep walking — every entry gets its
    // shot this evaluation.
    if (!eager && verdict === 'hold') break;
  }
  await touchEvaluated(evaluated, db);
  // Scheduled from the evaluator, not the executor: the executor must not
  // import this module (evaluator -> executor is the only legal direction).
  for (const moved of movedBases) {
    scheduleGroupEvaluation(repositoryId, moved, `${trigger}:base-changed`);
  }
}
