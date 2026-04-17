import { Express } from 'express';
import { workspaceRoutes } from './workspaces.js';
import { environmentRoutes } from './environments.js';
import { taskRoutes } from './tasks.js';
import { agentRoutes } from './agents.js';
import { inboxRoutes } from './inbox.js';
import { githubRoutes, githubPublicRoutes } from './github.js';
import { repositoryRoutes } from './repositories.js';
import { backlogRoutes } from './backlog.js';
import { requireAuth } from '../middleware/auth.js';

export function setupRoutes(app: Express): void {
  const api = '/api/v1';

  // Public routes: the GitHub OAuth callback is hit by GitHub's browser
  // redirect, not by our authenticated desktop client, so it must stay
  // unauth'd. State-token validation inside the handler prevents CSRF.
  app.use(`${api}/github`, githubPublicRoutes());

  // Everything below is authenticated. The middleware populates req.user
  // and refuses requests without a valid Supabase JWT.
  app.use(`${api}`, requireAuth);

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
