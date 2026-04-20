import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import { setupRoutes } from './routes/index.js';
import { setupWebSocket } from './services/websocket.js';
import { handleConnection as handleDaemonWsConnection } from './services/daemonWs.js';
import { daemonRegistry } from './services/daemonRegistry.js';
import { initDatabase } from './db/index.js';
import { getDbClient, closeDbClient } from './db/client.js';
import { environments as environmentsTable } from './db/schema.js';
import { environmentService } from './services/environment.js';
import { agentService } from './services/agent.js';
import { taskQueueService } from './services/taskQueue.js';
import { githubService } from './services/github.js';
import { prMonitorService } from './services/prMonitor.js';
import { backlogService } from './services/backlog/service.js';
import { continuousBuildScheduler } from './services/continuousBuild.js';
import { permissionInboxService } from './services/permissionInbox.js';
import { taskFileWatcher } from './services/taskFileWatcher.js';

const PORT = process.env.PORT || 4747;

async function main() {
  console.log('Starting FastOwl backend...');

  // Initialize database + run migrations. Must complete before services
  // read any state.
  console.log('Initializing database...');
  await initDatabase();

  // Initialize services. Each init is idempotent and DB-aware.
  console.log('Initializing services...');
  await environmentService.init();
  await agentService.init();
  await taskQueueService.init();
  await githubService.init();
  await prMonitorService.init();
  await backlogService.init();
  await continuousBuildScheduler.init();
  daemonRegistry.init();
  permissionInboxService.init();
  taskFileWatcher.init();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        environments: 'ready',
        agents: 'ready',
        taskQueue: 'ready',
        prMonitor: 'ready',
      },
    });
  });

  setupRoutes(app);

  const server = createServer(app);

  // Two separate WS servers sharing one HTTP listener, dispatched by
  // path in a single `upgrade` handler. We used to let the user-facing
  // `wss` auto-attach to the server via `{server, path: '/ws'}`, but
  // that installs an upgrade listener that aborts *every* non-`/ws`
  // upgrade with 400 before the `/daemon-ws` handler gets a chance —
  // and because ws calls `abortHandshake` synchronously, our custom
  // listener then tries to upgrade an already-destroyed socket. Using
  // `noServer: true` on both sides and routing ourselves is the only
  // reliable way to serve two paths on one server.
  const wss = new WebSocketServer({ noServer: true });
  setupWebSocket(wss);

  const daemonWss = new WebSocketServer({ noServer: true });
  daemonWss.on('connection', (ws) => { void handleDaemonWsConnection(ws); });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (pathname === '/daemon-ws') {
      daemonWss.handleUpgrade(req, socket, head, (ws) => daemonWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, () => {
    console.log(`FastOwl backend running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
    console.log(`Health check at http://localhost:${PORT}/health`);
  });

  connectSavedEnvironments().catch((err) =>
    console.error('Failed to auto-connect environments:', err)
  );

  const shutdown = async () => {
    console.log('Shutting down...');
    continuousBuildScheduler.shutdown();
    prMonitorService.shutdown();
    taskQueueService.shutdown();
    agentService.shutdown();
    environmentService.shutdown();
    await daemonRegistry.shutdown();

    server.close(async () => {
      await closeDbClient();
      console.log('Goodbye!');
      process.exit(0);
    });

    setTimeout(() => {
      console.log('Forcing exit...');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}

/**
 * Reconcile env.status on startup. Local envs "connect" synthetically
 * (backend-local PTY is always available). SSH envs retry their stored
 * creds. Daemon envs are marked disconnected by default — they'll flip
 * to `connected` when the daemon dials back in; the WS registers that
 * via daemonRegistry.register.
 */
async function connectSavedEnvironments() {
  const db = getDbClient();
  const envs = await db.select().from(environmentsTable);
  for (const env of envs) {
    if (env.type === 'local') {
      await db
        .update(environmentsTable)
        .set({ status: 'connected' })
        .where(eq(environmentsTable.id, env.id));
      continue;
    }
    if (env.type === 'daemon') {
      await db
        .update(environmentsTable)
        .set({ status: 'disconnected' })
        .where(eq(environmentsTable.id, env.id));
      continue;
    }
    if (env.type === 'ssh') {
      console.log(`Attempting to connect to ${env.name}...`);
      try {
        await environmentService.connect(env.id);
        console.log(`Connected to ${env.name}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.log(`Failed to connect to ${env.name}: ${msg}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
