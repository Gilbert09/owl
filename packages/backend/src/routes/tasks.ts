import { Router } from 'express';
import { and, desc, eq, inArray, lt, SQL, sql } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { createCloudTask } from '../services/taskCreate.js';
import {
  ACTIVE_TASK_STATUSES,
  assertCanActivateTask,
} from '../services/billing/entitlements.js';
import { bypassesPaywall } from '../services/billing/clientGate.js';
import { rowToTask, taskColumnsNoTranscript } from '../services/taskSerialize.js';
import { taskQueueService } from '../services/taskQueue.js';
import {
  emitTaskStatus,
  emitTaskDeleted,
} from '../services/websocket.js';
import { patchTaskMetadata } from '../services/taskMetadataMutex.js';
import { getCloudProvider } from '../services/cloudProviders/registry.js';
import { clearWatched, markWatched } from '../services/cloudProviders/taskWatch.js';
import { getPostHogCodeClient } from '../services/posthogCode/credentials.js';
import { postHogCodeStreamer } from '../services/posthogCode/streamer.js';
import {
  assertUser,
  handleAccessError,
  requireEnvironmentAccess,
  requireTaskAccess,
  requireWorkspaceAccess,
} from '../middleware/auth.js';
import {
  readCloudTaskProvider,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type CreateTaskRequest,
  readCloudTaskMeta,
  type ApiResponse,
  type GenerateTaskMetadataRequest,
  type GenerateTaskMetadataResponse,
} from '@talyn/shared';

/**
 * Cloud-only task routes. Every task is delegated to a cloud provider
 * (PostHog Code today). There is no local agent, working tree, or
 * approve/reject flow — review happens on the provider's PR. The handlers
 * here create/list/inspect tasks, enqueue them, and proxy cloud follow-up
 * actions (refresh logs, send a message) to the provider.
 */
export function taskRoutes(): Router {
  const router = Router();

  // Derive lightweight task metadata from a prompt. No LLM call — a clean
  // slug is enough; the cloud provider refines the title on its own run.
  router.post('/generate-metadata', async (req, res) => {
    const body = req.body as GenerateTaskMetadataRequest;
    if (!body.prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required' });
    }
    res.json({
      success: true,
      data: deriveTaskMetadata(body.prompt),
    } as ApiResponse<GenerateTaskMetadataResponse>);
  });

  // List tasks (with optional filters). Always scoped to the caller's
  // workspaces — the inner join on workspaces.owner_id enforces it even if
  // a workspaceId filter is omitted.
  router.get('/', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const { workspaceId, status, type, limit, before } = req.query;

    if (workspaceId) {
      try {
        await requireWorkspaceAccess(req, workspaceId as string);
      } catch (err) {
        return handleAccessError(err, res);
      }
    }

    const conditions: SQL[] = [eq(workspacesTable.ownerId, user.id)];
    if (workspaceId) conditions.push(eq(tasksTable.workspaceId, workspaceId as string));
    // `status` accepts a single value or a comma-separated list, so the desktop
    // can fetch all active statuses (pending,queued,in_progress) in one call and
    // paginate the finished history (completed,failed,cancelled) in another.
    if (status) {
      const statuses = String(status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length === 1) conditions.push(eq(tasksTable.status, statuses[0]));
      else if (statuses.length > 1) conditions.push(inArray(tasksTable.status, statuses));
    }
    if (type) conditions.push(eq(tasksTable.type, type as string));

    // `before` is a createdAt cursor (ISO) — return only rows strictly older, so
    // "load more" walks back through history without duplicating the boundary.
    const beforeDate = before ? new Date(String(before)) : null;
    if (beforeDate && !Number.isNaN(beforeDate.getTime())) {
      conditions.push(lt(tasksTable.createdAt, beforeDate));
    }

    const priorityCase = sql<number>`CASE ${tasksTable.priority}
      WHEN 'urgent' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      ELSE 4
    END`;

    // A limit switches the query into cursor-pagination mode: order purely by
    // createdAt desc so the `before` cursor is stable (the priority ordering,
    // useful for the active queue, would make a createdAt cursor skip rows). A
    // sane cap keeps a bogus ?limit from pulling the whole table.
    const pageLimit = limit ? Math.min(Math.max(1, Number(limit) || 0), 100) : null;

    // Project away the `transcript` blob — the list never returns it, so
    // selecting it just pulled MBs out of Postgres to be discarded.
    const base = db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
      .where(and(...conditions));

    const rows = pageLimit
      ? await base.orderBy(desc(tasksTable.createdAt), desc(tasksTable.id)).limit(pageLimit)
      : await base.orderBy(priorityCase, desc(tasksTable.createdAt));

    res.json({
      success: true,
      data: rows.map((r) => rowToTask(r)),
    } as ApiResponse<Task[]>);
  });

  // Get single task (includes the transcript).
  router.get('/:id', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    res.json({
      success: true,
      data: rowToTask(rows[0], { includeTranscript: true }),
    } as ApiResponse<Task>);
  });

  // Create task — queued immediately for the cloud scheduler to dispatch.
  router.post('/', async (req, res) => {
    const body = req.body as CreateTaskRequest;
    try {
      await requireWorkspaceAccess(req, body.workspaceId);
      if (body.assignedEnvironmentId) {
        await requireEnvironmentAccess(req, body.assignedEnvironmentId);
      }
    } catch (err) {
      return handleAccessError(err, res);
    }

    // Cloud tasks run against a repository (the provider clones it and
    // opens a PR), so a repo is required.
    if (!body.repositoryId) {
      return res.status(400).json({
        success: false,
        error:
          'repositoryId is required. Add a repository in Settings, then pick it when creating the task.',
      });
    }

    const row = await createCloudTask({
      workspaceId: body.workspaceId,
      type: body.type,
      title: body.title,
      description: body.description,
      prompt: body.prompt,
      priority: body.priority,
      repositoryId: body.repositoryId,
      assignedEnvironmentId: body.assignedEnvironmentId,
      pullRequestId: body.pullRequestId,
      runtimeAdapter: body.runtimeAdapter,
      model: body.model,
      skill: body.skill,
      bypassTaskLimit: bypassesPaywall(req, 'task'),
    });
    res.status(201).json({ success: true, data: rowToTask(row) } as ApiResponse<Task>);
  });

  // Update task
  router.patch('/:id', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const body = req.body as {
      status?: TaskStatus;
      priority?: TaskPriority;
      title?: string;
      description?: string;
      prompt?: string;
      assignedEnvironmentId?: string;
      result?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };

    // Re-pinning a task to an environment must prove the caller owns that
    // env — POST /tasks already enforces this; PATCH previously didn't.
    if (body.assignedEnvironmentId) {
      try {
        await requireEnvironmentAccess(req, body.assignedEnvironmentId);
      } catch (err) {
        return handleAccessError(err, res);
      }
    }

    // Reactivating via PATCH is subject to the same free-plan concurrency
    // gate as create/retry/start — without this it's a limit bypass. Throws
    // TaskLimitError → 402 via the error middleware. The task itself is
    // excluded from the count, so re-asserting an already-active status
    // never self-blocks.
    if (
      body.status !== undefined &&
      (ACTIVE_TASK_STATUSES as readonly string[]).includes(body.status) &&
      !bypassesPaywall(req, 'task')
    ) {
      await assertCanActivateTask(assertUser(req).id, req.params.id);
    }

    const existing = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!existing[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const updates: Record<string, unknown> = {};
    if (body.status !== undefined) updates.status = body.status;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.assignedEnvironmentId !== undefined)
      updates.assignedEnvironmentId = body.assignedEnvironmentId;
    if (body.result !== undefined) updates.result = body.result;
    if (body.metadata !== undefined) updates.metadata = body.metadata;

    const now = new Date();
    if (
      body.status === 'completed' ||
      body.status === 'failed' ||
      body.status === 'cancelled'
    ) {
      updates.completedAt = now;
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = now;
      await db
        .update(tasksTable)
        .set(updates)
        .where(eq(tasksTable.id, req.params.id));
    }

    const rows = await db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    const updated = rowToTask(rows[0]);
    // Status changes must reach other connected clients too — the REST
    // response only updates the caller's store.
    if (body.status !== undefined) {
      emitTaskStatus(updated.workspaceId, updated.id, updated.status);
    }
    res.json({ success: true, data: updated } as ApiResponse<Task>);
  });

  // Retry/reset a task back to queued for re-dispatch.
  router.post('/:id/retry', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const existing = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!existing[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    // Free-plan gate: a retry re-occupies a slot. Throws → 402.
    if (!bypassesPaywall(req, 'task')) {
      await assertCanActivateTask(assertUser(req).id, req.params.id);
    }

    // Clear the prior cloud run so dispatch starts a fresh one rather than
    // treating the task as already dispatched (idempotency short-circuit).
    await patchTaskMetadata(req.params.id, (meta) => {
      const next = { ...meta };
      delete next.posthogTaskId;
      delete next.posthogRunId;
      delete next.posthogStatus;
      delete next.cloudTask;
      return next;
    });
    await db
      .update(tasksTable)
      .set({ status: 'queued', result: null, completedAt: null, updatedAt: new Date() })
      .where(eq(tasksTable.id, req.params.id));
    void taskQueueService.processQueue();

    const rows = await db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(rows[0]) } as ApiResponse<Task>);
  });

  // Enqueue a task for dispatch (idempotent — already-running tasks are
  // left alone). The old local `/start` semantics collapse to "queue it".
  router.post('/:id/start', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    const task = rowToTask(rows[0]);
    if (task.status !== 'in_progress') {
      // Free-plan gate: queueing re-occupies a slot. Throws → 402.
      if (!bypassesPaywall(req, 'task')) {
        await assertCanActivateTask(assertUser(req).id, task.id);
      }
      await taskQueueService.queueTask(task.id);
    }
    const updated = await db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(updated[0]) } as ApiResponse<Task>);
  });

  // Stop a running cloud task — cancel the remote run (when the provider
  // supports it), drop the transcript stream, and mark the task cancelled.
  router.post('/:id/stop', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    const task = rowToTask(rows[0]);
    if (task.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: 'Task is not running' });
    }

    // Best-effort remote cancel — the local task is marked cancelled either
    // way, but record when the vendor run could not be stopped so the user
    // knows it may still open a PR.
    const provider = getCloudProvider(readCloudTaskProvider(task));
    let remoteCancelError: string | undefined;
    if (provider?.cancel) {
      try {
        await provider.cancel(task);
      } catch (err) {
        remoteCancelError = err instanceof Error ? err.message : String(err);
        console.warn(`[tasks] remote cancel failed for ${task.id}:`, err);
      }
    }
    provider?.stopStreaming(task.id);
    clearWatched(task.id);

    const result = {
      success: false,
      error: remoteCancelError
        ? `Cancelled by user. The remote run could not be stopped and may still finish: ${remoteCancelError}`
        : 'Cancelled by user',
    };
    const now = new Date();
    await db
      .update(tasksTable)
      .set({
        status: 'cancelled',
        result,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(tasksTable.id, task.id));
    emitTaskStatus(task.workspaceId, task.id, 'cancelled', result);

    const updatedRows = await db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(updatedRows[0]) } as ApiResponse<Task>);
  });

  // On-demand log fetch for a PostHog Code (cloud) task. The poller only
  // streams `in_progress` tasks, so opening a finished task — or a running
  // one before the first poll tick — would otherwise show a blank
  // transcript. Resolves the real run id, then kicks the streamer (live
  // SSE tail or one-shot S3 backfill). Events flow over `task:event`.
  router.post('/:id/refresh-logs', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    const task = rowToTask(rows[0]);
    const meta = (task.metadata ?? {}) as Record<string, unknown>;

    // Mark watched before any remote call — even if the run hasn't started
    // yet (409 below), the poller should start streaming once it has.
    markWatched(task.id);

    // Every provider EXCEPT PostHog Code refreshes through the generic seam.
    //
    // This route predates that seam and read `meta.posthogTaskId` directly, so
    // "Refresh logs" on a fleet task answered `Not a PostHog Code task.` — the
    // one button whose entire job is recovering a blank transcript refused to
    // work on exactly the tasks whose transcripts were blank.
    //
    // `reconcile` is the right thing to call: it is what the poller runs each
    // tick, and for the fleet it re-fetches by cursor and persists. Calling it
    // here just runs a tick early, on demand, which is what the button means.
    //
    // PostHog Code keeps its bespoke path below because refreshing it is not a
    // reconcile — it resolves a run id and starts a live SSE tail or a one-shot
    // S3 backfill, neither of which the generic seam models.
    const cloud = readCloudTaskMeta(task);
    const posthogTaskId = meta.posthogTaskId as string | undefined;
    if (!posthogTaskId) {
      if (!cloud?.provider || !cloud.remoteTaskId) {
        return res.status(400).json({
          success: false,
          error: 'This task has no cloud run to fetch logs from yet.',
        });
      }
      const provider = getCloudProvider(cloud.provider);
      if (!provider?.reconcile) {
        return res.status(400).json({
          success: false,
          error: `${cloud.provider} cannot refresh logs on demand.`,
        });
      }
      try {
        await provider.reconcile({
          id: task.id,
          workspaceId: task.workspaceId,
          title: task.title,
          repositoryId: task.repositoryId ?? null,
          metadata: (task.metadata ?? {}) as Record<string, unknown>,
          // The point of the request: assume nothing is stored and re-sync.
          transcriptEmpty: true,
          // The caller is looking at it, by definition — this is what opens the
          // live stream for a still-running task.
          watched: true,
          status: task.status as 'in_progress',
          // rowToTask serialises dates to ISO strings; CloudTaskRow wants the
          // Date the poller passes it, so convert rather than cast.
          completedAt: task.completedAt ? new Date(task.completedAt) : null,
          updatedAt: task.updatedAt ? new Date(task.updatedAt) : null,
        });
      } catch (err) {
        return res.status(502).json({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to reach the cloud provider.',
        });
      }
      return res.json({ success: true });
    }
    const client = await getPostHogCodeClient(task.workspaceId);
    if (!client) {
      return res.status(400).json({
        success: false,
        error: 'PostHog Code is not configured for this workspace.',
      });
    }

    let runId: string | undefined;
    let terminal = false;
    try {
      const remote = await client.getTask(posthogTaskId);
      runId = remote.latest_run?.id;
      const status = remote.latest_run?.status;
      terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    } catch (err) {
      return res.status(502).json({
        success: false,
        error: err instanceof Error ? err.message : 'Failed to reach PostHog Code.',
      });
    }
    if (!runId) {
      return res.status(409).json({ success: false, error: 'The run has not started yet.' });
    }

    if (runId !== meta.posthogRunId) {
      await patchTaskMetadata(task.id, (existing) => ({ ...existing, posthogRunId: runId }));
    }
    postHogCodeStreamer.ensure({
      taskId: task.id,
      workspaceId: task.workspaceId,
      posthogTaskId,
      posthogRunId: runId,
      backfillOnly: terminal,
    });
    await postHogCodeStreamer.flushNow(task.id);
    return res.json({ success: true });
  });

  // Viewing heartbeat. The desktop pings this while a task screen is
  // mounted; the cloud poller only keeps a live transcript stream open for
  // watched tasks (services/cloudProviders/taskWatch.ts). Deliberately
  // cheap — no remote call, no task-row read beyond the access check —
  // unlike refresh-logs, which resolves the run remotely on every call.
  router.post('/:id/watch', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const watched = (req.body as { watched?: boolean } | undefined)?.watched ?? true;
    if (watched) markWatched(req.params.id);
    else clearWatched(req.params.id);
    res.status(204).end();
  });

  // Delete task
  router.delete('/:id', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    try {
      const rows = await db
        .select(taskColumnsNoTranscript)
        .from(tasksTable)
        .where(eq(tasksTable.id, req.params.id))
        .limit(1);
      const task = rows[0] ? rowToTask(rows[0]) : null;
      if (task && task.status === 'in_progress') {
        const provider = getCloudProvider(readCloudTaskProvider(task));
        provider?.stopStreaming(task.id);
        clearWatched(task.id);
      }

      const result = await db
        .delete(tasksTable)
        .where(eq(tasksTable.id, req.params.id))
        .returning({ id: tasksTable.id });
      if (result.length === 0) {
        return res.status(404).json({ success: false, error: 'Task not found' });
      }
      if (task) emitTaskDeleted(task.workspaceId, task.id);
      res.json({ success: true } as ApiResponse<void>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tasks] delete failed for ${req.params.id}:`, err);
      res.status(500).json({ success: false, error: `Delete failed: ${message}` });
    }
  });

  return router;
}

/** Derive a friendly-ish title/description/priority from a prompt. */
function deriveTaskMetadata(prompt: string): GenerateTaskMetadataResponse {
  const firstLine = prompt.split('\n')[0]?.trim() ?? '';
  const title = (firstLine || prompt).slice(0, 60).trim() || 'New Task';
  return {
    title,
    description: prompt.slice(0, 200).trim(),
    suggestedPriority: 'medium',
  };
}

