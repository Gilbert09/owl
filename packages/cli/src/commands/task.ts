import { Command } from 'commander';
import type { CreateTaskRequest, Task, TaskPriority, TaskType } from '@fastowl/shared';
import { request } from '../client.js';

function envDefaults() {
  return {
    workspaceId: process.env.FASTOWL_WORKSPACE_ID,
    taskId: process.env.FASTOWL_TASK_ID,
  };
}

export function registerTaskCommands(program: Command): void {
  const task = program
    .command('task')
    .description('Create and inspect FastOwl tasks');

  task
    .command('create')
    .description('Create a new task')
    .option('--workspace <id>', 'Workspace id (default: $FASTOWL_WORKSPACE_ID)')
    .option(
      '--type <type>',
      'Task type: code_writing | pr_response | pr_review | manual',
      'code_writing'
    )
    .option('--title <title>', 'Task title (auto-generated if omitted)')
    .option('--description <desc>', 'Task description', '')
    .option('--prompt <prompt>', 'Prompt for Claude agent (required for agent tasks)')
    .option('--priority <priority>', 'Priority: low | medium | high | urgent', 'medium')
    .option('--repository <id>', 'Repository id to target')
    .option('--env <id>', 'Preferred environment id')
    .option('--json', 'Emit machine-readable JSON on stdout')
    .action(async (opts) => {
      const { workspaceId: fallbackWs } = envDefaults();
      const workspaceId = opts.workspace || fallbackWs;
      if (!workspaceId) {
        console.error('error: --workspace is required (or set $FASTOWL_WORKSPACE_ID)');
        process.exit(2);
      }

      const type = opts.type as TaskType;
      if (!['code_writing', 'pr_response', 'pr_review', 'manual'].includes(type)) {
        console.error(`error: invalid --type "${type}"`);
        process.exit(2);
      }

      const body: CreateTaskRequest = {
        workspaceId,
        type,
        title: opts.title || deriveTitle(opts.prompt, type),
        description: opts.description,
        prompt: opts.prompt,
        priority: opts.priority as TaskPriority,
        repositoryId: opts.repository,
        assignedEnvironmentId: opts.env,
      };

      try {
        const created = await request<Task>('POST', '/tasks', body);
        if (opts.json) {
          process.stdout.write(JSON.stringify(created) + '\n');
        } else {
          console.log(`✓ Created task ${created.id}`);
          console.log(`  title:  ${created.title}`);
          console.log(`  type:   ${created.type}`);
          console.log(`  status: ${created.status}`);
        }
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  task
    .command('list')
    .description('List tasks in a workspace')
    .option('--workspace <id>', 'Workspace id')
    .option('--status <status>', 'Filter by status')
    .option('--type <type>', 'Filter by type')
    .option('--json', 'Emit machine-readable JSON on stdout')
    .action(async (opts) => {
      const workspaceId = opts.workspace || envDefaults().workspaceId;
      const params = new URLSearchParams();
      if (workspaceId) params.set('workspaceId', workspaceId);
      if (opts.status) params.set('status', opts.status);
      if (opts.type) params.set('type', opts.type);
      const qs = params.toString();

      try {
        const tasks = await request<Task[]>('GET', `/tasks${qs ? `?${qs}` : ''}`);
        if (opts.json) {
          process.stdout.write(JSON.stringify(tasks) + '\n');
        } else {
          for (const t of tasks) {
            console.log(`${t.id}  ${t.status.padEnd(16)}  ${t.type.padEnd(13)}  ${t.title}`);
          }
          if (tasks.length === 0) console.log('(no tasks)');
        }
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  task
    .command('ready')
    .description('Mark a task ready for review (stops the agent)')
    .argument('[id]', 'Task id (default: $FASTOWL_TASK_ID)')
    .action(async (id?: string) => {
      const taskId = id || envDefaults().taskId;
      if (!taskId) {
        console.error('error: task id required (or set $FASTOWL_TASK_ID)');
        process.exit(2);
      }
      try {
        await request<Task>('POST', `/tasks/${taskId}/ready-for-review`);
        console.log(`✓ Task ${taskId} is now awaiting_review`);
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function deriveTitle(prompt: string | undefined, type: TaskType): string {
  if (prompt) {
    const firstLine = prompt.split('\n')[0].trim();
    return firstLine.slice(0, 80);
  }
  return `New ${type.replace('_', ' ')} task`;
}
