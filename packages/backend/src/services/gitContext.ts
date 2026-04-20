import { eq } from 'drizzle-orm';
import type { Task } from '@fastowl/shared';
import { getDbClient } from '../db/client.js';
import {
  environments as environmentsTable,
  repositories as repositoriesTable,
} from '../db/schema.js';
import { gitService } from './git.js';

export interface TaskGitContext {
  workingDirectory: string;
  baseBranch: string;
  /** True when the working dir came from a registered repositories row. */
  fromRepoRow: boolean;
}

/**
 * Resolve the working directory + base branch a task should run its
 * git operations against. Tries, in order:
 *
 *   1. Registered repo row (`task.repositoryId`) with a `localPath`.
 *   2. The environment's `config.workingDirectory`, if it's a git repo.
 *
 * Returns null when neither source yields a usable git working tree —
 * callers skip all git setup in that case (manual tasks, non-git dirs).
 *
 * This falls back to the env's CWD because in practice users often run
 * tasks without registering a `repositories` row first — the env is
 * already pointing at a checkout, and expecting a dropdown selection
 * before Claude can branch is a bad default.
 */
export async function resolveTaskGitContext(
  task: Pick<Task, 'repositoryId' | 'assignedEnvironmentId'>,
  environmentId: string
): Promise<TaskGitContext | null> {
  const db = getDbClient();

  if (task.repositoryId) {
    const repoRows = await db
      .select({
        localPath: repositoriesTable.localPath,
        defaultBranch: repositoriesTable.defaultBranch,
      })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, task.repositoryId))
      .limit(1);
    const repoRow = repoRows[0];
    if (repoRow?.localPath) {
      return {
        workingDirectory: repoRow.localPath,
        baseBranch: repoRow.defaultBranch || 'main',
        fromRepoRow: true,
      };
    }
  }

  const envRows = await db
    .select({ config: environmentsTable.config })
    .from(environmentsTable)
    .where(eq(environmentsTable.id, environmentId))
    .limit(1);
  const envRow = envRows[0];
  const envWd = (envRow?.config as { workingDirectory?: string } | undefined)
    ?.workingDirectory;
  if (!envWd) return null;

  const isRepo = await gitService.isGitRepo(environmentId, envWd).catch(() => false);
  if (!isRepo) return null;

  const detected = await gitService
    .detectDefaultBranch(environmentId, envWd)
    .catch(() => null);
  if (!detected) return null;

  return {
    workingDirectory: envWd,
    baseBranch: detected,
    fromRepoRow: false,
  };
}
