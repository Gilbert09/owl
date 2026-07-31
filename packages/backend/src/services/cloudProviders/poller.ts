import { and, eq, gte, or, sql } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { tasks as tasksTable } from '../../db/schema.js';
import { readCloudTaskProvider } from '@talyn/shared';
import { getCloudProvider } from './registry.js';
import { isWatched } from './taskWatch.js';
import { debugBus } from '../debugBus.js';
import { TickGuard } from '../tickGuard.js';
import { ThrottleBackoff, throttleRetryAfterMs } from './throttleBackoff.js';
import type { CloudTaskRow } from './types.js';

const POLL_INTERVAL_MS = 10_000;

/**
 * How long after a task is finalised we keep re-checking whether its remote run
 * has resumed. A cloud run that goes idle waiting on CI/review can be
 * optimistically completed by a provider (see PostHog's `maybeFinalizeIdle`) and
 * then resume when the wait clears; we revive it to `in_progress` when it does.
 * 24h is the ceiling for a legitimate suspension — past that the remote sandbox
 * is abandoned and will never resume, so we stop tracking the task as a candidate.
 */
const REVIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Drives every in-progress cloud task to a terminal state. Each tick it
 * loads `in_progress` tasks, resolves the owning provider from the task's
 * metadata, and hands the row to `provider.reconcile`. Provider-specific
 * status mapping / transcript streaming / PR linking all live inside the
 * provider; this loop is just the scheduler. One provider today (PostHog
 * Code); Codex/Claude slot in with no change here.
 */
class CloudTaskPoller {
  private interval: NodeJS.Timeout | null = null;
  private guard = new TickGuard('cloudPoller');
  /** Per-workspace rate-limit cooldowns; pruned each tick to workspaces that
   *  still have in-flight tasks, so it can't grow unbounded. */
  private throttle = new ThrottleBackoff();

  init(): void {
    if (this.interval) return;
    debugBus.registerPoller(
      'cloud_task',
      POLL_INTERVAL_MS,
      'Drives every in-progress cloud task (e.g. PostHog Code) to a terminal state — loads in-progress tasks and asks the owning provider to reconcile status, transcript, and PR linkage.',
    );
    this.interval = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  shutdown(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Enter (or escalate) a workspace's rate-limit cooldown and log once per
   * entry — replacing the per-task 429 warn storm.
   */
  private enterThrottleCooldown(
    workspaceId: string,
    retryAfterMs: number | null,
    now: number,
  ): void {
    const { backoffMs, consecutive, honoredRetryAfter } = this.throttle.record(
      workspaceId,
      retryAfterMs,
      now,
    );
    console.warn(
      `[cloudPoller] workspace ${workspaceId.slice(0, 8)} rate-limited by provider — ` +
        `backing off ${Math.round(backoffMs / 1000)}s (attempt ${consecutive}` +
        `${honoredRetryAfter ? ', honoring Retry-After' : ''})`,
    );
  }

  private async tick(): Promise<void> {
    if (!this.guard.tryBegin()) return;
    const startedAt = Date.now();
    let reconciled = 0;
    let throttledSkips = 0;
    let tickError: string | undefined;
    let skipRecord = false;
    let lockSkipped = false;
    try {
      // Cross-replica mutex: overlapping instances double-reconcile the same
      // run (duplicate transcript ingests / finalizations) without it.
      const lock = await guardCrossReplica('cloudPoller:tick', async () => {
        const db = getDbClient();
        // Only the columns the scheduler needs. Crucially we compute the
        // transcript's emptiness in Postgres rather than selecting the
        // `transcript` jsonb — that blob is the cloud-run conversation log
        // (often MBs) and pulling it every 10s for every in-flight task was the
        // dominant source of database egress. The CASE mirrors the old JS check
        // `!Array.isArray(t) || t.length === 0`: only an array runs through
        // `jsonb_array_length` (so it never throws on a non-array), and null /
        // non-array values fall to the `ELSE true` (empty) branch.
        // In-flight tasks, plus revival candidates: tasks a provider
        // optimistically finalised while the remote run was still active
        // (`metadata.reviveEligible`) and completed within the revive window. A
        // provider's reconcile re-checks a candidate and flips it back to
        // `in_progress` if its remote run has since resumed. The flag keeps this
        // set tiny — genuinely-completed tasks (remote reached a terminal state)
        // never carry it, so they're not re-polled.
        const reviveCutoff = new Date(Date.now() - REVIVE_WINDOW_MS);
        const rows = await db
          .select({
            id: tasksTable.id,
            workspaceId: tasksTable.workspaceId,
            title: tasksTable.title,
            repositoryId: tasksTable.repositoryId,
            metadata: tasksTable.metadata,
            status: tasksTable.status,
            completedAt: tasksTable.completedAt,
            transcriptEmpty: sql<boolean>`CASE WHEN jsonb_typeof(${tasksTable.transcript}) = 'array' THEN jsonb_array_length(${tasksTable.transcript}) = 0 ELSE true END`,
          })
          .from(tasksTable)
          .where(
            or(
              eq(tasksTable.status, 'in_progress'),
              and(
                eq(tasksTable.status, 'completed'),
                gte(tasksTable.completedAt, reviveCutoff),
                sql`${tasksTable.metadata} @> '{"reviveEligible":true}'::jsonb`,
              ),
            ),
          );
        reconciled = rows.length;

        // Drop cooldowns for workspaces with no in-flight tasks left, so the
        // map stays bounded to what's actually being polled.
        this.throttle.pruneTo(new Set(rows.map((r) => r.workspaceId)));

        const now = Date.now();
        // Deduplicates the warning below to one line per unknown provider per
        // tick, so a backlog of tasks on one unregistered provider cannot
        // flood the log every poll interval.
        const unregistered = new Set<string>();

        for (const row of rows) {
          // Skip every task in a rate-limited workspace until its cooldown
          // expires — one 429 shouldn't re-fire a request per sibling task.
          if (this.throttle.isCoolingDown(row.workspaceId, now)) {
            throttledSkips++;
            continue;
          }

          const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
          const providerType = readCloudTaskProvider({ metadata });
          const provider = getCloudProvider(providerType);
          if (!provider) {
            // No registered provider for this id. The task cannot be
            // reconciled by this process and will sit in_progress until
            // something else moves it, so say so once per provider per tick
            // rather than skipping in silence — a task stuck forever with no
            // log line is close to undiagnosable. Reasons this happens: a
            // provider gated off by an env flag, or a task written by a newer
            // deploy that knows a provider this one does not.
            if (providerType && !unregistered.has(providerType)) {
              unregistered.add(providerType);
              console.warn(
                `[cloudPoller] no provider registered for "${providerType}" (task ${row.id}); ` +
                  'leaving it in progress'
              );
            }
            continue;
          }

          const taskRow: CloudTaskRow = {
            id: row.id,
            workspaceId: row.workspaceId,
            title: row.title,
            repositoryId: row.repositoryId,
            metadata,
            transcriptEmpty: row.transcriptEmpty,
            watched: isWatched(row.id),
            status: row.status as CloudTaskRow['status'],
            completedAt: row.completedAt,
          };

          try {
            await provider.reconcile(taskRow);
            // Healthy again — lift any lingering cooldown for this workspace.
            this.throttle.clear(row.workspaceId);
          } catch (err) {
            const retryAfterMs = throttleRetryAfterMs(err);
            if (retryAfterMs !== undefined) {
              this.enterThrottleCooldown(row.workspaceId, retryAfterMs, now);
            } else {
              // Transient API hiccups are fine — retry next tick. A single
              // failed poll must never fail the task.
              console.warn(
                `[cloudPoller] reconcile failed for task ${row.id.slice(0, 8)}:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }
      });
      lockSkipped = !lock.acquired;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DATABASE_URL is not set')) {
        skipRecord = true;
        return;
      }
      tickError = msg;
      console.error('[cloudPoller] tick error:', err);
    } finally {
      this.guard.end();
      if (!skipRecord) {
        debugBus.pollerTick('cloud_task', {
          durationMs: Date.now() - startedAt,
          ok: !tickError,
          summary: tickError
            ? `cloud_task tick failed: ${tickError}`
            : lockSkipped
              ? 'cloud_task tick skipped — advisory lock held by another instance'
              : `cloud_task tick — ${reconciled} in-flight${
                  throttledSkips ? `, ${throttledSkips} skipped (rate-limit backoff)` : ''
                }`,
          error: tickError,
        });
      }
    }
  }
}

export const cloudTaskPoller = new CloudTaskPoller();
