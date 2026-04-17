import type {
  BacklogItem,
  BacklogSource,
  CreateTaskRequest,
  Task,
  TaskPriority,
  TaskType,
} from '@fastowl/shared';
import { request, workspaceId as envWorkspaceId, taskId as envTaskId } from './client.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

function resolveWorkspace(args: Record<string, unknown>): string {
  const id = (args.workspace_id as string | undefined) ?? envWorkspaceId();
  if (!id) {
    throw new Error(
      'workspace_id is required (or set FASTOWL_WORKSPACE_ID in the MCP server env)'
    );
  }
  return id;
}

/**
 * All FastOwl MCP tools. Each one talks to the FastOwl backend HTTP API
 * (at FASTOWL_API_URL) using the same calling convention as the CLI.
 */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'fastowl_create_task',
    description:
      'Create a new task in FastOwl. Use this to queue follow-up work that another Claude should pick up, without interrupting the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Prompt for the Claude agent. Plain english describing what to build.',
        },
        type: {
          type: 'string',
          enum: ['code_writing', 'pr_response', 'pr_review', 'manual'],
          description: 'Task type. Default: code_writing.',
        },
        title: {
          type: 'string',
          description: 'Short task title. Auto-derived from prompt if omitted.',
        },
        description: {
          type: 'string',
          description: 'Longer task description.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Priority. Default: medium.',
        },
        repository_id: {
          type: 'string',
          description: 'FastOwl repository id to target.',
        },
        environment_id: {
          type: 'string',
          description: 'Preferred environment id.',
        },
        workspace_id: {
          type: 'string',
          description:
            'Workspace id. Defaults to $FASTOWL_WORKSPACE_ID from the MCP server env.',
        },
      },
      required: ['prompt'],
    },
    handler: async (args) => {
      const ws = resolveWorkspace(args);
      const body: CreateTaskRequest = {
        workspaceId: ws,
        type: (args.type as TaskType) ?? 'code_writing',
        title: (args.title as string) ?? deriveTitle(args.prompt as string),
        description: (args.description as string) ?? '',
        prompt: args.prompt as string,
        priority: (args.priority as TaskPriority) ?? 'medium',
        repositoryId: args.repository_id as string | undefined,
        assignedEnvironmentId: args.environment_id as string | undefined,
      };
      const task = await request<Task>('POST', '/tasks', body);
      return `Created task ${task.id}: "${task.title}" (${task.status})`;
    },
  },
  {
    name: 'fastowl_list_tasks',
    description:
      'List tasks in a workspace. Useful for checking what is queued, in-flight, or awaiting review.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: 'Workspace id. Defaults to $FASTOWL_WORKSPACE_ID.',
        },
        status: {
          type: 'string',
          description:
            'Filter by status: queued, in_progress, awaiting_review, completed, failed, cancelled.',
        },
        type: {
          type: 'string',
          description: 'Filter by type.',
        },
      },
    },
    handler: async (args) => {
      const ws = resolveWorkspace(args);
      const params = new URLSearchParams({ workspaceId: ws });
      if (args.status) params.set('status', String(args.status));
      if (args.type) params.set('type', String(args.type));
      const tasks = await request<Task[]>('GET', `/tasks?${params.toString()}`);
      if (tasks.length === 0) return 'No tasks found.';
      return tasks
        .map((t) => `- ${t.id}  [${t.status}]  ${t.type}  ${t.title}`)
        .join('\n');
    },
  },
  {
    name: 'fastowl_mark_ready_for_review',
    description:
      'Stop the current task\'s agent and move it to awaiting_review so a human can approve or reject. Uses $FASTOWL_TASK_ID by default.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task id. Defaults to $FASTOWL_TASK_ID.',
        },
      },
    },
    handler: async (args) => {
      const id = (args.task_id as string | undefined) ?? envTaskId();
      if (!id) throw new Error('task_id is required (or set FASTOWL_TASK_ID)');
      await request<Task>('POST', `/tasks/${id}/ready-for-review`);
      return `Task ${id} is awaiting_review.`;
    },
  },
  {
    name: 'fastowl_list_backlog_items',
    description:
      'List backlog items — what Continuous Build is tracking. Great for deciding whether to spawn a follow-up task or letting the existing backlog handle it.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: 'Workspace id. Defaults to $FASTOWL_WORKSPACE_ID.',
        },
      },
    },
    handler: async (args) => {
      const ws = resolveWorkspace(args);
      const items = await request<BacklogItem[]>(
        'GET',
        `/backlog/items?workspaceId=${ws}`
      );
      if (items.length === 0) return 'No backlog items.';
      return items
        .map((it) => {
          const mark = it.completed
            ? '[x]'
            : it.blocked
            ? '[!]'
            : it.claimedTaskId
            ? '[~]'
            : '[ ]';
          return `${mark} ${it.text}`;
        })
        .join('\n');
    },
  },
  {
    name: 'fastowl_list_backlog_sources',
    description: 'List backlog sources configured in a workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: 'Workspace id. Defaults to $FASTOWL_WORKSPACE_ID.',
        },
      },
    },
    handler: async (args) => {
      const ws = resolveWorkspace(args);
      const sources = await request<BacklogSource[]>(
        'GET',
        `/backlog/sources?workspaceId=${ws}`
      );
      if (sources.length === 0) return 'No sources configured.';
      return sources
        .map((s) => {
          const cfg = s.config as { path?: string; section?: string };
          return `${s.id}  ${s.enabled ? 'on' : 'off'}  ${cfg.path ?? ''}${cfg.section ? ` (${cfg.section})` : ''}`;
        })
        .join('\n');
    },
  },
  {
    name: 'fastowl_sync_backlog_source',
    description:
      'Re-read a backlog source (e.g. a TODO markdown file) and upsert items. Run this after editing the source file to pick up changes.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: {
          type: 'string',
          description: 'Backlog source id.',
        },
      },
      required: ['source_id'],
    },
    handler: async (args) => {
      const result = await request<{ added: number; updated: number; retired: number }>(
        'POST',
        `/backlog/sources/${String(args.source_id)}/sync`
      );
      return `Synced: +${result.added} added, ${result.updated} changed, ${result.retired} retired.`;
    },
  },
  {
    name: 'fastowl_schedule',
    description:
      'Kick the Continuous Build scheduler for a workspace. Picks the next unblocked backlog item and spawns a task for it, respecting maxConcurrent and the approval gate.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: 'Workspace id. Defaults to $FASTOWL_WORKSPACE_ID.',
        },
      },
    },
    handler: async (args) => {
      const ws = resolveWorkspace(args);
      await request<void>('POST', '/backlog/schedule', { workspaceId: ws });
      return 'Scheduler evaluated.';
    },
  },
];

function deriveTitle(prompt: string | undefined): string {
  if (!prompt) return 'New task';
  const first = prompt.split('\n')[0].trim();
  return first.slice(0, 80);
}
