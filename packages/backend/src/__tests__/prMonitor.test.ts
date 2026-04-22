import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { prMonitorService } from '../services/prMonitor.js';
import { githubService } from '../services/github.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
} from '../db/schema.js';

describe('prMonitorService — repo CRUD', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {},
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  describe('addWatchedRepo', () => {
    it('inserts a repo with a default github url when one is not supplied', async () => {
      const watched = await prMonitorService.addWatchedRepo('ws1', 'acme', 'widgets');
      expect(watched.owner).toBe('acme');
      expect(watched.repo).toBe('widgets');
      expect(watched.fullName).toBe('acme/widgets');
      expect(watched.defaultBranch).toBe('main');

      const rows = await db.select().from(repositoriesTable);
      expect(rows).toHaveLength(1);
      expect(rows[0].url).toBe('https://github.com/acme/widgets');
      expect(rows[0].name).toBe('acme/widgets');
    });

    it('honours an explicit url + localPath', async () => {
      const watched = await prMonitorService.addWatchedRepo(
        'ws1', 'acme', 'widgets',
        'git@github.com:acme/widgets.git',
        '/Users/me/code/widgets'
      );
      expect(watched.localPath).toBe('/Users/me/code/widgets');
      const rows = await db.select().from(repositoriesTable);
      expect(rows[0].url).toBe('git@github.com:acme/widgets.git');
      expect(rows[0].localPath).toBe('/Users/me/code/widgets');
    });
  });

  describe('getWatchedRepos', () => {
    it('parses owner/repo out of the url', async () => {
      await db.insert(repositoriesTable).values([
        {
          id: 'r-https', workspaceId: 'ws1', name: 'acme/a',
          url: 'https://github.com/acme/a.git', defaultBranch: 'main',
        },
        {
          id: 'r-ssh', workspaceId: 'ws1', name: 'acme/b',
          url: 'git@github.com:acme/b', defaultBranch: 'main',
        },
      ]);

      const repos = await prMonitorService.getWatchedRepos('ws1');
      expect(repos).toHaveLength(2);
      const aByName = repos.find((r) => r.repo === 'a');
      const bByName = repos.find((r) => r.repo === 'b');
      expect(aByName?.owner).toBe('acme');
      expect(bByName?.owner).toBe('acme');
      // .git suffix stripped.
      expect(aByName?.fullName).toBe('acme/a');
    });

    it('filters out rows whose url is not a github URL', async () => {
      await db.insert(repositoriesTable).values([
        {
          id: 'r-good', workspaceId: 'ws1', name: 'acme/a',
          url: 'https://github.com/acme/a', defaultBranch: 'main',
        },
        {
          id: 'r-other', workspaceId: 'ws1', name: 'x',
          url: 'https://gitlab.com/foo/bar', defaultBranch: 'main',
        },
      ]);
      const repos = await prMonitorService.getWatchedRepos('ws1');
      expect(repos).toHaveLength(1);
      expect(repos[0].id).toBe('r-good');
    });

    it('never returns repos from other workspaces', async () => {
      await db.insert(workspacesTable).values({
        id: 'ws2', ownerId: TEST_USER_ID, name: 'other', settings: {},
      });
      await db.insert(repositoriesTable).values([
        {
          id: 'r-mine', workspaceId: 'ws1', name: 'acme/a',
          url: 'https://github.com/acme/a', defaultBranch: 'main',
        },
        {
          id: 'r-theirs', workspaceId: 'ws2', name: 'acme/b',
          url: 'https://github.com/acme/b', defaultBranch: 'main',
        },
      ]);
      const repos = await prMonitorService.getWatchedRepos('ws1');
      expect(repos.map((r) => r.id)).toEqual(['r-mine']);
    });
  });

  describe('updateWatchedRepo', () => {
    it('patches localPath and leaves other fields alone', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r1', workspaceId: 'ws1', name: 'acme/a',
        url: 'https://github.com/acme/a', localPath: '/old', defaultBranch: 'main',
      });

      await prMonitorService.updateWatchedRepo('r1', { localPath: '/new' });

      const rows = await db
        .select({
          url: repositoriesTable.url,
          localPath: repositoriesTable.localPath,
          defaultBranch: repositoriesTable.defaultBranch,
        })
        .from(repositoriesTable)
        .where(eq(repositoriesTable.id, 'r1'));
      expect(rows[0].localPath).toBe('/new');
      expect(rows[0].url).toBe('https://github.com/acme/a');
      expect(rows[0].defaultBranch).toBe('main');
    });

    it('clears localPath when passed null', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r1', workspaceId: 'ws1', name: 'a/b',
        url: 'https://github.com/a/b', localPath: '/prev', defaultBranch: 'main',
      });
      await prMonitorService.updateWatchedRepo('r1', { localPath: null });
      const rows = await db
        .select({ localPath: repositoriesTable.localPath })
        .from(repositoriesTable)
        .where(eq(repositoriesTable.id, 'r1'));
      expect(rows[0].localPath).toBeNull();
    });

    it('is a no-op when no patch fields are supplied', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r1', workspaceId: 'ws1', name: 'a/b',
        url: 'https://github.com/a/b', localPath: '/orig', defaultBranch: 'main',
      });
      await prMonitorService.updateWatchedRepo('r1', {});
      const rows = await db
        .select({ localPath: repositoriesTable.localPath })
        .from(repositoriesTable)
        .where(eq(repositoriesTable.id, 'r1'));
      expect(rows[0].localPath).toBe('/orig');
    });
  });

  describe('removeWatchedRepo', () => {
    it('deletes the row from the DB', async () => {
      await db.insert(repositoriesTable).values({
        id: 'r1', workspaceId: 'ws1', name: 'acme/a',
        url: 'https://github.com/acme/a', defaultBranch: 'main',
      });

      await prMonitorService.removeWatchedRepo('r1');

      const rows = await db.select().from(repositoriesTable);
      expect(rows).toHaveLength(0);
    });

    it('no-ops for an unknown id without throwing', async () => {
      await expect(prMonitorService.removeWatchedRepo('does-not-exist')).resolves.toBeUndefined();
    });
  });

  describe('forcePoll', () => {
    it('does nothing when no workspaces are connected to GitHub', async () => {
      vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue([]);
      await expect(prMonitorService.forcePoll()).resolves.toBeUndefined();
    });

    it('iterates connected workspaces', async () => {
      vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue(['ws1']);
      // No watched repos → the inner loop is a no-op per workspace.
      // Make every downstream API call a stub so a single call in
      // doesn't hit the network.
      vi.spyOn(githubService, 'listPullRequests').mockResolvedValue([]);
      await expect(prMonitorService.forcePoll()).resolves.toBeUndefined();
    });
  });
});
