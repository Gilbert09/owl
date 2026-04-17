import { Express } from 'express';
import { workspaceRoutes } from './workspaces.js';
import { environmentRoutes } from './environments.js';
import { taskRoutes } from './tasks.js';
import { agentRoutes } from './agents.js';
import { inboxRoutes } from './inbox.js';
import { githubRoutes } from './github.js';
import { repositoryRoutes } from './repositories.js';
import { backlogRoutes } from './backlog.js';

export function setupRoutes(app: Express): void {
  const api = '/api/v1';

  app.use(`${api}/workspaces`, workspaceRoutes());
  app.use(`${api}/environments`, environmentRoutes());
  app.use(`${api}/tasks`, taskRoutes());
  app.use(`${api}/agents`, agentRoutes());
  app.use(`${api}/inbox`, inboxRoutes());
  app.use(`${api}/github`, githubRoutes());
  app.use(`${api}/repositories`, repositoryRoutes());
  app.use(`${api}/backlog`, backlogRoutes());

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
  });

  app.use((err: Error, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    console.error('API Error:', err);
    res.status(500).json({ success: false, error: err.message });
  });
}
