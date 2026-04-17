import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import { setupRoutes } from './routes/index.js';
import { setupWebSocket } from './services/websocket.js';
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
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

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
 * Connect to every saved environment on startup. Local envs always
 * "connect" (it's a no-op). SSH envs try their stored credentials.
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
