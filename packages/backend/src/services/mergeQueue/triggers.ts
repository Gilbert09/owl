// Merge queue v2 — trigger wiring.
//
// Subscribes to the in-process domain-event bus and turns state changes into
// group evaluations. This is the module that replaces the 10s poll: the
// events ARE the schedule. Everything is fire-and-forget and no-ops while the
// v1 engine drives (cheap cached flag check), so the pipeline ships dormant.
//
// Sources → evaluations:
//   pr:snapshot   — fresh PR summary written (webhook refresh, poll, patch).
//                   Evaluates the PR's own entry-group; a terminal snapshot
//                   also evaluates its (repo, base) group (the group-advance
//                   case: a same-base sibling merged, promote the next head).
//   pr:checks     — incremental check counts flushed (check_run fast lane).
//                   The "checks settled → merge/arm now" moment.
//   task:status   — a cloud task went terminal: account the queue's fix run,
//                   and re-evaluate anything deferred on the task limit.
//   route         — enqueue/dequeue call onQueueMembershipChanged directly.

import { runWithoutScope } from '../../db/client.js';
import {
  domainEvents,
  type DomainPrChecksEvent,
  type DomainPrSnapshotEvent,
  type DomainTaskStatusEvent,
} from '../events.js';
import {
  getActiveEntriesByFixTask,
  getActiveEntriesForPrs,
  getActiveEntryForPr,
  hasActiveEntries,
  headBranchOfPr,
} from './store.js';
import { scheduleGroupEvaluation } from './evaluator.js';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

let initialized = false;

export function initMergeQueueTriggers(): void {
  if (initialized) return;
  initialized = true;
  // Every handler is scope-escaped: domain events are often emitted from
  // inside a request's withOwnerScope transaction (prCache upserts on refresh
  // routes, the queue toggle), and AsyncLocalStorage would otherwise hand
  // these detached handlers the request's transaction — dead by the time
  // they run (hangs / 25P02). The pipeline always works on the pool.
  domainEvents.on('pr:snapshot', (evt) =>
    runWithoutScope(() => void handlePrSnapshot(evt).catch(swallow('pr:snapshot')))
  );
  domainEvents.on('pr:checks', (evt) =>
    runWithoutScope(() => void handlePrChecks(evt).catch(swallow('pr:checks')))
  );
  domainEvents.on('task:status', (evt) =>
    runWithoutScope(() => void handleTaskStatus(evt).catch(swallow('task:status')))
  );
}

function swallow(source: string) {
  return (err: unknown) =>
    console.warn(
      `[mergeQueueV2] ${source} trigger failed:`,
      err instanceof Error ? err.message : err
    );
}

async function handlePrSnapshot(evt: DomainPrSnapshotEvent): Promise<void> {
  const entry = await getActiveEntryForPr(evt.prId);
  if (entry) {
    scheduleGroupEvaluation(entry.repositoryId, entry.baseBranch, evt.trigger);
  }
  // Group advance: a PR that just merged/closed un-blocks the (repo, base)
  // group even when IT wasn't queued (an external same-base merge makes every
  // sibling BEHIND — the group must re-evaluate its head now, not in 2min).
  if (
    evt.state !== 'open' &&
    evt.baseBranch &&
    (!entry || entry.baseBranch !== evt.baseBranch) &&
    (await hasActiveEntries(evt.repositoryId, evt.baseBranch))
  ) {
    scheduleGroupEvaluation(evt.repositoryId, evt.baseBranch, `${evt.trigger}:group-advance`);
  }
  // Stack advance: this PR's HEAD branch is the group key of every entry
  // stacked on it. NOTHING else schedules that group when the parent lands —
  // every trigger those entries have keys on the base they are parked on, which
  // is this PR's head, and this PR's own events are about a different pair.
  // Without this the whole stack sits parked until the 2-minute reconciler.
  if (evt.state !== 'open') {
    const headBranch = evt.headBranch || (await headBranchOfPr(evt.prId));
    if (headBranch && (await hasActiveEntries(evt.repositoryId, headBranch))) {
      scheduleGroupEvaluation(
        evt.repositoryId,
        headBranch,
        `${evt.trigger}:stack-advance`
      );
    }
  }
}

async function handlePrChecks(evt: DomainPrChecksEvent): Promise<void> {
  const entries = await getActiveEntriesForPrs(evt.prs.map((p) => p.prId));
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.repositoryId}|${entry.baseBranch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scheduleGroupEvaluation(entry.repositoryId, entry.baseBranch, 'webhook:check_run');
  }
}

async function handleTaskStatus(evt: DomainTaskStatusEvent): Promise<void> {
  if (!TERMINAL_TASK_STATUSES.has(evt.status)) return;
  // The queue's own fix run finished → account it (decide R8). NOTE: a freed
  // task slot also un-defers TaskLimit-held entries in this workspace — the
  // reconciler's 2-minute staleness sweep covers those; wiring an owner-level
  // fan-out here isn't worth the query.
  const entries = await getActiveEntriesByFixTask(evt.taskId);
  for (const entry of entries) {
    scheduleGroupEvaluation(entry.repositoryId, entry.baseBranch, 'task:terminal');
  }
}

/** Direct hook for the enqueue/dequeue route (no event round-trip needed).
 *  Scope-escaped: the route fires this without awaiting it, so it must never
 *  inherit the request's transaction handle. */
export async function onQueueMembershipChanged(prId: string, trigger: string): Promise<void> {
  await runWithoutScope(async () => {
    const entry = await getActiveEntryForPr(prId);
    if (entry) scheduleGroupEvaluation(entry.repositoryId, entry.baseBranch, trigger);
  });
}
