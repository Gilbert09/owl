// Merge queue v2 — the reconcile backstop.
//
// The webhooks drive the queue; this 60s loop only catches what they can't:
// dropped deliveries, evaluations abandoned by the timeout/CAS guards,
// rate-gate deferrals, entries wedged in `merging` by a crash (verify-merged
// runs on their next evaluation), and TaskLimit-deferred entries whose slot
// freed without a task:status fan-out. Plus hygiene: orphaned entries whose
// PR left `open` outside the pipeline, and 30-day terminal pruning.

import { and, eq, ne, notInArray, sql } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { mergeQueueEntries, pullRequests as pullRequestsTable } from '../../db/schema.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { disableAutoMerge } from '../githubAutoMerge.js';
import { debugBus } from '../debugBus.js';
import { TickGuard } from '../tickGuard.js';
import {
  closeActiveEntry,
  loadStaleGroups,
  pruneTerminalEntries,
  TERMINAL_STATUSES,
} from './store.js';
import { scheduleGroupEvaluation } from './evaluator.js';

const RECONCILE_INTERVAL_MS = 60_000;
/** A `merging` marker older than this is a crashed attempt — re-evaluate. */
const MERGING_STALE_MS = 60_000;
/** Nothing may sit unexamined longer than this (the dropped-webhook net). */
const EVALUATED_STALE_MS = 2 * 60_000;
const PRUNE_TERMINAL_DAYS = 30;

class MergeQueueReconciler {
  private interval: NodeJS.Timeout | null = null;
  private guard = new TickGuard('mergeQueueReconciler');

  init(): void {
    if (this.interval) return;
    debugBus.registerPoller(
      'merge_queue_reconcile',
      RECONCILE_INTERVAL_MS,
      'Merge queue v2 backstop — re-evaluates stale/wedged queue entries the webhook triggers missed, heals entries whose PR left open outside the pipeline, and prunes 30-day-old terminal history. Dormant while the v1 engine drives.',
    );
    // Jitter the first tick so overlapping replicas don't sweep in lockstep.
    const jitter = Math.floor(Math.random() * 5_000);
    setTimeout(() => {
      this.interval = setInterval(() => void this.tick(), RECONCILE_INTERVAL_MS);
      void this.tick();
    }, jitter);
  }

  shutdown(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test entry point — run a single tick synchronously. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.guard.tryBegin()) return;
    const startedAt = Date.now();
    let summaryText = '';
    let tickError: string | undefined;
    let skipRecord = false;
    try {
      // The lock transaction covers ONLY the cheap DB work — the pending
      // disarms make GitHub calls and run AFTER it, so no pool connection is
      // ever pinned across network I/O (the eager-mode pool-starvation
      // lesson; disarms are idempotent, so a deploy-overlap double-run is
      // harmless).
      const lock = await guardCrossReplica('mergeQueueV2:reconcile', async () => {
        const healed = await this.healOrphans();
        const groups = await loadStaleGroups({
          mergingStaleMs: MERGING_STALE_MS,
          evaluatedStaleMs: EVALUATED_STALE_MS,
        });
        for (const g of groups) {
          scheduleGroupEvaluation(g.repositoryId, g.baseBranch, 'reconcile');
        }
        const pruned = await pruneTerminalEntries(PRUNE_TERMINAL_DAYS);
        return { healed, groups: groups.length, pruned };
      });
      const disarmed = lock.acquired ? await this.retryPendingDisarms() : 0;
      summaryText = !lock.acquired
        ? 'merge_queue_reconcile tick skipped — advisory lock held by another instance'
        : `merge_queue_reconcile — ${lock.result!.groups} stale group(s) scheduled` +
          (lock.result!.healed ? `, ${lock.result!.healed} orphan(s) healed` : '') +
          (disarmed ? `, ${disarmed} pending disarm(s) retried` : '') +
          (lock.result!.pruned ? `, ${lock.result!.pruned} terminal entr(ies) pruned` : '');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DATABASE_URL is not set')) {
        skipRecord = true;
        return;
      }
      tickError = msg;
      console.error('[mergeQueueReconciler] tick error:', err);
    } finally {
      this.guard.end();
      if (!skipRecord) {
        debugBus.pollerTick('merge_queue_reconcile', {
          durationMs: Date.now() - startedAt,
          ok: !tickError,
          summary: tickError ? `merge_queue_reconcile failed: ${tickError}` : summaryText,
          error: tickError,
        });
      }
    }
  }

  /**
   * Retry disarms that failed at their trigger (dequeue, block transition).
   * A Talyn-armed auto-merge left dangling on GitHub merges a PR the queue no
   * longer owns — this sweep guarantees it eventually clears. Works on
   * terminal entries too (a dequeue closes the entry before flagging).
   */
  private async retryPendingDisarms(): Promise<number> {
    const db = getDbClient();
    const pending = await db
      .select({
        entryId: mergeQueueEntries.id,
        workspaceId: mergeQueueEntries.workspaceId,
        owner: pullRequestsTable.owner,
        repo: pullRequestsTable.repo,
        nodeId: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'nodeId'`,
      })
      .from(mergeQueueEntries)
      .innerJoin(pullRequestsTable, eq(pullRequestsTable.id, mergeQueueEntries.pullRequestId))
      .where(eq(mergeQueueEntries.pendingDisarm, true));
    let cleared = 0;
    for (const row of pending) {
      const ok = row.nodeId
        ? await disableAutoMerge({
            workspaceId: row.workspaceId,
            owner: row.owner,
            repo: row.repo,
            nodeId: row.nodeId,
          })
        : false;
      if (ok) {
        await db
          .update(mergeQueueEntries)
          .set({ pendingDisarm: false, automergeArmedAt: null, automergeArmedBy: null, updatedAt: new Date() })
          .where(eq(mergeQueueEntries.id, row.entryId));
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Close out active entries whose PR row left `open` through a path that
   * never touched the pipeline (a sweep, a manual GitHub merge discovered by
   * the poll, a workspace teardown that didn't cascade).
   */
  private async healOrphans(): Promise<number> {
    const db = getDbClient();
    const orphans = await db
      .select({
        prId: mergeQueueEntries.pullRequestId,
        prState: pullRequestsTable.state,
      })
      .from(mergeQueueEntries)
      .innerJoin(pullRequestsTable, eq(pullRequestsTable.id, mergeQueueEntries.pullRequestId))
      .where(
        and(
          notInArray(mergeQueueEntries.status, TERMINAL_STATUSES),
          ne(pullRequestsTable.state, 'open')
        )
      );
    for (const orphan of orphans) {
      await closeActiveEntry(
        orphan.prId,
        orphan.prState === 'merged' ? 'merged' : 'removed',
        {
          trigger: 'reconcile',
          code: 'orphan_heal',
          message: `PR is ${orphan.prState} — closing the queue entry.`,
        },
        db
      );
    }
    return orphans.length;
  }
}

export const mergeQueueReconciler = new MergeQueueReconciler();
