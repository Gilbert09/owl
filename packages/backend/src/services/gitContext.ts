import { eq } from 'drizzle-orm';
import type { Task } from '@fastowl/shared';
import { getDbClient } from '../db/client.js';
import { repositories as repositoriesTable } from '../db/schema.js';

export interface TaskGitContext {
  workingDirectory: string;
  baseBranch: string;
}

/**
 * Resolve the working directory + base branch a task should run its
 * git operations against, from its registered `repositories` row.
 * Returns null when the task has no repo assigned or the repo has no
 * `localPath` — callers must surface a clear error so the user knows
 * to configure the local path in Settings.
 */
export async function resolveTaskGitContext(
  task: Pick<Task, 'repositoryId' | 'assignedEnvironmentId'>,
  _environmentId: string
): Promise<TaskGitContext | null> {
  if (!task.repositoryId) return null;
  const db = getDbClient();
  const rows = await db
    .select({
      localPath: repositoriesTable.localPath,
      defaultBranch: repositoriesTable.defaultBranch,
    })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.id, task.repositoryId))
    .limit(1);
  const row = rows[0];
  if (!row?.localPath) return null;
  return {
    workingDirectory: row.localPath,
    baseBranch: row.defaultBranch || 'main',
  };
}
