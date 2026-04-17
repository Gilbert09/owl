import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { eq, inArray, sql } from 'drizzle-orm';
import type {
  Agent,
  AgentStatus,
  AgentAttention,
  InboxItem,
  StartAgentRequest,
} from '@fastowl/shared';
import { environmentService } from './environment.js';
import { sshService } from './ssh.js';
import {
  emitAgentStatus,
  emitAgentOutput,
  emitInboxNew,
  emitTaskOutput,
  emitTaskAgentStatus,
  emitTaskStatus,
} from './websocket.js';
import { getDbClient, type Database } from '../db/client.js';
import {
  agents as agentsTable,
  tasks as tasksTable,
  inboxItems as inboxItemsTable,
} from '../db/schema.js';

// Patterns to detect Claude CLI status
export const STATUS_PATTERNS = {
  working: [
    /^\s*\d+\s*│/,
    /Thinking\.\.\./i,
    /Working on/i,
    /Let me/i,
    /I'll/i,
    /I will/i,
  ],
  awaitingInput: [
    /\?\s*$/,
    /What would you/i,
    /Would you like/i,
    /Should I/i,
    /Do you want/i,
    /Please (provide|specify|confirm|choose)/i,
    /Which (one|option)/i,
    /Enter your/i,
    /Type your/i,
    /\(y\/n\)/i,
    /\[Y\/n\]/i,
  ],
  completed: [
    /Done\.?\s*$/i,
    /Complete\.?\s*$/i,
    /Finished\.?\s*$/i,
    /Successfully/i,
    /I've (completed|finished|done)/i,
    /The (task|work) (is|has been) (complete|done|finished)/i,
  ],
  error: [
    /Error:/i,
    /Failed:/i,
    /Exception:/i,
    /Cannot/i,
    /Unable to/i,
    /Permission denied/i,
    /command not found/i,
  ],
  toolUse: [
    /^> Running/i,
    /^> Reading/i,
    /^> Writing/i,
    /^> Editing/i,
    /^> Executing/i,
    /^> Searching/i,
  ],
};

/**
 * Pure status detection from Claude CLI output. Extracted so it can be
 * unit-tested independently of the live agent service.
 */
export function detectStatusFromOutput(
  recentOutput: string,
  current: { status: AgentStatus; attention: AgentAttention }
): { status: AgentStatus; attention: AgentAttention } {
  let newStatus: AgentStatus = current.status;
  let newAttention: AgentAttention = current.attention;

  for (const pattern of STATUS_PATTERNS.toolUse) {
    if (pattern.test(recentOutput)) {
      newStatus = 'tool_use';
      newAttention = 'none';
      break;
    }
  }

  for (const pattern of STATUS_PATTERNS.error) {
    if (pattern.test(recentOutput)) {
      newStatus = 'error';
      newAttention = 'high';
      break;
    }
  }

  if (newStatus !== 'error') {
    for (const pattern of STATUS_PATTERNS.awaitingInput) {
      if (pattern.test(recentOutput)) {
        newStatus = 'awaiting_input';
        newAttention = 'high';
        break;
      }
    }
  }

  if (newStatus !== 'error' && newStatus !== 'awaiting_input') {
    for (const pattern of STATUS_PATTERNS.completed) {
      if (pattern.test(recentOutput)) {
        newStatus = 'completed';
        newAttention = 'low';
        break;
      }
    }
  }

  if (newStatus !== 'error' && newStatus !== 'awaiting_input' && newStatus !== 'completed') {
    for (const pattern of STATUS_PATTERNS.working) {
      if (pattern.test(recentOutput)) {
        newStatus = 'working';
        newAttention = 'none';
        break;
      }
    }
  }

  return { status: newStatus, attention: newAttention };
}

export interface ActiveAgent {
  id: string;
  environmentId: string;
  workspaceId: string;
  sessionId: string;
  status: AgentStatus;
  attention: AgentAttention;
  outputBuffer: string;
  lastActivityTime: Date;
  currentTaskId?: string;
}

class AgentService extends EventEmitter {
  private activeAgents: Map<string, ActiveAgent> = new Map();
  private statusCheckInterval: NodeJS.Timeout | null = null;

  private get db(): Database {
    return getDbClient();
  }

  async init(): Promise<void> {
    // Clean up any stale agent records from previous runs. Statuses that
    // imply a running process are fiction after a restart.
    await this.cleanupStaleAgents();

    environmentService.on('session:data', (sessionId, data) => {
      this.handleSessionData(sessionId, data).catch((err) =>
        console.error('handleSessionData error:', err)
      );
    });

    environmentService.on('session:close', (sessionId, code) => {
      this.handleSessionClose(sessionId, code).catch((err) =>
        console.error('handleSessionClose error:', err)
      );
    });

    sshService.on('pty:data', (sessionId, data) => {
      this.handleSessionData(sessionId, data).catch((err) =>
        console.error('handleSessionData error:', err)
      );
    });

    sshService.on('pty:close', (sessionId, code?: number) => {
      this.handleSessionClose(sessionId, code ?? 0).catch((err) =>
        console.error('handleSessionClose error:', err)
      );
    });

    this.statusCheckInterval = setInterval(() => {
      this.checkStuckAgents();
    }, 60000);
  }

  private async cleanupStaleAgents(): Promise<void> {
    const result = await this.db
      .delete(agentsTable)
      .where(inArray(agentsTable.status, ['idle', 'working', 'tool_use', 'awaiting_input']))
      .returning({ id: agentsTable.id });
    if (result.length > 0) {
      console.log(`Cleaned up ${result.length} stale agent records`);
    }
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
    const includeApiUrl = env?.type === 'local';
    const envPrefix = buildFastOwlEnvPrefix(workspaceId, taskId, { includeApiUrl });

    const autonomous = taskId ? await this.isAutonomousTask(taskId) : false;

    let claudeCommand: string;
    if (autonomous && prompt) {
      claudeCommand =
        `${envPrefix}claude --print --permission-mode acceptEdits ${shellQuote(prompt)}`;
    } else {
      claudeCommand = `${envPrefix}claude`;
    }

    const cwd = workingDirectory || (env?.config.type === 'ssh'
      ? (env.config as { workingDirectory?: string }).workingDirectory
      : (env?.config as { workingDirectory?: string } | undefined)?.workingDirectory);

    await environmentService.spawnInteractive(environmentId, sessionId, claudeCommand, {
      cwd,
      rows: 40,
      cols: 120,
    });

    if (prompt && !autonomous) {
      setTimeout(() => {
        environmentService.writeToSession(sessionId, prompt + '\n');
      }, 500);
    }

    const activeAgent: ActiveAgent = {
      id: agentId,
      environmentId,
      workspaceId,
      sessionId,
      status: 'idle',
      attention: 'none',
      outputBuffer: '',
      lastActivityTime: now,
      currentTaskId: taskId,
    };
    this.activeAgents.set(agentId, activeAgent);

    await this.db.insert(agentsTable).values({
      id: agentId,
      environmentId,
      workspaceId,
      status: 'idle',
      attention: 'none',
      currentTaskId: taskId ?? null,
      terminalOutput: '',
      lastActivity: now,
      createdAt: now,
    });

    if (taskId) {
      await this.db
        .update(tasksTable)
        .set({ assignedAgentId: agentId, status: 'in_progress', updatedAt: now })
        .where(eq(tasksTable.id, taskId));
    }

    const agent = await this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} vanished immediately after insert`);
    return agent;
  }

  sendInput(agentId: string, input: string): void {
    const agent = this.activeAgents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    environmentService.writeToSession(agent.sessionId, input + '\n');
    this.updateAgentStatus(agentId, 'working', 'none').catch((err) =>
      console.error('updateAgentStatus error:', err)
    );
  }

  stopAgent(agentId: string): void {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return;
    environmentService.killSession(agent.sessionId);
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
   * backlog item in its metadata). Those tasks run `claude --print` and
   * derive completion from process exit.
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
    for (const [, agent] of this.activeAgents) {
      if (agent.currentTaskId === taskId) return agent;
    }
    return null;
  }

  getTerminalOutput(agentId: string): string {
    return this.activeAgents.get(agentId)?.outputBuffer ?? '';
  }

  private async handleSessionData(sessionId: string, data: Buffer): Promise<void> {
    let agent: ActiveAgent | undefined;
    for (const [, a] of this.activeAgents) {
      if (a.sessionId === sessionId) {
        agent = a;
        break;
      }
    }
    if (!agent) return;

    const output = data.toString();
    agent.outputBuffer += output;
    agent.lastActivityTime = new Date();

    const truncatedOutput = agent.outputBuffer.slice(-10000);
    await this.db
      .update(agentsTable)
      .set({ terminalOutput: truncatedOutput, lastActivity: agent.lastActivityTime })
      .where(eq(agentsTable.id, agent.id));

    // Append to task's persistent terminal output so history survives the
    // agent session. Raw `||` concat keeps write cost proportional to each
    // chunk rather than the full buffer.
    if (agent.currentTaskId) {
      await this.db
        .update(tasksTable)
        .set({
          terminalOutput: sql`${tasksTable.terminalOutput} || ${output}`,
          updatedAt: agent.lastActivityTime,
        })
        .where(eq(tasksTable.id, agent.currentTaskId));
    }

    emitAgentOutput(agent.workspaceId, agent.id, output, true);
    if (agent.currentTaskId) {
      emitTaskOutput(agent.workspaceId, agent.currentTaskId, output, true);
    }

    await this.analyzeOutput(agent);
  }

  private async handleSessionClose(sessionId: string, code: number | null): Promise<void> {
    let agentId: string | undefined;
    for (const [id, a] of this.activeAgents) {
      if (a.sessionId === sessionId) {
        agentId = id;
        break;
      }
    }
    if (!agentId) return;

    const agent = this.activeAgents.get(agentId)!;
    const finalStatus: AgentStatus = code === 0 ? 'completed' : 'error';
    await this.updateAgentStatus(agentId, finalStatus, 'none');
    this.activeAgents.delete(agentId);

    await this.createInboxItemForAgent(agent, finalStatus);

    // Update task. Clean agent exits go through the approval gate
    // (awaiting_review) so the user can accept/reject the work.
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

  private async analyzeOutput(agent: ActiveAgent): Promise<void> {
    const recentOutput = agent.outputBuffer.split('\n').slice(-10).join('\n');
    const { status: newStatus, attention: newAttention } = detectStatusFromOutput(
      recentOutput,
      { status: agent.status, attention: agent.attention }
    );

    if (newStatus !== agent.status || newAttention !== agent.attention) {
      const prevAttention = agent.attention;
      await this.updateAgentStatus(agent.id, newStatus, newAttention);
      if (newAttention === 'high' && prevAttention !== 'high') {
        await this.createInboxItemForAgent(agent, newStatus);
      }
    }
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

/**
 * Build an inline `KEY=val ` prefix for a shell command so child Claudes
 * can find their parent FastOwl via the CLI. Values are single-quoted and
 * safely escaped for bash.
 *
 * Pass `includeApiUrl: false` for SSH environments — "localhost" on the
 * VM isn't this process. The remote shell sets FASTOWL_API_URL via
 * .bashrc (see docs/SSH_VM_SETUP.md).
 */
export function buildFastOwlEnvPrefix(
  workspaceId: string,
  taskId?: string,
  opts: { includeApiUrl?: boolean } = {}
): string {
  const parts: string[] = [];
  if (opts.includeApiUrl !== false) {
    const port = process.env.PORT || '4747';
    const apiUrl = process.env.FASTOWL_API_URL || `http://localhost:${port}`;
    parts.push(`FASTOWL_API_URL=${shellQuote(apiUrl)}`);
  }
  parts.push(`FASTOWL_WORKSPACE_ID=${shellQuote(workspaceId)}`);
  if (taskId) parts.push(`FASTOWL_TASK_ID=${shellQuote(taskId)}`);
  return parts.join(' ') + ' ';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
