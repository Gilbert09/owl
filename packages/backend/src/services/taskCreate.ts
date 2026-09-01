import { v4 as uuid } from 'uuid';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { TaskPriority, TaskType, TaskSkillInfo, PostHogCodeRuntimeAdapter } from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  environments as environmentsTable,
  pullRequests as pullRequestsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { withTaskLimitGate } from './billing/entitlements.js';
import { attachTaskToPullRequestRow } from './prCache.js';
import { bumpSkillUsage } from './skills.js';
import { rowToTask } from './taskSerialize.js';
import { emitTaskCreated, emitTaskUpdate } from './websocket.js';

export interface CreateCloudTaskInput {
  workspaceId: string;
  type: TaskType;
  title: string;
  description: string;
  prompt?: string | null;
  priority?: TaskPriority;
  /** Cloud tasks always run against a repository (the provider clones it). */
  repositoryId: string;
  assignedEnvironmentId?: string | null;
  /** When started from a PR, stashes a pointer on metadata + reverse-links the row. */
  pullRequestId?: string | null;
  runtimeAdapter?: PostHogCodeRuntimeAdapter;
  model?: string;
  /**
   * The agent skill this task runs, if any. The skill's content is already
   * inlined into `prompt`; this descriptor is persisted to `metadata.skill`
   * for display and bumps the workspace's usage stats.
   */
  skill?: TaskSkillInfo;
}

/**
 * Insert a cloud task as `queued` (the queue's tick picks it up), stash the
 * cloud overrides + PR pointer on metadata, and reverse-link the PR row so the
 * GitHub screen shows a live in-progress indicator. Returns the inserted row.
 *
 * Shared by the `POST /tasks` route and the auto-keep-mergeable watcher so both
 * create identical task rows.
 */
export async function createCloudTask(
  input: CreateCloudTaskInput
): Promise<typeof tasksTable.$inferSelect> {
  const db = getDbClient();

  // Free-plan concurrency gate. Every creation path (routes AND the
  // merge-queue / auto-keep watchers) funnels through here, so the limit has
  // no back door and no exemption; throws TaskLimitError when a free owner is
  // at the cap.
  const ownerRows = await db
    .select({ ownerId: workspacesTable.ownerId })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, input.workspaceId))
    .limit(1);
  const ownerId = ownerRows[0]?.ownerId;
  if (!ownerId) {
    throw new Error(`createCloudTask: workspace ${input.workspaceId} not found`);
  }

  return withTaskLimitGate(ownerId, {}, async () => {
    const reusable = await findReusableTask(input);
    return reusable ? redispatchCloudTask(reusable, input) : insertCloudTask(input);
  });
}

/**
 * Statuses a task must have settled into before it can be reused. Anything
 * still active is left strictly alone — rewriting a running task's prompt
 * would redirect a run already in flight.
 */
const REUSABLE_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/**
 * The most recent finished task for this exact PR and task type, if any.
 *
 * Reuse is keyed on (workspace, PR, type) rather than on the title, which is
 * edited freely, and rather than on the PR alone — a `pr_review` and a
 * `pr_response` on one PR are different pieces of work and must not land in
 * each other's remote session. Reads `tasks.pull_request_id` (indexed), the
 * authoritative link.
 *
 * Note the projection: `tasks.transcript` is the big jsonb column on this
 * table, and this runs on every dispatch. Only the two columns the reuse
 * decision needs are selected.
 */
async function findReusableTask(
  input: CreateCloudTaskInput
): Promise<{ id: string; metadata: unknown } | null> {
  if (!input.pullRequestId) return null;
  const rows = await getDbClient()
    .select({ id: tasksTable.id, metadata: tasksTable.metadata })
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.workspaceId, input.workspaceId),
        eq(tasksTable.pullRequestId, input.pullRequestId),
        eq(tasksTable.type, input.type),
        inArray(tasksTable.status, [...REUSABLE_STATUSES])
      )
    )
    .orderBy(desc(tasksTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** How many runs this row has already had, for the next one to count from. */
function previousRunAttempt(metadata: unknown): number {
  const raw = ((metadata ?? {}) as Record<string, unknown>).runAttempt;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** The cloud provider a task is being dispatched to, from its env marker. */
async function providerTypeFor(envId: string | null | undefined): Promise<string | null> {
  if (!envId) return null;
  const rows = await getDbClient()
    .select({ type: environmentsTable.type })
    .from(environmentsTable)
    .where(eq(environmentsTable.id, envId))
    .limit(1);
  return rows[0]?.type ?? null;
}

/**
 * Carry the remote handle from the run being reused onto the new one, so the
 * provider starts another run on the SAME remote task instead of creating a
 * duplicate. What is deliberately NOT carried matters more than what is:
 *
 *  - **the run fields** (`posthogRunId` and friends). The executor treats
 *    "has a task id AND a run id" as "already dispatched" and returns early,
 *    so carrying the run id would wedge the task in `queued` forever.
 *  - **`cloudTask`**. Only PostHog exposes "start another run on this task"
 *    (`POST /tasks/{id}/run/`); Claude and the self-hosted fleet have no such
 *    primitive, and their dispatch guards read `readCloudTaskMeta`, which
 *    falls back to the legacy `posthog*` fields. Handing either of them a
 *    remote id they cannot re-run makes their dispatch a permanent no-op —
 *    which is also why the handle is dropped when the workspace has switched
 *    providers since the last run.
 */
function carryRemoteHandle(
  previous: unknown,
  next: Record<string, unknown>,
  providerType: string | null
): Record<string, unknown> {
  if (providerType !== 'posthog_code') return next;
  const prev = (previous ?? {}) as Record<string, unknown>;
  const remoteTaskId = prev.posthogTaskId;
  if (typeof remoteTaskId !== 'string' || !remoteTaskId) return next;
  return {
    ...next,
    posthogTaskId: remoteTaskId,
    ...(prev.posthogProjectId === undefined ? {} : { posthogProjectId: prev.posthogProjectId }),
    ...(prev.posthogHost === undefined ? {} : { posthogHost: prev.posthogHost }),
  };
}

/** The metadata a freshly dispatched task carries, shared by both paths. */
async function buildTaskMetadata(
  input: CreateCloudTaskInput,
  now: Date
): Promise<Record<string, unknown>> {
  const db = getDbClient();
  // Stash cloud overrides (model / runtime adapter) on metadata — the
  // provider reads them at dispatch.
  const metadata: Record<string, unknown> = {};
  if (input.runtimeAdapter) metadata.runtimeAdapter = input.runtimeAdapter;
  if (input.model) metadata.model = input.model;
  if (input.skill) {
    metadata.skill = input.skill;
    // Best-effort usage bump for the picker's "frequently used" ordering —
    // never blocks or fails task creation.
    void bumpSkillUsage(input.workspaceId, input.skill.key).catch((err) => {
      console.warn('[taskCreate] failed to bump skill usage:', err);
    });
  }

  // When started FROM a PR, stash a pullRequest pointer up front so the task
  // screen renders its PR pill immediately.
  if (input.pullRequestId) {
    const prRows = await db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, input.pullRequestId))
      .limit(1);
    const prRow = prRows[0];
    if (prRow && prRow.workspaceId === input.workspaceId) {
      metadata.pullRequest = {
        id: prRow.id,
        number: prRow.number,
        url: (prRow.lastSummary as { url?: string } | null)?.url ?? '',
        createdAt: now.toISOString(),
      };
    }
  }
  return metadata;
}

/**
 * Re-arm a finished task for another run at the same PR, instead of inserting
 * a new one. Keeps ONE task per (PR, type) in Talyn and — via the carried
 * remote handle — one session per PR at the provider, with the repeat runs
 * hanging off it rather than cluttering the list as separate sessions.
 *
 * The row is reset to what a brand-new task looks like: the new prompt, back
 * to `queued`, and the previous run's output cleared. The transcript goes with
 * it — it is this table's large jsonb column, so accumulating every run's
 * would grow one row without bound, and the provider keeps the older runs.
 */
async function redispatchCloudTask(
  existing: { id: string; metadata: unknown },
  input: CreateCloudTaskInput
): Promise<typeof tasksTable.$inferSelect> {
  const db = getDbClient();
  const now = new Date();
  const providerType = await providerTypeFor(input.assignedEnvironmentId);
  const metadata = carryRemoteHandle(
    existing.metadata,
    {
      ...(await buildTaskMetadata(input, now)),
      // Which run of this row this is. A provider that derives its remote id
      // from the task id needs it to tell this run from the last: the fleet
      // does exactly that, and its create is idempotent on the id, so without
      // a counter a reused task was handed back its PREVIOUS (already
      // finished) sandbox and settled the instant it started.
      runAttempt: previousRunAttempt(existing.metadata) + 1,
    },
    providerType
  );

  await db
    .update(tasksTable)
    .set({
      status: 'queued',
      priority: input.priority || 'medium',
      title: input.title,
      description: input.description,
      prompt: input.prompt ?? null,
      repositoryId: input.repositoryId,
      assignedEnvironmentId: input.assignedEnvironmentId ?? null,
      metadata,
      transcript: null,
      result: null,
      branch: null,
      completedAt: null,
      // Bumped, not preserved. The task list is ordered by `created_at DESC`
      // (it is also the keyset cursor), so a reused row would sit wherever its
      // FIRST run landed — start a fix run on a week-old PR task and it would
      // appear a week down the list. The row now stands for the run it is
      // currently carrying, so this is when that run was queued.
      createdAt: now,
      updatedAt: now,
    })
    .where(eq(tasksTable.id, existing.id));

  // Same reverse link the insert path writes — the previous run may have been
  // superseded on the PR row by a task at another PR.
  if (input.pullRequestId) {
    await attachTaskToPullRequestRow({
      workspaceId: input.workspaceId,
      pullRequestId: input.pullRequestId,
      taskId: existing.id,
    }).catch((err) => {
      console.error('[taskCreate] failed to link task to PR:', err);
    });
  }

  const rows = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, existing.id))
    .limit(1);
  const task = rowToTask(rows[0]);

  // BOTH events, and in this order. `task:created` is what puts the task in
  // front of a client that never had it (or has pruned it), but the desktop
  // store's addTask is idempotent by id and SKIPS a task it already holds —
  // so on its own it would leave an existing client showing the finished
  // previous run. The update is what refreshes those, `transcript: []`
  // included, so the old run's log is dropped rather than shown under the
  // new one.
  emitTaskCreated(input.workspaceId, task);
  emitTaskUpdate(input.workspaceId, existing.id, {
    ...task,
    transcript: [],
    // Explicit nulls, because the stores DEEP-MERGE `metadata` on a task
    // update (a partial poller patch must not drop the provider marker). A
    // key we simply left out would therefore be kept from the previous run,
    // so the task screen would go on offering a "view run" link pointing at
    // the run that already finished. Only the scalars can be cleared this
    // way; a stale `cloudTask` survives its own sub-merge until the dispatch
    // writes the new remote ids over it moments later.
    metadata: {
      ...(task.metadata ?? {}),
      posthogRunId: null,
      posthogStatus: null,
      posthogLogUrl: null,
      posthogPrUrl: null,
    },
  });

  return rows[0];
}

async function insertCloudTask(
  input: CreateCloudTaskInput
): Promise<typeof tasksTable.$inferSelect> {
  const db = getDbClient();
  const id = uuid();
  const now = new Date();
  const initialMetadata = await buildTaskMetadata(input, now);

  await db.insert(tasksTable).values({
    id,
    workspaceId: input.workspaceId,
    type: input.type,
    // Auto-enqueue on create — the cloud scheduler picks up `queued` tasks
    // on its next tick.
    status: 'queued',
    title: input.title,
    description: input.description,
    prompt: input.prompt ?? null,
    priority: input.priority || 'medium',
    repositoryId: input.repositoryId,
    // The authoritative PR link, written with the row rather than by the
    // attach call below: that call is best-effort and its failure is swallowed,
    // and a null here would let a second run be dispatched at the same PR.
    pullRequestId: input.pullRequestId ?? null,
    assignedEnvironmentId: input.assignedEnvironmentId ?? null,
    metadata: Object.keys(initialMetadata).length > 0 ? initialMetadata : undefined,
    createdAt: now,
    updatedAt: now,
  });

  // Link the task to the PR it was started from, so the GitHub screen can show
  // a live in-progress indicator that deep-links back to the run.
  if (input.pullRequestId) {
    await attachTaskToPullRequestRow({
      workspaceId: input.workspaceId,
      pullRequestId: input.pullRequestId,
      taskId: id,
    }).catch((err) => {
      console.error('[taskCreate] failed to link task to PR:', err);
    });
  }

  const rows = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, id))
    .limit(1);

  // Announce the new task so the desktop adds it to the Tasks list live —
  // critical for backend-created tasks (merge-queue / auto-keep fix runs) the
  // desktop never sees otherwise. Deduped by id on the client, so the POST
  // /tasks caller that already added it optimistically is unaffected.
  emitTaskCreated(input.workspaceId, rowToTask(rows[0]));

  return rows[0];
}
