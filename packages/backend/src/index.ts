import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { setupRoutes } from './routes/index.js';
import { setupWebSocket } from './services/websocket.js';
import { initDatabase } from './db/index.js';
import { environmentService } from './services/environment.js';
import { agentService } from './services/agent.js';
import { taskQueueService } from './services/taskQueue.js';
import { githubService } from './services/github.js';
import { prMonitorService } from './services/prMonitor.js';
import { backlogService } from './services/backlog/service.js';

const PORT = process.env.PORT || 4747;

async function main() {
  console.log('Starting FastOwl backend...');

  // Initialize database
  console.log('Initializing database...');
  const db = initDatabase();

  // Initialize services
  console.log('Initializing services...');
  environmentService.init(db);
  agentService.init(db);
  taskQueueService.init(db);
  githubService.init(db);
  prMonitorService.init(db);
  backlogService.init(db);

  // Create Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health check
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

  // Setup API routes
  setupRoutes(app, db);

  // Create HTTP server
  const server = createServer(app);

  // Setup WebSocket server
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  // Start server
  server.listen(PORT, () => {
    console.log(`FastOwl backend running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
    console.log(`Health check at http://localhost:${PORT}/health`);
  });

  // Auto-connect to saved environments
  connectSavedEnvironments(db);

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down...');

    // Shutdown services
    prMonitorService.shutdown();
    taskQueueService.shutdown();
    agentService.shutdown();
    environmentService.shutdown();

    // Close server
    server.close(() => {
      db.close();
      console.log('Goodbye!');
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      console.log('Forcing exit...');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Connect to all saved environments that should auto-connect
 */
async function connectSavedEnvironments(db: ReturnType<typeof initDatabase>) {
  const environments = db.prepare('SELECT * FROM environments').all();

  for (const env of environments as any[]) {
    if (env.type === 'local') {
      // Local is always connected
      db.prepare(`UPDATE environments SET status = 'connected' WHERE id = ?`).run(env.id);
      continue;
    }

    // Try to connect to SSH environments
    if (env.type === 'ssh') {
      console.log(`Attempting to connect to ${env.name}...`);
      try {
        await environmentService.connect(env.id);
        console.log(`Connected to ${env.name}`);
      } catch (err: any) {
        console.log(`Failed to connect to ${env.name}: ${err.message}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
