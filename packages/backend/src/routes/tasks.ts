import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { and, desc, eq, SQL, sql } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
  environments as environmentsTableRef,
} from '../db/schema.js';
import { agentService } from '../services/agent.js';
import { environmentService } from '../services/environment.js';
import { gitService } from '../services/git.js';
import { emitTaskStatus } from '../services/websocket.js';
import { generateTaskMetadata, isConfigured as isAIConfigured } from '../services/ai.js';
import {
  assertUser,
  handleAccessError,
  requireEnvironmentAccess,
  requireTaskAccess,
  requireWorkspaceAccess,
} from '../middleware/auth.js';
import type {
  Task,
  TaskPriority,
  TaskStatus,
  TaskType,
  CreateTaskRequest,
  ApiResponse,
  GenerateTaskMetadataRequest,
  GenerateTaskMetadataResponse,
} from '@fastowl/shared';
import { isAgentTask } from '@fastowl/shared';

export function taskRoutes(): Router {
  const router = Router();

  // Generate task metadata from a prompt using AI
  router.post('/generate-metadata', async (req, res) => {
    const body = req.body as GenerateTaskMetadataRequest;

    if (!body.prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required' });
    }

    if (!isAIConfigured()) {
      return res.json({
        success: true,
        data: {
          title: body.prompt.slice(0, 60).trim() || 'New Task',
          description: body.prompt.slice(0, 200).trim(),
          suggestedPriority: 'medium',
        },
      } as ApiResponse<GenerateTaskMetadataResponse>);
    }

    try {
      const metadata = await generateTaskMetadata(body.prompt);
      res.json({ success: true, data: metadata } as ApiResponse<GenerateTaskMetadataResponse>);
    } catch (err) {
      console.error('Failed to generate task metadata:', err);
      res.json({
        success: true,
        data: {
          title: body.prompt.slice(0, 60).trim() || 'New Task',
          description: body.prompt.slice(0, 200).trim(),
          suggestedPriority: 'medium',
        },
      } as ApiResponse<GenerateTaskMetadataResponse>);
    }
  });

  // List tasks (with optional filters). Always scoped to the caller's
  // workspaces — the inner join on workspaces.owner_id enforces it even if
  // a workspaceId filter is omitted.
  router.get('/', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const { workspaceId, status, type } = req.query;

    if (workspaceId) {
      try {
        await requireWorkspaceAccess(req, workspaceId as string);
      } catch (err) {
        return handleAccessError(err, res);
      }
    }

    const conditions: SQL[] = [eq(workspacesTable.ownerId, user.id)];
    if (workspaceId) conditions.push(eq(tasksTable.workspaceId, workspaceId as string));
    if (status) conditions.push(eq(tasksTable.status, status as string));
    if (type) conditions.push(eq(tasksTable.type, type as string));

    const priorityCase = sql<number>`CASE ${tasksTable.priority}
      WHEN 'urgent' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      ELSE 4
    END`;

    const rows = await db
      .select({ task: tasksTable })
      .from(tasksTable)
      .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
      .where(and(...conditions))
      .orderBy(priorityCase, desc(tasksTable.createdAt));

    res.json({
      success: true,
      data: rows.map((r) => rowToTask(r.task)),
    } as ApiResponse<Task[]>);
  });

  // Get single task (includes agent status if running)
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

    const task = rowToTask(rows[0], { includeTerminalOutput: true });

    if (task.status === 'in_progress') {
      const activeAgent = agentService.getAgentByTaskId(task.id);
      if (activeAgent) {
        task.agentStatus = activeAgent.status;
        task.agentAttention = activeAgent.attention;
      }
    }

    res.json({ success: true, data: task } as ApiResponse<Task>);
  });

  // Create task
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
    const db = getDbClient();
    const id = uuid();
    const now = new Date();

    await db.insert(tasksTable).values({
      id,
      workspaceId: body.workspaceId,
      type: body.type,
      title: body.title,
      description: body.description,
      prompt: body.prompt ?? null,
      priority: body.priority || 'medium',
      repositoryId: body.repositoryId ?? null,
      assignedEnvironmentId: body.assignedEnvironmentId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, id))
      .limit(1);
    res.status(201).json({ success: true, data: rowToTask(rows[0]) } as ApiResponse<Task>);
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
      assignedAgentId?: string;
      assignedEnvironmentId?: string;
      result?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };

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
    if (body.assignedAgentId !== undefined) updates.assignedAgentId = body.assignedAgentId;
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
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(rows[0]) } as ApiResponse<Task>);
  });

  // Retry/reset a task back to queued
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

    await db
      .update(tasksTable)
      .set({
        status: 'queued',
        assignedAgentId: null,
        result: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, req.params.id));

    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(rows[0]) } as ApiResponse<Task>);
  });

  // Start executing a task (spawns an agent)
  router.post('/:id/start', async (req, res) => {
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

    const task = rowToTask(rows[0]);

    // Idempotent: if the task is already running (e.g. the scheduler
    // picked it up in the ~5s window between user's "retry" and
    // their "start now" click), return the current task state rather
    // than an error. Users don't care whether *they* started it —
    // only that it's running.
    if (task.status === 'in_progress') {
      const existing = agentService.getAgentByTaskId(task.id);
      if (existing) {
        return res.json({ success: true, data: task } as ApiResponse<Task>);
      }
      // Status says in_progress but no live agent — the agent died
      // and something missed the cleanup. Let the flow below reset +
      // re-spawn. We'll reset status to `queued` on the way through
      // so the agent insert's task update is clean.
      await db
        .update(tasksTable)
        .set({ status: 'queued', assignedAgentId: null, updatedAt: new Date() })
        .where(eq(tasksTable.id, task.id));
      task.status = 'queued';
      task.assignedAgentId = undefined;
    }
    if (!isAgentTask(task.type)) {
      return res.status(400).json({ success: false, error: 'Only agent tasks can be started' });
    }

    let environmentId = task.assignedEnvironmentId;
    if (!environmentId) {
      const connected = await findConnectedEnvironmentForUser(req);
      if (!connected) {
        return res
          .status(400)
          .json({ success: false, error: 'No connected environments available' });
      }
      environmentId = connected;
    } else {
      try {
        await requireEnvironmentAccess(req, environmentId);
      } catch (err) {
        return handleAccessError(err, res);
      }
    }

    const envStatus = await environmentService.getStatus(environmentId);
    if (envStatus !== 'connected') {
      try {
        await environmentService.connect(environmentId);
      } catch {
        return res
          .status(400)
          .json({ success: false, error: 'Failed to connect to environment' });
      }
    }

    // Same idempotency guard as above, but covering the narrow window
    // where the scheduler populated activeAgents but hasn't yet
    // flipped the task row to `in_progress`.
    const existingAgent = agentService.getAgentByTaskId(task.id);
    if (existingAgent) {
      return res.json({ success: true, data: task } as ApiResponse<Task>);
    }

    let workingDirectory: string | undefined;
    let taskBranch: string | undefined;

    if (task.repositoryId) {
      const repoRows = await db
        .select({
          localPath: repositoriesTable.localPath,
        })
        .from(repositoriesTable)
        .where(eq(repositoriesTable.id, task.repositoryId))
        .limit(1);
      const repoRow = repoRows[0];

      if (repoRow?.localPath) {
        workingDirectory = repoRow.localPath;

        if (task.branch) {
          try {
            await gitService.checkoutBranch(environmentId, task.branch, workingDirectory);
            taskBranch = task.branch;
          } catch (err) {
            console.warn('Failed to checkout existing branch, creating new:', err);
            taskBranch = await gitService.createTaskBranch(
              environmentId,
              task.id,
              task.title,
              workingDirectory
            );
          }
        } else {
          try {
            taskBranch = await gitService.createTaskBranch(
              environmentId,
              task.id,
              task.title,
              workingDirectory
            );
          } catch (err) {
            console.warn('Failed to create task branch (continuing without):', err);
          }
        }
      }
    }

    try {
      const agent = await agentService.startAgent({
        environmentId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        prompt: task.prompt || task.description,
        workingDirectory,
      });

      const now = new Date();
      const updateValues: Record<string, unknown> = {
        status: 'in_progress',
        assignedAgentId: agent.id,
        assignedEnvironmentId: environmentId,
        updatedAt: now,
      };
      if (taskBranch) updateValues.branch = taskBranch;

      await db
        .update(tasksTable)
        .set(updateValues)
        .where(eq(tasksTable.id, task.id));

      emitTaskStatus(task.workspaceId, task.id, 'in_progress');

      const updatedRows = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, task.id))
        .limit(1);
      const updatedTask = rowToTask(updatedRows[0]);
      updatedTask.agentStatus = 'working';
      updatedTask.agentAttention = 'none';
      updatedTask.terminalOutput = '';

      res.json({ success: true, data: updatedTask } as ApiResponse<Task>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start task';
      console.error('Failed to start task:', err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // Send input to a running task
  router.post('/:id/input', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const { input } = req.body as { input: string };
    if (!input) {
      return res.status(400).json({ success: false, error: 'Input is required' });
    }

    const rows = await db
      .select()
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

    const activeAgent = agentService.getAgentByTaskId(task.id);
    if (!activeAgent) {
      return res.status(400).json({ success: false, error: 'No active agent for this task' });
    }

    try {
      agentService.sendInput(activeAgent.id, input);
      res.json({ success: true } as ApiResponse<void>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send input';
      res.status(500).json({ success: false, error: msg });
    }
  });

  // Mark a running task as ready for review.
  router.post('/:id/ready-for-review', async (req, res) => {
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

    const task = rowToTask(rows[0]);
    if (task.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: 'Task is not running' });
    }
    if (!isAgentTask(task.type)) {
      return res
        .status(400)
        .json({ success: false, error: 'Only agent tasks can be marked ready for review' });
    }

    const activeAgent = agentService.getAgentByTaskId(task.id);
    if (activeAgent) agentService.stopAgent(activeAgent.id);

    await db
      .update(tasksTable)
      .set({ status: 'awaiting_review', updatedAt: new Date() })
      .where(eq(tasksTable.id, task.id));

    emitTaskStatus(task.workspaceId, task.id, 'awaiting_review');

    const updatedRows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(updatedRows[0]) } as ApiResponse<Task>);
  });

  // Approve an awaiting_review task → completed
  router.post('/:id/approve', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select({ status: tasksTable.status, workspaceId: tasksTable.workspaceId })
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    if (rows[0].status !== 'awaiting_review') {
      return res.status(400).json({ success: false, error: 'Task is not awaiting review' });
    }

    const now = new Date();
    await db
      .update(tasksTable)
      .set({ status: 'completed', completedAt: now, updatedAt: now })
      .where(eq(tasksTable.id, req.params.id));

    emitTaskStatus(rows[0].workspaceId, req.params.id, 'completed');

    const updatedRows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(updatedRows[0]) } as ApiResponse<Task>);
  });

  // Reject an awaiting_review task → back to queued
  router.post('/:id/reject', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select({ status: tasksTable.status, workspaceId: tasksTable.workspaceId })
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    if (rows[0].status !== 'awaiting_review') {
      return res.status(400).json({ success: false, error: 'Task is not awaiting review' });
    }

    await db
      .update(tasksTable)
      .set({ status: 'queued', assignedAgentId: null, updatedAt: new Date() })
      .where(eq(tasksTable.id, req.params.id));

    emitTaskStatus(rows[0].workspaceId, req.params.id, 'queued');

    const updatedRows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(updatedRows[0]) } as ApiResponse<Task>);
  });

  // Stop a running task
  router.post('/:id/stop', async (req, res) => {
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

    const task = rowToTask(rows[0]);
    if (task.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: 'Task is not running' });
    }

    const activeAgent = agentService.getAgentByTaskId(task.id);
    if (activeAgent) agentService.stopAgent(activeAgent.id);

    const now = new Date();
    await db
      .update(tasksTable)
      .set({
        status: 'failed',
        result: { success: false, error: 'Stopped by user' },
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(tasksTable.id, task.id));

    emitTaskStatus(task.workspaceId, task.id, 'failed', {
      success: false,
      error: 'Stopped by user',
    });

    const updatedRows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(updatedRows[0]) } as ApiResponse<Task>);
  });

  // Get the diff of a task's work against the base branch
  router.get('/:id/diff', async (req, res) => {
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

    const task = rowToTask(rows[0]);
    if (!task.branch || !task.repositoryId) {
      return res
        .status(400)
        .json({ success: false, error: 'Task has no branch or repository' });
    }

    const repoRows = await db
      .select({
        localPath: repositoriesTable.localPath,
        defaultBranch: repositoriesTable.defaultBranch,
      })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, task.repositoryId))
      .limit(1);
    const repoRow = repoRows[0];
    if (!repoRow?.localPath) {
      return res
        .status(400)
        .json({ success: false, error: 'Repository has no local path on this machine' });
    }

    let environmentId = task.assignedEnvironmentId;
    if (!environmentId) {
      const connected = await findConnectedEnvironmentForUser(req);
      if (!connected) {
        return res
          .status(400)
          .json({ success: false, error: 'No connected environment to compute diff' });
      }
      environmentId = connected;
    } else {
      try {
        await requireEnvironmentAccess(req, environmentId);
      } catch (err) {
        return handleAccessError(err, res);
      }
    }

    try {
      const diff = await gitService.getDiff(
        environmentId,
        task.branch,
        repoRow.defaultBranch || 'main',
        repoRow.localPath
      );
      res.json({ success: true, data: { diff } } as ApiResponse<{ diff: string }>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to get diff';
      console.error('Failed to get diff:', err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // Get terminal output for a task. Returns the PTY transcript (bytes)
  // and the structured transcript (JSONL events) — caller decides which
  // to render based on `metadata.runtime`.
  router.get('/:id/terminal', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select({
        status: tasksTable.status,
        terminalOutput: tasksTable.terminalOutput,
        transcript: tasksTable.transcript,
        metadata: tasksTable.metadata,
      })
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    // Slice 4c: legacy terminal_output column kept for historical PTY
    // rows only. Live tasks write to `transcript` via the structured
    // renderer; nothing updates terminal_output anymore.
    const terminalOutput = rows[0].terminalOutput || '';

    res.json({
      success: true,
      data: {
        terminalOutput,
        transcript: (rows[0].transcript as Task['transcript']) ?? undefined,
        runtime:
          (rows[0].metadata as { runtime?: string } | null | undefined)?.runtime ??
          'pty',
      },
    } as ApiResponse<{
      terminalOutput: string;
      transcript?: Task['transcript'];
      runtime: string;
    }>);
  });

  // Delete task
  router.delete('/:id', async (req, res) => {
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
    if (rows[0]) {
      const task = rowToTask(rows[0]);
      if (task.status === 'in_progress') {
        const activeAgent = agentService.getAgentByTaskId(task.id);
        if (activeAgent) agentService.stopAgent(activeAgent.id);
      }
    }

    const result = await db
      .delete(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .returning({ id: tasksTable.id });
    if (result.length === 0) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}

/**
 * Pick an auto-assignable environment for the current user. Returns the
 * environment id of the first connected env, or null when they have none.
 * Kept here rather than on `environmentService` because the service is
 * stateless re: users and we want the scoping explicit at the call site.
 */
async function findConnectedEnvironmentForUser(req: import('express').Request): Promise<string | null> {
  const user = assertUser(req);
  const db = getDbClient();
  const rows = await db
    .select({ id: environmentsTableRef.id })
    .from(environmentsTableRef)
    .where(
      and(
        eq(environmentsTableRef.ownerId, user.id),
        eq(environmentsTableRef.status, 'connected')
      )
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

function rowToTask(
  row: typeof tasksTable.$inferSelect,
  opts: { includeTerminalOutput?: boolean } = {}
): Task {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    title: row.title,
    description: row.description,
    prompt: row.prompt ?? undefined,
    repositoryId: row.repositoryId ?? undefined,
    branch: row.branch ?? undefined,
    assignedAgentId: row.assignedAgentId ?? undefined,
    assignedEnvironmentId: row.assignedEnvironmentId ?? undefined,
    result: (row.result as Task['result']) ?? undefined,
    metadata: (row.metadata as Task['metadata']) ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
    terminalOutput: opts.includeTerminalOutput ? row.terminalOutput || undefined : undefined,
    transcript: opts.includeTerminalOutput
      ? ((row.transcript as Task['transcript']) ?? undefined)
      : undefined,
  };
}
