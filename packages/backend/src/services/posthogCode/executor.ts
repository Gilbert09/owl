import { eq, sql } from 'drizzle-orm';
import type { Environment, PostHogCodeRuntimeAdapter, Task } from '@talyn/shared';
import { isStoredPostHogCodeModelId } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus } from '../websocket.js';
import { getPostHogCodeClient, getPostHogCodeCredentials } from './credentials.js';
import { DEFAULT_POSTHOG_CODE_MODEL, PostHogCodeApiError } from './client.js';

const DEFAULT_RUNTIME_ADAPTER: PostHogCodeRuntimeAdapter = 'claude';

export type DispatchResult = { ok: true } | { ok: false; error: string };

/**
 * Hand a task off to PostHog Code: create the remote task, start a
 * background run, and stash the remote ids on `task.metadata`. The
 * cloud owns the agent loop from here — the poller (poller.ts) drives
 * the FastOwl task through to `completed` / `failed`.
 *
 * Idempotent: if the task already carries a `posthogTaskId`, we assume a
 * prior dispatch succeeded and do nothing (the poller owns it).
 */
export async function dispatchTaskToPostHogCode(
  task: Task,
  env: Environment,
): Promise<DispatchResult> {
  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  const existingTaskId =
    typeof meta.posthogTaskId === 'string' && meta.posthogTaskId
      ? meta.posthogTaskId
      : undefined;
  const existingRunId =
    typeof meta.posthogRunId === 'string' && meta.posthogRunId
      ? meta.posthogRunId
      : undefined;
  // Only treat the dispatch as done once a run actually started. A task whose
  // remote task was created but whose `startRun` then failed (e.g. the model
  // validation error) has a `posthogTaskId` but no `posthogRunId` — re-running
  // below reuses that remote task and starts the run rather than wedging
  // forever on this guard.
  if (existingTaskId && existingRunId) {
    return { ok: true };
  }

  const creds = await getPostHogCodeCredentials(task.workspaceId);
  const client = await getPostHogCodeClient(task.workspaceId);
  if (!creds || !client) {
    return {
      ok: false,
      error:
        'PostHog Code is not configured for this workspace — add an API key and project id in workspace settings.',
    };
  }

  if (!task.repositoryId) {
    return { ok: false, error: 'PostHog Code tasks require a repository.' };
  }
  const repository = await resolveRepositorySlug(task.repositoryId);
  if (!repository) {
    return {
      ok: false,
      error: 'Could not resolve a GitHub owner/repo for this task’s repository.',
    };
  }

  const runtimeAdapter =
    (meta.runtimeAdapter as PostHogCodeRuntimeAdapter | undefined) ??
    runtimeAdapterFromEnv(env) ??
    DEFAULT_RUNTIME_ADAPTER;
  // The API requires a model on every cloud run, so resolve to a concrete one:
  // task-level (UI) → workspace setting → env default → the backend default.
  const model =
    (typeof meta.model === 'string' && meta.model) ||
    (await workspacePostHogCodeModel(task.workspaceId)) ||
    modelFromEnv(env) ||
    DEFAULT_POSTHOG_CODE_MODEL;

  const description = task.prompt?.trim() || task.description?.trim() || task.title;

  try {
    // Reuse the remote task when we already have one. Two callers land here:
    // a prior attempt that created the task but failed before starting a run,
    // and a REDISPATCH of a task being reused for another run at the same PR
    // (see taskCreate's reuse path). Both want the same thing — one PostHog
    // task carrying N runs, rather than a fresh task per run.
    //
    // The prompt has to be pushed first. `run/` takes no prompt; PostHog reads
    // the task's current `description` when it starts the run, so a reused
    // task would otherwise repeat the prompt it was created with.
    let remoteTaskId = existingTaskId;
    if (remoteTaskId) {
      try {
        await client.updateTask(remoteTaskId, { title: task.title, description });
      } catch (err) {
        // Gone remotely (deleted, or the workspace was repointed at another
        // project) — fall back to creating a fresh one rather than failing the
        // dispatch on a stale id we only kept as an optimisation.
        if (err instanceof PostHogCodeApiError && err.status === 404) {
          console.warn(
            `[posthogCode] task ${task.id.slice(0, 8)}: remote task ${remoteTaskId} is gone — creating a new one`,
          );
          remoteTaskId = undefined;
        } else {
          throw err;
        }
      }
    }
    if (!remoteTaskId) {
      const remoteTask = await client.createTask({
        title: task.title,
        description,
        repository,
      });
      remoteTaskId = remoteTask.id;

      // Record the remote task id before starting the run so a failure
      // mid-flight doesn't strand us into re-creating a duplicate task.
      await patchTaskMetadata(task.id, (existing) => ({
        ...existing,
        posthogTaskId: remoteTask.id,
        posthogProjectId: creds.projectId,
        posthogHost: creds.host,
        posthogStatus: 'not_started',
      }));
    }

    // `run/` returns the task; the new run is on `latest_run`. Its
    // `latest_run.id` (NOT the returned `id`, which is the task id) is the
    // run id the logs/stream endpoints are keyed on.
    const startedTask = await client.startRun(remoteTaskId, { runtimeAdapter, model });
    const startedRun = startedTask.latest_run ?? null;
    const runId = startedRun?.id;

    await patchTaskMetadata(task.id, (existing) => ({
      ...existing,
      posthogRunId: runId ?? existing.posthogRunId,
      posthogStatus: startedRun?.status ?? 'queued',
      posthogLogUrl: startedRun?.log_url ?? existing.posthogLogUrl,
    }));

    // Pin the env + flip to in_progress so the UI stops showing it as
    // queued. The poller takes it from here.
    await getDbClient()
      .update(tasksTable)
      .set({
        status: 'in_progress',
        assignedEnvironmentId: env.id,
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, task.id));
    emitTaskStatus(task.workspaceId, task.id, 'in_progress');

    // No stream on dispatch — transcript streaming is view-gated. A user
    // watching the task screen starts it instantly via refresh-logs, and
    // SSE replays from the start so a later viewer loses nothing.

    console.log(
      `[posthogCode] task ${task.id.slice(0, 8)} → remote task ${remoteTaskId} run ${runId ?? '(pending)'} (${repository})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function resolveRepositorySlug(repositoryId: string): Promise<string | null> {
  const rows = await getDbClient()
    .select({ url: repositoriesTable.url, name: repositoriesTable.name })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.id, repositoryId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return parseGitHubSlug(row.url) ?? sanitizeSlug(row.name);
}

function parseGitHubSlug(url: string): string | null {
  const match = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
}

function sanitizeSlug(name: string): string | null {
  // Repository.name is conventionally "owner/repo" already.
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : null;
}

function runtimeAdapterFromEnv(env: Environment): PostHogCodeRuntimeAdapter | undefined {
  const config = env.config as { runtimeAdapter?: PostHogCodeRuntimeAdapter };
  return config?.runtimeAdapter;
}

function modelFromEnv(env: Environment): string | undefined {
  const config = env.config as { model?: string };
  return config?.model;
}

/**
 * The workspace's Settings → PostHog Code model choice, or undefined when
 * unset/unknown. Extracted in SQL so the settings jsonb never ships.
 */
async function workspacePostHogCodeModel(workspaceId: string): Promise<string | undefined> {
  const db = getDbClient();
  const [row] = await db
    .select({
      model: sql<string | null>`${workspacesTable.settings} ->> 'posthogCodeModel'`,
    })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  // The wider guard on purpose: a workspace may have pinned an Opus 4.x the
  // pickers no longer offer, and falling back to the default would quietly move
  // it to a dearer model.
  return isStoredPostHogCodeModelId(row?.model) ? row.model : undefined;
}
