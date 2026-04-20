import { eq } from 'drizzle-orm';
import type { AgentEvent } from '@fastowl/shared';
import { agentStructuredService } from './agentStructured.js';
import { gitService } from './git.js';
import { emitTaskFilesChanged } from './websocket.js';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../db/schema.js';

/**
 * Tool names that can mutate the working tree. Bash is included
 * because it's the generic escape hatch — `git mv`, `mkdir`,
 * `mv file1 file2`, etc. all pass through it. Pure-read tools like
 * `Read`, `Glob`, `Grep` are intentionally absent: reacting to them
 * would fire the debounce for every file Claude reads, which is tens
 * of events per turn with no actual working-tree change.
 */
const WATCHED_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
]);

const DEBOUNCE_MS = 500;

/**
 * Listens to the structured agent event stream and — when it sees a
 * file-mutating tool_use — schedules a debounced `git` query on the
 * task's env, then broadcasts the resulting file list as
 * `task:files_changed`. Drives the desktop Files tab.
 *
 * Debounce keeps us cheap during tool bursts (Claude running 40
 * `Edit`s back-to-back triggers one git query, not 40).
 */
class TaskFileWatcher {
  private timers = new Map<string, NodeJS.Timeout>();
  private attached = false;

  init(): void {
    if (this.attached) return;
    this.attached = true;

    agentStructuredService.on('event', (run: unknown, event: AgentEvent) => {
      const r = run as { taskId?: string; workspaceId: string };
      if (!r.taskId) return;
      if (!this.isFileMutatingEvent(event)) return;
      this.scheduleRefresh(r.taskId, r.workspaceId);
    });
  }

  shutdown(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private isFileMutatingEvent(event: AgentEvent): boolean {
    // CLI tool_use blocks live inside `message.content` on
    // `type: 'assistant'` events.
    if (event.type !== 'assistant') return false;
    const content = event.message?.content;
    if (!Array.isArray(content)) return false;
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as { type?: string; name?: string };
      if (block.type === 'tool_use' && block.name && WATCHED_TOOLS.has(block.name)) {
        return true;
      }
    }
    return false;
  }

  private scheduleRefresh(taskId: string, workspaceId: string): void {
    const existing = this.timers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      this.refresh(taskId, workspaceId).catch((err) => {
        console.error(`[taskFileWatcher] refresh failed for ${taskId}:`, err);
      });
    }, DEBOUNCE_MS);
    this.timers.set(taskId, timer);
  }

  private async refresh(taskId: string, workspaceId: string): Promise<void> {
    const db = getDbClient();
    const rows = await db
      .select({
        repositoryId: tasksTable.repositoryId,
        environmentId: tasksTable.assignedEnvironmentId,
      })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    const task = rows[0];
    if (!task?.repositoryId || !task?.environmentId) return;

    const repoRows = await db
      .select({
        localPath: repositoriesTable.localPath,
        defaultBranch: repositoriesTable.defaultBranch,
      })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, task.repositoryId))
      .limit(1);
    const repoRow = repoRows[0];
    if (!repoRow?.localPath) return;

    try {
      const files = await gitService.getChangedFiles(
        task.environmentId,
        repoRow.defaultBranch || 'main',
        repoRow.localPath
      );
      emitTaskFilesChanged(workspaceId, taskId, files);
    } catch (err) {
      // Env disconnects, network blips — silent. The next file-
      // mutating tool_use will trigger another refresh attempt.
      console.warn(`[taskFileWatcher] getChangedFiles failed for ${taskId}:`, err);
    }
  }
}

export const taskFileWatcher = new TaskFileWatcher();
