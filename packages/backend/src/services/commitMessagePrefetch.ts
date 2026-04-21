import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { tasks as tasksTable } from '../db/schema.js';
import { gitService } from './git.js';
import { resolveTaskGitContext } from './gitContext.js';
import { generateCommitMessage } from './ai.js';
import { emitTaskUpdate } from './websocket.js';

/**
 * Fire-and-forget: when a task lands in awaiting_review, kick off the
 * LLM commit-message generation in the background and persist it to
 * `task.metadata.proposedCommitMessage`. The desktop's approve modal
 * then has a message ready the instant it opens instead of waiting
 * 3–5s for a daemon CLI round-trip.
 *
 * No-ops when the task has no branch/env/repo — the approve flow
 * would refuse the commit anyway, so nothing to pre-fetch.
 */
export async function prefetchCommitMessage(taskId: string): Promise<void> {
  try {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    const task = rows[0];
    if (!task) return;
    if (!task.branch || !task.assignedEnvironmentId) return;

    const gitContext = await resolveTaskGitContext(
      {
        repositoryId: task.repositoryId ?? undefined,
        assignedEnvironmentId: task.assignedEnvironmentId,
      },
      task.assignedEnvironmentId
    );
    if (!gitContext) return;

    const [diffStat, diff] = await Promise.all([
      gitService.getDiffStat(
        task.assignedEnvironmentId,
        task.branch,
        gitContext.baseBranch,
        gitContext.workingDirectory
      ),
      gitService.getDiff(
        task.assignedEnvironmentId,
        task.branch,
        gitContext.baseBranch,
        gitContext.workingDirectory
      ),
    ]);

    const message = await generateCommitMessage({
      title: task.title,
      prompt: task.prompt ?? undefined,
      diffStat,
      diff,
      preferredEnvId: task.assignedEnvironmentId,
    });

    const existingMetadata = (task.metadata as Record<string, unknown>) ?? {};
    const nextMetadata = { ...existingMetadata, proposedCommitMessage: message };
    await db
      .update(tasksTable)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(tasksTable.id, taskId));

    emitTaskUpdate(task.workspaceId, taskId, { metadata: nextMetadata });
  } catch (err) {
    console.warn(`[prefetchCommitMessage] failed for ${taskId}:`, err);
  }
}
