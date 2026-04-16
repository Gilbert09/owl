import { EventEmitter } from 'events';
import type { Task, TaskPriority, Agent } from '@fastowl/shared';
import { agentService } from './agent.js';
import { environmentService } from './environment.js';
import { emitTaskStatus } from './websocket.js';
import { DB } from '../db/index.js';

class TaskQueueService extends EventEmitter {
  private db: DB | null = null;
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;

  // Priority weights for scoring
  private priorityWeights: Record<TaskPriority, number> = {
    urgent: 1000,
    high: 100,
    medium: 10,
    low: 1,
  };

  /**
   * Initialize the task queue
   */
  init(db: DB): void {
    this.db = db;

    // Listen for agent status changes
    agentService.on('status', (_agentId, status, _attention) => {
      if (status === 'idle' || status === 'completed') {
        // Agent became available, try to assign next task
        this.processQueue();
      }
    });

    // Start periodic queue processing
    this.processingInterval = setInterval(() => {
      this.processQueue();
    }, 5000); // Every 5 seconds
  }

  /**
   * Shutdown the queue
   */
  shutdown(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
  }

  /**
   * Add a task to the queue
   */
  queueTask(taskId: string): void {
    if (!this.db) return;

    this.db.prepare(`
      UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), taskId);

    // Get the task to emit event
    const task = this.getTask(taskId);
    if (task) {
      emitTaskStatus(task.workspaceId, taskId, 'queued');
    }

    // Try to process immediately
    this.processQueue();
  }

  /**
   * Cancel a queued task
   */
  cancelTask(taskId: string): void {
    if (!this.db) return;

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE tasks SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ?
    `).run(now, now, taskId);

    const task = this.getTask(taskId);
    if (task) {
      emitTaskStatus(task.workspaceId, taskId, 'cancelled');
    }
  }

  /**
   * Get queued tasks sorted by priority
   */
  getQueuedTasks(workspaceId?: string): Task[] {
    if (!this.db) return [];

    let query = `
      SELECT * FROM tasks
      WHERE status IN ('pending', 'queued')
    `;
    const params: any[] = [];

    if (workspaceId) {
      query += ' AND workspace_id = ?';
      params.push(workspaceId);
    }

    query += `
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          ELSE 4
        END,
        created_at ASC
    `;

    const rows = this.db.prepare(query).all(...params);
    return rows.map(this.rowToTask);
  }

  /**
   * Process the queue - assign tasks to available agents
   */
  async processQueue(): Promise<void> {
    // Prevent concurrent processing
    if (this.isProcessing || !this.db) return;
    this.isProcessing = true;

    try {
      // Get queued tasks
      const queuedTasks = this.getQueuedTasks();
      if (queuedTasks.length === 0) return;

      // Get idle agents
      const idleAgents = agentService.getIdleAgents();

      // Also check for connected environments without agents
      const connectedEnvironments = environmentService.getAllEnvironments()
        .filter(env => env.status === 'connected');

      // For each high-priority task, try to assign it
      for (const task of queuedTasks) {
        // Only auto-process automated tasks
        if (task.type !== 'automated') continue;

        // Check if there's a preferred environment
        const targetEnvironmentId = task.assignedEnvironmentId;

        // Find an available agent or environment
        let agentToUse: Agent | null = null;

        // First try idle agents
        for (const agent of idleAgents) {
          if (agent.workspaceId === task.workspaceId) {
            if (!targetEnvironmentId || agent.environmentId === targetEnvironmentId) {
              agentToUse = agent;
              break;
            }
          }
        }

        // If no idle agent, check if we can start a new one
        if (!agentToUse) {
          // Find a connected environment without an active agent
          const workspace = this.getWorkspace(task.workspaceId);
          const maxAgents = workspace?.settings?.maxConcurrentAgents || 3;

          const activeAgentCount = this.getActiveAgentCount(task.workspaceId);

          if (activeAgentCount < maxAgents) {
            // Find a suitable environment
            for (const env of connectedEnvironments) {
              // Check if there's already an agent on this environment for this workspace
              const envHasAgent = idleAgents.some(
                a => a.environmentId === env.id && a.workspaceId === task.workspaceId
              );

              if (!envHasAgent) {
                if (!targetEnvironmentId || env.id === targetEnvironmentId) {
                  // Start a new agent on this environment
                  try {
                    const newAgent = await agentService.startAgent({
                      environmentId: env.id,
                      workspaceId: task.workspaceId,
                      taskId: task.id,
                      prompt: task.prompt || task.description,
                    });

                    // Update task
                    this.db!.prepare(`
                      UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, updated_at = ? WHERE id = ?
                    `).run(newAgent.id, new Date().toISOString(), task.id);

                    emitTaskStatus(task.workspaceId, task.id, 'in_progress');

                    break; // Move to next task
                  } catch (err) {
                    console.error(`Failed to start agent on ${env.name}:`, err);
                  }
                }
              }
            }
          }
        } else {
          // Use the idle agent
          // Send the task to the agent
          try {
            const prompt = task.prompt || task.description;
            agentService.sendInput(agentToUse.id, prompt);

            // Update task
            this.db.prepare(`
              UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, updated_at = ? WHERE id = ?
            `).run(agentToUse.id, new Date().toISOString(), task.id);

            // Update agent
            this.db.prepare(`
              UPDATE agents SET current_task_id = ?, status = 'working', updated_at = ? WHERE id = ?
            `).run(task.id, new Date().toISOString(), agentToUse.id);

            emitTaskStatus(task.workspaceId, task.id, 'in_progress');

            // Remove from idle list for this iteration
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

  /**
   * Get a task by ID
   */
  getTask(taskId: string): Task | null {
    if (!this.db) return null;

    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    return row ? this.rowToTask(row) : null;
  }

  /**
   * Get workspace settings
   */
  private getWorkspace(workspaceId: string): any | null {
    if (!this.db) return null;

    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    if (!row) return null;

    return {
      ...(row as any),
      settings: JSON.parse((row as any).settings),
    };
  }

  /**
   * Get count of active agents for a workspace
   */
  private getActiveAgentCount(workspaceId: string): number {
    if (!this.db) return 0;

    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM agents
      WHERE workspace_id = ? AND status IN ('working', 'tool_use', 'awaiting_input')
    `).get(workspaceId) as any;

    return result?.count || 0;
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      type: row.type,
      status: row.status,
      priority: row.priority,
      title: row.title,
      description: row.description,
      prompt: row.prompt || undefined,
      assignedAgentId: row.assigned_agent_id || undefined,
      assignedEnvironmentId: row.assigned_environment_id || undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || undefined,
    };
  }
}

// Singleton instance
export const taskQueueService = new TaskQueueService();
