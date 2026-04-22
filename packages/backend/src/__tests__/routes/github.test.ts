import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { githubRoutes, githubPublicRoutes } from '../../routes/github.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';
import { githubService } from '../../services/github.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  // Public routes (unauthenticated — hit by GitHub's browser redirect).
  app.use('/github', githubPublicRoutes());
  // Authenticated routes.
  app.use('/api/v1/github', requireAuth, githubRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await seedUser(db, { id: OTHER_USER_ID });
  await db.insert(workspacesTable).values([
    { id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
    { id: 'ws2', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
  ]);
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/github', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
  });

  afterEach(async () => {
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
    await closeServer();
    await cleanup();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('GET /api/v1/github/status', () => {
    it('returns configured=false shape + connected=false when no workspaceId', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/status`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('configured');
    });

    it('reports connected=false for a fresh workspace', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/status?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data.connected).toBe(false);
    });

    it('reports connected=true with scopes after a token is stored', async () => {
      vi.spyOn(githubService, 'isConfigured').mockReturnValue(true);
      await githubService.storeToken('ws1', 'gho_test', 'bearer', 'repo read:user');
      const res = await fetch(`${serverUrl}/api/v1/github/status?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data.connected).toBe(true);
      expect(body.data.scopes).toEqual(['repo', 'read:user']);
    });

    it('404s a workspace the caller does not own', async () => {
      vi.spyOn(githubService, 'isConfigured').mockReturnValue(true);
      const res = await fetch(`${serverUrl}/api/v1/github/status?workspaceId=ws2`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/github/connect', () => {
    it('401s unauthenticated', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
      expect(res.status).toBe(401);
    });

    it('requires workspaceId', async () => {
      vi.spyOn(githubService, 'isConfigured').mockReturnValue(true);
      const res = await fetch(`${serverUrl}/api/v1/github/connect`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('404s a cross-tenant workspace', async () => {
      vi.spyOn(githubService, 'isConfigured').mockReturnValue(true);
      const res = await fetch(`${serverUrl}/api/v1/github/connect`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws2' }),
      });
      expect(res.status).toBe(404);
    });

    it('400s when GitHub OAuth is not configured', async () => {
      vi.spyOn(githubService, 'isConfigured').mockReturnValue(false);
      const res = await fetch(`${serverUrl}/api/v1/github/connect`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not configured/i);
    });

    it('returns an auth URL + state when configured', async () => {
      vi.spyOn(githubService, 'isConfigured').mockReturnValue(true);
      vi.spyOn(githubService, 'getAuthorizationUrl').mockReturnValue(
        'https://github.com/login/oauth/authorize?client_id=x&state=ws1:token'
      );
      const res = await fetch(`${serverUrl}/api/v1/github/connect`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.authUrl).toMatch(/github\.com\/login\/oauth\/authorize/);
      expect(body.data.state).toBeTruthy();
    });
  });

  describe('GET /github/callback', () => {
    it('400s (HTML page) on OAuth error query param', async () => {
      const res = await fetch(
        `${serverUrl}/github/callback?error=access_denied&error_description=User+declined`
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      const body = await res.text();
      expect(body).toContain('User declined');
    });

    it('400s on missing code or state', async () => {
      const res = await fetch(`${serverUrl}/github/callback`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('Missing code or state');
    });

    it('400s on a bogus state token not in the in-memory map', async () => {
      const res = await fetch(
        `${serverUrl}/github/callback?code=abc&state=ws1:never-issued`
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toMatch(/Invalid OAuth state/);
    });

    it('round-trips code for a token on the happy path', async () => {
      vi.spyOn(githubService, 'isConfigured').mockReturnValue(true);
      vi.spyOn(githubService, 'getAuthorizationUrl').mockReturnValue('x');
      vi.spyOn(githubService, 'exchangeCodeForToken').mockResolvedValue({
        access_token: 'gho_test',
        token_type: 'bearer',
        scope: 'repo',
      });
      const storeSpy = vi.spyOn(githubService, 'storeToken').mockResolvedValue();

      // Step 1: initiate via /connect so a state token is registered.
      const init = await fetch(`${serverUrl}/api/v1/github/connect`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
      const { data: initData } = await init.json();
      const stateToken = initData.state as string;

      // Step 2: callback hit with the matching state.
      const res = await fetch(
        `${serverUrl}/github/callback?code=abc&state=${encodeURIComponent(`ws1:${stateToken}`)}`
      );
      expect(res.status).toBe(200);
      expect(storeSpy).toHaveBeenCalledWith('ws1', 'gho_test', 'bearer', 'repo');
    });
  });

  describe('POST /api/v1/github/disconnect', () => {
    it('removes the token for the workspace', async () => {
      await githubService.storeToken('ws1', 'gho', 'bearer', 'repo');
      const removeSpy = vi.spyOn(githubService, 'removeToken');

      const res = await fetch(`${serverUrl}/api/v1/github/disconnect`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
      expect(res.status).toBe(200);
      expect(removeSpy).toHaveBeenCalledWith('ws1');
    });

    it('404s a cross-tenant workspace', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/disconnect`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws2' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/github/user', () => {
    it('404s a cross-tenant workspace', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/user?workspaceId=ws2`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });

    it('forwards to githubService.getUser and returns the result', async () => {
      vi.spyOn(githubService, 'getUser').mockResolvedValue({
        id: 1, login: 'octocat', name: 'Octo', avatar_url: 'x', email: null,
      });
      const res = await fetch(`${serverUrl}/api/v1/github/user?workspaceId=ws1`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.login).toBe('octocat');
    });

    it('400s when githubService surfaces an error', async () => {
      vi.spyOn(githubService, 'getUser').mockRejectedValue(new Error('token expired'));
      const res = await fetch(`${serverUrl}/api/v1/github/user?workspaceId=ws1`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/github/repos', () => {
    it('delegates to listRepositories', async () => {
      vi.spyOn(githubService, 'listRepositories').mockResolvedValue([
        {
          id: 1, name: 'a', full_name: 'o/a', private: false,
          html_url: 'u', default_branch: 'main', owner: { login: 'o', avatar_url: 'x' },
        },
      ]);
      const res = await fetch(`${serverUrl}/api/v1/github/repos?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

  describe('POST /api/v1/github/repos/:owner/:repo/pulls', () => {
    it('forwards to createPullRequest with the body', async () => {
      const spy = vi.spyOn(githubService, 'createPullRequest').mockResolvedValue({
        id: 1, number: 42, title: 'feat', state: 'open', html_url: 'x',
        user: { login: 'me', avatar_url: 'a' },
        created_at: 'now', updated_at: 'now', draft: false,
        mergeable: true, mergeable_state: 'clean',
        head: { ref: 'fastowl/x', sha: 's' }, base: { ref: 'main' },
      });

      const res = await fetch(
        `${serverUrl}/api/v1/github/repos/acme/widgets/pulls`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            workspaceId: 'ws1',
            title: 't',
            head: 'fastowl/x',
            base: 'main',
          }),
        }
      );
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith('ws1', 'acme', 'widgets', expect.objectContaining({
        title: 't', head: 'fastowl/x', base: 'main',
      }));
    });

    it('404s a cross-tenant workspace', async () => {
      const res = await fetch(
        `${serverUrl}/api/v1/github/repos/acme/widgets/pulls`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            workspaceId: 'ws2',
            title: 't',
            head: 'x',
            base: 'main',
          }),
        }
      );
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/v1/github/repos/:owner/:repo/pulls/:number/merge', () => {
    it('delegates to mergePullRequest', async () => {
      const spy = vi.spyOn(githubService, 'mergePullRequest').mockResolvedValue({
        sha: 'abcdef', merged: true, message: 'ok',
      });
      const res = await fetch(
        `${serverUrl}/api/v1/github/repos/acme/widgets/pulls/42/merge`,
        {
          method: 'PUT',
          headers: authHeaders,
          body: JSON.stringify({ workspaceId: 'ws1', merge_method: 'squash' }),
        }
      );
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith('ws1', 'acme', 'widgets', 42, expect.objectContaining({
        merge_method: 'squash',
      }));
    });
  });

  describe('GET /api/v1/github/repos/:owner/:repo/branches', () => {
    it('delegates to listBranches', async () => {
      const spy = vi
        .spyOn(githubService, 'listBranches')
        .mockResolvedValue([{ name: 'main' }, { name: 'dev' }]);
      const res = await fetch(
        `${serverUrl}/api/v1/github/repos/acme/widgets/branches?workspaceId=ws1`,
        { headers: authHeaders }
      );
      const body = await res.json();
      expect(body.data).toEqual([{ name: 'main' }, { name: 'dev' }]);
      expect(spy).toHaveBeenCalledWith(
        'ws1',
        'acme',
        'widgets',
        expect.any(Object)
      );
    });
  });
});
