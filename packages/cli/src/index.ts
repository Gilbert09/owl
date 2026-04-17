#!/usr/bin/env node
import { Command } from 'commander';
import { registerTaskCommands } from './commands/task.js';
import { registerBacklogCommands } from './commands/backlog.js';
import { baseUrl } from './client.js';

const program = new Command();

program
  .name('fastowl')
  .description('FastOwl command-line client')
  .version('0.1.0')
  .option('-v, --verbose', 'Print additional diagnostics to stderr');

registerTaskCommands(program);
registerBacklogCommands(program);

program
  .command('ping')
  .description('Check that the FastOwl backend is reachable')
  .action(async () => {
    const url = `${baseUrl()}/health`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`error: ${url} returned ${res.status}`);
        process.exit(1);
      }
      const body = (await res.json()) as { status: string };
      console.log(`ok: ${url} → ${body.status}`);
    } catch (err) {
      console.error(`error: could not reach ${url}: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
