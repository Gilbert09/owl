import { and, eq } from 'drizzle-orm';
import {
  prNeedsFollowup,
  buildMergeablePrompt,
  normalizeLabelNames,
  type PRMergeableSummary,
} from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import { guardCrossReplica } from './advisoryLock.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { readWorkspaceSettings } from './workspaceSettings.js';
import { createCloudTask } from './taskCreate.js';
import { TaskLimitError } from './billing/entitlements.js';
import { githubService } from './github.js';
import { graphqlBudget } from './graphqlBudget.js';
import { prMonitorService } from './prMonitor.js';
import { emitPullRequestUpdated } from './websocket.js';
import { debugBus } from './debugBus.js';
import { TickGuard } from './tickGuard.js';
import { ACTIVE_STATUSES, linkedTaskStatus, resolveCloudEnv } from './prCloudFix.js';

const POLL_INTERVAL_MS = 60_000;
/** Re-poll a watched PR if its cached summary is older than this. */
const FRESHNESS_MS = 90_000;
/** Pause auto-firing after this many consecutive un-mergeable auto-runs. */
const MAX_ATTEMPTS = 3;
const LABEL_FAILURE_BACKOFF_MS = 15 * 60_000;

interface AutoMergeState {
  attempts: number;
  lastAutoTaskId?: string;
  /** Whether `lastAutoTaskId`'s terminal result has been folded into attempts. */
  accounted?: boolean;
  pausedAt?: string;
  appliedLabels?: string[];
}

// Only the columns this watcher touches — avoids `select()`-ing every PR
// column (and any large one added to the table later) each tick. The `Pick`
// makes the compiler enforce completeness: read a column not listed here and
// tsc fails, so the projection can't silently drift out of sync.
const WATCH_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  repositoryId: pullRequestsTable.repositoryId,
  taskId: pullRequestsTable.taskId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  lastPolledAt: pullRequestsTable.lastPolledAt,
  lastSummary: pullRequestsTable.lastSummary,
  autoKeepMergeable: pullRequestsTable.autoKeepMergeable,
  autoMergeState: pullRequestsTable.autoMergeState,
} as const;

type PRRow = Pick<typeof pullRequestsTable.$inferSelect, keyof typeof WATCH_COLUMNS>;

function readState(row: PRRow): AutoMergeState {
  const s = (row.autoMergeState as AutoMergeState | null) ?? null;
  const applied = s?.appliedLabels;
  return {
    attempts: s?.attempts ?? 0,
    lastAutoTaskId: s?.lastAutoTaskId,
    accounted: s?.accounted ?? true,
    pausedAt: s?.pausedAt,
    appliedLabels: Array.isArray(applied) ? applied.filter((l) => typeof l === 'string') : undefined,
  };
}

export function normalizeWatchLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeLabelNames(value.filter((v): v is string => typeof v === 'string'));
}

/** Compact watcher state for the desktop (toggle + badge). */
function publicState(s: AutoMergeState): { attempts: number; paused: boolean } {
  return { attempts: s.attempts, paused: !!s.pausedAt };
}

/**
 * Keeps every PR with `auto_keep_mergeable = true` in a mergeable state,
 * unattended and indefinitely. Each tick, per enabled open PR:
 *
 *   1. Refresh stale summaries so blocker detection is current, and add any of
 *      the workspace's watch labels (`settings.autoKeepMergeableLabels`) this
 *      PR hasn't received yet.
 *   2. Skip if a run is already in flight (never two at once).
 *   3. Fold the last auto-run's outcome into the attempt counter.
 *   4. Reset the counter whenever the PR is observed mergeable (re-arm) — so a
 *      problem that appears after a clean state gets a fresh batch of attempts.
 *   5. If the PR has a blocker, isn't paused, and nothing's running, fire the
 *      same "take this PR to a clean, mergeable state" cloud run the manual
 *      "Get PR mergeable" button fires.
 *
 * After {@link MAX_ATTEMPTS} consecutive auto-runs that leave the PR
 * un-mergeable, the watcher pauses (surfaced in the UI) until the PR is seen
 * mergeable again or the user toggles it off/on.
 */
class PRAutoMergeWatcher {
  private interval: NodeJS.Timeout | null = null;
  private guard = new TickGuard('prAutoMergeWatcher');
  private labelRetryAt = new Map<string, number>();

  init(): void {
    if (this.interval) return;
    debugBus.registerPoller(
      'auto_merge',
      POLL_INTERVAL_MS,
      'Keeps every PR with auto-keep-mergeable enabled in a mergeable state — refreshes blockers, applies the workspace watch labels, and fires a cloud fix run when a blocker is found, pausing after repeated failed attempts.',
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

  /** Test entry point — run a single tick synchronously. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  _resetLabelRetries(): void {
    this.labelRetryAt.clear();
  }

  private async tick(): Promise<void> {
    if (!this.guard.tryBegin()) return;
    const startedAt = Date.now();
    let watched = 0;
    let tickError: string | undefined;
    let skipRecord = false;
    let lockSkipped = false;
    try {
      // Cross-replica mutex: two overlapping instances would both fire a
      // cloud fix run for the same un-mergeable PR.
      const lock = await guardCrossReplica('prAutoMergeWatcher:tick', async () => {
        const db = getDbClient();
        const rows = await db
          .select(WATCH_COLUMNS)
          .from(pullRequestsTable)
          .where(
            and(
              eq(pullRequestsTable.autoKeepMergeable, true),
              eq(pullRequestsTable.state, 'open')
            )
          );
        watched = rows.length;

        const workspaceLabelsCache = new Map<string, string[]>();
        for (const row of rows) {
          try {
            await this.processPr(row, workspaceLabelsCache);
          } catch (err) {
            // One PR failing must never abort the tick — retry next time.
            console.warn(
              `[prAutoMergeWatcher] failed for PR ${row.owner}/${row.repo}#${row.number}:`,
              err instanceof Error ? err.message : err
            );
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
      console.error('[prAutoMergeWatcher] tick error:', err);
    } finally {
      this.guard.end();
      if (!skipRecord) {
        debugBus.pollerTick('auto_merge', {
          durationMs: Date.now() - startedAt,
          ok: !tickError,
          summary: tickError
            ? `auto_merge tick failed: ${tickError}`
            : lockSkipped
              ? 'auto_merge tick skipped — advisory lock held by another instance'
              : `auto_merge tick — ${watched} watched`,
          error: tickError,
        });
      }
    }
  }

  private async processPr(
    initialRow: PRRow,
    workspaceLabelsCache: Map<string, string[]>
  ): Promise<void> {
    const db = getDbClient();

    // 1. Freshness — refetch a stale summary so we don't fire (or pause) off
    //    outdated blocker state. refreshPr is a no-op if the repo isn't watched.
    let row = initialRow;
    const freshnessStale = Date.now() - new Date(row.lastPolledAt).getTime() > FRESHNESS_MS;
    // Skip this opportunistic re-poll when the account's GraphQL budget is in the
    // reserve (same guard the reconcile sweep uses) — proceed on the existing row
    // rather than burning a scarce point and hard-tripping the rate limit. The
    // next tick (post budget-reset) refetches cleanly.
    if (freshnessStale && !graphqlBudget.shouldDefer(githubService.accountKeyFor(row.workspaceId))) {
      await prMonitorService
        .refreshPr(row.workspaceId, row.owner, row.repo, row.number)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.warn(
            `[prAutoMergeWatcher] freshness refetch failed for ${row.owner}/${row.repo}#${row.number}:`,
            msg
          );
        });
      const reread = await db
        .select(WATCH_COLUMNS)
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, row.id))
        .limit(1);
      if (reread[0]) row = reread[0];
      // The refresh may have flipped the PR to merged/closed.
      if (row.state !== 'open' || !row.autoKeepMergeable) return;
    }

    const summary = row.lastSummary as PRMergeableSummary;
    const needsFollowup = prNeedsFollowup(summary);
    const state = readState(row);

    await this.ensureLabels(row, state, workspaceLabelsCache);

    // 2. Active-task guard — if the linked task is still running, leave it.
    const linkedStatus = await linkedTaskStatus(row.taskId);
    if (linkedStatus && ACTIVE_STATUSES.has(linkedStatus)) return;

    // 3. Account the last auto-run now that it's terminal.
    if (state.lastAutoTaskId && !state.accounted) {
      if (needsFollowup) {
        state.attempts += 1;
        if (state.attempts >= MAX_ATTEMPTS) state.pausedAt = new Date().toISOString();
      } else {
        state.attempts = 0;
        state.pausedAt = undefined;
      }
      state.accounted = true;
      await this.persist(row, state);
    }

    // 4. Re-arm on clean — nothing to fix; reset the guard so a later problem
    //    gets a fresh batch of attempts.
    if (!needsFollowup) {
      if (state.attempts !== 0 || state.pausedAt) {
        state.attempts = 0;
        state.pausedAt = undefined;
        await this.persist(row, state);
      }
      return;
    }

    // 5. Fire — blocker present, nothing running, not paused.
    if (state.pausedAt || state.attempts >= MAX_ATTEMPTS) return;

    const resolved = await resolveCloudEnv(row.workspaceId);
    if (!resolved) return; // No connected cloud provider — can't dispatch.
    const { envId, provider } = resolved;

    const ref = `${row.owner}/${row.repo}#${row.number}`;
    const prTitle = (row.lastSummary as { title?: string } | null)?.title ?? '';
    let created;
    try {
      created = await createCloudTask({
        workspaceId: row.workspaceId,
        type: 'pr_response',
        title: `Get ${ref} mergeable`,
        description: `Auto-keep-mergeable: take ${ref} ("${prTitle}") to a clean, mergeable state.`,
        prompt: buildMergeablePrompt({
          owner: row.owner,
          repo: row.repo,
          number: row.number,
          summary,
          provider,
        }),
        repositoryId: row.repositoryId,
        assignedEnvironmentId: envId,
        pullRequestId: row.id,
      });
    } catch (err) {
      if (err instanceof TaskLimitError) {
        // Free-plan concurrency limit — skip this tick without burning an
        // attempt; the watcher retries once a slot frees up.
        console.log(`[autoKeep] ${ref}: fix run deferred — ${err.message}`);
        return;
      }
      throw err;
    }

    state.lastAutoTaskId = created.id;
    state.accounted = false;
    await this.persist(row, state);
  }

  private async ensureLabels(
    row: PRRow,
    state: AutoMergeState,
    workspaceLabelsCache: Map<string, string[]>
  ): Promise<void> {
    const wanted = await this.labelsFor(row.workspaceId, workspaceLabelsCache);
    const applied = state.appliedLabels ?? [];
    const appliedKeys = new Set(applied.map((l) => l.toLowerCase()));
    const missing = wanted.filter((l) => !appliedKeys.has(l.toLowerCase()));
    if (missing.length === 0) return;

    const repoKey = `${row.workspaceId}:${row.owner.toLowerCase()}/${row.repo.toLowerCase()}`;
    const retryAt = this.labelRetryAt.get(repoKey);
    if (retryAt !== undefined && Date.now() < retryAt) return;

    try {
      await githubService.addPullRequestLabels(
        row.workspaceId,
        row.owner,
        row.repo,
        row.number,
        missing
      );
    } catch (err) {
      this.labelRetryAt.set(repoKey, Date.now() + LABEL_FAILURE_BACKOFF_MS);
      console.warn(
        `[prAutoMergeWatcher] failed to add labels ${JSON.stringify(missing)} to ${row.owner}/${row.repo}#${row.number}:`,
        err instanceof Error ? err.message : err
      );
      return;
    }
    this.labelRetryAt.delete(repoKey);
    state.appliedLabels = [...applied, ...missing];
    await this.persist(row, state);
  }

  private async labelsFor(
    workspaceId: string,
    workspaceLabelsCache: Map<string, string[]>
  ): Promise<string[]> {
    const cached = workspaceLabelsCache.get(workspaceId);
    if (cached) return cached;
    const settings = await readWorkspaceSettings(getDbClient(), workspaceId);
    const wanted = normalizeWatchLabels(settings.autoKeepMergeableLabels);
    workspaceLabelsCache.set(workspaceId, wanted);
    return wanted;
  }

  private async persist(row: PRRow, state: AutoMergeState): Promise<void> {
    const db = getDbClient();
    await db
      .update(pullRequestsTable)
      .set({ autoMergeState: state, updatedAt: new Date() })
      .where(eq(pullRequestsTable.id, row.id));
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      autoKeepMergeable: row.autoKeepMergeable,
      autoMergeState: publicState(state),
    });
  }
}

export const prAutoMergeWatcher = new PRAutoMergeWatcher();
