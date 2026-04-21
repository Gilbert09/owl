import { EventEmitter } from 'events';
import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Task, TaskPriority, Agent, TaskStatus, TaskType } from '@fastowl/shared';
import { isAgentTask } from '@fastowl/shared';
import { agentService } from './agent.js';
import { environmentService } from './environment.js';
import { gitService } from './git.js';
import { resolveTaskGitContext } from './gitContext.js';
import { withTaskGitLog } from './gitLogService.js';
import { generateTaskTitle, looksLikePlaceholderTitle } from './ai.js';
import { permissionService } from './permissionService.js';
import { emitTaskStatus, emitTaskUpdate } from './websocket.js';
import { getDbClient, type Database } from '../db/client.js';
import {
  tasks as tasksTable,
  agents as agentsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';

// Priority weights; referenced by the SQL CASE expressions below.
const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  urgent: 1000,
  high: 100,
  medium: 10,
  low: 1,
};
// Silence unused warning: kept as canonical source of the priority order.
void PRIORITY_WEIGHTS;

/** How often recoverStuckTasks runs outside of init(). */
const STUCK_TASK_CHECK_MS = 2 * 60 * 1000;
/**
 * A task that's been `in_progress` for longer than this — without any
 * updated_at activity from the agent service — is considered stuck even
 * if its agent still exists. Typically means the agent session died
 * abnormally or the daemon connection dropped.
 */
const IN_PROGRESS_STALE_AFTER_MS = 20 * 60 * 1000;

class TaskQueueService extends EventEmitter {
  private processingInterval: NodeJS.Timeout | null = null;
  private stuckTaskInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private shuttingDown = false;

  private get db(): Database {
    return getDbClient();
  }

  /** Run a processQueue without logging the "DB client reset" noise
   *  that floats in from afterEach in tests. Anything else still logs. */
  private runProcessQueue(): void {
    if (this.shuttingDown) return;
    this.processQueue().catch((err) => {
      if (this.shuttingDown) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DATABASE_URL is not set')) return;
      console.error('[TaskQueue] processQueue error:', err);
    });
  }

  async init(): Promise<void> {
    await this.recoverStuckTasks();

    agentService.on('status', (_agentId, status) => {
      if (status === 'idle' || status === 'completed') {
        this.runProcessQueue();
      }
    });

    this.processingInterval = setInterval(() => {
      this.runProcessQueue();
    }, 5000);

    // Periodically recover stuck tasks — not just at boot. Agents can
    // die mid-task (daemon disconnect, process crash) during normal
    // operation; without this, a failed in_progress task would languish
    // until the next service restart.
    this.stuckTaskInterval = setInterval(() => {
      if (this.shuttingDown) return;
      this.recoverStuckTasks().catch((err) => {
        if (this.shuttingDown) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('DATABASE_URL is not set')) return;
        console.error('[TaskQueue] recoverStuckTasks error:', err);
      });
    }, STUCK_TASK_CHECK_MS);
  }

  /**
   * Reset tasks that are `in_progress` but have no live agent driving
   * them. Two criteria:
   *   1. The assigned agent doesn't exist or is in a terminal status
   *      (completed/error/idle) — agent process died.
   *   2. The task has been in_progress for >= IN_PROGRESS_STALE_AFTER_MS
   *      without `updated_at` moving — the agent might still exist but
   *      is silent (daemon disconnect, hung process, etc).
   *
   * Matched tasks go back to `queued`, their assigned_agent_id cleared,
   * so they're pickable on the next tick.
   */
  private async recoverStuckTasks(): Promise<void> {
    const staleCutoff = new Date(Date.now() - IN_PROGRESS_STALE_AFTER_MS);

    const stuckTasks = await this.db
      .select({
        id: tasksTable.id,
        workspaceId: tasksTable.workspaceId,
        title: tasksTable.title,
      })
      .from(tasksTable)
      .leftJoin(agentsTable, eq(tasksTable.assignedAgentId, agentsTable.id))
      .where(
        and(
          eq(tasksTable.status, 'in_progress'),
          or(
            isNull(tasksTable.assignedAgentId),
            isNull(agentsTable.id),
            // `idle` deliberately NOT here: interactive structured runs
            // sit in `idle` between turns while the child waits on
            // stdin. That's the intended steady state, not stuck.
            inArray(agentsTable.status, ['completed', 'error']),
            lt(tasksTable.updatedAt, staleCutoff)
          )
        )
      );

    if (stuckTasks.length === 0) return;

    // Two extra filters on top of the SQL match:
    //  1. Permission-pending: hook is blocked on a user click, so
    //     stdout is silent and `updated_at` won't budge. Legitimate.
    //  2. Live agent in memory: `cleanupStaleAgents` removes dead
    //     agent rows at boot, but between boots a task may match the
    //     `updated_at < cutoff` clause despite having a healthy
    //     in-memory agent (e.g. the user left the task idle in
    //     interactive mode for 20+ min). Don't reset those — we'd
    //     kill a live session and re-spawn the seed prompt, which is
    //     a very bad surprise.
    const actionable = stuckTasks.filter((t) => {
      if (permissionService.hasPendingForTask(t.id)) {
        console.log(
          `[TaskQueue] Task "${t.title}" looks stuck but has pending permission prompts — leaving alone`
        );
        return false;
      }
      if (agentService.getAgentByTaskId(t.id)) {
        console.log(
          `[TaskQueue] Task "${t.title}" looks stuck but has a live in-memory agent — leaving alone`
        );
        return false;
      }
      return true;
    });
    if (actionable.length === 0) return;

    console.log(`Found ${actionable.length} stuck task(s), resetting to queued...`);
    const now = new Date();
    for (const task of actionable) {
      await this.db
        .update(tasksTable)
        .set({ status: 'queued', assignedAgentId: null, updatedAt: now })
        .where(eq(tasksTable.id, task.id));
      console.log(`  Reset task: ${task.title}`);
      emitTaskStatus(task.workspaceId, task.id, 'queued');
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    if (this.stuckTaskInterval) {
      clearInterval(this.stuckTaskInterval);
      this.stuckTaskInterval = null;
    }
  }

  /** Tests re-use the singleton across describes — let them un-shutdown. */
  resetForTests(): void {
    this.shuttingDown = false;
  }

  async queueTask(taskId: string): Promise<void> {
    await this.db
      .update(tasksTable)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(eq(tasksTable.id, taskId));

    const task = await this.getTask(taskId);
    if (task) emitTaskStatus(task.workspaceId, taskId, 'queued');

    this.runProcessQueue();
  }

  async cancelTask(taskId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(tasksTable)
      .set({ status: 'cancelled', updatedAt: now, completedAt: now })
      .where(eq(tasksTable.id, taskId));

    const task = await this.getTask(taskId);
    if (task) emitTaskStatus(task.workspaceId, taskId, 'cancelled');
  }

  /**
   * Queued tasks ordered by priority weight then by creation time.
   */
  async getQueuedTasks(workspaceId?: string): Promise<Task[]> {
    const priorityCase = sql<number>`CASE ${tasksTable.priority}
      WHEN 'urgent' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      ELSE 4
    END`;

    const whereClause = workspaceId
      ? and(
          inArray(tasksTable.status, ['pending', 'queued']),
          eq(tasksTable.workspaceId, workspaceId)
        )
      : inArray(tasksTable.status, ['pending', 'queued']);

    const rows = await this.db
      .select()
      .from(tasksTable)
      .where(whereClause)
      .orderBy(priorityCase, tasksTable.createdAt);

    return rows.map(rowToTask);
  }

  async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const queuedTasks = await this.getQueuedTasks();
      if (queuedTasks.length === 0) return;

      console.log(`[TaskQueue] Processing ${queuedTasks.length} queued task(s)`);
      const idleAgents = await agentService.getIdleAgents();
      console.log(`[TaskQueue] Found ${idleAgents.length} idle agent(s)`);

      const connectedEnvironments = (await environmentService.getAllEnvironments())
        .filter((env) => env.status === 'connected');
      console.log(`[TaskQueue] Found ${connectedEnvironments.length} connected environment(s)`);

      for (const task of queuedTasks) {
        if (!isAgentTask(task.type)) {
          console.log(
            `[TaskQueue] Skipping task "${task.title}" - type is ${task.type}, not an agent task`
          );
          continue;
        }

        console.log(`[TaskQueue] Processing task: "${task.title}"`);

        const targetEnvironmentId = task.assignedEnvironmentId;
        let agentToUse: Agent | null = null;

        for (const agent of idleAgents) {
          if (agent.workspaceId !== task.workspaceId) continue;
          if (targetEnvironmentId && agent.environmentId !== targetEnvironmentId) continue;

          // Same (env, repo) slot guard as the new-agent path below.
          if (task.repositoryId) {
            const holder = await findTaskHoldingEnvRepoSlot(
              this.db,
              agent.environmentId,
              task.repositoryId,
              task.id
            );
            if (holder) {
              console.log(
                `[TaskQueue] Idle agent ${agent.id} on env ${agent.environmentId} blocked: (env, repo) slot held by task "${holder.title}" (${holder.status})`
              );
              continue;
            }
          }

          agentToUse = agent;
          console.log(`[TaskQueue] Found idle agent: ${agent.id}`);
          break;
        }

        if (!agentToUse) {
          console.log(`[TaskQueue] No idle agent found, checking for available environments...`);
          const workspace = await this.getWorkspaceSettings(task.workspaceId);
          const maxAgents = workspace?.maxConcurrentAgents ?? 3;
          const activeAgentCount = await this.getActiveAgentCount(task.workspaceId);
          console.log(`[TaskQueue] Active agents: ${activeAgentCount}/${maxAgents}`);

          if (activeAgentCount < maxAgents) {
            for (const env of connectedEnvironments) {
              console.log(
                `[TaskQueue] Checking environment: ${env.name} (${env.type}, status: ${env.status})`
              );
              const agentsInWorkspace = await agentService.getAgentsByWorkspace(task.workspaceId);
              const envHasActiveAgent = agentsInWorkspace.some(
                (a) => a.environmentId === env.id && agentService.isAgentActive(a.id)
              );

              if (envHasActiveAgent) {
                console.log(
                  `[TaskQueue] Environment ${env.name} already has an active agent, skipping`
                );
                continue;
              }

              // (env, repo) single-slot: an in_progress OR awaiting_review
              // task already owns the working tree for this repo on this
              // env. Starting a second one would stomp on its branch.
              if (task.repositoryId) {
                const holder = await findTaskHoldingEnvRepoSlot(
                  this.db,
                  env.id,
                  task.repositoryId,
                  task.id
                );
                if (holder) {
                  console.log(
                    `[TaskQueue] (env, repo) slot busy on ${env.name}: task "${holder.title}" is ${holder.status}; skipping`
                  );
                  continue;
                }
              }

              if (!targetEnvironmentId || env.id === targetEnvironmentId) {
                console.log(`[TaskQueue] Starting new agent on ${env.name}...`);

                // Prep the task branch on a synced base before the
                // agent touches anything. Manual `/start` does the
                // equivalent in routes/tasks.ts — but scheduler-picked
                // tasks previously skipped this entirely and edited
                // whatever branch happened to be checked out.
                let workingDirectory: string | undefined;
                let taskBranch: string | undefined = task.branch;
                if (task.repositoryId) {
                  const prep = await this.prepareRepoForTask(task, env.id);
                  if (!prep.ok) {
                    console.error(
                      `[TaskQueue] Failed to prepare repo for task "${task.title}": ${prep.error}`
                    );
                    continue;
                  }
                  workingDirectory = prep.workingDirectory;
                  if (prep.branch) taskBranch = prep.branch;
                }

                try {
                  const newAgent = await agentService.startAgent({
                    environmentId: env.id,
                    workspaceId: task.workspaceId,
                    taskId: task.id,
                    prompt: task.prompt || task.description,
                    workingDirectory,
                  });
                  console.log(`[TaskQueue] Agent started: ${newAgent.id}`);

                  const updateValues: Record<string, unknown> = {
                    status: 'in_progress',
                    assignedAgentId: newAgent.id,
                    updatedAt: new Date(),
                  };
                  if (taskBranch) updateValues.branch = taskBranch;

                  await this.db
                    .update(tasksTable)
                    .set(updateValues)
                    .where(eq(tasksTable.id, task.id));

                  emitTaskStatus(task.workspaceId, task.id, 'in_progress');
                  break;
                } catch (err) {
                  console.error(`[TaskQueue] Failed to start agent on ${env.name}:`, err);
                }
              }
            }
          } else {
            console.log(`[TaskQueue] Max concurrent agents reached (${activeAgentCount}/${maxAgents})`);
          }
        } else {
          console.log(`[TaskQueue] Sending task to idle agent ${agentToUse.id}...`);
          try {
            const prompt = task.prompt || task.description;
            agentService.sendInput(agentToUse.id, prompt);

            const now = new Date();
            await this.db
              .update(tasksTable)
              .set({ status: 'in_progress', assignedAgentId: agentToUse.id, updatedAt: now })
              .where(eq(tasksTable.id, task.id));
            await this.db
              .update(agentsTable)
              .set({ currentTaskId: task.id, status: 'working', lastActivity: now })
              .where(eq(agentsTable.id, agentToUse.id));

            emitTaskStatus(task.workspaceId, task.id, 'in_progress');
            idleAgents.splice(idleAgents.indexOf(agentToUse), 1);
          } catch (err) {
            console.error(`Failed to assign task to agent:`, err);
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async getTask(taskId: string): Promise<Task | null> {
    const rows = await this.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  private async getWorkspaceSettings(
    workspaceId: string
  ): Promise<{ maxConcurrentAgents?: number } | null> {
    const rows = await this.db
      .select({ settings: workspacesTable.settings })
      .from(workspacesTable)
      .where(eq(workspacesTable.id, workspaceId))
      .limit(1);
    if (!rows[0]) return null;
    return (rows[0].settings as { maxConcurrentAgents?: number } | null) ?? {};
  }

  private async getActiveAgentCount(workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.workspaceId, workspaceId),
          inArray(agentsTable.status, ['working', 'tool_use', 'awaiting_input'])
        )
      );
    return rows[0]?.count ?? 0;
  }

  /**
   * Resolve the repo's local path + sync the base branch + create the
   * task branch — the scheduler's equivalent of the block in
   * `routes/tasks.ts:/start`. Returns an error-typed result rather
   * than throwing so the caller can log + skip without aborting the
   * whole queue tick.
   */
  private async prepareRepoForTask(
    task: Task,
    environmentId: string
  ): Promise<
    | { ok: true; workingDirectory?: string; branch?: string }
    | { ok: false; error: string }
  > {
    const gitContext = await resolveTaskGitContext(task, environmentId);
    if (!gitContext) return { ok: true };

    // Refine the title inline if it's still the prompt placeholder —
    // mirrors the same step in /start so scheduler-launched tasks
    // also get clean branch slugs. The title patch is broadcast so
    // the desktop replaces the placeholder live.
    if (task.prompt && looksLikePlaceholderTitle(task.title, task.prompt)) {
      try {
        const refined = await generateTaskTitle(task.prompt, environmentId);
        if (refined && refined !== task.title) {
          await this.db
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
        console.warn(
          `[TaskQueue] inline title refinement failed for ${task.id}, branch slug may be ugly:`,
          err
        );
      }
    }

    const { workingDirectory, baseBranch } = gitContext;

    // Wrap the git work in a task-scoped context so every command
    // shows up in the desktop Git tab.
    return withTaskGitLog(task.id, async () => {
      if (task.branch) {
        try {
          await gitService.checkoutBranch(environmentId, task.branch, workingDirectory);
          return { ok: true, workingDirectory, branch: task.branch } as const;
        } catch (err) {
          console.warn(
            `[TaskQueue] Failed to checkout existing branch ${task.branch}, will create fresh:`,
            err
          );
        }
      }

      try {
        const branch = await gitService.prepareTaskBranch({
          environmentId,
          taskId: task.id,
          taskTitle: task.title,
          workingDirectory,
          baseBranch,
        });
        return { ok: true, workingDirectory, branch } as const;
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as const;
      }
    });
  }
}

/**
 * Find the task currently holding the (env, repo) single-slot, or null
 * if the slot is free. `in_progress` holds it (agent is actively
 * writing); `awaiting_review` holds it too because the working tree is
 * still dirty with that task's work until approve/reject commits or
 * resets it.
 *
 * Used by both the scheduler and `/start` to refuse to launch a second
 * task that would stomp on the first's branch.
 */
export async function findTaskHoldingEnvRepoSlot(
  db: Database,
  envId: string,
  repoId: string,
  excludeTaskId?: string
): Promise<{ id: string; title: string; status: string } | null> {
  const conditions = [
    eq(tasksTable.assignedEnvironmentId, envId),
    eq(tasksTable.repositoryId, repoId),
    inArray(tasksTable.status, ['in_progress', 'awaiting_review']),
  ];
  if (excludeTaskId) conditions.push(ne(tasksTable.id, excludeTaskId));

  const rows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
    })
    .from(tasksTable)
    .where(and(...conditions))
    .limit(1);

  return rows[0] ?? null;
}

function rowToTask(row: typeof tasksTable.$inferSelect): Task {
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
  };
}

export const taskQueueService = new TaskQueueService();
