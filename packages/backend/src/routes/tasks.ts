import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { and, desc, eq, SQL, sql } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  workspaces as workspacesTable,
  environments as environmentsTableRef,
} from '../db/schema.js';
import { agentService } from '../services/agent.js';
import { environmentService } from '../services/environment.js';
import { gitService } from '../services/git.js';
import { resolveTaskGitContext } from '../services/gitContext.js';
import { enterTaskGitLog, getGitLog } from '../services/gitLogService.js';
import { prefetchCommitMessage } from '../services/commitMessagePrefetch.js';
import { openPullRequestForTask } from '../services/taskPullRequest.js';
import { findTaskHoldingEnvRepoSlot } from '../services/taskQueue.js';
import { emitTaskStatus, emitTaskUpdate, emitTaskDeleted } from '../services/websocket.js';
import {
  generateCommitMessage,
  generateTaskMetadata,
  generateTaskTitle,
  isConfigured as isAIConfigured,
  looksLikePlaceholderTitle,
} from '../services/ai.js';
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
      const metadata = await generateTaskMetadata(body.prompt, body.assignedEnvironmentId);
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

    // Agent tasks must declare a repository — tasks branch + commit
    // against it, and a task without a repo has nowhere for
    // prepareTaskBranch / /approve / /reject to operate. Manual tasks
    // don't need one.
    if (isAgentTask(body.type) && !body.repositoryId) {
      return res.status(400).json({
        success: false,
        error:
          'repositoryId is required for agent tasks. Add a repository (with a local path) in Settings first.',
      });
    }

    const db = getDbClient();
    const id = uuid();
    const now = new Date();

    await db.insert(tasksTable).values({
      id,
      workspaceId: body.workspaceId,
      type: body.type,
      // Auto-enqueue on create. The scheduler already treats `pending`
      // and `queued` identically for picking work; going straight to
      // `queued` makes the UI reflect the scheduler's intent without
      // a 5s poll-lag. Users who want to create a task without queuing
      // it can PATCH the status afterward.
      status: 'queued',
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

    // Fire-and-forget title refinement. The modal sends a placeholder
    // title (typically the prompt's first 60 chars); the fast Haiku
    // model produces something friendlier in ~500ms. Result is
    // patched into the task row and pushed to every client via
    // `task:update` so the desktop replaces the placeholder without
    // a manual refresh.
    if (body.prompt && isAIConfigured()) {
      void generateTaskTitle(body.prompt, body.assignedEnvironmentId)
        .then(async (generatedTitle) => {
          if (!generatedTitle || generatedTitle === body.title) return;
          const updatedAt = new Date();
          await db
            .update(tasksTable)
            .set({ title: generatedTitle, updatedAt })
            .where(eq(tasksTable.id, id));
          emitTaskUpdate(body.workspaceId, id, {
            title: generatedTitle,
            updatedAt: updatedAt.toISOString(),
          });
        })
        .catch((err) => {
          console.error('[tasks] async title generation failed:', err);
        });
    }
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

    // (env, repo) single-slot: refuse to start if a different task is
    // already holding the working tree on this pair.
    if (task.repositoryId) {
      const holder = await findTaskHoldingEnvRepoSlot(
        db,
        environmentId,
        task.repositoryId,
        task.id
      );
      if (holder) {
        return res.status(409).json({
          success: false,
          error: `Repository is busy on this environment — task "${holder.title}" is ${holder.status}. Approve or reject it before starting another.`,
        });
      }
    }

    // Flip the task to `in_progress` BEFORE we do the slow git prep
    // (fetch + pull + checkout -b) — otherwise the task sits in
    // `queued` for 10-60s from the UI's perspective. Git activity is
    // already visible via the Git tab (enterTaskGitLog).
    {
      const now = new Date();
      await db
        .update(tasksTable)
        .set({
          status: 'in_progress',
          assignedEnvironmentId: environmentId,
          updatedAt: now,
        })
        .where(eq(tasksTable.id, task.id));
      emitTaskStatus(task.workspaceId, task.id, 'in_progress');
    }

    // Branch slug derives from task.title. If the title is still the
    // raw-prompt placeholder (LLM refinement hasn't landed yet because
    // the user clicked Start within ~2s of Create), refine it inline
    // here so the branch comes out clean — `fastowl/<id>-<slug>` looks
    // bad with 30 chars of arbitrary prompt text.
    if (task.prompt && looksLikePlaceholderTitle(task.title, task.prompt)) {
      try {
        const refined = await generateTaskTitle(task.prompt, environmentId);
        if (refined && refined !== task.title) {
          await db
            .update(tasksTable)
            .set({ title: refined, updatedAt: new Date() })
            .where(eq(tasksTable.id, task.id));
          task.title = refined;
          emitTaskUpdate(task.workspaceId, task.id, {
            title: refined,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        // Non-fatal — branch will fall back to the placeholder slug.
        console.warn('[tasks] inline title refinement failed, branch slug may be ugly:', err);
      }
    }

    let workingDirectory: string | undefined;
    let taskBranch: string | undefined;

    // Helper: any git-prep / agent-start failure below has to roll
    // the task back out of in_progress, since we flipped it early.
    const rollbackToFailed = async (error: string): Promise<void> => {
      const now = new Date();
      await db
        .update(tasksTable)
        .set({
          status: 'failed',
          result: { success: false, error },
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(tasksTable.id, task.id));
      emitTaskStatus(task.workspaceId, task.id, 'failed', {
        success: false,
        error,
      });
    };

    const gitContext = await resolveTaskGitContext(task, environmentId);
    if (!gitContext && isAgentTask(task.type) && task.repositoryId) {
      // Agent task tied to a repo, but the repo has no localPath.
      // Refuse rather than silently running on whatever branch is
      // checked out in the env's default working directory.
      const msg =
        "This task's repository has no local path configured. Set a local path for the repository in Settings before starting the task.";
      await rollbackToFailed(msg);
      return res.status(400).json({ success: false, error: msg });
    }
    if (gitContext) {
      workingDirectory = gitContext.workingDirectory;
      enterTaskGitLog(task.id);

      if (task.branch) {
        // Resume: checkout the existing task branch. Skip base sync —
        // we don't want to rewrite history on work already in flight.
        try {
          await gitService.checkoutBranch(environmentId, task.branch, workingDirectory);
          taskBranch = task.branch;
        } catch (err) {
          console.warn('Failed to checkout existing branch, will create fresh:', err);
        }
      }

      if (!taskBranch) {
        try {
          taskBranch = await gitService.prepareTaskBranch({
            environmentId,
            taskId: task.id,
            taskTitle: task.title,
            workingDirectory,
            baseBranch: gitContext.baseBranch,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await rollbackToFailed(msg);
          return res.status(400).json({ success: false, error: msg });
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

      // Task status was already flipped to in_progress up-front; just
      // fill in the agent + branch references now that they exist.
      const updateValues: Record<string, unknown> = {
        assignedAgentId: agent.id,
        updatedAt: new Date(),
      };
      if (taskBranch) updateValues.branch = taskBranch;

      await db
        .update(tasksTable)
        .set(updateValues)
        .where(eq(tasksTable.id, task.id));

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
      await rollbackToFailed(msg);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // Continue an exited conversation with a new prompt. Spawns a
  // fresh CLI child with `--resume <claudeSessionId>` and the prompt.
  // Task flips back from awaiting_review/completed/failed → in_progress.
  router.post('/:id/continue', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const { prompt } = req.body as { prompt?: string };
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ success: false, error: 'prompt is required' });
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

    // Idempotent: if the task has come back to in_progress (e.g. the
    // scheduler beat us), treat the call as accepted — the user's
    // next input action will go through the live input pipe.
    if (task.status === 'in_progress') {
      return res.json({ success: true, data: task } as ApiResponse<Task>);
    }

    try {
      await agentService.continueTask({
        taskId: task.id,
        workspaceId: task.workspaceId,
        prompt,
      });
      const updatedRows = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, task.id))
        .limit(1);
      res.json({ success: true, data: rowToTask(updatedRows[0]) } as ApiResponse<Task>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to continue task';
      res.status(400).json({ success: false, error: msg });
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
    void prefetchCommitMessage(task.id);

    const updatedRows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(updatedRows[0]) } as ApiResponse<Task>);
  });

  // Approve an awaiting_review task → commit + push branch → completed
  router.post('/:id/approve', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const { commitMessage: overrideMessage } = (req.body ?? {}) as {
      commitMessage?: string;
    };

    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    if (rows[0].status !== 'awaiting_review') {
      return res.status(400).json({ success: false, error: 'Task is not awaiting review' });
    }

    const task = rowToTask(rows[0]);

    // Agent tasks must commit + push before they can be completed. We
    // refuse to flip the status flag without doing the actual git work
    // — the previous behaviour silently marked completed when any
    // precondition was missing (no branch, no repo, no env), which is
    // how "Approve & push did nothing but said success" happened.
    if (isAgentTask(task.type)) {
      if (!task.branch) {
        return res.status(400).json({
          success: false,
          error:
            'Task has no branch. It was likely started before branch-per-task was wired up. Reject and re-queue, then approve the new run.',
        });
      }
      // Tasks are supposed to pick up an env on /start, but a task can
      // reach awaiting_review without one (scheduler rolled back, env
      // got deleted mid-flight, task created via a code path that
      // didn't persist it). Rather than refuse the approve, mirror
      // /start's behaviour and attach any connected env we can find,
      // then keep going. Log it so we can track down the upstream
      // anomaly — the UI would otherwise leave the user dead in the
      // water with no way to ship their work.
      if (!task.assignedEnvironmentId) {
        const fallbackEnv = await findConnectedEnvironmentForUser(req);
        if (!fallbackEnv) {
          return res.status(400).json({
            success: false,
            error:
              'Task has no assigned environment and no connected environment is available. Connect an environment in Settings.',
          });
        }
        console.warn(
          `[tasks] approve ${task.id.slice(0, 8)}: task lacked assignedEnvironmentId; attaching ${fallbackEnv}`
        );
        await db
          .update(tasksTable)
          .set({ assignedEnvironmentId: fallbackEnv, updatedAt: new Date() })
          .where(eq(tasksTable.id, task.id));
        task.assignedEnvironmentId = fallbackEnv;
      }

      const gitContext = await resolveTaskGitContext(task, task.assignedEnvironmentId);
      if (!gitContext) {
        return res.status(400).json({
          success: false,
          error:
            "Task's repository has no local path configured. Set one in Settings → Repositories before approving.",
        });
      }

      const workingDirectory = gitContext.workingDirectory;
      const envId = task.assignedEnvironmentId;
      const baseBranch = gitContext.baseBranch;
      const tag = `[tasks] approve ${task.id.slice(0, 8)}`;
      console.log(
        `${tag}: starting · env=${envId} wd=${workingDirectory} branch=${task.branch}`
      );
      // Audit every git command into the task's gitLog so the desktop's
      // Git tab can show what happened.
      enterTaskGitLog(task.id);

      try {
        // Defensive: explicitly checkout the task branch before
        // staging. The agent may have moved off the branch (or never
        // landed on it cleanly), and committing on the wrong branch
        // is exactly the failure mode that produced the silent-bug.
        const before = await gitService.getCurrentBranch(envId, workingDirectory);
        console.log(`${tag}: current branch before commit is ${before}`);
        if (before !== task.branch) {
          console.warn(`${tag}: not on task branch (on ${before}); checking out ${task.branch}`);
          await gitService.checkoutBranch(envId, task.branch, workingDirectory);
          const after = await gitService.getCurrentBranch(envId, workingDirectory);
          if (after !== task.branch) {
            return res.status(500).json({
              success: false,
              error: `Could not switch to task branch ${task.branch} (still on ${after}).`,
            });
          }
          console.log(`${tag}: now on ${after}`);
        }

        let message = overrideMessage?.trim();
        if (!message) {
          const [diffStat, diff] = await Promise.all([
            gitService.getDiffStat(envId, task.branch, baseBranch, workingDirectory),
            gitService.getDiff(envId, task.branch, baseBranch, workingDirectory),
          ]);
          message = await generateCommitMessage({
            title: task.title,
            prompt: task.prompt,
            diffStat,
            diff,
            preferredEnvId: envId,
          });
        }

        console.log(`${tag}: committing with subject: ${message.split('\n')[0]}`);
        const sha = await gitService.commitAll(envId, message, workingDirectory);
        console.log(`${tag}: commit result sha=${sha ?? '(none — nothing to stage)'}`);

        if (!sha) {
          // Nothing got committed. Either everything was already
          // committed by the agent (unlikely — it doesn't run git
          // commit on its own) or every change is gitignored. Either
          // way, refuse to mark completed and tell the user.
          return res.status(400).json({
            success: false,
            error:
              "Nothing to commit. The agent's changes may all be in .gitignore, or there were no edits. Task left in awaiting_review.",
          });
        }

        console.log(`${tag}: pushing branch ${task.branch} to origin`);
        await gitService.pushBranch(envId, task.branch, workingDirectory);
        console.log(`${tag}: push done`);

        // Open the PR synchronously. Used to be fire-and-forget, but
        // the task was flipping to `completed` before the PR existed,
        // which read to the user as "approve finished, nothing got
        // published." Awaiting keeps the task in `awaiting_review`
        // until the PR is up (or openPullRequestForTask has written a
        // pullRequestError onto metadata for the retry button). All
        // failure modes are internalised — the call never throws.
        await openPullRequestForTask(task.id);

        // Final guard: working tree must be clean before we call this
        // task done. Catches anything subtle that left modifications
        // behind (post-commit edits, partial stage failures, etc.).
        const stillDirty = await gitService.hasUncommittedChanges(envId, workingDirectory);
        if (stillDirty) {
          return res.status(500).json({
            success: false,
            error:
              'Commit + push completed but working tree still has uncommitted changes. Task left in awaiting_review.',
          });
        }

        // Snapshot the per-file list + each file's diff onto
        // task.metadata.finalFiles BEFORE we delete the local
        // branch. Post-completion the Files tab reads from this
        // snapshot — the task becomes self-contained and history
        // doesn't depend on the env being online or the remote
        // branch still existing.
        try {
          const files = await gitService.getChangedFiles(
            envId,
            baseBranch,
            workingDirectory
          );
          const FILE_DIFF_CAP = 50_000;
          const snapshot = await Promise.all(
            files.map(async (f) => {
              if (f.binary) return { ...f, diff: '' };
              let diff = '';
              try {
                diff = await gitService.getFileDiff(
                  envId,
                  baseBranch,
                  f.path,
                  workingDirectory
                );
              } catch (err) {
                console.warn(`${tag}: snapshot diff failed for ${f.path}:`, err);
              }
              if (diff.length > FILE_DIFF_CAP) {
                diff = diff.slice(0, FILE_DIFF_CAP) + '\n[… truncated …]';
              }
              return { ...f, diff };
            })
          );

          const existingMetadata = (rows[0].metadata as Record<string, unknown>) ?? {};
          await db
            .update(tasksTable)
            .set({
              metadata: { ...existingMetadata, finalFiles: snapshot },
              updatedAt: new Date(),
            })
            .where(eq(tasksTable.id, task.id));
          console.log(`${tag}: snapshotted ${snapshot.length} file diffs to metadata`);
        } catch (snapshotErr) {
          console.warn(`${tag}: final-diff snapshot failed (non-fatal):`, snapshotErr);
        }

        // Cleanup: return to base branch + drop the local task branch
        // so the env+repo slot is free.
        try {
          await gitService.checkoutBranch(envId, baseBranch, workingDirectory);
          await gitService.forceDeleteBranch(envId, task.branch, workingDirectory);
          console.log(`${tag}: cleanup done · checked out ${baseBranch}, deleted ${task.branch}`);
        } catch (cleanupErr) {
          console.warn(`${tag}: local branch cleanup failed (non-fatal):`, cleanupErr);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag}: commit/push failed:`, err);
        return res.status(500).json({
          success: false,
          error: `Commit/push failed: ${msg}. Task left in awaiting_review.`,
        });
      }
    }

    const now = new Date();
    await db
      .update(tasksTable)
      .set({ status: 'completed', completedAt: now, updatedAt: now })
      .where(eq(tasksTable.id, req.params.id));

    emitTaskStatus(task.workspaceId, req.params.id, 'completed');

    const updatedRows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(updatedRows[0]) } as ApiResponse<Task>);
  });

  // Reject an awaiting_review task → stash rejected work to a backup
  // ref → reset working tree to base → re-queue so the env+repo slot
  // is usable again. The backup ref lets the user recover rejected
  // work with `git checkout -b <name> refs/fastowl/rejected/<taskId>`.
  router.post('/:id/reject', async (req, res) => {
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
    if (rows[0].status !== 'awaiting_review') {
      return res.status(400).json({ success: false, error: 'Task is not awaiting review' });
    }

    const task = rowToTask(rows[0]);

    if (task.branch && task.assignedEnvironmentId) {
      const gitContext = await resolveTaskGitContext(task, task.assignedEnvironmentId);
      if (gitContext) {
        const envId = task.assignedEnvironmentId;
        const workingDirectory = gitContext.workingDirectory;
        const baseBranch = gitContext.baseBranch;
        // Audit every git command into the task's gitLog.
        enterTaskGitLog(task.id);

        try {
          await gitService.stashToBackupRef(envId, 'rejected', task.id, workingDirectory);
          await gitService.resetToBase(envId, baseBranch, workingDirectory);
          // Delete the branch so a re-queue + retry gets a fresh
          // prepareTaskBranch off the synced base.
          try {
            await gitService.forceDeleteBranch(envId, task.branch, workingDirectory);
          } catch (err) {
            console.warn('[tasks] reject: failed to delete rejected branch (continuing):', err);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[tasks] reject: working-tree reset failed:', err);
          return res.status(500).json({
            success: false,
            error: `Reset failed: ${msg}. Task left in awaiting_review.`,
          });
        }
      }
    }

    await db
      .update(tasksTable)
      .set({
        status: 'queued',
        assignedAgentId: null,
        // Clear branch so the re-queued task gets a fresh
        // prepareTaskBranch run. The rejected work lives under
        // refs/fastowl/rejected/<taskId> if the user wants it back.
        branch: null,
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, req.params.id));

    emitTaskStatus(task.workspaceId, req.params.id, 'queued');

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

  // Propose a commit message for an awaiting_review task so the
  // desktop approve modal can pre-fill the textarea. Calls the same
  // helper `/approve` uses when no override is supplied.
  router.get('/:id/proposed-commit-message', async (req, res) => {
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

    // Serve from the prefetched cache if available — the backend
    // kicks off a background generation the moment a task lands in
    // awaiting_review, so the modal opens instantly in the common
    // case instead of waiting on a 3–5s daemon CLI round-trip.
    const cached =
      (task.metadata as { proposedCommitMessage?: string } | undefined)
        ?.proposedCommitMessage;
    if (typeof cached === 'string' && cached.trim().length > 0) {
      return res.json({
        success: true,
        data: { message: cached },
      } as ApiResponse<{ message: string }>);
    }

    let diffStat: string | undefined;
    let diff: string | undefined;
    if (task.branch && task.assignedEnvironmentId) {
      const gitContext = await resolveTaskGitContext(task, task.assignedEnvironmentId);
      if (gitContext) {
        try {
          [diffStat, diff] = await Promise.all([
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
        } catch (err) {
          // If we can't read the diff, still return a reasonable
          // message from title/prompt alone rather than erroring out.
          console.warn('[tasks] proposed-commit-message: failed to read diff:', err);
        }
      }
    }

    const message = await generateCommitMessage({
      title: task.title,
      prompt: task.prompt,
      diffStat,
      diff,
      preferredEnvId: task.assignedEnvironmentId ?? undefined,
    });

    res.json({ success: true, data: { message } } as ApiResponse<{ message: string }>);
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
      .select({ branch: tasksTable.branch })
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    const branch = rows[0].branch;
    if (!branch) {
      return res.status(400).json({ success: false, error: 'Task has no branch to diff' });
    }

    const context = await resolveTaskDiffContext(req);
    if (!context.ok) {
      return res.status(context.status).json({ success: false, error: context.error });
    }

    try {
      const diff = await gitService.getDiff(
        context.environmentId,
        branch,
        context.baseBranch,
        context.workingDirectory
      );
      res.json({ success: true, data: { diff } } as ApiResponse<{ diff: string }>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to get diff';
      console.error('Failed to get diff:', err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // Retry creating a PR for a task whose first attempt errored
  // (usually a missing GH integration, a pre-existing PR, or a
  // transient GH API failure). Re-runs openPullRequestForTask,
  // which overwrites task.metadata.pullRequest or ...Error.
  router.post('/:id/retry-pr', async (req, res) => {
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
    if (!task.branch) {
      return res.status(400).json({
        success: false,
        error: 'Task has no branch — cannot create a PR.',
      });
    }

    // Run synchronously so the desktop gets a meaningful response
    // (success → new PR URL, failure → the error the user saw before
    // but now also persisted on metadata).
    await openPullRequestForTask(task.id);

    const updated = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    const updatedTask = rowToTask(updated[0]);
    const prState =
      (updatedTask.metadata as {
        pullRequest?: { number: number; url: string };
        pullRequestError?: string;
      } | undefined) ?? {};

    if (prState.pullRequest) {
      return res.json({
        success: true,
        data: { pullRequest: prState.pullRequest },
      });
    }
    return res.status(502).json({
      success: false,
      error: prState.pullRequestError || 'PR creation failed',
    });
  });

  // Read the audit log of every git command FastOwl ran on this
  // task's behalf — drives the desktop Git tab.
  router.get('/:id/git-log', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const entries = await getGitLog(req.params.id);
    res.json({ success: true, data: { entries } } as ApiResponse<{
      entries: Awaited<ReturnType<typeof getGitLog>>;
    }>);
  });

  // List files changed on this task's branch vs base, one entry per path.
  // Drives the desktop Files tab.
  router.get('/:id/diff/files', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }

    // Prefer the snapshot persisted at approve time — once the task
    // is completed, the local branch is gone and the working tree is
    // back on base, so live `git diff` would return nothing. The
    // snapshot is the record of what actually shipped.
    const snapshot = await readFinalFilesSnapshot(req.params.id);
    if (snapshot) {
      const files = snapshot.map((f) => ({
        path: f.path,
        status: f.status,
        added: f.added,
        removed: f.removed,
        binary: f.binary,
      }));
      return res.json({ success: true, data: { files } } as ApiResponse<{ files: typeof files }>);
    }

    const context = await resolveTaskDiffContext(req);
    if (!context.ok) return res.status(context.status).json({ success: false, error: context.error });
    try {
      const files = await gitService.getChangedFiles(
        context.environmentId,
        context.baseBranch,
        context.workingDirectory
      );
      res.json({ success: true, data: { files } } as ApiResponse<{ files: typeof files }>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to list changed files';
      console.error('[tasks] diff/files failed:', err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // Unified diff for a single file on this task's branch vs base.
  router.get('/:id/diff/file', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const pathParam = req.query.path;
    if (typeof pathParam !== 'string' || !pathParam) {
      return res.status(400).json({ success: false, error: 'path query param is required' });
    }

    const snapshot = await readFinalFilesSnapshot(req.params.id);
    if (snapshot) {
      const hit = snapshot.find((f) => f.path === pathParam);
      if (hit) {
        return res.json({
          success: true,
          data: { diff: hit.diff ?? '' },
        } as ApiResponse<{ diff: string }>);
      }
    }

    const context = await resolveTaskDiffContext(req);
    if (!context.ok) return res.status(context.status).json({ success: false, error: context.error });
    try {
      const diff = await gitService.getFileDiff(
        context.environmentId,
        context.baseBranch,
        pathParam,
        context.workingDirectory
      );
      res.json({ success: true, data: { diff } } as ApiResponse<{ diff: string }>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to get file diff';
      console.error('[tasks] diff/file failed:', err);
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
    try {
      const rows = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, req.params.id))
        .limit(1);
      const task = rows[0] ? rowToTask(rows[0]) : null;
      if (task && task.status === 'in_progress') {
        const activeAgent = agentService.getAgentByTaskId(task.id);
        if (activeAgent) agentService.stopAgent(activeAgent.id);
      }

      const result = await db
        .delete(tasksTable)
        .where(eq(tasksTable.id, req.params.id))
        .returning({ id: tasksTable.id });
      if (result.length === 0) {
        return res.status(404).json({ success: false, error: 'Task not found' });
      }
      // Broadcast so other connected clients (and as defense in depth,
      // the originating client) drop the row from their local state.
      if (task) {
        emitTaskDeleted(task.workspaceId, task.id);
      }
      res.json({ success: true } as ApiResponse<void>);
    } catch (err) {
      // Surface DB errors (FK violations, RLS denials, etc.) — the old
      // handler swallowed them as a generic 500 with no body, which made
      // "delete silently fails" reports very hard to debug.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tasks] delete failed for ${req.params.id}:`, err);
      res.status(500).json({ success: false, error: `Delete failed: ${message}` });
    }
  });

  return router;
}

/**
 * Pick an auto-assignable environment for the current user. Returns the
 * environment id of the first connected env, or null when they have none.
 * Kept here rather than on `environmentService` because the service is
 * stateless re: users and we want the scoping explicit at the call site.
 */
/**
 * Resolve the env + repo working directory + base branch for a task —
 * the stuff every per-file diff route needs before it can shell out.
 * Returns a discriminated union so call sites can surface the right
 * HTTP status without duplicating the lookup dance.
 */
async function resolveTaskDiffContext(
  req: import('express').Request
): Promise<
  | { ok: true; environmentId: string; workingDirectory: string; baseBranch: string }
  | { ok: false; status: number; error: string }
> {
  const db = getDbClient();
  const rows = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, req.params.id))
    .limit(1);
  if (!rows[0]) return { ok: false, status: 404, error: 'Task not found' };
  const task = rowToTask(rows[0]);
  if (!task.branch) {
    return { ok: false, status: 400, error: 'Task has no branch to diff' };
  }

  let environmentId = task.assignedEnvironmentId;
  if (!environmentId) {
    const connected = await findConnectedEnvironmentForUser(req);
    if (!connected) {
      return { ok: false, status: 400, error: 'No connected environment to compute diff' };
    }
    environmentId = connected;
  } else {
    try {
      await requireEnvironmentAccess(req, environmentId);
    } catch (err) {
      if (err instanceof Error && err.message === 'Forbidden') {
        return { ok: false, status: 403, error: 'Forbidden' };
      }
      return { ok: false, status: 500, error: err instanceof Error ? err.message : 'Access check failed' };
    }
  }

  const gitContext = await resolveTaskGitContext(task, environmentId);
  if (!gitContext) {
    return {
      ok: false,
      status: 400,
      error:
        'Could not resolve a git working directory for this task. ' +
        'Either register a repository with a local path, or configure the environment with a workingDirectory that points at a git checkout.',
    };
  }

  return {
    ok: true,
    environmentId,
    workingDirectory: gitContext.workingDirectory,
    baseBranch: gitContext.baseBranch,
  };
}

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

interface FinalFileEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  added: number;
  removed: number;
  binary: boolean;
  diff?: string;
}

/**
 * Return the persisted per-file snapshot captured at approve time,
 * or null if the task never reached completion / was approved before
 * snapshots were added.
 */
async function readFinalFilesSnapshot(taskId: string): Promise<FinalFileEntry[] | null> {
  const db = getDbClient();
  const rows = await db
    .select({ metadata: tasksTable.metadata })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const metadata = rows[0]?.metadata as Record<string, unknown> | undefined;
  const snapshot = metadata?.finalFiles;
  return Array.isArray(snapshot) ? (snapshot as FinalFileEntry[]) : null;
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
