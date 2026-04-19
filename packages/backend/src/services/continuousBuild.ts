import { v4 as uuid } from 'uuid';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  BacklogItem,
  BacklogSource,
  ContinuousBuildSettings,
  MarkdownFileBacklogConfig,
  TaskStatus,
} from '@fastowl/shared';
import { getDbClient, type Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  tasks as tasksTable,
  backlogItems as backlogItemsTable,
} from '../db/schema.js';
import { backlogService } from './backlog/service.js';
import { environmentService } from './environment.js';
import { domainEvents, type DomainTaskStatusEvent } from './events.js';
import { emitTaskStatus } from './websocket.js';

const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Exponential-ish backoff (in ms) to apply to a backlog item after
 * successive failures. Indexed by failure count.
 *   1st failure → 1 min
 *   2nd       → 5 min
 *   3rd       → 15 min
 *   4+        → 60 min
 *
 * After BLOCK_AFTER_FAILURES consecutive failures the item is marked
 * `blocked` and won't be retried automatically — a human has to
 * unblock it in the UI after fixing whatever's deterministically
 * broken.
 */
const FAILURE_BACKOFF_MS = [0, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const BLOCK_AFTER_FAILURES = 5;

function backoffForFailures(count: number): number {
  if (count <= 0) return 0;
  const idx = Math.min(count, FAILURE_BACKOFF_MS.length - 1);
  return FAILURE_BACKOFF_MS[idx];
}

/**
 * Keeps the task queue warm from a workspace's backlog sources.
 *
 * Subscribes to `task:status` domain events. When a task that was claimed
 * by a backlog item transitions, updates the item state and — if the
 * workspace has Continuous Build enabled — tries to spawn the next item.
 *
 * Also ticks on an interval as a safety net for missed events and in case
 * a source's file changed out from under us.
 */
class ContinuousBuildScheduler {
  private tickTimer: NodeJS.Timeout | null = null;
  private listener: ((evt: DomainTaskStatusEvent) => void) | null = null;
  private creating = new Set<string>();

  private get db(): Database {
    return getDbClient();
  }

  async init(): Promise<void> {
    this.listener = (evt) => {
      this.onTaskStatus(evt).catch((err) =>
        console.error('ContinuousBuildScheduler onTaskStatus error:', err)
      );
    };
    domainEvents.on('task:status', this.listener);

    this.tickTimer = setInterval(() => {
      this.tickAllWorkspaces().catch((err) =>
        console.error('ContinuousBuildScheduler tick error:', err)
      );
    }, 60_000);
  }

  shutdown(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.listener) {
      domainEvents.off('task:status', this.listener);
      this.listener = null;
    }
  }

  /**
   * Public test/manual hook: evaluate whether to spawn the next task in a
   * workspace right now. Called by REST + on every task:status event.
   */
  async scheduleNext(workspaceId: string): Promise<void> {
    if (this.creating.has(workspaceId)) return;
    const settings = await this.getContinuousBuildSettings(workspaceId);
    if (!settings?.enabled) return;

    const inFlight = await this.countInFlight(workspaceId);
    if (inFlight >= Math.max(1, settings.maxConcurrent)) return;

    if (settings.requireApproval && (await this.countAwaitingReview(workspaceId)) > 0) {
      return;
    }

    const sources = (await backlogService.listSources(workspaceId)).filter((s) => s.enabled);
    for (const source of sources) {
      // Skip sources whose target environment is disconnected — spawning a
      // task there would just fail at agent start time and put the item
      // back in the queue.
      if (!(await this.isSourceEnvironmentReady(source))) {
        console.log(
          `[ContinuousBuild] Skipping source ${source.id}: environment not connected`
        );
        continue;
      }

      // Ask the backlog for an item that's out of backoff. We hand it
      // the cutoff "lastFailureAt <= now - backoff_for_current_count"
      // — since the backoff width depends on the per-item failure
      // count, fetch a candidate and re-check its backoff window here.
      const item = await backlogService.nextActionableItem(source.id);
      if (!item) continue;

      const waitMs = backoffForFailures(item.consecutiveFailures);
      if (item.lastFailureAt && waitMs > 0) {
        const readyAt = new Date(item.lastFailureAt).getTime() + waitMs;
        if (Date.now() < readyAt) {
          const secs = Math.ceil((readyAt - Date.now()) / 1000);
          console.log(
            `[ContinuousBuild] Item ${item.id} still in backoff (~${secs}s left); skipping.`
          );
          continue;
        }
      }

      this.creating.add(workspaceId);
      try {
        await this.spawnTaskForItem(source, item);
      } finally {
        this.creating.delete(workspaceId);
      }
      return;
    }
  }

  private async isSourceEnvironmentReady(source: BacklogSource): Promise<boolean> {
    const envId = source.environmentId;
    if (!envId) {
      // No env specified — ready if we have *any* executable fallback:
      // a local env (always ready) or a connected daemon.
      const envs = await environmentService.getAllEnvironments();
      return envs.some(
        (e) => e.type === 'local' || (e.type === 'daemon' && e.status === 'connected')
      );
    }
    const env = await environmentService.getEnvironment(envId);
    if (!env) return false;
    if (env.type === 'local') return true;
    return env.status === 'connected';
  }

  private async onTaskStatus(evt: DomainTaskStatusEvent): Promise<void> {
    const item = await backlogService.findByClaimedTask(evt.taskId);
    if (item) {
      if (evt.status === 'completed') {
        await backlogService.completeItem(item.id);
      } else if (evt.status === 'cancelled') {
        // User-initiated cancel — release the item so it's pickable
        // immediately. Don't count this as a failure.
        await backlogService.releaseItem(item.id);
      } else if (evt.status === 'failed') {
        const failures = await backlogService.releaseItemWithFailure(item.id);
        if (failures >= BLOCK_AFTER_FAILURES) {
          console.warn(
            `[ContinuousBuild] Item ${item.id} ("${item.text.slice(0, 60)}") hit ` +
            `${failures} consecutive failures — blocking. Fix and unblock manually.`
          );
          await backlogService.blockItem(item.id);
        } else {
          const waitMs = backoffForFailures(failures);
          console.log(
            `[ContinuousBuild] Item ${item.id} failed (${failures}/${BLOCK_AFTER_FAILURES}); ` +
            `backing off ${Math.round(waitMs / 1000)}s before retry.`
          );
        }
      }
    }

    if (TERMINAL_STATUSES.includes(evt.status) || evt.status === 'awaiting_review') {
      await this.scheduleNext(evt.workspaceId);
    }
  }

  private async tickAllWorkspaces(): Promise<void> {
    const rows = await this.db
      .select({ id: workspacesTable.id, settings: workspacesTable.settings })
      .from(workspacesTable);
    for (const row of rows) {
      const settings = (row.settings as { continuousBuild?: ContinuousBuildSettings } | null)
        ?.continuousBuild;
      if (!settings?.enabled) continue;
      await this.scheduleNext(row.id);
    }
  }

  private async spawnTaskForItem(source: BacklogSource, item: BacklogItem): Promise<void> {
    const sourcePath = describeSourcePath(source);
    const title = deriveTitle(item.text);
    const prompt = buildPrompt(sourcePath, item.text);
    const now = new Date();
    const taskId = uuid();

    await this.db.transaction(async (tx) => {
      await tx.insert(tasksTable).values({
        id: taskId,
        workspaceId: source.workspaceId,
        type: 'code_writing',
        status: 'queued',
        priority: 'medium',
        title,
        description: item.text,
        prompt,
        repositoryId: source.repositoryId ?? null,
        assignedEnvironmentId: source.environmentId ?? null,
        metadata: { backlogSourceId: source.id, backlogItemId: item.id },
        createdAt: now,
        updatedAt: now,
      });
      // Inline the claim so it's in the same transaction as the insert.
      await tx
        .update(backlogItemsTable)
        .set({ claimedTaskId: taskId, updatedAt: now })
        .where(eq(backlogItemsTable.id, item.id));
    });

    emitTaskStatus(source.workspaceId, taskId, 'queued');
    console.log(
      `[ContinuousBuild] Spawned task ${taskId} for backlog item "${item.text.slice(0, 60)}"`
    );
  }

  private async getContinuousBuildSettings(
    workspaceId: string
  ): Promise<ContinuousBuildSettings | undefined> {
    const rows = await this.db
      .select({ settings: workspacesTable.settings })
      .from(workspacesTable)
      .where(eq(workspacesTable.id, workspaceId))
      .limit(1);
    return (rows[0]?.settings as { continuousBuild?: ContinuousBuildSettings } | null)
      ?.continuousBuild;
  }

  private async countInFlight(workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.workspaceId, workspaceId),
          eq(tasksTable.type, 'code_writing'),
          inArray(tasksTable.status, ['queued', 'in_progress', 'awaiting_review'])
        )
      );
    return rows[0]?.count ?? 0;
  }

  private async countAwaitingReview(workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.workspaceId, workspaceId),
          eq(tasksTable.status, 'awaiting_review')
        )
      );
    return rows[0]?.count ?? 0;
  }
}

export const continuousBuildScheduler = new ContinuousBuildScheduler();

// ---------- helpers ----------

function describeSourcePath(source: BacklogSource): string {
  if (source.config.type === 'markdown_file') {
    const cfg = source.config as MarkdownFileBacklogConfig;
    return cfg.section ? `${cfg.path} (section: ${cfg.section})` : cfg.path;
  }
  return 'backlog source';
}

function deriveTitle(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length <= 80 ? firstLine : firstLine.slice(0, 77) + '...';
}

function buildPrompt(sourcePath: string, itemText: string): string {
  // Autonomous Continuous Build tasks run via
  //   `claude --print --verbose --dangerously-skip-permissions <prompt>`
  // Completion = process exit. See agentService.startAgent() for the
  // rationale on --dangerously-skip-permissions (MCP trust prompts would
  // otherwise block a headless run).
  return [
    `You are working autonomously on a FastOwl Continuous Build task.`,
    `Implement the following TODO item from \`${sourcePath}\`:`,
    '',
    itemText,
    '',
    'Guidance:',
    '- Read surrounding project context before starting (CLAUDE.md, nearby files).',
    '- Follow existing conventions. Make the minimum change required — do not add unrelated refactors.',
    '- Commit your work to the current branch with a descriptive message when complete.',
    '- Before finishing, run the project checks locally and make sure they pass:',
    '    * `npm run typecheck`',
    '    * `npm run lint`',
    '    * `npm test`',
    '- If any check fails, fix the issue before finishing.',
    '- When done, stop responding. Your process exiting is how FastOwl knows the task is complete — a human will review the branch in `awaiting_review` state.',
    '- If you get stuck or need human input, stop responding — the task will land in `awaiting_review` with whatever progress you made, and the reviewer can resume.',
  ].join('\n');
}
