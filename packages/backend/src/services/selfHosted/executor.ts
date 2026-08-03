import { eq } from 'drizzle-orm';
import { readCloudTaskMeta, type CloudTaskMetadata, type Environment, type Task } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable, repositories as repositoriesTable } from '../../db/schema.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus } from '../websocket.js';
import { githubService } from '../github.js';
import { FleetCapacityError, FleetClient } from './client.js';
import { getSelfHostedCredentials, resolveFleetTarget } from './credentials.js';

// Re-exported, not redeclared. A second definition of this contract is how the
// two drift: the shared one grew a `capacity` discriminator and this copy
// silently did not, so the value the fail-back routes on could not be set.
import type { DispatchResult } from '../cloudProviders/types.js';

export type { DispatchResult };

/**
 * The publishing instruction is load-bearing, not boilerplate.
 *
 * The first real fleet run did its work correctly and then could not ship it:
 * `posthog/posthog` requires verified signatures, so every `git push` came back
 * `GH013: Commits must have verified signatures`. There is no signing key in the
 * VM and there must not be one. The agent then spent minutes probing GitHub API
 * routes looking for a way through — all correctly refused by the credential
 * proxy — and in the process created an empty review draft it could not delete.
 *
 * `fleet-publish` is the way through: it asks the credential proxy to create the
 * commit through GitHub's API, which signs it server-side. Telling the agent
 * that git push WILL fail matters as much as telling it the alternative exists,
 * because an agent that believes push should work treats the refusal as
 * something to route around.
 */
const SYSTEM_PROMPT =
  'You are a coding agent working in an isolated microVM with the repository checked out. ' +
  'Make the requested change and open a pull request. ' +
  'Keep the change minimal and focused on what was asked; do not refactor unrelated code.\n\n' +
  'PUBLISHING YOUR WORK: do not use `git push`. It will be rejected on any repository that ' +
  'requires verified signatures, and there is no signing key in this VM by design. ' +
  'Instead run `fleet-publish --branch <branch> --message "<headline>" [--body "<longer text>"]`, ' +
  'which publishes your working tree as one commit that GitHub signs server-side. ' +
  'It diffs against the merge-base with the default branch, so commit locally or not as you prefer — ' +
  'only the final file contents matter. Then open the PR with the GitHub API as usual.\n\n' +
  'BRINGING A PR UP TO DATE WITH ITS BASE: try these in order and stop at the first that ' +
  'works. (1) `PUT /repos/{owner}/{repo}/pulls/{n}/update-branch`. (2) `POST /repos/{owner}/{repo}/merges` ' +
  'merging the base branch into the head branch. Both make GitHub perform the merge server-side, so ' +
  'the result is signed, and both refuse when the merge is not clean — a refusal means there is a real ' +
  'conflict, not that you used them wrongly. (3) Only if both refuse: resolve the conflict in the working ' +
  'tree, `fleet-publish` the result to a NEW scratch branch, then ' +
  '`fleet-publish --move-branch <the PR head branch> --oid <the sha you just published>`. ' +
  'Rung 3 rewrites the PR branch and discards its previous commits, so do not reach for it while (1) or ' +
  '(2) would have worked. Never move the repository default branch; the fleet will refuse.\n\n' +
  'git and the GitHub API are already authenticated — there are no credentials in this VM and you ' +
  'do not need any. Some API endpoints are deliberately unreachable; if one is refused, that is a ' +
  'policy decision, not an obstacle to work around. Do not probe for alternatives, and never use a ' +
  'request that creates state (a review, a comment, a ref) to test whether something is permitted.\n\n' +
  'When done, state the URL of the pull request you opened.';

/**
 * Derive the fleet run id from the task id.
 *
 * Deterministic on purpose: the fleet is idempotent on runId (fleet spec
 * §11.5), so a redelivered webhook that re-dispatches the same task cannot
 * spawn a second microVM. A random id here would silently double-spend.
 */
export function fleetRunIdForTask(taskId: string): string {
  return `talyn-${taskId}`;
}

/**
 * Hand a task to the self-hosted fleet: POST a run and let the fleet own the
 * agent loop. The poller drives the local task to completed / failed.
 *
 * Idempotent: a task already carrying a `cloudTask.remoteTaskId` is a no-op.
 */
export async function dispatchTaskToFleet(task: Task, env: Environment): Promise<DispatchResult> {
  if (readCloudTaskMeta(task)?.remoteTaskId) return { ok: true };

  const creds = await getSelfHostedCredentials(task.workspaceId);
  if (!creds) {
    return {
      ok: false,
      error:
        'Talyn Fleet is not configured for this workspace — add your Claude OAuth token in workspace settings.',
    };
  }

  // Fetched fresh each dispatch so a re-connected or rotated token is current.
  // It goes backend -> fleetd only; the fleet's credential proxy injects it
  // host-side and it never enters the microVM (fleet spec §8).
  const githubToken = githubService.getAccessToken(task.workspaceId);
  if (!githubToken) {
    return {
      ok: false,
      error: 'Connect GitHub for this workspace — the fleet uses it to clone the repo and open the PR.',
    };
  }

  if (!task.repositoryId) {
    return { ok: false, error: 'Talyn Fleet tasks require a repository.' };
  }
  const repo = await resolveRepository(task.repositoryId);
  if (!repo) {
    return { ok: false, error: 'Could not resolve a GitHub owner/repo for this task’s repository.' };
  }

  const prompt = task.prompt?.trim() || task.description?.trim() || task.title;
  const runId = fleetRunIdForTask(task.id);

  try {
    // The TARGET, not just a client: the run's metadata records which box took
    // it, and "which box" is now the registry's answer rather than a string the
    // workspace stored. Reading it off the resolved target is the only way that
    // stays true — a remembered endpoint would name the host that was picked
    // the day the credential was saved.
    const target = await resolveFleetTarget(task.workspaceId);
    if (!target) return { ok: false, error: 'Talyn Fleet is not configured for this workspace.' };
    const client = new FleetClient(target.endpoint, target.token);

    const run = await client.createRun({
      runId,
      workspaceId: task.workspaceId,
      taskType: task.type === 'pr_response' ? 'pr_response' : 'code_writing',
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      model: modelFromTask(task) ?? modelFromEnv(env),
      repo: { slug: repo.slug, baseBranch: repo.defaultBranch },
      githubToken,
      // Always sent, never optional. The workspace's own Claude credential is
      // the only LLM key in play — the fleet has no house key to fall back on.
      anthropicKey: creds.claudeToken,
    });

    const cloudTask: CloudTaskMetadata = {
      provider: 'selfhosted',
      remoteTaskId: run.id,
      remoteRunId: run.id,
      status: run.status ?? 'queued',
      extra: { repo: repo.slug, endpoint: target.endpoint, ...(target.host ? { host: target.host } : {}) },
    };
    await patchTaskMetadata(task.id, (existing) => ({ ...existing, cloudTask }));

    await getDbClient()
      .update(tasksTable)
      .set({ status: 'in_progress', assignedEnvironmentId: env.id, updatedAt: new Date() })
      .where(eq(tasksTable.id, task.id));
    emitTaskStatus(task.workspaceId, task.id, 'in_progress');

    console.log(`[selfhosted] task ${task.id.slice(0, 8)} → run ${run.id} (${repo.slug})`);
    return { ok: true };
  } catch (err) {
    if (err instanceof FleetCapacityError) {
      // Availability, not failure: the task is fine and another provider can
      // run it. `capacity` is what the task queue routes on (§10.7, §11.6) —
      // the message stays human-readable for the UI but nothing branches on it.
      return { ok: false, error: `No fleet capacity: ${err.message}`, capacity: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function resolveRepository(
  repositoryId: string,
): Promise<{ slug: string; defaultBranch: string } | null> {
  const rows = await getDbClient()
    .select({
      url: repositoriesTable.url,
      name: repositoriesTable.name,
      defaultBranch: repositoriesTable.defaultBranch,
    })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.id, repositoryId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const slug = parseGitHubSlug(row.url) ?? sanitizeSlug(row.name);
  if (!slug) return null;
  return { slug, defaultBranch: row.defaultBranch || 'main' };
}

function parseGitHubSlug(url: string): string | null {
  const match = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
}

function sanitizeSlug(name: string): string | null {
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : null;
}

function modelFromTask(task: Task): string | undefined {
  const m = (task.metadata as Record<string, unknown> | null)?.model;
  return typeof m === 'string' && m ? m : undefined;
}

function modelFromEnv(env: Environment): string | undefined {
  return (env.config as { model?: string } | null)?.model;
}
