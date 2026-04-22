import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveTaskGitContext } from '../services/gitContext.js';
import { pickGenerationEnv, runClaudeCli } from '../services/claudeCli.js';
import { prefetchCommitMessage } from '../services/commitMessagePrefetch.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../db/schema.js';
import { daemonRegistry } from '../services/daemonRegistry.js';
import { environmentService } from '../services/environment.js';
import { gitService } from '../services/git.js';
import * as ai from '../services/ai.js';
import { eq } from 'drizzle-orm';

describe('services/gitContext — resolveTaskGitContext', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {},
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('returns null when the task has no repositoryId', async () => {
    const ctx = await resolveTaskGitContext(
      { repositoryId: undefined, assignedEnvironmentId: 'env1' },
      'env1'
    );
    expect(ctx).toBeNull();
  });

  it('returns null when the repo has no localPath configured', async () => {
    await db.insert(repositoriesTable).values({
      id: 'r1', workspaceId: 'ws1', name: 'a/b',
      url: 'https://github.com/a/b', defaultBranch: 'main', localPath: null,
    });
    const ctx = await resolveTaskGitContext(
      { repositoryId: 'r1', assignedEnvironmentId: 'env1' },
      'env1'
    );
    expect(ctx).toBeNull();
  });

  it('returns working directory + default branch from the repo row', async () => {
    await db.insert(repositoriesTable).values({
      id: 'r1', workspaceId: 'ws1', name: 'a/b',
      url: 'https://github.com/a/b', defaultBranch: 'trunk', localPath: '/tmp/b',
    });
    const ctx = await resolveTaskGitContext(
      { repositoryId: 'r1', assignedEnvironmentId: 'env1' },
      'env1'
    );
    expect(ctx).toEqual({ workingDirectory: '/tmp/b', baseBranch: 'trunk' });
  });

  it('defaults baseBranch to "main" when the repo row leaves it blank', async () => {
    await db.insert(repositoriesTable).values({
      id: 'r1', workspaceId: 'ws1', name: 'a/b',
      url: 'https://github.com/a/b', defaultBranch: '', localPath: '/tmp/b',
    });
    const ctx = await resolveTaskGitContext(
      { repositoryId: 'r1', assignedEnvironmentId: 'env1' },
      'env1'
    );
    expect(ctx?.baseBranch).toBe('main');
  });
});

describe('services/claudeCli — pickGenerationEnv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the preferred env when it is connected', () => {
    vi.spyOn(daemonRegistry, 'isConnected').mockImplementation(
      (id) => id === 'env-pref'
    );
    vi.spyOn(daemonRegistry, 'listConnected').mockReturnValue(['env-pref', 'env-other']);
    expect(pickGenerationEnv('env-pref')).toBe('env-pref');
  });

  it('falls back to the first connected env when the preferred is not connected', () => {
    vi.spyOn(daemonRegistry, 'isConnected').mockReturnValue(false);
    vi.spyOn(daemonRegistry, 'listConnected').mockReturnValue(['env-A', 'env-B']);
    expect(pickGenerationEnv('env-pref')).toBe('env-A');
  });

  it('returns null when nothing is connected', () => {
    vi.spyOn(daemonRegistry, 'isConnected').mockReturnValue(false);
    vi.spyOn(daemonRegistry, 'listConnected').mockReturnValue([]);
    expect(pickGenerationEnv('env-pref')).toBeNull();
    expect(pickGenerationEnv()).toBeNull();
  });
});

describe('services/claudeCli — runClaudeCli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls environmentService.run with claude --print and the right argv', async () => {
    const run = vi.spyOn(environmentService, 'run').mockResolvedValue({
      stdout: 'generated title\n',
      stderr: '',
      code: 0,
    });
    const out = await runClaudeCli('env-1', 'prompt body');
    expect(out).toBe('generated title');
    expect(run).toHaveBeenCalledWith('env-1', 'claude', [
      '--print',
      '--model',
      'claude-haiku-4-5',
      'prompt body',
    ]);
  });

  it('throws with stderr/stdout context on non-zero exit', async () => {
    vi.spyOn(environmentService, 'run').mockResolvedValue({
      stdout: '',
      stderr: 'claude: command not found',
      code: 127,
    });
    await expect(runClaudeCli('env-1', 'p')).rejects.toThrow(/127.*command not found/);
  });

  it('trims trailing whitespace in the returned output', async () => {
    vi.spyOn(environmentService, 'run').mockResolvedValue({
      stdout: '   hi there\n\n',
      stderr: '',
      code: 0,
    });
    expect(await runClaudeCli('env-1', 'p')).toBe('hi there');
  });
});

describe('services/commitMessagePrefetch — prefetchCommitMessage', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {},
    });
    await db.insert(environmentsTable).values({
      id: 'env1', ownerId: TEST_USER_ID, name: 'e', type: 'local',
      status: 'connected', config: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1', workspaceId: 'ws1', name: 'a/b',
      url: 'https://github.com/a/b', localPath: '/tmp/b', defaultBranch: 'main',
    });
    vi.spyOn(gitService, 'getDiff').mockResolvedValue('+added\n-removed\n');
    vi.spyOn(gitService, 'getDiffStat').mockResolvedValue('1 file changed');
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function insertTask(
    overrides: Partial<{
      branch: string | null;
      assignedEnvironmentId: string | null;
      repositoryId: string | null;
    }>
  ): Promise<string> {
    const id = 't-prefetch';
    const now = new Date();
    await db.insert(tasksTable).values({
      id,
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'awaiting_review',
      priority: 'medium',
      title: 'Add login',
      description: 'd',
      prompt: 'add login',
      branch: overrides.branch === undefined ? 'fastowl/abc' : overrides.branch,
      assignedEnvironmentId:
        overrides.assignedEnvironmentId === undefined ? 'env1' : overrides.assignedEnvironmentId,
      repositoryId: overrides.repositoryId === undefined ? 'repo1' : overrides.repositoryId,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function readMeta(taskId: string): Promise<Record<string, unknown>> {
    const rows = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    return (rows[0]?.metadata as Record<string, unknown>) ?? {};
  }

  it('no-ops when the task has no branch', async () => {
    const id = await insertTask({ branch: null });
    const gen = vi.spyOn(ai, 'generateCommitMessage');

    await prefetchCommitMessage(id);

    expect(gen).not.toHaveBeenCalled();
    expect(await readMeta(id)).not.toHaveProperty('proposedCommitMessage');
  });

  it('no-ops when the task has no assignedEnvironmentId', async () => {
    const id = await insertTask({ assignedEnvironmentId: null });
    const gen = vi.spyOn(ai, 'generateCommitMessage');

    await prefetchCommitMessage(id);

    expect(gen).not.toHaveBeenCalled();
  });

  it('no-ops when the repo has no localPath', async () => {
    await db
      .update(repositoriesTable)
      .set({ localPath: null })
      .where(eq(repositoriesTable.id, 'repo1'));

    const id = await insertTask({});
    const gen = vi.spyOn(ai, 'generateCommitMessage');

    await prefetchCommitMessage(id);

    expect(gen).not.toHaveBeenCalled();
  });

  it('writes metadata.proposedCommitMessage on success', async () => {
    const id = await insertTask({});
    vi.spyOn(ai, 'generateCommitMessage').mockResolvedValue(
      'feat(auth): add login endpoint\n\nWires the GitHub OAuth callback.'
    );

    await prefetchCommitMessage(id);

    const meta = await readMeta(id);
    expect(meta.proposedCommitMessage).toBe(
      'feat(auth): add login endpoint\n\nWires the GitHub OAuth callback.'
    );
  });

  it('swallows unexpected errors rather than throwing', async () => {
    const id = await insertTask({});
    vi.spyOn(ai, 'generateCommitMessage').mockRejectedValue(new Error('ai exploded'));

    await expect(prefetchCommitMessage(id)).resolves.toBeUndefined();
    // No metadata written on failure.
    expect(await readMeta(id)).not.toHaveProperty('proposedCommitMessage');
  });
});
