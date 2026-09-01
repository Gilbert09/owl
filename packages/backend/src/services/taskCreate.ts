import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import type { TaskPriority, TaskType, TaskSkillInfo, PostHogCodeRuntimeAdapter } from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  pullRequests as pullRequestsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { withTaskLimitGate } from './billing/entitlements.js';
import { attachTaskToPullRequestRow } from './prCache.js';
import { bumpSkillUsage } from './skills.js';
import { rowToTask } from './taskSerialize.js';
import { emitTaskCreated } from './websocket.js';

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

  return withTaskLimitGate(ownerId, {}, () => insertCloudTask(input));
}

async function insertCloudTask(
  input: CreateCloudTaskInput
): Promise<typeof tasksTable.$inferSelect> {
  const db = getDbClient();
  const id = uuid();
  const now = new Date();

  // Stash cloud overrides (model / runtime adapter) on metadata — the
  // provider reads them at dispatch.
  const initialMetadata: Record<string, unknown> = {};
  if (input.runtimeAdapter) initialMetadata.runtimeAdapter = input.runtimeAdapter;
  if (input.model) initialMetadata.model = input.model;
  if (input.skill) {
    initialMetadata.skill = input.skill;
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
      initialMetadata.pullRequest = {
        id: prRow.id,
        number: prRow.number,
        url: (prRow.lastSummary as { url?: string } | null)?.url ?? '',
        createdAt: now.toISOString(),
      };
    }
  }

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
