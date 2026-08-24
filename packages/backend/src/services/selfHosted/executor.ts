import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_FLEET_MODEL_ID,
  fleetProviderForModel,
  isStoredFleetModelId,
  readCloudTaskMeta,
  type CloudTaskMetadata,
  type Environment,
  type Task,
} from '@talyn/shared';
import { reconcileDefaultBranch } from '../repoDefaultBranch.js';
import { getDbClient } from '../../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus } from '../websocket.js';
import { githubService } from '../github.js';
import {
  FleetCapacityError,
  FleetClient,
  FleetDispatchUncertainError,
  type CreateSandboxInput,
  type FleetSandbox,
} from './client.js';
import { cloudStatusForSandbox } from './poller.js';
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
 * Derive the fleet sandbox id from the task id.
 *
 * Deterministic on purpose: the fleet is idempotent on the caller-chosen id
 * (fleet spec §11.5), so a redelivered webhook that re-dispatches the same
 * task cannot spawn a second microVM. A random id here would silently
 * double-spend. The name keeps "run": this is still the runId of the
 * credential-pull wire, and the id contract must not move with the merge.
 */
export function fleetRunIdForTask(taskId: string): string {
  return `talyn-${taskId}`;
}

/**
 * How many times a dispatch that got 504 `dispatch_uncertain` is re-sent.
 *
 * The control plane lost the host's answer; the sandbox MAY exist. The only
 * safe move is the SAME id again — the create is idempotent on it — and never
 * another provider, which could run the task twice. Bounded so a gateway that
 * is genuinely down does not hold the queue tick hostage.
 */
const DISPATCH_UNCERTAIN_RETRIES = 2;
const DISPATCH_UNCERTAIN_DELAY_MS = 2_000;

/**
 * Hand a task to the self-hosted fleet: POST an ephemeral sandbox whose
 * initial task is the prompt, and let the fleet own the agent loop. The
 * poller drives the local task to completed / failed.
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
  const repo = await resolveRepository(task.repositoryId, task.workspaceId);
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

    // Per-task override, then the workspace's Settings → Talyn Fleet choice,
    // then the environment's, then the default. Explicit rather than letting
    // the SDK decide: an unset model was served by Opus 5 on every turn, which
    // is how fleet runs came to cost ~$15.85 each.
    const model =
      modelFromTask(task) ??
      (await workspaceFleetModel(task.workspaceId)) ??
      modelFromEnv(env) ??
      DEFAULT_FLEET_MODEL_ID;

    // The model decides the provider, and the provider decides what the microVM
    // can reach: the host builds the sandbox's egress route table from it, so a
    // dispatch at an OpenAI model has no route to Anthropic's API at all.
    // Sent explicitly rather than left to the host's default — the route table
    // should be the one this dispatch chose.
    const provider = fleetProviderForModel(model);

    const { sandbox, host } = await createSandboxRetryingUncertain(client, {
      id: runId,
      workspaceId: task.workspaceId,
      // Ephemeral is what a run was: the host stops and retires the sandbox
      // the moment its initial task reaches a terminal state.
      ephemeral: true,
      task: {
        taskType: task.type === 'pr_response' ? 'pr_response' : 'code_writing',
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        model,
        provider,
        repo: { slug: repo.slug, baseBranch: repo.defaultBranch },
      },
      githubToken,
      // The credential for this dispatch's provider, and only that one. Always
      // sent, never optional: the workspace's own key is the only one in play,
      // and the fleet has no house key to fall back on — it refuses a dispatch
      // that arrives without one rather than booting a guest that cannot call
      // out.
      ...(provider === 'openai'
        ? { openaiKey: creds.openaiKey ?? '' }
        : { anthropicKey: creds.claudeToken }),
    });

    // WHICH BOX IS RUNNING THIS, from whichever party actually knows.
    //
    // Dialling a host directly, the registry chose it and `target.host` says so.
    // Through the gateway the registry chose nothing — the gateway placed it —
    // so the name arrives on the create's response and `host` carries it.
    //
    // Recorded because it is an authorization input, not a label: when that
    // host's fleetd restarts it asks us for this run's credentials back, and
    // `resolveRunCredentials` answers only for a run dispatched TO THE ASKING
    // HOST. A row with no host refuses every pull, and the run goes on failing
    // every LLM call for the rest of its deadline. It is also what the operator
    // console's host column and host filter read.
    const fleetHost = target.host ?? host;
    if (!fleetHost) {
      // Not fatal — the run is dispatched and will do its work. Said out loud
      // because the consequence surfaces much later and somewhere else: the
      // credential pull after a fleetd restart, refused, with nothing at the
      // refusal naming this moment.
      console.warn(
        `[fleet] dispatch of ${runId} recorded no host (endpoint ${target.endpoint}); ` +
          'a credential pull after a host restart will be refused. ' +
          'The gateway names the host in X-Fleet-Host — is it too old to send one?',
      );
    }
    const cloudTask: CloudTaskMetadata = {
      provider: 'selfhosted',
      remoteTaskId: sandbox.id,
      remoteRunId: sandbox.id,
      status: cloudStatusForSandbox(sandbox),
      extra: { repo: repo.slug, endpoint: target.endpoint, ...(fleetHost ? { host: fleetHost } : {}) },
    };
    await patchTaskMetadata(task.id, (existing) => ({ ...existing, cloudTask }));

    await getDbClient()
      .update(tasksTable)
      .set({ status: 'in_progress', assignedEnvironmentId: env.id, updatedAt: new Date() })
      .where(eq(tasksTable.id, task.id));
    emitTaskStatus(task.workspaceId, task.id, 'in_progress');

    console.log(`[selfhosted] task ${task.id.slice(0, 8)} → sandbox ${sandbox.id} (${repo.slug})`);
    return { ok: true };
  } catch (err) {
    if (err instanceof FleetCapacityError) {
      // Availability, not failure: the task is fine and another provider can
      // run it. `capacity` is what the task queue routes on (§10.7, §11.6).
      //
      // The message is written FOR A USER and deliberately does not include
      // err.message, which carries the host's private endpoint — a tailnet
      // address has no business in a customer-facing banner. The detail is
      // already in the log line and on the debug bus for whoever is debugging.
      console.warn(`[fleet] capacity refusal dispatching ${task.id}: ${err.message}`);
      return {
        ok: false,
        error:
          err.reason === 'unreachable'
            ? 'The self-hosted runners are not reachable right now.'
            : 'All self-hosted runners are busy.',
        capacity: true,
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The repo to run against, with its default branch CHECKED rather than trusted.
 *
 * `repositories.default_branch` is hardcoded to 'main' by addWatchedRepo and
 * was never corrected, so a master-defaulted repo carried a branch that does
 * not exist. That is survivable for a run — the agent clones and works it out —
 * and fatal for a golden, whose identity is `(repo, baseBranch)`: the bake
 * cloned `--branch main`, git said "Remote branch main not found", and
 * PostHog/posthog silently never got an image, on every single dispatch.
 *
 * Reconciling here rather than only at add-time is deliberate: every row that
 * already exists is wrong, and a migration cannot ask GitHub. The first
 * dispatch after this ships repairs the row.
 */
async function resolveRepository(
  repositoryId: string,
  workspaceId: string,
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

  const defaultBranch = await reconcileDefaultBranch({
    repositoryId,
    workspaceId,
    url: row.url,
    stored: row.defaultBranch,
  });
  return { slug, defaultBranch };
}

function parseGitHubSlug(url: string): string | null {
  const match = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
}

function sanitizeSlug(name: string): string | null {
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : null;
}

/**
 * The workspace's Settings → Talyn Fleet model choice, or undefined when unset
 * or unrecognised. Extracted in SQL so the settings jsonb never ships.
 *
 * An unrecognised value falls through to the next source rather than to the
 * default: a workspace that pinned a model the picker no longer offers should
 * keep whatever its environment says, not be quietly moved.
 */
async function workspaceFleetModel(workspaceId: string): Promise<string | undefined> {
  const db = getDbClient();
  const [row] = await db
    .select({ model: sql<string | null>`${workspacesTable.settings} ->> 'fleetModel'` })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return isStoredFleetModelId(row?.model) ? row.model : undefined;
}

/**
 * POST the create, re-sending the SAME id on 504 `dispatch_uncertain`.
 *
 * That status means the control plane lost the host's answer: the sandbox may
 * or may not exist, and the create is idempotent on the id, so re-asking is
 * always safe and anything else is not — failing back to another provider here
 * could run the task twice. If the retries run out the error propagates as a
 * plain (non-capacity) failure, which is the honest answer: nobody knows
 * whether the work started, so nothing may re-dispatch it elsewhere.
 */
async function createSandboxRetryingUncertain(
  client: FleetClient,
  input: CreateSandboxInput,
): Promise<{ sandbox: FleetSandbox; host?: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.createSandbox(input);
    } catch (err) {
      if (!(err instanceof FleetDispatchUncertainError) || attempt >= DISPATCH_UNCERTAIN_RETRIES) {
        throw err;
      }
      console.warn(
        `[fleet] dispatch of ${input.id} uncertain (attempt ${attempt + 1}): ${err.message} — retrying the same id`,
      );
      await new Promise((r) => setTimeout(r, DISPATCH_UNCERTAIN_DELAY_MS));
    }
  }
}

function modelFromTask(task: Task): string | undefined {
  const m = (task.metadata as Record<string, unknown> | null)?.model;
  return typeof m === 'string' && m ? m : undefined;
}

function modelFromEnv(env: Environment): string | undefined {
  return (env.config as { model?: string } | null)?.model;
}
