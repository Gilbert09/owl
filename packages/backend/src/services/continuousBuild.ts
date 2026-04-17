import { v4 as uuid } from 'uuid';
import type {
  BacklogItem,
  BacklogSource,
  ContinuousBuildSettings,
  MarkdownFileBacklogConfig,
  TaskStatus,
} from '@fastowl/shared';
import { DB } from '../db/index.js';
import { backlogService } from './backlog/service.js';
import { domainEvents, type DomainTaskStatusEvent } from './events.js';
import { emitTaskStatus } from './websocket.js';

const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled'];

interface WorkspaceRow {
  id: string;
  settings: string;
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
  private db: DB | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private listener: ((evt: DomainTaskStatusEvent) => void) | null = null;
  private creating = new Set<string>();

  init(db: DB): void {
    this.db = db;
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
    const settings = this.getContinuousBuildSettings(workspaceId);
    if (!settings?.enabled) return;

    const inFlight = this.countInFlight(workspaceId);
    if (inFlight >= Math.max(1, settings.maxConcurrent)) return;

    if (settings.requireApproval && this.countAwaitingReview(workspaceId) > 0) {
      return;
    }

    const sources = backlogService.listSources(workspaceId).filter((s) => s.enabled);
    for (const source of sources) {
      const item = backlogService.nextActionableItem(source.id);
      if (!item) continue;

      this.creating.add(workspaceId);
      try {
        await this.spawnTaskForItem(source, item);
      } finally {
        this.creating.delete(workspaceId);
      }
      return;
    }
  }

  private async onTaskStatus(evt: DomainTaskStatusEvent): Promise<void> {
    const item = backlogService.findByClaimedTask(evt.taskId);
    if (item) {
      if (evt.status === 'completed') {
        backlogService.completeItem(item.id);
      } else if (evt.status === 'failed' || evt.status === 'cancelled') {
        backlogService.releaseItem(item.id);
      }
    }

    if (TERMINAL_STATUSES.includes(evt.status) || evt.status === 'awaiting_review') {
      await this.scheduleNext(evt.workspaceId);
    }
  }

  private async tickAllWorkspaces(): Promise<void> {
    const db = this.requireDb();
    const rows = db.prepare('SELECT id, settings FROM workspaces').all() as WorkspaceRow[];
    for (const row of rows) {
      let settings: ContinuousBuildSettings | undefined;
      try {
        settings = JSON.parse(row.settings)?.continuousBuild;
      } catch {
        continue;
      }
      if (!settings?.enabled) continue;
      await this.scheduleNext(row.id);
    }
  }

  private async spawnTaskForItem(source: BacklogSource, item: BacklogItem): Promise<void> {
    const db = this.requireDb();
    const sourcePath = describeSourcePath(source);
    const title = deriveTitle(item.text);
    const prompt = buildPrompt(sourcePath, item.text);
    const now = new Date().toISOString();
    const taskId = uuid();

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO tasks
           (id, workspace_id, type, status, priority, title, description, prompt,
            repository_id, assigned_environment_id, metadata, created_at, updated_at)
         VALUES (?, ?, 'code_writing', 'queued', 'medium', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        taskId,
        source.workspaceId,
        title,
        item.text,
        prompt,
        source.repositoryId ?? null,
        source.environmentId ?? null,
        JSON.stringify({ backlogSourceId: source.id, backlogItemId: item.id }),
        now,
        now
      );
      backlogService.claimItem(item.id, taskId);
    });
    tx();

    emitTaskStatus(source.workspaceId, taskId, 'queued');
    console.log(
      `[ContinuousBuild] Spawned task ${taskId} for backlog item "${item.text.slice(0, 60)}"`
    );
  }

  private getContinuousBuildSettings(workspaceId: string): ContinuousBuildSettings | undefined {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT settings FROM workspaces WHERE id = ?')
      .get(workspaceId) as { settings: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.settings)?.continuousBuild;
    } catch {
      return undefined;
    }
  }

  private countInFlight(workspaceId: string): number {
    const db = this.requireDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks
         WHERE workspace_id = ?
           AND type = 'code_writing'
           AND status IN ('queued', 'in_progress', 'awaiting_review')`
      )
      .get(workspaceId) as { c: number };
    return row.c;
  }

  private countAwaitingReview(workspaceId: string): number {
    const db = this.requireDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks
         WHERE workspace_id = ? AND status = 'awaiting_review'`
      )
      .get(workspaceId) as { c: number };
    return row.c;
  }

  private requireDb(): DB {
    if (!this.db) throw new Error('ContinuousBuildScheduler not initialized');
    return this.db;
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
  return [
    `Implement the following TODO item from \`${sourcePath}\`:`,
    '',
    itemText,
    '',
    'Read surrounding context in the project before starting. Follow existing conventions.',
    'Make the minimum change required to satisfy the item — do not add unrelated refactors.',
    'Before finishing, run the project checks locally:',
    '  - `npm run typecheck`',
    '  - `npm run lint`',
    '  - `npm test`',
    'All three must pass. When everything looks good, hit "Ready for Review" in FastOwl so a human can approve.',
  ].join('\n');
}
