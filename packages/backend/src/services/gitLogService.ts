import { AsyncLocalStorage } from 'async_hooks';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { tasks as tasksTable } from '../db/schema.js';
import { emitTaskGitLog } from './websocket.js';
import { patchTaskMetadata } from './taskMetadataMutex.js';

/**
 * One git command's worth of audit data. Stored as a bounded array
 * on `tasks.metadata.gitLog` so the user (and Claude) can see exactly
 * what FastOwl did to their working tree from the desktop's Git tab.
 *
 * stdout/stderr are previewed (first 500 chars) — full output rarely
 * matters for the audit view and would blow up the metadata JSON.
 */
export interface GitLogEntry {
  ts: string;
  command: string;
  cwd?: string;
  exitCode: number;
  stdoutPreview: string;
  stderrPreview: string;
  durationMs: number;
}

const MAX_ENTRIES = 200;

const ctx = new AsyncLocalStorage<{ taskId: string }>();

/**
 * Run `fn` with a task-scoped context so any git command issued from
 * inside (via gitService.executeGitCommand) gets recorded against
 * that task's audit log.
 *
 * Uses AsyncLocalStorage so concurrent /approve calls for different
 * tasks don't tangle their logs together.
 */
export function withTaskGitLog<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  return ctx.run({ taskId }, fn);
}

/**
 * One-way variant of `withTaskGitLog`. Sets the current task context
 * for the rest of this async execution chain — handy in Express
 * handlers where wrapping the whole body in a callback would force a
 * restructure of all the early `return res.xxx` paths.
 *
 * Each request runs in its own async context, so a per-handler
 * `enterTaskGitLog(taskId)` doesn't leak to concurrent requests.
 */
export function enterTaskGitLog(taskId: string): void {
  ctx.enterWith({ taskId });
}

/**
 * Record one git command. Called from gitService after every exec.
 * No-op when no task context is active (e.g. ad-hoc git ops outside
 * the task lifecycle).
 *
 * Routes through `patchTaskMetadata` so that gitLog appends serialize
 * head-of-line against autoCommit / finalFiles / pullRequest /
 * scheduler-rollback writers. Without that shared chain, those
 * writers' RMW landed stale and silently ate gitLog entries (or got
 * eaten themselves, e.g. losing `metadata.autoCommit`).
 */
export async function recordGitCommand(entry: GitLogEntry): Promise<void> {
  const store = ctx.getStore();
  if (!store) return;
  try {
    const result = await patchTaskMetadata(store.taskId, (existing) => {
      const prior = Array.isArray(existing.gitLog)
        ? (existing.gitLog as GitLogEntry[])
        : [];
      const nextEntries = prior.concat(entry).slice(-MAX_ENTRIES);
      return { ...existing, gitLog: nextEntries };
    });
    if (result) {
      emitTaskGitLog(result.workspaceId, store.taskId, entry);
    }
  } catch (err) {
    console.error('[gitLog] failed to record:', err);
  }
}

/**
 * Read the persisted log for a task. Returns the raw array; the
 * route layer adds an envelope.
 */
export async function getGitLog(taskId: string): Promise<GitLogEntry[]> {
  const db = getDbClient();
  const rows = await db
    .select({ metadata: tasksTable.metadata })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const metadata = (rows[0]?.metadata as Record<string, unknown>) ?? {};
  return Array.isArray(metadata.gitLog) ? (metadata.gitLog as GitLogEntry[]) : [];
}
