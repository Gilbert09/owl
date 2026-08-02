import { EventEmitter } from 'events';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  Environment,
  EnvironmentConfig,
  Task,
  TaskPriority,
} from '@talyn/shared';
import { guardCrossReplica } from './advisoryLock.js';
import { captureWorkspaceEvent } from './analytics.js';
import { getCloudProvider } from './cloudProviders/registry.js';
import { fleetRefusalReason, workspaceMayUseFleet } from './cloudProviders/fleetAccess.js';
import { resolveCloudEnvId } from './prCloudFix.js';
import { rowToTask, taskColumnsNoTranscript } from './taskSerialize.js';
import { patchTaskMetadata } from './taskMetadataMutex.js';
import { TickGuard } from './tickGuard.js';
import { emitTaskStatus } from './websocket.js';
import { getDbClient, type Database } from '../db/client.js';
import {
  tasks as tasksTable,
  environments as environmentsTable,
} from '../db/schema.js';

// Priority weights; referenced by the SQL CASE expressions below.
const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  urgent: 1000,
  high: 100,
  medium: 10,
  low: 1,
};
// Silence unused warning: kept as canonical source of the priority order.
void PRIORITY_WEIGHTS;

/**
 * Retry policy for failed dispatches. A failure here is usually provider-side
 * (outage, bad credentials, quota) — worth retrying, but the old behaviour
 * (reset to `queued`, retry every 5s tick, forever) meant one poisoned task
 * hammered the provider indefinitely. Exponential backoff from 10s doubling
 * to a 10-minute cap; 40 attempts spends ~20 minutes ramping then ~34 × 10min
 * ≈ 6 hours at the cap — enough to ride out a multi-hour provider outage
 * unattended, while a genuinely broken task reaches a visible terminal
 * `failed` the same day instead of spinning forever.
 */
export const MAX_DISPATCH_ATTEMPTS = 40;
const DISPATCH_BACKOFF_BASE_MS = 10_000;
const DISPATCH_BACKOFF_CAP_MS = 10 * 60_000;

/** Backoff before attempt `attempts + 1` (exported for tests). */
export function dispatchBackoffMs(attempts: number): number {
  return Math.min(
    DISPATCH_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
    DISPATCH_BACKOFF_CAP_MS
  );
}

/** True while a previously-failed task's backoff window is still open. */
export function isBackingOff(task: Task, now: number): boolean {
  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  const nextAt =
    typeof meta.nextDispatchAttemptAt === 'string'
      ? Date.parse(meta.nextDispatchAttemptAt)
      : NaN;
  return Number.isFinite(nextAt) && nextAt > now;
}

/**
 * Cloud-only task scheduler. Every task is delegated to a cloud provider
 * (PostHog Code today). The queue's whole job is: pick up pending/queued
 * tasks, resolve the provider from the task's assigned cloud-marker env,
 * and call `provider.dispatch`. The provider flips the task to
 * `in_progress` and the cloud poller (cloudProviders/poller.ts) drives it
 * to a terminal state. There is no local agent loop, no working tree, and
 * no concurrency slots — the vendor hosts all of that.
 */
class TaskQueueService extends EventEmitter {
  private processingInterval: NodeJS.Timeout | null = null;
  // Re-entry guard with a wedge watchdog: a plain boolean flag stays held
  // forever if one dispatch await never settles, silently freezing the queue
  // (see tickGuard.ts for the prod incidents behind this pattern).
  private guard = new TickGuard('taskQueue');
  private shuttingDown = false;

  private get db(): Database {
    return getDbClient();
  }

  /** Run a processQueue without logging the "DB client reset" noise
   *  that floats in from afterEach in tests. Anything else still logs. */
  private runProcessQueue(): void {
    if (this.shuttingDown) return;
    this.processQueue().catch((err) => {
      if (this.shuttingDown) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DATABASE_URL is not set')) return;
      console.error('[TaskQueue] processQueue error:', err);
    });
  }

  async init(): Promise<void> {
    this.processingInterval = setInterval(() => {
      this.runProcessQueue();
    }, 5000);
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }

  /** Tests re-use the singleton across describes — let them un-shutdown. */
  resetForTests(): void {
    this.shuttingDown = false;
  }

  async queueTask(taskId: string): Promise<void> {
    await this.db
      .update(tasksTable)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(eq(tasksTable.id, taskId));

    const task = await this.getTask(taskId);
    if (task) emitTaskStatus(task.workspaceId, taskId, 'queued');

    this.runProcessQueue();
  }

  async cancelTask(taskId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(tasksTable)
      .set({ status: 'cancelled', updatedAt: now, completedAt: now })
      .where(eq(tasksTable.id, taskId));

    const task = await this.getTask(taskId);
    if (task) emitTaskStatus(task.workspaceId, taskId, 'cancelled');
  }

  /**
   * Queued tasks ordered by priority weight then by creation time.
   */
  async getQueuedTasks(workspaceId?: string): Promise<Task[]> {
    const priorityCase = sql<number>`CASE ${tasksTable.priority}
      WHEN 'urgent' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      ELSE 4
    END`;

    const whereClause = workspaceId
      ? and(
          inArray(tasksTable.status, ['pending', 'queued']),
          eq(tasksTable.workspaceId, workspaceId)
        )
      : inArray(tasksTable.status, ['pending', 'queued']);

    const rows = await this.db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(whereClause)
      .orderBy(priorityCase, tasksTable.createdAt);

    return rows.map((row) => rowToTask(row));
  }

  async processQueue(): Promise<void> {
    if (!this.guard.tryBegin()) return;

    try {
      // Cross-replica mutex: during a deploy overlap two instances tick this
      // queue — without the lock both dispatch the same queued task.
      const outcome = await guardCrossReplica('taskQueue:dispatch', () =>
        this.dispatchQueuedTasks()
      );
      if (!outcome.acquired) {
        console.log('[TaskQueue] dispatch tick held by another instance — skipping');
      }
    } finally {
      this.guard.end();
    }
  }

  private async dispatchQueuedTasks(): Promise<void> {
    const queuedTasks = await this.getQueuedTasks();
    if (queuedTasks.length === 0) return;

    const now = Date.now();
    const due = queuedTasks.filter((task) => !isBackingOff(task, now));
    if (due.length === 0) return;

    console.log(`[TaskQueue] Processing ${due.length} queued task(s)`);

    for (const task of due) {
      // Per-task isolation: one task whose dispatch pipeline throws (bad
      // metadata, provider bug, DB hiccup) must not starve the rest of the
      // tick — mirrors the per-row try/catch in cloudProviders/poller.ts.
      try {
        await this.dispatchTask(task);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[TaskQueue] dispatch threw for "${task.title}": ${reason}`);
        await this.recordDispatchFailure(task, reason).catch((recordErr) =>
          console.error(
            `[TaskQueue] failed to record dispatch failure for "${task.title}":`,
            recordErr
          )
        );
      }
    }
  }

  private async dispatchTask(task: Task): Promise<void> {
    const env = await this.resolveCloudEnv(task);
    if (!env) {
      // resolveCloudEnv already tried the workspace's configured provider,
      // so reaching here means the workspace has NO connected cloud
      // provider at all — nothing can run it. Leave it queued (visible,
      // not lost) until a provider is connected.
      console.warn(
        `[TaskQueue] task "${task.title}" has no connected cloud provider; skipping`
      );
      return;
    }

    const provider = getCloudProvider(env.type);
    if (!provider) {
      console.warn(
        `[TaskQueue] no provider registered for env type "${env.type}"; skipping "${task.title}"`
      );
      return;
    }

    // The self-hosted fleet is allowlisted by the workspace owner's email.
    // Enforced HERE, at the point of work, rather than by filtering the list
    // the desktop renders: this codebase has already paid for a gate that only
    // existed in the client (services/billing/clientGate.ts), which the CLI,
    // the MCP server and plain curl all walked past silently. Anything that
    // reaches dispatch has to pass, whatever asked for it.
    if (provider.type === 'selfhosted' && !(await workspaceMayUseFleet(task.workspaceId))) {
      const reason = fleetRefusalReason();
      console.warn(`[TaskQueue] refusing to dispatch "${task.title}" to the fleet: ${reason}`);
      // A terminal dispatch failure, not a capacity one: no amount of waiting
      // puts this workspace on the allowlist, so failing it back to another
      // provider (§11.6) would be the wrong shape too. Say so and stop.
      await this.recordDispatchFailure(task, reason, env.type);
      return;
    }

    console.log(
      `[TaskQueue] Dispatching task "${task.title}" to ${provider.displayName}`
    );
    const result = await provider.dispatch(task, env);
    if (!result.ok) {
      await this.recordDispatchFailure(task, result.error, env.type);
    } else {
      // Stamp when the remote run started so finalize can report the
      // actual run duration (vs total time incl. queueing) — and clear the
      // retry bookkeeping so a later re-queue starts a fresh attempt budget.
      await patchTaskMetadata(task.id, (existing) => {
        const {
          dispatchAttempts: _attempts,
          nextDispatchAttemptAt: _nextAt,
          ...rest
        } = existing;
        return { ...rest, dispatchedAt: new Date().toISOString() };
      });
      captureWorkspaceEvent(task.workspaceId, 'task_dispatched', {
        task_id: task.id,
        task_type: task.type,
        provider: env.type,
        priority: task.priority,
        duration_queued_ms: Date.now() - new Date(task.createdAt).getTime(),
      });
    }
  }

  /**
   * Count a failed dispatch attempt: back off exponentially, and after
   * MAX_DISPATCH_ATTEMPTS land the task in a terminal `failed` instead of
   * retrying forever.
   */
  private async recordDispatchFailure(
    task: Task,
    reason: string,
    providerType?: string
  ): Promise<void> {
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const attempts = (Number(meta.dispatchAttempts) || 0) + 1;
    const terminal = attempts >= MAX_DISPATCH_ATTEMPTS;
    console.error(
      `[TaskQueue] dispatch failed for "${task.title}" ` +
        `(attempt ${attempts}/${MAX_DISPATCH_ATTEMPTS}): ${reason}`
    );
    captureWorkspaceEvent(task.workspaceId, 'task_dispatch_failed', {
      task_id: task.id,
      task_type: task.type,
      provider: providerType,
      reason,
      attempts,
      terminal,
    });

    await patchTaskMetadata(task.id, (existing) => {
      const { nextDispatchAttemptAt: _nextAt, ...rest } = existing;
      return {
        ...rest,
        dispatchAttempts: attempts,
        ...(terminal
          ? {}
          : {
              nextDispatchAttemptAt: new Date(
                Date.now() + dispatchBackoffMs(attempts)
              ).toISOString(),
            }),
        lastScheduleError: {
          at: new Date().toISOString(),
          reason,
          attempts,
        },
      };
    });

    const now = new Date();
    await this.db
      .update(tasksTable)
      .set(
        terminal
          ? { status: 'failed', updatedAt: now, completedAt: now }
          : { status: 'queued', updatedAt: now }
      )
      .where(eq(tasksTable.id, task.id));
    emitTaskStatus(task.workspaceId, task.id, terminal ? 'failed' : 'queued');
  }

  /**
   * Resolve the cloud-marker env to dispatch this task to.
   *
   * Prefers the env pinned at creation (the desktop composer always sets one).
   * When none is pinned — tasks created by the CLI, the MCP server, or the
   * generic `POST /tasks` API — we fall back to the workspace's configured
   * cloud provider (its `defaultCloudProvider`, else the standard order) and
   * persist it onto the row. Without this, an env-less task sits `queued`
   * forever because the dispatcher has nothing to call. Returns null only when
   * the workspace genuinely has no connected provider.
   */
  private async resolveCloudEnv(task: Task): Promise<Environment | null> {
    let envId = task.assignedEnvironmentId ?? null;
    if (!envId) {
      envId = await resolveCloudEnvId(task.workspaceId);
      if (envId) {
        await this.db
          .update(tasksTable)
          .set({ assignedEnvironmentId: envId, updatedAt: new Date() })
          .where(eq(tasksTable.id, task.id));
      }
    }
    if (!envId) return null;
    const rows = await this.db
      .select(CLOUD_ENV_COLUMNS)
      .from(environmentsTable)
      .where(eq(environmentsTable.id, envId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return rowToCloudEnv(row);
  }

  async getTask(taskId: string): Promise<Task | null> {
    const rows = await this.db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    return rows[0] ? rowToTask(rows[0]) : null;
  }
}

/**
 * Columns `rowToCloudEnv` actually reads. Projected (rather than `.select()`)
 * so the marker's `config` jsonb is the only blob shipped — and so a future
 * column added to `environments` can't silently leak into this hot dispatch
 * read. The `Pick` type makes `tsc` fail if `rowToCloudEnv` ever reads more.
 */
const CLOUD_ENV_COLUMNS = {
  id: environmentsTable.id,
  name: environmentsTable.name,
  type: environmentsTable.type,
  status: environmentsTable.status,
  config: environmentsTable.config,
} as const;

type CloudEnvRow = Pick<
  typeof environmentsTable.$inferSelect,
  keyof typeof CLOUD_ENV_COLUMNS
>;

/** Build a minimal Environment from a marker row for provider dispatch. */
function rowToCloudEnv(row: CloudEnvRow): Environment {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Environment['type'],
    status: row.status as Environment['status'],
    config: (row.config as EnvironmentConfig) ?? { type: row.type as never },
    renderer: 'structured',
  } as unknown as Environment;
}

export const taskQueueService = new TaskQueueService();
