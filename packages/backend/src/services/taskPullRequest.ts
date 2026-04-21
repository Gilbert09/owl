import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../db/schema.js';
import { environmentService } from './environment.js';
import { gitService } from './git.js';
import { githubService } from './github.js';
import { generatePullRequestContent } from './ai.js';
import { emitTaskUpdate } from './websocket.js';

/**
 * Fire-and-forget: open a GitHub pull request for a just-pushed task
 * branch. Called from /approve after the push succeeds.
 *
 * Title + body are LLM-generated via Haiku:
 *   - Title: Conventional Commits format, inferred from the diff.
 *   - Body: if the repo ships a PR template (e.g.
 *     `.github/pull_request_template.md`), the template is filled in;
 *     otherwise Haiku writes a fresh PR description.
 *
 * Outcome persisted onto `task.metadata.pullRequest` (success) or
 * `task.metadata.pullRequestError` (failure). Non-fatal — the task
 * still marks completed on failure. Retryable via /tasks/:id/retry-pr.
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
    if (!task || !task.branch || !task.repositoryId || !task.assignedEnvironmentId) {
      return;
    }

    const repoRows = await db
      .select({
        url: repositoriesTable.url,
        defaultBranch: repositoriesTable.defaultBranch,
        localPath: repositoriesTable.localPath,
      })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, task.repositoryId))
      .limit(1);
    const repo = repoRows[0];
    if (!repo) return;
    const parsed = parseGitHubUrl(repo.url);
    if (!parsed) return;

    const envId = task.assignedEnvironmentId;
    const workingDirectory = repo.localPath ?? undefined;
    const baseBranch = repo.defaultBranch || 'main';

    // Gather diff + diff stat for the LLM. Best-effort — we prefer a
    // rich PR body, but we'll still attempt the PR if these fail.
    let diff = '';
    let diffStat = '';
    let templateContent: string | undefined;
    if (workingDirectory) {
      try {
        [diff, diffStat] = await Promise.all([
          gitService.getDiff(envId, task.branch, baseBranch, workingDirectory),
          gitService.getDiffStat(envId, task.branch, baseBranch, workingDirectory),
        ]);
      } catch (err) {
        console.warn(`[pr] ${taskId.slice(0, 8)}: diff read failed (continuing):`, err);
      }

      templateContent = await findPrTemplate(envId, workingDirectory);
      if (templateContent) {
        console.log(`[pr] ${taskId.slice(0, 8)}: using repo PR template`);
      }
    }

    const { title, body } = await generatePullRequestContent({
      taskTitle: task.title,
      prompt: task.prompt ?? undefined,
      diffStat,
      diff,
      templateContent,
      preferredEnvId: envId,
    });

    const existingMetadata = (task.metadata as Record<string, unknown>) ?? {};

    try {
      const pr = await githubService.createPullRequest(
        task.workspaceId,
        parsed.owner,
        parsed.repo,
        {
          title,
          head: task.branch,
          base: baseBranch,
          body: body || stampFastowlFooter(task.id),
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
      delete (nextMetadata as Record<string, unknown>).pullRequestError;
      await db
        .update(tasksTable)
        .set({ metadata: nextMetadata, updatedAt: new Date() })
        .where(eq(tasksTable.id, task.id));
      emitTaskUpdate(task.workspaceId, task.id, { metadata: nextMetadata });
      console.log(`[pr] task ${task.id.slice(0, 8)}: opened ${pr.html_url}`);
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

/**
 * Look for a PR template file on the env's working directory. GitHub
 * respects these paths (case-insensitive, but the actual files are
 * usually lowercase-or-upper-only so we list both). Returns the file
 * contents, or undefined if no template exists. Uses the env's exec
 * surface so it works for both local + remote daemons.
 */
async function findPrTemplate(
  envId: string,
  workingDirectory: string
): Promise<string | undefined> {
  const candidates = [
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'docs/pull_request_template.md',
    'docs/PULL_REQUEST_TEMPLATE.md',
    'PULL_REQUEST_TEMPLATE.md',
    'pull_request_template.md',
  ];
  for (const path of candidates) {
    try {
      const result = await environmentService.exec(
        envId,
        `test -f ${path} && cat ${path}`,
        { cwd: workingDirectory }
      );
      if (result.code === 0 && result.stdout.trim().length > 0) {
        return result.stdout;
      }
    } catch {
      // Ignore — try next candidate.
    }
  }
  return undefined;
}

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ''),
  };
}

/**
 * Last-resort body when the LLM fails AND the user had no prompt —
 * ensures the PR still carries a tiny traceable footer.
 */
function stampFastowlFooter(taskId: string): string {
  return `_Opened automatically by [FastOwl](https://github.com/Gilbert09/owl). Task: \`${taskId}\`._`;
}
