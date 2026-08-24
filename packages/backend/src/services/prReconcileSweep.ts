import { guardCrossReplica } from './advisoryLock.js';
import { githubService } from './github.js';
import { prMonitorService, createRestSweepCache } from './prMonitor.js';
import { debugBus } from './debugBus.js';
import { graphqlBudget } from './graphqlBudget.js';
import { TickGuard } from './tickGuard.js';
import { pruneStaleCheckStates } from './checkCounts.js';

/**
 * Low-frequency safety net for the webhook pipeline.
 *
 * Webhooks are best-effort: GitHub can drop a delivery, a replica can crash
 * mid-process, and a paused/suspended installation receives nothing while it's
 * off. This sweep re-polls every connected workspace on a long, jittered
 * interval — re-deriving buckets + summaries exactly as a scheduled tick would
 * — so anything a webhook missed self-heals within one sweep. It reuses
 * prMonitor.refreshWorkspaceNow; it does NOT add GitHub load beyond the normal
 * poll (it IS a poll, just slower).
 *
 * The same per-workspace refresh is exposed for on-demand use (install
 * (re)connect, paused→active) via prMonitorService.refreshWorkspaceNow directly.
 */

// 5 min baseline; jitter avoids a thundering herd across replicas/workspaces.
const BASE_INTERVAL_MS = 5 * 60_000;
const JITTER_MS = 60_000;

class PrReconcileSweep {
  private timer: NodeJS.Timeout | null = null;
  private guard = new TickGuard('pr_reconcile_sweep', 10 * 60_000);

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'pr_reconcile_sweep',
      BASE_INTERVAL_MS,
      'Low-frequency full re-poll of every workspace — the webhook safety net for dropped/missed deliveries.',
    );
    const schedule = () => {
      const jitter = Math.floor(JITTER_MS * pseudoJitter());
      this.timer = setTimeout(() => {
        void this.tick().finally(schedule);
      }, BASE_INTERVAL_MS + jitter);
    };
    schedule();
  }

  /** Test entry point — run a single tick synchronously. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.guard.tryBegin()) return;
    const startedAt = Date.now();
    let count = 0;
    let deferred = 0;
    let restClosed = 0;
    let failedWorkspaces = 0;
    let lockSkipped = false;
    try {
      // Cross-replica mutex: two overlapping instances re-polling every
      // workspace at once doubles the heaviest GraphQL consumer for nothing.
      const lock = await guardCrossReplica('prReconcileSweep:tick', async () => {
        const workspaces = githubService.getConnectedWorkspaces();
        count = workspaces.length;
        // Shared across every workspace that needs the REST close-out this
        // tick, so N workspaces watching the same repo make ONE open-list call
        // between them.
        const restCache = createRestSweepCache();
        // The GraphQL-free close-out. Runs whenever the GraphQL poll couldn't —
        // deferred for budget, or failed outright. Spends core REST budget only,
        // and degrades to zero closes (never a mass-close) when REST is gated too.
        const restCloseOut = async (workspaceId: string): Promise<void> => {
          try {
            restClosed += await prMonitorService.sweepClosedViaRest(workspaceId, restCache);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'unknown error';
            console.error(
              `[reconcileSweep] REST close-out for ${workspaceId.slice(0, 8)} failed:`,
              msg
            );
          }
        };
        for (const workspaceId of workspaces) {
          // The sweep is the heaviest, least time-sensitive GraphQL consumer (it
          // re-polls everything). When this account's points budget has fallen
          // into the reserve, skip it this tick — webhooks, the merge queue, and
          // manual refresh keep flowing on the reserved budget, and the next
          // sweep (or the window reset) picks it back up. Prevents the sweep from
          // being the thing that tips an account into a hard RATE_LIMIT error.
          if (graphqlBudget.shouldDefer(githubService.accountKeyFor(workspaceId))) {
            deferred++;
            // Deferral must not mean "no safety net at all": a merged/closed PR
            // whose webhook was dropped would stay on the open list until a
            // manual refresh (this is how an ~8-min GitHub delivery outage in a
            // budget-reserve window played out).
            await restCloseOut(workspaceId);
            continue;
          }
          try {
            // A repo whose poll THREW is the same hole as a deferred one, and
            // it was the bigger one in practice: a poll that dies on a 502 or
            // inside a secondary-rate-limit backoff never reaches its close-out
            // either, and only the budget-reserve branch had a fallback. The
            // poll swallows per-repo errors, so the count is what tells us.
            const { failedRepos } = await prMonitorService.refreshWorkspaceNow(workspaceId);
            if (failedRepos > 0) {
              failedWorkspaces++;
              await restCloseOut(workspaceId);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'unknown error';
            console.error(`[reconcileSweep] workspace ${workspaceId.slice(0, 8)} failed:`, msg);
            failedWorkspaces++;
            await restCloseOut(workspaceId);
          }
        }
        if (deferred > 0 || failedWorkspaces > 0) {
          const parts: string[] = [];
          if (deferred > 0) {
            parts.push(
              `deferred ${deferred} workspace${deferred === 1 ? '' : 's'} — GraphQL budget in reserve`
            );
          }
          if (failedWorkspaces > 0) {
            parts.push(
              `${failedWorkspaces} workspace${failedWorkspaces === 1 ? '' : 's'} had a failing repo poll`
            );
          }
          if (restClosed > 0) parts.push(`REST close-out swept ${restClosed} row(s)`);
          debugBus.recordEvent({
            service: 'pr_reconcile_sweep',
            action: deferred > 0 ? 'deferred' : 'degraded',
            summary: parts.join('; '),
          });
        }
        // TTL safety net for the incremental check-count table — drops any per-check
        // state orphaned by a missed close/force-push delivery so it can't grow
        // unbounded. Close/merge/synchronize prune precisely; this is the backstop.
        await pruneStaleCheckStates().catch((err) => {
          console.error('[reconcileSweep] pruneStaleCheckStates failed:', err);
        });
      });
      lockSkipped = !lock.acquired;
    } catch (err) {
      console.error('[reconcileSweep] tick error:', err instanceof Error ? err.message : err);
    } finally {
      this.guard.end();
      debugBus.pollerTick('pr_reconcile_sweep', {
        durationMs: Date.now() - startedAt,
        ok: true,
        summary: lockSkipped
          ? 'pr_reconcile_sweep skipped — advisory lock held by another instance'
          : `pr_reconcile_sweep — ${count} workspace${count === 1 ? '' : 's'}` +
          (deferred > 0 ? ` (${deferred} deferred: low GraphQL budget)` : '') +
          (failedWorkspaces > 0 ? ` (${failedWorkspaces} with a failing repo poll)` : '') +
          (restClosed > 0 ? ` (REST close-out: ${restClosed} row(s))` : ''),
      });
    }
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Cheap deterministic-ish jitter without Math.random (kept available for
 * resume-safety parity with the rest of the codebase): derive a [0,1) factor
 * from the current minute. Good enough to de-sync replicas.
 */
function pseudoJitter(): number {
  const m = new Date().getTime() % 1000;
  return m / 1000;
}

export const prReconcileSweep = new PrReconcileSweep();
