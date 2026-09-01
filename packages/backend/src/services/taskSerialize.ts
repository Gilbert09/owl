import type { Task, TaskType, TaskStatus, TaskPriority } from '@talyn/shared';
import { tasks as tasksTable } from '../db/schema.js';

/**
 * Every `tasks` column EXCEPT the heavy `transcript` jsonb (the cloud-run
 * conversation log, often MBs). List reads use this projection so they never
 * pull the transcript out of Postgres — `rowToTask` drops it anyway without
 * `includeTranscript`, so selecting it was pure egress waste. Endpoints that
 * genuinely return the transcript (single-task GET) select the full row.
 */
export const taskColumnsNoTranscript = {
  id: tasksTable.id,
  workspaceId: tasksTable.workspaceId,
  type: tasksTable.type,
  status: tasksTable.status,
  priority: tasksTable.priority,
  title: tasksTable.title,
  description: tasksTable.description,
  prompt: tasksTable.prompt,
  assignedEnvironmentId: tasksTable.assignedEnvironmentId,
  repositoryId: tasksTable.repositoryId,
  pullRequestId: tasksTable.pullRequestId,
  branch: tasksTable.branch,
  result: tasksTable.result,
  metadata: tasksTable.metadata,
  createdAt: tasksTable.createdAt,
  updatedAt: tasksTable.updatedAt,
  completedAt: tasksTable.completedAt,
} as const;

type TaskRow = typeof tasksTable.$inferSelect;

/**
 * Map a `tasks` DB row to the shared `Task` shape the desktop renders.
 *
 * Lives here (not in `routes/tasks.ts`) so the route AND `taskCreate` can both
 * serialize without a route↔service import cycle — `taskCreate` needs it to
 * broadcast the `task:created` WS event with the same shape the REST list/get
 * endpoints return.
 *
 * `transcript` is optional on the input: list reads project it away (see
 * {@link taskColumnsNoTranscript}) and never set `includeTranscript`.
 */
export function rowToTask(
  row: Omit<TaskRow, 'transcript'> & { transcript?: TaskRow['transcript'] },
  opts: { includeTranscript?: boolean } = {}
): Task {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    title: row.title,
    description: row.description,
    prompt: row.prompt ?? undefined,
    repositoryId: row.repositoryId ?? undefined,
    branch: row.branch ?? undefined,
    assignedEnvironmentId: row.assignedEnvironmentId ?? undefined,
    result: (row.result as Task['result']) ?? undefined,
    metadata: (row.metadata as Task['metadata']) ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
    transcript: opts.includeTranscript
      ? ((row.transcript as Task['transcript']) ?? undefined)
      : undefined,
  };
}
