import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import type {
  Agent,
  AgentStatus,
  AgentAttention,
  InboxItem,
  StartAgentRequest,
} from '@fastowl/shared';
import { environmentService } from './environment.js';
import { sshService } from './ssh.js';
import { emitAgentStatus, emitAgentOutput, emitInboxNew, emitTaskOutput, emitTaskAgentStatus, emitTaskStatus } from './websocket.js';
import { DB } from '../db/index.js';

// Patterns to detect Claude CLI status
export const STATUS_PATTERNS = {
  // Claude is thinking/working. Note: tool-use indicators ("> Running ...")
  // are intentionally NOT included here — they're matched by the more
  // specific STATUS_PATTERNS.toolUse and including a catch-all `/^>/` here
  // would override the tool_use classification in the cascade.
  working: [
    /^\s*\d+\s*│/,  // Code block line numbers
    /Thinking\.\.\./i,
    /Working on/i,
    /Let me/i,
    /I'll/i,
    /I will/i,
  ],
  // Claude is waiting for user input
  awaitingInput: [
    /\?\s*$/,  // Ends with question mark
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
  // Claude completed a task
  completed: [
    /Done\.?\s*$/i,
    /Complete\.?\s*$/i,
    /Finished\.?\s*$/i,
    /Successfully/i,
    /I've (completed|finished|done)/i,
    /The (task|work) (is|has been) (complete|done|finished)/i,
  ],
  // Claude encountered an error
  error: [
    /Error:/i,
    /Failed:/i,
    /Exception:/i,
    /Cannot/i,
    /Unable to/i,
    /Permission denied/i,
    /command not found/i,
  ],
  // Claude is using a tool
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
 *
 * Takes the recent output (typically the last ~10 lines) and the current
 * status, returns the derived status. Priority cascade preserves the
 * historical behavior: tool_use → error → awaiting_input → completed → working.
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
  private db: DB | null = null;
  private activeAgents: Map<string, ActiveAgent> = new Map();
  private statusCheckInterval: NodeJS.Timeout | null = null;

  /**
   * Initialize with database
   */
  init(db: DB): void {
    this.db = db;

    // Clean up any stale agent records from previous runs
    // (agents that aren't in activeAgents are not actually running)
    this.cleanupStaleAgents();

    // Listen for session data from environment service
    environmentService.on('session:data', (sessionId, data) => {
      this.handleSessionData(sessionId, data);
    });

    environmentService.on('session:close', (sessionId, code) => {
      this.handleSessionClose(sessionId, code);
    });

    // Listen for SSH PTY data
    sshService.on('pty:data', (sessionId, data) => {
      this.handleSessionData(sessionId, data);
    });

    sshService.on('pty:close', (sessionId) => {
      this.handleSessionClose(sessionId, 0);
    });

    // Periodic status check for stuck agents
    this.statusCheckInterval = setInterval(() => {
      this.checkStuckAgents();
    }, 60000); // Every minute
  }

  /**
   * Clean up stale agent records from database
   * (agents from previous server runs that are no longer active)
   */
  private cleanupStaleAgents(): void {
    if (!this.db) return;

    const result = this.db.prepare(`
      DELETE FROM agents WHERE status IN ('idle', 'working', 'tool_use', 'awaiting_input')
    `).run();

    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} stale agent records`);
    }
  }

  /**
   * Shutdown service
   */
  shutdown(): void {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }

    // Stop all agents
    for (const [id, _agent] of this.activeAgents) {
      this.stopAgent(id);
    }
  }

  /**
   * Start a new agent on an environment
   */
  async startAgent(request: StartAgentRequest): Promise<Agent> {
    const { environmentId, workspaceId, taskId, prompt, workingDirectory } = request;

    // Ensure environment is connected
    const status = environmentService.getStatus(environmentId);
    if (status !== 'connected') {
      await environmentService.connect(environmentId);
    }

    const agentId = uuid();
    const sessionId = `agent:${agentId}`;
    const now = new Date().toISOString();

    // Launch claude interactively - the user can interact with it like Claude Code CLI
    // If a prompt is provided, we'll send it as the initial input.
    //
    // Inline env vars expose FastOwl context to the child process so that
    // `fastowl` CLI invocations (for task-spawns-task) have context without
    // needing to be configured per-run.
    const claudeCommand = `${buildFastOwlEnvPrefix(workspaceId, taskId)}claude`;

    // Determine working directory: use task's repo path, then fall back to environment's default
    const env = environmentService.getEnvironment(environmentId);
    const cwd = workingDirectory || (env?.config.type === 'ssh'
      ? (env.config as any).workingDirectory
      : (env?.config as any)?.workingDirectory);

    await environmentService.spawnInteractive(environmentId, sessionId, claudeCommand, {
      cwd,
      rows: 40,
      cols: 120,
    });

    // If there's a prompt, send it as initial input after a short delay
    // This allows Claude to start up before receiving input
    if (prompt) {
      setTimeout(() => {
        environmentService.writeToSession(sessionId, prompt + '\n');
      }, 500);
    }

    // Create active agent tracking
    const activeAgent: ActiveAgent = {
      id: agentId,
      environmentId,
      workspaceId,
      sessionId,
      status: 'idle',
      attention: 'none',
      outputBuffer: '',
      lastActivityTime: new Date(),
      currentTaskId: taskId,
    };

    this.activeAgents.set(agentId, activeAgent);

    // Create database record
    if (this.db) {
      this.db.prepare(`
        INSERT INTO agents (id, environment_id, workspace_id, status, attention, current_task_id, terminal_output, last_activity, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(agentId, environmentId, workspaceId, 'idle', 'none', taskId || null, '', now, now);
    }

    // If there's a task, update it
    if (taskId && this.db) {
      this.db.prepare(`
        UPDATE tasks SET assigned_agent_id = ?, status = 'in_progress', updated_at = ? WHERE id = ?
      `).run(agentId, now, taskId);
    }

    return this.getAgent(agentId)!;
  }

  /**
   * Send input to an agent
   */
  sendInput(agentId: string, input: string): void {
    const agent = this.activeAgents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    environmentService.writeToSession(agent.sessionId, input + '\n');

    // Update status to working
    this.updateAgentStatus(agentId, 'working', 'none');
  }

  /**
   * Stop an agent
   */
  stopAgent(agentId: string): void {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return;

    environmentService.killSession(agent.sessionId);
    this.activeAgents.delete(agentId);

    // Update database
    if (this.db) {
      this.db.prepare(`
        UPDATE agents SET status = 'idle', attention = 'none', last_activity = ? WHERE id = ?
      `).run(new Date().toISOString(), agentId);
    }

    emitAgentStatus(agent.workspaceId, agentId, 'idle', 'none');
  }

  /**
   * Get agent from database
   */
  getAgent(agentId: string): Agent | null {
    if (!this.db) return null;

    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    if (!row) return null;

    return {
      id: (row as any).id,
      environmentId: (row as any).environment_id,
      workspaceId: (row as any).workspace_id,
      status: (row as any).status,
      attention: (row as any).attention,
      currentTaskId: (row as any).current_task_id || undefined,
      terminalOutput: (row as any).terminal_output,
      lastActivity: (row as any).last_activity,
      createdAt: (row as any).created_at,
    };
  }

  /**
   * Get all agents for a workspace
   */
  getAgentsByWorkspace(workspaceId: string): Agent[] {
    if (!this.db) return [];

    const rows = this.db.prepare('SELECT * FROM agents WHERE workspace_id = ?').all(workspaceId);
    return rows.map((row: any) => ({
      id: row.id,
      environmentId: row.environment_id,
      workspaceId: row.workspace_id,
      status: row.status,
      attention: row.attention,
      currentTaskId: row.current_task_id || undefined,
      terminalOutput: row.terminal_output,
      lastActivity: row.last_activity,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get idle agents for a workspace (only returns agents that are actually running)
   */
  getIdleAgents(workspaceId?: string): Agent[] {
    // Only return agents that are actually running (in activeAgents map)
    const idleAgents: Agent[] = [];

    for (const [id, activeAgent] of this.activeAgents) {
      if (activeAgent.status === 'idle') {
        if (!workspaceId || activeAgent.workspaceId === workspaceId) {
          const agent = this.getAgent(id);
          if (agent) {
            idleAgents.push(agent);
          }
        }
      }
    }

    return idleAgents;
  }

  /**
   * Check if an agent is currently active (has a running session)
   */
  isAgentActive(agentId: string): boolean {
    return this.activeAgents.has(agentId);
  }

  /**
   * Get the active agent for a task (if any)
   */
  getAgentByTaskId(taskId: string): ActiveAgent | null {
    for (const [_id, agent] of this.activeAgents) {
      if (agent.currentTaskId === taskId) {
        return agent;
      }
    }
    return null;
  }

  /**
   * Get terminal output for an agent
   */
  getTerminalOutput(agentId: string): string {
    const agent = this.activeAgents.get(agentId);
    return agent?.outputBuffer || '';
  }

  /**
   * Handle output from agent session
   */
  private handleSessionData(sessionId: string, data: Buffer): void {
    // Find the agent for this session
    let agent: ActiveAgent | undefined;
    for (const [_id, a] of this.activeAgents) {
      if (a.sessionId === sessionId) {
        agent = a;
        break;
      }
    }

    if (!agent) return;

    const output = data.toString();
    agent.outputBuffer += output;
    agent.lastActivityTime = new Date();

    // Update terminal output in database (limit to last 10000 chars)
    if (this.db) {
      const truncatedOutput = agent.outputBuffer.slice(-10000);
      this.db.prepare(`
        UPDATE agents SET terminal_output = ?, last_activity = ? WHERE id = ?
      `).run(truncatedOutput, agent.lastActivityTime.toISOString(), agent.id);

      // Append to task's persistent terminal output so history survives
      // the agent session. Append-only keeps write cost proportional to
      // each chunk, not the full buffer.
      if (agent.currentTaskId) {
        this.db.prepare(`
          UPDATE tasks SET terminal_output = terminal_output || ?, updated_at = ? WHERE id = ?
        `).run(output, agent.lastActivityTime.toISOString(), agent.currentTaskId);
      }
    }

    // Emit output via WebSocket
    emitAgentOutput(agent.workspaceId, agent.id, output, true);

    // Also emit task output if this agent has a task
    if (agent.currentTaskId) {
      emitTaskOutput(agent.workspaceId, agent.currentTaskId, output, true);
    }

    // Analyze output for status
    this.analyzeOutput(agent);
  }

  /**
   * Handle session close
   */
  private handleSessionClose(sessionId: string, code: number | null): void {
    // Find the agent for this session
    let agentId: string | undefined;
    for (const [id, agent] of this.activeAgents) {
      if (agent.sessionId === sessionId) {
        agentId = id;
        break;
      }
    }

    if (!agentId) return;

    const agent = this.activeAgents.get(agentId)!;

    // Determine final status
    const finalStatus: AgentStatus = code === 0 ? 'completed' : 'error';

    this.updateAgentStatus(agentId, finalStatus, 'none');
    this.activeAgents.delete(agentId);

    // Create inbox item for completion
    this.createInboxItemForAgent(agent, finalStatus);

    // Update task if there was one. Clean agent exits go through the
    // approval gate (awaiting_review) so the user can accept/reject the
    // work before it's considered completed.
    if (agent.currentTaskId && this.db) {
      const now = new Date().toISOString();
      if (code === 0) {
        this.db.prepare(`
          UPDATE tasks SET status = 'awaiting_review', updated_at = ? WHERE id = ?
        `).run(now, agent.currentTaskId);
        emitTaskStatus(agent.workspaceId, agent.currentTaskId, 'awaiting_review');
      } else {
        this.db.prepare(`
          UPDATE tasks SET status = 'failed', completed_at = ?, updated_at = ? WHERE id = ?
        `).run(now, now, agent.currentTaskId);
        emitTaskStatus(agent.workspaceId, agent.currentTaskId, 'failed');
      }
    }

    // Remove agent record from database (it's no longer active)
    if (this.db) {
      this.db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
    }
  }

  /**
   * Analyze output to detect status
   */
  private analyzeOutput(agent: ActiveAgent): void {
    const recentOutput = agent.outputBuffer.split('\n').slice(-10).join('\n');
    const { status: newStatus, attention: newAttention } = detectStatusFromOutput(
      recentOutput,
      { status: agent.status, attention: agent.attention }
    );

    if (newStatus !== agent.status || newAttention !== agent.attention) {
      this.updateAgentStatus(agent.id, newStatus, newAttention);

      if (newAttention === 'high' && agent.attention !== 'high') {
        this.createInboxItemForAgent(agent, newStatus);
      }
    }
  }

  /**
   * Update agent status
   */
  private updateAgentStatus(agentId: string, status: AgentStatus, attention: AgentAttention): void {
    const agent = this.activeAgents.get(agentId);
    if (agent) {
      agent.status = status;
      agent.attention = attention;
    }

    if (this.db) {
      this.db.prepare(`
        UPDATE agents SET status = ?, attention = ?, last_activity = ? WHERE id = ?
      `).run(status, attention, new Date().toISOString(), agentId);
    }

    // Emit via WebSocket
    if (agent) {
      emitAgentStatus(agent.workspaceId, agentId, status, attention);

      // Also emit task agent status if this agent has a task
      if (agent.currentTaskId) {
        emitTaskAgentStatus(agent.workspaceId, agent.currentTaskId, status, attention);
      }
    }

    this.emit('status', agentId, status, attention);
  }

  /**
   * Create inbox item for agent status
   */
  private createInboxItemForAgent(agent: ActiveAgent, status: AgentStatus): void {
    if (!this.db) return;

    let type: 'agent_question' | 'agent_completed' | 'agent_error';
    let title: string;
    let summary: string;
    let priority: 'low' | 'medium' | 'high' | 'urgent';

    const env = environmentService.getEnvironment(agent.environmentId);
    const envName = env?.name || 'Unknown';

    switch (status) {
      case 'awaiting_input':
        type = 'agent_question';
        title = `Agent needs input`;
        summary = `Claude on ${envName} is asking a question`;
        priority = 'high';
        break;

      case 'completed':
        type = 'agent_completed';
        title = `Agent completed task`;
        summary = `Claude on ${envName} finished working`;
        priority = 'low';
        break;

      case 'error':
        type = 'agent_error';
        title = `Agent encountered error`;
        summary = `Claude on ${envName} ran into a problem`;
        priority = 'urgent';
        break;

      default:
        return; // Don't create inbox item for other statuses
    }

    const inboxId = uuid();
    const now = new Date().toISOString();

    // Use taskId in source/actions if available, otherwise fall back to agentId
    const sourceId = agent.currentTaskId || agent.id;
    const sourceType = agent.currentTaskId ? 'task' : 'agent';
    const actionLabel = agent.currentTaskId ? 'View Task' : 'View Agent';
    const actionType = agent.currentTaskId ? 'view_task' : 'view_agent';

    this.db.prepare(`
      INSERT INTO inbox_items (id, workspace_id, type, status, priority, title, summary, source, actions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      inboxId,
      agent.workspaceId,
      type,
      'unread',
      priority,
      title,
      summary,
      JSON.stringify({ type: sourceType, id: sourceId, name: `Task on ${envName}` }),
      JSON.stringify([
        { id: '1', label: actionLabel, type: 'primary', action: actionType },
      ]),
      now
    );

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
      createdAt: now,
    };

    emitInboxNew(agent.workspaceId, inboxItem);
  }

  /**
   * Check for stuck agents (no activity for 5 minutes)
   */
  private checkStuckAgents(): void {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    for (const [id, agent] of this.activeAgents) {
      if (agent.status === 'working' && agent.lastActivityTime < fiveMinutesAgo) {
        // Agent might be stuck
        this.updateAgentStatus(id, 'awaiting_input', 'medium');
      }
    }
  }
}

// Singleton instance
export const agentService = new AgentService();

/**
 * Build an inline `KEY=val ` prefix for a shell command so child Claudes
 * can find their parent FastOwl via the CLI. Values are single-quoted and
 * safely escaped for bash.
 */
export function buildFastOwlEnvPrefix(workspaceId: string, taskId?: string): string {
  const port = process.env.PORT || '4747';
  const apiUrl = process.env.FASTOWL_API_URL || `http://localhost:${port}`;
  const parts = [
    `FASTOWL_API_URL=${shellQuote(apiUrl)}`,
    `FASTOWL_WORKSPACE_ID=${shellQuote(workspaceId)}`,
  ];
  if (taskId) parts.push(`FASTOWL_TASK_ID=${shellQuote(taskId)}`);
  return parts.join(' ') + ' ';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
