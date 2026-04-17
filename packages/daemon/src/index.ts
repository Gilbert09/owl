#!/usr/bin/env node
import { resolveConfig } from './config.js';
import { DaemonWsClient } from './wsClient.js';
import { shutdownAllSessions } from './executor.js';

/**
 * Entry point for the FastOwl daemon. Resolves configuration, dials
 * the backend, and hangs around. Meant to be run under systemd/launchd
 * (or as an Electron child process for the bundled case) so there's no
 * exit-on-success — the daemon should stay up forever.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = resolveConfig(argv);

  console.log(`fastowl-daemon starting — backend=${config.backendUrl}`);
  const client = new DaemonWsClient(config);
  client.start();

  const shutdown = () => {
    console.log('fastowl-daemon shutting down');
    shutdownAllSessions();
    client.shutdown();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('fastowl-daemon failed to start:', err);
  process.exit(1);
});
