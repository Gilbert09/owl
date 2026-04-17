import { Command } from 'commander';
import type { BacklogItem, BacklogSource } from '@fastowl/shared';
import { request } from '../client.js';

export function registerBacklogCommands(program: Command): void {
  const backlog = program
    .command('backlog')
    .description('Inspect and sync backlog sources');

  backlog
    .command('sources')
    .description('List backlog sources in a workspace')
    .option('--workspace <id>', 'Workspace id')
    .option('--json', 'Emit machine-readable JSON on stdout')
    .action(async (opts) => {
      const workspaceId = opts.workspace || process.env.FASTOWL_WORKSPACE_ID;
      if (!workspaceId) {
        console.error('error: --workspace is required (or set $FASTOWL_WORKSPACE_ID)');
        process.exit(2);
      }
      try {
        const sources = await request<BacklogSource[]>(
          'GET',
          `/backlog/sources?workspaceId=${workspaceId}`
        );
        if (opts.json) {
          process.stdout.write(JSON.stringify(sources) + '\n');
          return;
        }
        for (const s of sources) {
          const cfg = s.config as { path?: string; section?: string };
          console.log(
            `${s.id}  ${s.enabled ? 'on ' : 'off'}  ${cfg.path ?? ''}${cfg.section ? ` (${cfg.section})` : ''}`
          );
        }
        if (sources.length === 0) console.log('(no sources)');
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  backlog
    .command('sync')
    .description('Re-read a source and upsert items')
    .argument('<sourceId>', 'Source id')
    .action(async (sourceId: string) => {
      try {
        const result = await request<{ added: number; updated: number; retired: number }>(
          'POST',
          `/backlog/sources/${sourceId}/sync`
        );
        console.log(
          `✓ synced: +${result.added} added, ${result.updated} changed, ${result.retired} retired`
        );
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  backlog
    .command('items')
    .description('List backlog items')
    .option('--source <id>', 'List items from a specific source')
    .option('--workspace <id>', 'List all items in a workspace')
    .option('--json', 'Emit machine-readable JSON on stdout')
    .action(async (opts) => {
      const path = opts.source
        ? `/backlog/sources/${opts.source}/items`
        : `/backlog/items?workspaceId=${opts.workspace || process.env.FASTOWL_WORKSPACE_ID}`;
      try {
        const items = await request<BacklogItem[]>('GET', path);
        if (opts.json) {
          process.stdout.write(JSON.stringify(items) + '\n');
          return;
        }
        for (const it of items) {
          const marker = it.completed ? '[x]' : it.blocked ? '[!]' : it.claimedTaskId ? '[~]' : '[ ]';
          console.log(`${marker} ${it.text}`);
        }
        if (items.length === 0) console.log('(no items)');
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  backlog
    .command('schedule')
    .description('Kick the Continuous Build scheduler for a workspace')
    .option('--workspace <id>', 'Workspace id')
    .action(async (opts) => {
      const workspaceId = opts.workspace || process.env.FASTOWL_WORKSPACE_ID;
      if (!workspaceId) {
        console.error('error: --workspace is required (or set $FASTOWL_WORKSPACE_ID)');
        process.exit(2);
      }
      try {
        await request<void>('POST', '/backlog/schedule', { workspaceId });
        console.log('✓ scheduler evaluated');
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
