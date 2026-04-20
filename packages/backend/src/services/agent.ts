import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  Agent,
  AgentStatus,
  AgentAttention,
  InboxItem,
  StartAgentRequest,
} from '@fastowl/shared';
import { environmentService } from './environment.js';
import { agentStructuredService } from './agentStructured.js';
import { ensurePermissionHook } from './permissionHook.js';
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
    // For interactive runs that means "child is idling on stdin,
    // waiting for the next user message" — flip the agent status
    // back to idle so the desktop re-enables the input box.
    agentStructuredService.on(
      'turn_complete',
      (run: { interactive: boolean; agentId: string }) => {
        if (!run.interactive) return;
        this.updateAgentStatus(run.agentId, 'idle', 'none').catch((err) =>
          console.error('turn_complete status update failed:', err)
        );
      }
    );

    this.statusCheckInterval = setInterval(() => {
      this.checkStuckAgents();
    }, 60000);
  }

  private async cleanupStaleAgents(): Promise<void> {
    // Agents are in-memory state — any row still present after a
    // backend restart describes a dead child (SIGPIPE killed it the
    // moment our stdout pipe closed). Scrub them.
    const result = await this.db
      .delete(agentsTable)
      .where(inArray(agentsTable.status, ['idle', 'working', 'tool_use', 'awaiting_input']))
      .returning({ id: agentsTable.id, currentTaskId: agentsTable.currentTaskId });
    if (result.length === 0) return;

    console.log(`Cleaned up ${result.length} stale agent records`);

    // Flip the orphaned tasks from in_progress → failed immediately.
    // `recoverStuckTasks` would eventually catch these via its 20min
    // staleness sweep, but that window is terrible UX after a deploy —
    // a user watching the task would see it "running" for 20 minutes
    // with no real agent. Fail them now so the scheduler can retry
    // straight away (Continuous Build backoff still applies).
    const taskIds = result.map((r) => r.currentTaskId).filter((id): id is string => !!id);
    if (taskIds.length === 0) return;

    const now = new Date();
    await this.db
      .update(tasksTable)
      .set({
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        result: { success: false, error: 'backend restart orphaned the agent' },
      })
      .where(and(inArray(tasksTable.id, taskIds), eq(tasksTable.status, 'in_progress')));
    console.log(`Marked ${taskIds.length} orphaned tasks as failed (backend restart)`);
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

    // Strict mode needs the PreToolUse hook script on disk for the
    // child to exec. Writing it is idempotent — first call after
    // backend boot writes the file, subsequent calls reuse it.
    const hookScriptPath = permissionMode === 'strict' ? await ensurePermissionHook() : undefined;

    // FASTOWL_* context the child Claude uses to reach its parent.
    // FASTOWL_ENVIRONMENT_ID is used by the permission service to
    // scope pre-approvals per-env.
    const port = process.env.PORT || '4747';
    const envVars: Record<string, string> = {
      FASTOWL_API_URL: process.env.FASTOWL_API_URL || `http://localhost:${port}`,
      FASTOWL_WORKSPACE_ID: workspaceId,
      FASTOWL_ENVIRONMENT_ID: environmentId,
    };
    if (taskId) envVars.FASTOWL_TASK_ID = taskId;

    // Initial status: `working` if we have a prompt to kick off the
    // first turn, else `idle` (interactive, waiting for the user).
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
        await this.db
          .update(tasksTable)
          .set({
            assignedAgentId: agentId,
            status: 'in_progress',
            updatedAt: now,
            // `metadata.runtime` is no longer load-bearing (structured
            // is the only path), but downstream code + historical rows
            // still look for it.
            metadata: sql`
              COALESCE(${tasksTable.metadata}, '{}'::jsonb) || '{"runtime":"structured"}'::jsonb
            `,
            transcript: [] as unknown as object,
          })
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
      });

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
      console.error(`[agent] startAgent failed for task=${taskId}; rolling back:`, err);
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
        // Reset the task to `queued` so the user can retry. Preserves
        // whatever error context we have in `result`.
        await this.db
          .update(tasksTable)
          .set({
            assignedAgentId: null,
            status: 'queued',
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
      } else {
        await this.db
          .update(tasksTable)
          .set({ status: 'failed', completedAt: now, updatedAt: now })
          .where(eq(tasksTable.id, agent.currentTaskId));
        emitTaskStatus(agent.workspaceId, agent.currentTaskId, 'failed');
      }
    }

    await this.db.delete(agentsTable).where(eq(agentsTable.id, agentId));
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
