import { Express } from 'express';
import { DB } from '../db/index.js';
import { workspaceRoutes } from './workspaces.js';
import { environmentRoutes } from './environments.js';
import { taskRoutes } from './tasks.js';
import { agentRoutes } from './agents.js';
import { inboxRoutes } from './inbox.js';
import { githubRoutes } from './github.js';

export function setupRoutes(app: Express, db: DB): void {
  // API version prefix
  const api = '/api/v1';

  // Mount routes
  app.use(`${api}/workspaces`, workspaceRoutes(db));
  app.use(`${api}/environments`, environmentRoutes(db));
  app.use(`${api}/tasks`, taskRoutes(db));
  app.use(`${api}/agents`, agentRoutes(db));
  app.use(`${api}/inbox`, inboxRoutes(db));
  app.use(`${api}/github`, githubRoutes(db));

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
  });

  // Error handler
  app.use((err: Error, _req: any, res: any, _next: any) => {
    console.error('API Error:', err);
    res.status(500).json({ success: false, error: err.message });
  });
}
