import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { repositoryRoutes } from '../../routes/repositories.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
} from '../../db/schema.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/repositories', requireAuth, repositoryRoutes());
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

describe('routes/repositories', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
  });

  describe('GET /repositories', () => {
    it('requires a workspaceId query param', async () => {
      const res = await fetch(`${serverUrl}/repositories`, { headers: authHeaders });
      expect(res.status).toBe(400);
    });

    it('lists repos owned via the caller workspace', async () => {
      await db.insert(repositoriesTable).values([
        {
          id: 'r1',
          workspaceId: 'ws1',
          name: 'acme/a',
          url: 'https://github.com/acme/a',
          defaultBranch: 'main',
        },
        {
          id: 'r2',
          workspaceId: 'ws1',
          name: 'acme/b',
          url: 'https://github.com/acme/b',
          defaultBranch: 'main',
        },
      ]);
      const res = await fetch(`${serverUrl}/repositories?workspaceId=ws1`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      const ids = (body.data as Array<{ id: string }>).map((r) => r.id).sort();
      expect(ids).toEqual(['r1', 'r2']);
    });

    it('404s when the workspace is not owned by the caller', async () => {
      const res = await fetch(`${serverUrl}/repositories?workspaceId=ws2`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });

    it('skips repos whose url is not a recognisable github URL', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r3',
        workspaceId: 'ws1',
        name: 'weird',
        url: 'not-a-github-url',
        defaultBranch: 'main',
      });
      const res = await fetch(`${serverUrl}/repositories?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data).toEqual([]); // filtered out by the github regex
    });
  });

  describe('POST /repositories', () => {
    it('adds a repo and defaults the url when not provided', async () => {
      const res = await fetch(`${serverUrl}/repositories`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws1',
          owner: 'acme',
          repo: 'widgets',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.owner).toBe('acme');
      expect(body.data.repo).toBe('widgets');
      expect(body.data.fullName).toBe('acme/widgets');

      const rows = await db.select().from(repositoriesTable);
      expect(rows).toHaveLength(1);
      expect(rows[0].url).toBe('https://github.com/acme/widgets');
    });

    it('rejects when workspaceId / owner / repo is missing', async () => {
      const res = await fetch(`${serverUrl}/repositories`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1', owner: 'acme' }),
      });
      expect(res.status).toBe(400);
    });

    it('404s when the workspace is not owned', async () => {
      const res = await fetch(`${serverUrl}/repositories`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws2',
          owner: 'acme',
          repo: 'widgets',
        }),
      });
      expect(res.status).toBe(404);
    });

    it('normalises traversal segments in an otherwise-valid absolute path', async () => {
      // path.normalize resolves `/a/b/../c` to `/a/c` before the
      // traversal-residue check, so the validator accepts it and the
      // stored value is the normalised form. The residue check only
      // catches paths that still contain `..` after normalize (which
      // requires a relative path, already rejected by isAbsolute).
      const res = await fetch(`${serverUrl}/repositories`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws1',
          owner: 'acme',
          repo: 'widgets',
          localPath: '/Users/me/code/../safe',
        }),
      });
      expect(res.status).toBe(200);
      const rows = await db.select().from(repositoriesTable);
      // The route normalises via path.normalize() — OS-specific
      // (forward slashes on POSIX, backslashes on Windows). Match the
      // same normalisation in the expected value.
      expect(rows[0].localPath).toBe(path.normalize('/Users/me/safe'));
    });

    it('rejects a relative localPath', async () => {
      const res = await fetch(`${serverUrl}/repositories`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws1',
          owner: 'acme',
          repo: 'widgets',
          localPath: 'not/absolute',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/absolute/i);
    });

    it('rejects a localPath starting with "-" (shell flag injection guard)', async () => {
      const res = await fetch(`${serverUrl}/repositories`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws1',
          owner: 'acme',
          repo: 'widgets',
          localPath: '--evil',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a localPath with control characters', async () => {
      const res = await fetch(`${serverUrl}/repositories`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws1',
          owner: 'acme',
          repo: 'widgets',
          localPath: '/tmp/\n/evil',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('accepts and stores a valid localPath', async () => {
      const res = await fetch(`${serverUrl}/repositories`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws1',
          owner: 'acme',
          repo: 'widgets',
          localPath: '/Users/me/code/widgets',
        }),
      });
      expect(res.status).toBe(200);
      const rows = await db.select().from(repositoriesTable);
      expect(rows[0].localPath).toBe(path.normalize('/Users/me/code/widgets'));
    });
  });

  describe('PATCH /repositories/:id', () => {
    it('clears localPath when passed an empty string', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r1',
        workspaceId: 'ws1',
        name: 'acme/a',
        url: 'https://github.com/acme/a',
        localPath: '/prev',
        defaultBranch: 'main',
      });
      const res = await fetch(`${serverUrl}/repositories/r1`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ localPath: '' }),
      });
      expect(res.status).toBe(200);
      const rows = await db
        .select({ localPath: repositoriesTable.localPath })
        .from(repositoriesTable)
        .where(eq(repositoriesTable.id, 'r1'));
      expect(rows[0].localPath).toBeNull();
    });

    it('accepts a valid absolute path update', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r1',
        workspaceId: 'ws1',
        name: 'acme/a',
        url: 'https://github.com/acme/a',
        defaultBranch: 'main',
      });
      const res = await fetch(`${serverUrl}/repositories/r1`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ localPath: '/Users/me/code/a' }),
      });
      expect(res.status).toBe(200);
      const rows = await db
        .select({ localPath: repositoriesTable.localPath })
        .from(repositoriesTable)
        .where(eq(repositoriesTable.id, 'r1'));
      expect(rows[0].localPath).toBe(path.normalize('/Users/me/code/a'));
    });

    it('rejects an invalid localPath on update', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r1',
        workspaceId: 'ws1',
        name: 'acme/a',
        url: 'https://github.com/acme/a',
        defaultBranch: 'main',
      });
      const res = await fetch(`${serverUrl}/repositories/r1`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ localPath: 'still/relative' }),
      });
      expect(res.status).toBe(400);
    });

    it('404s when the repo belongs to another workspace', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r1',
        workspaceId: 'ws2',
        name: 'foo',
        url: 'https://github.com/foo/bar',
        defaultBranch: 'main',
      });
      const res = await fetch(`${serverUrl}/repositories/r1`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ localPath: '/safe' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /repositories/:id', () => {
    it('removes an owned repo', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r1',
        workspaceId: 'ws1',
        name: 'acme/a',
        url: 'https://github.com/acme/a',
        defaultBranch: 'main',
      });
      const res = await fetch(`${serverUrl}/repositories/r1`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const rows = await db.select().from(repositoriesTable);
      expect(rows).toHaveLength(0);
    });

    it('404s when the repo belongs to another workspace', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r1',
        workspaceId: 'ws2',
        name: 'a',
        url: 'https://github.com/a/b',
        defaultBranch: 'main',
      });
      const res = await fetch(`${serverUrl}/repositories/r1`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
      const rows = await db.select().from(repositoriesTable);
      expect(rows).toHaveLength(1);
    });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`${serverUrl}/repositories?workspaceId=ws1`);
    expect(res.status).toBe(401);
  });
});
