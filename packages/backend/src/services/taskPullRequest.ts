import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../db/schema.js';
import { githubService } from './github.js';
import { emitTaskUpdate } from './websocket.js';

/**
 * Fire-and-forget: open a GitHub pull request for a just-pushed task
 * branch. Called from /approve after the push succeeds.
 *
 * Title comes from the task's (LLM-refined) title; body composes the
 * original prompt + a FastOwl footer tag.
 *
 * Non-fatal on failure — the task still marks completed. We persist
 * the outcome onto `task.metadata.pullRequest` (success) or
 * `task.metadata.pullRequestError` (failure) so the desktop can
 * surface a "View PR" link or an error banner.
 *
 * Common failure modes and how they surface:
 *   - Workspace has no GitHub integration connected → caught by
 *     github.ts's `missing token` error.
 *   - Branch already has an open PR → GitHub returns 422; we capture
 *     the message.
 *   - Repo URL isn't github.com → we silently skip (no-op).
 */
export async function openPullRequestForTask(taskId: string): Promise<void> {
  try {
    const db = getDbClient();
    const taskRows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    const task = taskRows[0];
    if (!task || !task.branch || !task.repositoryId) return;

    const repoRows = await db
      .select({
        url: repositoriesTable.url,
        defaultBranch: repositoriesTable.defaultBranch,
      })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, task.repositoryId))
      .limit(1);
    const repo = repoRows[0];
    if (!repo) return;
    const parsed = parseGitHubUrl(repo.url);
    if (!parsed) return;

    const body = buildPullRequestBody({
      prompt: task.prompt ?? undefined,
      taskId: task.id,
    });

    const existingMetadata = (task.metadata as Record<string, unknown>) ?? {};

    try {
      const pr = await githubService.createPullRequest(
        task.workspaceId,
        parsed.owner,
        parsed.repo,
        {
          title: task.title,
          head: task.branch,
          base: repo.defaultBranch || 'main',
          body,
        }
      );
      const nextMetadata = {
        ...existingMetadata,
        pullRequest: {
          number: pr.number,
          url: pr.html_url,
          createdAt: new Date().toISOString(),
        },
      };
      // Clear any prior failure marker on retry-success.
      delete (nextMetadata as Record<string, unknown>).pullRequestError;
      await db
        .update(tasksTable)
        .set({ metadata: nextMetadata, updatedAt: new Date() })
        .where(eq(tasksTable.id, task.id));
      emitTaskUpdate(task.workspaceId, task.id, { metadata: nextMetadata });
      console.log(
        `[pr] task ${task.id.slice(0, 8)}: opened ${pr.html_url}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pr] task ${task.id.slice(0, 8)}: create failed · ${msg}`);
      const nextMetadata = { ...existingMetadata, pullRequestError: msg };
      delete (nextMetadata as Record<string, unknown>).pullRequest;
      await db
        .update(tasksTable)
        .set({ metadata: nextMetadata, updatedAt: new Date() })
        .where(eq(tasksTable.id, task.id));
      emitTaskUpdate(task.workspaceId, task.id, { metadata: nextMetadata });
    }
  } catch (err) {
    console.error('[openPullRequestForTask] unexpected failure:', err);
  }
}

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ''),
  };
}

function buildPullRequestBody(opts: {
  prompt?: string;
  taskId: string;
}): string {
  const parts: string[] = [];
  parts.push('_Opened automatically by [FastOwl](https://github.com/Gilbert09/owl)._');
  if (opts.prompt && opts.prompt.trim()) {
    const quoted = opts.prompt
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    parts.push('**Task prompt**\n\n' + quoted);
  }
  parts.push(`_FastOwl task: \`${opts.taskId}\`_`);
  return parts.join('\n\n');
}
