import { AsyncLocalStorage } from 'async_hooks';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { tasks as tasksTable } from '../db/schema.js';
import { emitTaskGitLog } from './websocket.js';

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
 */
export async function recordGitCommand(entry: GitLogEntry): Promise<void> {
  const store = ctx.getStore();
  if (!store) return;
  await appendEntry(store.taskId, entry).catch((err) => {
    console.error('[gitLog] failed to record:', err);
  });
}

async function appendEntry(taskId: string, entry: GitLogEntry): Promise<void> {
  const db = getDbClient();
  const rows = await db
    .select({
      metadata: tasksTable.metadata,
      workspaceId: tasksTable.workspaceId,
    })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) return;

  const metadata = (row.metadata as Record<string, unknown>) ?? {};
  const existing = Array.isArray(metadata.gitLog)
    ? (metadata.gitLog as GitLogEntry[])
    : [];
  const next = existing.concat(entry).slice(-MAX_ENTRIES);

  await db
    .update(tasksTable)
    .set({
      metadata: { ...metadata, gitLog: next },
      updatedAt: new Date(),
    })
    .where(eq(tasksTable.id, taskId));

  emitTaskGitLog(row.workspaceId, taskId, entry);
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
