import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  Agent,
  AgentStatus,
  AgentAttention,
  InboxItem,
  StartAgentRequest,
  TaskType,
} from '@fastowl/shared';
import { isAgentTask } from '@fastowl/shared';
import { environmentService } from './environment.js';
import { agentStructuredService } from './agentStructured.js';
import { daemonRegistry } from './daemonRegistry.js';
import { permissionService } from './permissionService.js';
import { ensurePermissionHook } from './permissionHook.js';
import { prefetchCommitMessage } from './commitMessagePrefetch.js';
import {
  emitAgentStatus,
  emitInboxNew,
  emitTaskAgentStatus,
  emitTaskStatus,
} from './websocket.js';
import { getDbClient, type Database } from '../db/client.js';
import {
  agents as agentsTable,
  tasks as tasksTable,
  inboxItems as inboxItemsTable,
} from '../db/schema.js';

export interface ActiveAgent {
  id: string;
  environmentId: string;
  workspaceId: string;
  sessionId: string;
  status: AgentStatus;
  attention: AgentAttention;
  lastActivityTime: Date;
  currentTaskId?: string;
}

/**
 * Agent lifecycle on top of the structured (stream-json) runtime.
 * PTY was removed in Slice 4c — every run goes through
 * `agentStructuredService`, which spawns `claude -p` non-PTY and
 * emits JSONL events to the desktop.
 */
class AgentService extends EventEmitter {
  private activeAgents: Map<string, ActiveAgent> = new Map();
  private statusCheckInterval: NodeJS.Timeout | null = null;

  private get db(): Database {
    return getDbClient();
  }

  async init(): Promise<void> {
    await this.cleanupStaleAgents();

    // Structured runs fire `turn_complete` after each `result` event.
    // One-shot runs already exit the CLI here (handleStructuredExit
    // flips the task to awaiting_review). Interactive runs keep the
    // CLI alive between turns — we auto-finish those too: flip the
    // agent to idle, then on agent tasks fire the same path
    // /ready-for-review takes (stop the child + move task to
    // awaiting_review). Saves the user a manual Finish click; if
    // they want another turn they use the Continue button.
    agentStructuredService.on(
      'turn_complete',
      (run: { interactive: boolean; agentId: string; taskId?: string; workspaceId: string }) => {
        if (!run.interactive) return;
        this.updateAgentStatus(run.agentId, 'idle', 'none').catch((err) =>
          console.error('turn_complete status update failed:', err)
        );
        if (run.taskId) {
          void this.maybeAutoFinishAgentTask(run.taskId, run.agentId, run.workspaceId);
        }
      }
    );

    // Capture the CLI's session id on the task metadata the first
    // time we see it. Powers `/tasks/:id/continue` — user types a
    // follow-up prompt after the task has landed in awaiting_review,
    // we spawn a fresh child with `--resume <id>` and that prompt.
    agentStructuredService.on(
      'session_id_captured',
      (run: { taskId?: string }, sessionId: string) => {
        if (!run.taskId) return;
        this.db
          .update(tasksTable)
          .set({
            metadata: sql`
              COALESCE(${tasksTable.metadata}, '{}'::jsonb) ||
              ${JSON.stringify({ claudeSessionId: sessionId })}::jsonb
            `,
          })
          .where(eq(tasksTable.id, run.taskId))
          .catch((err) =>
            console.error('[agent] failed to persist claudeSessionId:', err)
          );
      }
    );

    this.statusCheckInterval = setInterval(() => {
      this.checkStuckAgents();
    }, 60000);
  }

  /**
   * Reconcile in-progress agent rows against what daemons actually
   * still have running after a backend restart.
   *
   * Pre-"daemon everywhere" this was a blanket nuke — agents ran as
   * child processes of the backend, so backend exit = SIGPIPE = dead
   * child, no exceptions. Now daemons own the child pipes and survive
   * backend restart, so some "stale" agent rows actually describe
   * live work.
   *
   * Flow:
   *   1. Schedule a deferred sweep (60s grace) to give daemons time
   *      to reconnect + advertise their activeSessions.
   *   2. Subscribe to the registry's `daemon:connected` event so we
   *      can also sweep early when all expected daemons have dialled
   *      in (fast path for the common case).
   *   3. At sweep time: any agent whose env's daemon claims its
   *      session → leave alone (task stays in_progress; output will
   *      resume via session events). Anything else → fail + delete.
   *
   * Known gap tracked for a follow-up: the `agentStructuredService`
   * per-run state doesn't get rehydrated here, so even a surviving
   * agent row won't produce live UI events until a future commit
   * reconstructs that state from DB.
   */
  private async cleanupStaleAgents(): Promise<void> {
    const rows = await this.db
      .select({
        id: agentsTable.id,
        environmentId: agentsTable.environmentId,
        workspaceId: agentsTable.workspaceId,
        currentTaskId: agentsTable.currentTaskId,
        permissionToken: agentsTable.permissionToken,
      })
      .from(agentsTable)
      .where(inArray(agentsTable.status, ['idle', 'working', 'tool_use', 'awaiting_input']));
    if (rows.length === 0) return;

    console.log(
      `[agent] reconciling ${rows.length} in-flight agent(s) after restart…`,
    );

    const GRACE_MS = 60_000;
    const expectedEnvIds = new Set(rows.map((r) => r.environmentId));
    // Sessions are keyed by `agent:<agentId>` — see `spawnStructuredRun`
    // in this file and the daemon's streamSessions map. That naming is
    // the contract we use to match DB rows against daemon-claimed
    // live session ids.
    const sessionIdFor = (agentId: string) => `agent:${agentId}`;

    const sweep = async (): Promise<void> => {
      daemonRegistry.off('daemon:connected', onDaemonConnected);
      if (sweptOnce) return;
      sweptOnce = true;

      const toFail: typeof rows = [];
      const survivors: typeof rows = [];
      for (const row of rows) {
        if (daemonRegistry.isSessionLive(sessionIdFor(row.id))) {
          survivors.push(row);
        } else {
          toFail.push(row);
        }
      }

      if (survivors.length > 0) {
        console.log(
          `[agent] ${survivors.length} agent(s) survived the restart — resuming runs.`,
        );
        await Promise.all(survivors.map((row) => this.resumeStaleAgent(row)));
      }
      if (toFail.length === 0) return;

      const failIds = toFail.map((r) => r.id);
      const taskIds = toFail
        .map((r) => r.currentTaskId)
        .filter((id): id is string => !!id);
      await this.db.delete(agentsTable).where(inArray(agentsTable.id, failIds));
      if (taskIds.length > 0) {
        const now = new Date();
        await this.db
          .update(tasksTable)
          .set({
            status: 'failed',
            completedAt: now,
            updatedAt: now,
            result: {
              success: false,
              error: 'backend restart orphaned the agent',
            },
          })
          .where(
            and(inArray(tasksTable.id, taskIds), eq(tasksTable.status, 'in_progress')),
          );
      }
      console.log(
        `[agent] failed ${toFail.length} orphaned agent(s) + ${taskIds.length} task(s).`,
      );
    };

    let sweptOnce = false;
    // Fast path: once every expected env's daemon has reconnected,
    // the reconcile answer is stable — no reason to wait for the
    // 60s timer to elapse.
    const onDaemonConnected = () => {
      const connected = daemonRegistry.connectedEnvironmentIds();
      const allIn = [...expectedEnvIds].every((id) => connected.has(id));
      if (allIn) void sweep();
    };
    daemonRegistry.on('daemon:connected', onDaemonConnected);

    // Safety net: if a daemon never dials back (its VM is offline,
    // the user uninstalled it, etc.) we still fail after the grace
    // window rather than leaving tasks stuck in_progress forever.
    setTimeout(() => void sweep(), GRACE_MS).unref();

    // Check immediately too: a local daemon bundled with the desktop
    // app may already be connected by the time this runs.
    onDaemonConnected();
  }

  shutdown(): void {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
    for (const [id] of this.activeAgents) {
      this.stopAgent(id);
    }
  }

  /**
   * Spin up a structured agent for a task. Scheduler-kicked tasks
   * (metadata.backlogItemId set) run one-shot; user-initiated tasks
   * run interactively with stdin kept open for follow-up messages.
   * Permission mode follows `env.autonomousBypassPermissions`.
   */
  async startAgent(request: StartAgentRequest): Promise<Agent> {
    const { environmentId, workspaceId, taskId, prompt, workingDirectory } = request;
    return this.spawnStructuredRun({
      environmentId,
      workspaceId,
      taskId,
      prompt,
      workingDirectory,
    });
  }

  /**
   * Shared startup path used by both the initial spawn (`startAgent`)
   * and the conversation-continue flow (`continueTask`). Handles the
   * common lifecycle: env/agent/task row writes, hook setup,
   * structured spawn, rollback on failure.
   */
  private async spawnStructuredRun(opts: {
    environmentId: string;
    workspaceId: string;
    taskId?: string;
    prompt?: string;
    workingDirectory?: string;
    /** If set, pass `--resume <id>` to the CLI — resumes a prior conversation. */
    resumeSessionId?: string;
  }): Promise<Agent> {
    const { environmentId, workspaceId, taskId, prompt, workingDirectory, resumeSessionId } = opts;

    const status = await environmentService.getStatus(environmentId);
    if (status !== 'connected') {
      await environmentService.connect(environmentId);
    }

    const agentId = uuid();
    const sessionId = `agent:${agentId}`;
    const now = new Date();

    const env = await environmentService.getEnvironment(environmentId);
    if (!env) throw new Error(`Environment ${environmentId} not found`);
    const autonomous = taskId ? await this.isAutonomousTask(taskId) : false;
    const cwd =
      workingDirectory ||
      (env.config as { workingDirectory?: string } | undefined)?.workingDirectory;
    const interactive = !autonomous;
    const permissionMode: 'bypass' | 'strict' = env.autonomousBypassPermissions
      ? 'bypass'
      : 'strict';

    const hookScriptPath = permissionMode === 'strict' ? await ensurePermissionHook() : undefined;

    const port = process.env.PORT || '4747';
    const envVars: Record<string, string> = {
      FASTOWL_API_URL: process.env.FASTOWL_API_URL || `http://localhost:${port}`,
      FASTOWL_WORKSPACE_ID: workspaceId,
      FASTOWL_ENVIRONMENT_ID: environmentId,
    };
    if (taskId) envVars.FASTOWL_TASK_ID = taskId;

    const initialStatus: AgentStatus = prompt ? 'working' : 'idle';
    const activeAgent: ActiveAgent = {
      id: agentId,
      environmentId,
      workspaceId,
      sessionId,
      status: initialStatus,
      attention: 'none',
      lastActivityTime: now,
      currentTaskId: taskId,
    };

    // Everything past this point is "partially-committed startup":
    // if any step throws after we've populated `activeAgents` or
    // written the agent/task rows, we MUST unwind. Otherwise the
    // in-memory map ends up with a phantom agent and subsequent
    // `/start` calls fail with "task already has an active agent"
    // forever. Wrap and clean up aggressively.
    this.activeAgents.set(agentId, activeAgent);
    let agentRowInserted = false;
    let taskRowUpdated = false;
    try {
      await this.db.insert(agentsTable).values({
        id: agentId,
        environmentId,
        workspaceId,
        status: initialStatus,
        attention: 'none',
        currentTaskId: taskId ?? null,
        terminalOutput: '',
        lastActivity: now,
        createdAt: now,
      });
      agentRowInserted = true;

      if (taskId) {
        // On resume, preserve the existing transcript (new events
        // append). On fresh start, wipe it so retries don't show
        // stale output. `metadata.runtime` is no longer load-bearing
        // but downstream code + historical rows still look for it.
        const taskUpdate: Record<string, unknown> = {
          assignedAgentId: agentId,
          status: 'in_progress',
          updatedAt: now,
          metadata: sql`
            COALESCE(${tasksTable.metadata}, '{}'::jsonb) || '{"runtime":"structured"}'::jsonb
          `,
        };
        if (!resumeSessionId) {
          taskUpdate.transcript = [] as unknown as object;
        }
        await this.db
          .update(tasksTable)
          .set(taskUpdate)
          .where(eq(tasksTable.id, taskId));
        taskRowUpdated = true;
      }

      const run = await agentStructuredService.start({
        sessionKey: sessionId,
        agentId,
        environmentId,
        workspaceId,
        taskId,
        cwd,
        prompt,
        permissionMode,
        hookScriptPath,
        env: envVars,
        interactive,
        resumeSessionId,
      });

      // Persist the permission token (strict mode only) so surviving
      // agents after a backend restart can re-register it in
      // permissionService. Row-level UPDATE — agent row already exists.
      if (run.permissionToken) {
        await this.db
          .update(agentsTable)
          .set({ permissionToken: run.permissionToken })
          .where(eq(agentsTable.id, agentId));
      }

      emitAgentStatus(workspaceId, agentId, initialStatus, 'none');
      if (taskId) emitTaskAgentStatus(workspaceId, taskId, initialStatus, 'none');

      // Wait for exit and map onto the usual task lifecycle.
      void run.completion.then(async (code) => {
        try {
          await agentStructuredService.flush(sessionId);
          await this.handleStructuredExit(agentId, code);
        } catch (err) {
          console.error('[agent] structured-exit handler threw:', err);
        }
      });
    } catch (err) {
      console.error(`[agent] spawnStructuredRun failed for task=${taskId}; rolling back:`, err);
      this.activeAgents.delete(agentId);
      if (agentRowInserted) {
        await this.db
          .delete(agentsTable)
          .where(eq(agentsTable.id, agentId))
          .catch((dbErr) =>
            console.error('[agent] rollback: delete agent row failed:', dbErr)
          );
      }
      if (taskRowUpdated && taskId) {
        // On fresh start, reset to queued so the user can retry. On
        // resume, put it back to the prior terminal state (awaiting
        // review) since the conversation didn't actually continue.
        const rollbackStatus = resumeSessionId ? 'awaiting_review' : 'queued';
        await this.db
          .update(tasksTable)
          .set({
            assignedAgentId: null,
            status: rollbackStatus,
            updatedAt: new Date(),
            result: {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            },
          })
          .where(eq(tasksTable.id, taskId))
          .catch((dbErr) =>
            console.error('[agent] rollback: reset task row failed:', dbErr)
          );
      }
      throw err;
    }

    const agent = await this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} vanished immediately after insert`);
    return agent;
  }

  private async handleStructuredExit(agentId: string, code: number): Promise<void> {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return;

    const finalStatus: AgentStatus = code === 0 ? 'completed' : 'error';
    await this.updateAgentStatus(agentId, finalStatus, 'none');
    this.activeAgents.delete(agentId);

    await this.createInboxItemForAgent(agent, finalStatus);

    if (agent.currentTaskId) {
      const now = new Date();
      if (code === 0) {
        await this.db
          .update(tasksTable)
          .set({ status: 'awaiting_review', updatedAt: now })
          .where(eq(tasksTable.id, agent.currentTaskId));
        emitTaskStatus(agent.workspaceId, agent.currentTaskId, 'awaiting_review');
        // Kick off commit-message generation in the background so the
        // approve modal has a message ready when the user opens it.
        void prefetchCommitMessage(agent.currentTaskId);
      } else {
        // Persist a result so the desktop failed-view banner has
        // something meaningful to show — without this the user sees
        // only a generic "Failed" label and has to dig through logs
        // to work out why.
        const failureError = `Agent exited with code ${code}. Check the task's Git tab and terminal for details.`;
        await this.db
          .update(tasksTable)
          .set({
            status: 'failed',
            result: { success: false, error: failureError },
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(tasksTable.id, agent.currentTaskId));
        emitTaskStatus(agent.workspaceId, agent.currentTaskId, 'failed', {
          success: false,
          error: failureError,
        });
      }
    }

    await this.db.delete(agentsTable).where(eq(agentsTable.id, agentId));
  }

  /**
   * Resume an exited structured task with a new user prompt.
   * Mirrors `startAgent`'s lifecycle — inserts a fresh agent row,
   * flips task back to `in_progress`, spawns a new child with
   * `--resume <claudeSessionId>` + the prompt. Transcript already
   * on the task row is preserved and extended with the new turn's
   * events.
   *
   * Throws if the task has no stored `claudeSessionId` (pre-Slice 4c
   * tasks, or tasks that exited before the first `system/init`).
   */
  async continueTask(request: {
    taskId: string;
    workspaceId: string;
    prompt: string;
  }): Promise<Agent> {
    const { taskId, workspaceId, prompt } = request;

    const taskRows = await this.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    const taskRow = taskRows[0];
    if (!taskRow) throw new Error(`Task ${taskId} not found`);

    const meta = (taskRow.metadata ?? {}) as Record<string, unknown>;
    const claudeSessionId = typeof meta.claudeSessionId === 'string' ? meta.claudeSessionId : undefined;
    if (!claudeSessionId) {
      throw new Error('Task has no saved Claude session to resume');
    }

    const environmentId = taskRow.assignedEnvironmentId;
    if (!environmentId) {
      throw new Error('Task has no assigned environment');
    }

    // Delegate to the shared spawn path, passing `resumeSessionId`.
    return this.spawnStructuredRun({
      environmentId,
      workspaceId,
      taskId,
      prompt,
      resumeSessionId: claudeSessionId,
    });
  }

  /**
   * Send a user message to an interactive agent. Only valid while the
   * agent's child is running — for one-shot autonomous runs, the
   * child has already exited by the time anything could call this.
   */
  sendInput(agentId: string, input: string): void {
    const agent = this.activeAgents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    agentStructuredService.sendMessage(agent.sessionId, input);
    this.updateAgentStatus(agentId, 'working', 'none').catch((err) =>
      console.error('updateAgentStatus error:', err)
    );
  }

  /**
   * Auto-finish an interactive agent task when the child turns idle
   * (fires from the structured `turn_complete` event). Mirrors the
   * manual Finish / `/ready-for-review` flow: stop the agent, flip
   * the task status to awaiting_review, broadcast.
   *
   * Scoped to agent-type tasks (code_writing / pr_response /
   * pr_review) — manual tasks have no "finish" concept. Idempotent
   * on task.status so a late turn_complete after the user already
   * hit Finish doesn't double-flip.
   */
  private async maybeAutoFinishAgentTask(
    taskId: string,
    agentId: string,
    workspaceId: string
  ): Promise<void> {
    try {
      const rows = await this.db
        .select({ type: tasksTable.type, status: tasksTable.status })
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId))
        .limit(1);
      const row = rows[0];
      if (!row) return;
      if (!isAgentTask(row.type as TaskType)) return;
      if (row.status !== 'in_progress') return;

      this.stopAgent(agentId);

      const now = new Date();
      await this.db
        .update(tasksTable)
        .set({ status: 'awaiting_review', updatedAt: now })
        .where(eq(tasksTable.id, taskId));
      emitTaskStatus(workspaceId, taskId, 'awaiting_review');
      void prefetchCommitMessage(taskId);
      console.log(`[agent] auto-finished task ${taskId.slice(0, 8)} on agent idle`);
    } catch (err) {
      console.error(`[agent] auto-finish for task ${taskId} failed:`, err);
    }
  }

  stopAgent(agentId: string): void {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return;
    agentStructuredService.stop(agent.sessionId);
    this.activeAgents.delete(agentId);

    this.db
      .update(agentsTable)
      .set({ status: 'idle', attention: 'none', lastActivity: new Date() })
      .where(eq(agentsTable.id, agentId))
      .then(() => {
        emitAgentStatus(agent.workspaceId, agentId, 'idle', 'none');
      })
      .catch((err) => console.error('stopAgent DB update failed:', err));
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    const rows = await this.db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return rowToAgent(row);
  }

  async getAgentsByWorkspace(workspaceId: string): Promise<Agent[]> {
    const rows = await this.db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.workspaceId, workspaceId));
    return rows.map(rowToAgent);
  }

  /**
   * Idle agents for a workspace. Only returns agents that are actually
   * running (present in activeAgents) — DB rows alone aren't enough because
   * a process may have died between polls.
   */
  async getIdleAgents(workspaceId?: string): Promise<Agent[]> {
    const idleAgents: Agent[] = [];
    for (const [id, activeAgent] of this.activeAgents) {
      if (activeAgent.status !== 'idle') continue;
      if (workspaceId && activeAgent.workspaceId !== workspaceId) continue;
      const agent = await this.getAgent(id);
      if (agent) idleAgents.push(agent);
    }
    return idleAgents;
  }

  isAgentActive(agentId: string): boolean {
    return this.activeAgents.has(agentId);
  }

  /**
   * True if a task was spawned by the Continuous Build scheduler (has a
   * backlog item in its metadata). Autonomous tasks run one-shot;
   * interactive tasks (no backlog item) keep their child's stdin open.
   */
  /**
   * Adopt a surviving agent row + its still-running child after a
   * backend restart. Called from cleanupStaleAgents's sweep for every
   * agent whose env's daemon claimed the session as live.
   *
   * Rebuilds:
   *   - `activeAgents` map entry (so stopAgent/continueTask work).
   *   - `agentStructuredService` listener set (so new session events
   *     resume flowing into the transcript + desktop).
   *   - `run.completion` → handleStructuredExit wiring (so the task
   *     lifecycle still fires when the child finally exits).
   */
  private async resumeStaleAgent(row: {
    id: string;
    environmentId: string;
    workspaceId: string;
    currentTaskId: string | null;
    permissionToken: string | null;
  }): Promise<void> {
    const sessionId = `agent:${row.id}`;
    const taskId = row.currentTaskId ?? undefined;
    const interactive = taskId ? !(await this.isAutonomousTask(taskId)) : true;

    this.activeAgents.set(row.id, {
      id: row.id,
      environmentId: row.environmentId,
      workspaceId: row.workspaceId,
      sessionId,
      // Best-effort status — we don't know what the child is actually
      // doing right now. `working` is the safe default; the next event
      // we receive (via onRawEvent → turn_complete → updateAgentStatus)
      // will correct it.
      status: 'working',
      attention: 'none',
      lastActivityTime: new Date(),
      currentTaskId: taskId,
    });

    // Re-register the permission token the child was given at spawn
    // so its in-flight PreToolUse hooks authenticate against the new
    // backend process. Only present for strict-mode envs.
    if (row.permissionToken) {
      permissionService.rehydrateRun(row.permissionToken, {
        environmentId: row.environmentId,
        agentId: row.id,
        workspaceId: row.workspaceId,
        taskId,
      });
    }

    try {
      const run = await agentStructuredService.resumeRun({
        sessionKey: sessionId,
        agentId: row.id,
        environmentId: row.environmentId,
        workspaceId: row.workspaceId,
        taskId,
        interactive,
        permissionToken: row.permissionToken ?? undefined,
      });
      void run.completion.then(async (code) => {
        try {
          await agentStructuredService.flush(sessionId);
          await this.handleStructuredExit(row.id, code);
        } catch (err) {
          console.error('[agent] resumed-run exit handler threw:', err);
        }
      });
    } catch (err) {
      console.error(
        `[agent] failed to resume agent ${row.id}; falling back to fail:`,
        err,
      );
      this.activeAgents.delete(row.id);
      await this.db.delete(agentsTable).where(eq(agentsTable.id, row.id));
      if (taskId) {
        const now = new Date();
        await this.db
          .update(tasksTable)
          .set({
            status: 'failed',
            completedAt: now,
            updatedAt: now,
            result: {
              success: false,
              error: 'agent resume failed after backend restart',
            },
          })
          .where(and(eq(tasksTable.id, taskId), eq(tasksTable.status, 'in_progress')));
      }
    }
  }

  private async isAutonomousTask(taskId: string): Promise<boolean> {
    const rows = await this.db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    const meta = rows[0]?.metadata as { backlogItemId?: string } | null | undefined;
    return Boolean(meta?.backlogItemId);
  }

  getAgentByTaskId(taskId: string): ActiveAgent | null {
    for (const [id, agent] of this.activeAgents) {
      if (agent.currentTaskId !== taskId) continue;
      // Self-heal: if we think an agent is active but the underlying
      // structured run is gone AND the entry has aged past the
      // startup grace window, it's a ghost — drop it. Happens when
      // startAgent partially succeeded (spawn failed after we
      // inserted activeAgent) or when handleStructuredExit ran but
      // something leaked.
      //
      // The grace window exists because during startAgent there's a
      // brief moment where activeAgent is populated but
      // agentStructuredService hasn't registered its run yet.
      if (!agentStructuredService.has(agent.sessionId)) {
        const ageMs = Date.now() - agent.lastActivityTime.getTime();
        const GHOST_GRACE_MS = 5000;
        if (ageMs < GHOST_GRACE_MS) return agent; // still starting up
        console.warn(
          `[agent] dropping ghost activeAgent ${id} (task=${taskId}, session=${agent.sessionId}, age=${ageMs}ms)`
        );
        this.activeAgents.delete(id);
        continue;
      }
      return agent;
    }
    return null;
  }

  private async updateAgentStatus(
    agentId: string,
    status: AgentStatus,
    attention: AgentAttention
  ): Promise<void> {
    const agent = this.activeAgents.get(agentId);
    if (agent) {
      agent.status = status;
      agent.attention = attention;
    }

    await this.db
      .update(agentsTable)
      .set({ status, attention, lastActivity: new Date() })
      .where(eq(agentsTable.id, agentId));

    if (agent) {
      emitAgentStatus(agent.workspaceId, agentId, status, attention);
      if (agent.currentTaskId) {
        emitTaskAgentStatus(agent.workspaceId, agent.currentTaskId, status, attention);
      }
    }

    this.emit('status', agentId, status, attention);
  }

  private async createInboxItemForAgent(agent: ActiveAgent, status: AgentStatus): Promise<void> {
    let type: 'agent_question' | 'agent_completed' | 'agent_error';
    let title: string;
    let summary: string;
    let priority: 'low' | 'medium' | 'high' | 'urgent';

    const env = await environmentService.getEnvironment(agent.environmentId);
    const envName = env?.name || 'Unknown';

    switch (status) {
      case 'awaiting_input':
        type = 'agent_question';
        title = 'Agent needs input';
        summary = `Claude on ${envName} is asking a question`;
        priority = 'high';
        break;
      case 'completed':
        type = 'agent_completed';
        title = 'Agent completed task';
        summary = `Claude on ${envName} finished working`;
        priority = 'low';
        break;
      case 'error':
        type = 'agent_error';
        title = 'Agent encountered error';
        summary = `Claude on ${envName} ran into a problem`;
        priority = 'urgent';
        break;
      default:
        return;
    }

    const inboxId = uuid();
    const now = new Date();
    const sourceId = agent.currentTaskId || agent.id;
    const sourceType = agent.currentTaskId ? 'task' : 'agent';
    const actionLabel = agent.currentTaskId ? 'View Task' : 'View Agent';
    const actionType = agent.currentTaskId ? 'view_task' : 'view_agent';

    const source = { type: sourceType, id: sourceId, name: `Task on ${envName}` };
    const actions = [{ id: '1', label: actionLabel, type: 'primary', action: actionType }];

    await this.db.insert(inboxItemsTable).values({
      id: inboxId,
      workspaceId: agent.workspaceId,
      type,
      status: 'unread',
      priority,
      title,
      summary,
      source,
      actions,
      createdAt: now,
    });

    const inboxItem: InboxItem = {
      id: inboxId,
      workspaceId: agent.workspaceId,
      type,
      status: 'unread',
      priority,
      title,
      summary,
      source: { type: sourceType as 'agent' | 'github' | 'slack' | 'posthog' | 'system', id: sourceId, name: `Task on ${envName}` },
      actions: [{ id: '1', label: actionLabel, type: 'primary', action: actionType }],
      createdAt: now.toISOString(),
    };

    emitInboxNew(agent.workspaceId, inboxItem);
  }

  private checkStuckAgents(): void {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    for (const [id, agent] of this.activeAgents) {
      if (agent.status === 'working' && agent.lastActivityTime < fiveMinutesAgo) {
        this.updateAgentStatus(id, 'awaiting_input', 'medium').catch((err) =>
          console.error('checkStuckAgents updateAgentStatus failed:', err)
        );
      }
    }
  }
}

function rowToAgent(row: typeof agentsTable.$inferSelect): Agent {
  return {
    id: row.id,
    environmentId: row.environmentId,
    workspaceId: row.workspaceId,
    status: row.status as AgentStatus,
    attention: row.attention as AgentAttention,
    currentTaskId: row.currentTaskId ?? undefined,
    terminalOutput: row.terminalOutput,
    lastActivity: row.lastActivity.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export const agentService = new AgentService();
