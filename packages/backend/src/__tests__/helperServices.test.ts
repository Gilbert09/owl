import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveTaskGitContext } from '../services/gitContext.js';
import { pickGenerationEnv, runClaudeCli } from '../services/claudeCli.js';
import { autoCommitAndSnapshot } from '../services/taskCommitSnapshot.js';
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
import { drainTaskMetadata } from '../services/taskMetadataMutex.js';
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

describe('services/taskCommitSnapshot — autoCommitAndSnapshot', () => {
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
    vi.spyOn(gitService, 'getCurrentBranch').mockResolvedValue('fastowl/abc');
    vi.spyOn(gitService, 'checkoutBranch').mockResolvedValue();
    vi.spyOn(gitService, 'getDiff').mockResolvedValue('+added\n-removed\n');
    vi.spyOn(gitService, 'getDiffStat').mockResolvedValue('1 file changed');
    vi.spyOn(gitService, 'getChangedFiles').mockResolvedValue([]);
    vi.spyOn(gitService, 'getFileDiff').mockResolvedValue('');
    // Default to "everything's clean and well-behaved". Individual
    // tests override these to drive the verifier into its failure
    // modes (dirty-after-commit, no-changes-no-commits, wrong-branch).
    vi.spyOn(gitService, 'getPorcelainStatus').mockResolvedValue('');
    vi.spyOn(gitService, 'commitsAhead').mockResolvedValue(1);
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
    const id = 't-autocommit';
    const now = new Date();
    await db.insert(tasksTable).values({
      id,
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'in_progress',
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

  it('returns no-branch (advanceOk=false) without calling git when the task has no branch', async () => {
    const id = await insertTask({ branch: null });
    const commit = vi.spyOn(gitService, 'commitAll');

    const result = await autoCommitAndSnapshot(id);

    expect(result).toMatchObject({
      committed: false,
      reason: 'no-branch',
      advanceOk: false,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('returns no-env (advanceOk=false) when the task has no assignedEnvironmentId', async () => {
    const id = await insertTask({ assignedEnvironmentId: null });
    const result = await autoCommitAndSnapshot(id);
    expect(result).toMatchObject({
      committed: false,
      reason: 'no-env',
      advanceOk: false,
    });
  });

  it('returns no-repo (advanceOk=false) when the repo has no localPath', async () => {
    await db
      .update(repositoriesTable)
      .set({ localPath: null })
      .where(eq(repositoriesTable.id, 'repo1'));
    const id = await insertTask({});
    const result = await autoCommitAndSnapshot(id);
    expect(result).toMatchObject({
      committed: false,
      reason: 'no-repo',
      advanceOk: false,
    });
  });

  it('returns no-changes-prior-commits (advanceOk=true) when nothing staged but branch already has commits', async () => {
    const id = await insertTask({});
    vi.spyOn(ai, 'generateCommitMessage').mockResolvedValue('feat: nothing');
    vi.spyOn(gitService, 'commitAll').mockResolvedValue(null);
    vi.mocked(gitService.commitsAhead).mockResolvedValue(2);

    const result = await autoCommitAndSnapshot(id);

    expect(result).toMatchObject({
      committed: false,
      reason: 'no-changes-prior-commits',
      advanceOk: true,
    });
    // The agent committed its own work; finalFiles still gets a fresh
    // snapshot so the Files tab populates.
    expect(await readMeta(id)).toHaveProperty('finalFiles');
  });

  it('returns no-changes-no-commits (advanceOk=false) when nothing was staged AND branch has no new commits', async () => {
    const id = await insertTask({});
    vi.spyOn(ai, 'generateCommitMessage').mockResolvedValue('feat: nothing');
    vi.spyOn(gitService, 'commitAll').mockResolvedValue(null);
    vi.mocked(gitService.commitsAhead).mockResolvedValue(0);

    const result = await autoCommitAndSnapshot(id);

    expect(result).toMatchObject({
      committed: false,
      reason: 'no-changes-no-commits',
      advanceOk: false,
    });
    expect(await readMeta(id)).not.toHaveProperty('finalFiles');
  });

  it('returns dirty-after-commit (advanceOk=false) when working tree is still dirty after the commit attempt', async () => {
    const id = await insertTask({});
    vi.spyOn(ai, 'generateCommitMessage').mockResolvedValue('feat: x');
    vi.spyOn(gitService, 'commitAll').mockResolvedValue('newSha1234');
    // Pre-commit clean, post-commit dirty — the symptom we keep hitting.
    vi.mocked(gitService.getPorcelainStatus)
      .mockResolvedValueOnce('') // pre-commit
      .mockResolvedValueOnce(' M apps/desktop/src/foo.tsx\n?? new.txt\n'); // post-commit

    const result = await autoCommitAndSnapshot(id);

    expect(result).toMatchObject({
      committed: false,
      reason: 'dirty-after-commit',
      advanceOk: false,
    });
    if (result.committed === false) {
      expect(result.porcelain).toContain('foo.tsx');
    }
    const meta = await readMeta(id);
    expect((meta.autoCommit as { reason: string }).reason).toBe('dirty-after-commit');
  });

  it('returns wrong-branch (advanceOk=false) when checkout to the task branch fails', async () => {
    const id = await insertTask({});
    // Agent left HEAD on main; the checkout to fastowl/abc throws.
    vi.mocked(gitService.getCurrentBranch).mockResolvedValueOnce('main');
    vi.mocked(gitService.checkoutBranch).mockRejectedValue(
      new Error('local changes would be overwritten')
    );

    const result = await autoCommitAndSnapshot(id);

    expect(result).toMatchObject({
      committed: false,
      reason: 'wrong-branch',
      advanceOk: false,
    });
  });

  it('commits + snapshots finalFiles on success (advanceOk=true)', async () => {
    const id = await insertTask({});
    vi.spyOn(ai, 'generateCommitMessage').mockResolvedValue('feat(auth): add login endpoint');
    vi.spyOn(gitService, 'commitAll').mockResolvedValue('sha123456789');
    vi.spyOn(gitService, 'getChangedFiles').mockResolvedValue([
      { path: 'src/login.ts', status: 'added', added: 42, removed: 0, binary: false },
    ]);
    vi.spyOn(gitService, 'getFileDiff').mockResolvedValue('+ added login\n');

    const result = await autoCommitAndSnapshot(id);

    expect(result).toMatchObject({
      committed: true,
      sha: 'sha123456789',
      message: 'feat(auth): add login endpoint',
      advanceOk: true,
    });
    const meta = await readMeta(id);
    const finalFiles = meta.finalFiles as Array<{ path: string; diff: string }>;
    expect(finalFiles).toHaveLength(1);
    expect(finalFiles[0]).toMatchObject({ path: 'src/login.ts', diff: '+ added login\n' });
    // autoCommit status persists through the per-task mutex even with
    // gitLog appends racing in the background.
    expect(meta.autoCommit).toMatchObject({
      committed: true,
      sha: 'sha123456789',
      advanceOk: true,
    });
  });

  it('snapshots cumulatively on re-run (overwrites finalFiles)', async () => {
    const id = await insertTask({});
    vi.spyOn(ai, 'generateCommitMessage').mockResolvedValue('feat: round 1');
    vi.spyOn(gitService, 'commitAll')
      .mockResolvedValueOnce('shaA')
      .mockResolvedValueOnce('shaB');
    const changedFiles = vi.spyOn(gitService, 'getChangedFiles');
    changedFiles.mockResolvedValueOnce([
      { path: 'a.ts', status: 'added', added: 1, removed: 0, binary: false },
    ]);
    changedFiles.mockResolvedValueOnce([
      { path: 'a.ts', status: 'added', added: 1, removed: 0, binary: false },
      { path: 'b.ts', status: 'added', added: 2, removed: 0, binary: false },
    ]);
    vi.spyOn(gitService, 'getFileDiff').mockResolvedValue('+diff');

    await autoCommitAndSnapshot(id);
    await autoCommitAndSnapshot(id);

    const meta = await readMeta(id);
    const finalFiles = meta.finalFiles as Array<{ path: string }>;
    expect(finalFiles.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('returns error (advanceOk=false, non-throwing) when an unexpected git call rejects', async () => {
    const id = await insertTask({});
    vi.spyOn(ai, 'generateCommitMessage').mockResolvedValue('feat: x');
    vi.spyOn(gitService, 'commitAll').mockRejectedValue(new Error('daemon dead'));

    const result = await autoCommitAndSnapshot(id);

    expect(result.committed).toBe(false);
    if (result.committed === false) {
      expect(result.reason).toBe('error');
      expect(result.error).toContain('daemon dead');
      expect(result.advanceOk).toBe(false);
    }
  });

  it('persists every git command + the autoCommit + finalFiles fields after a full end-to-end run (regression: gitLog losing entries on restart)', async () => {
    // The user-reported symptom: "open a completed task after a
    // restart, the `git commit` entry is missing from metadata.gitLog."
    //
    // The other autoCommit tests stub `gitService` methods directly,
    // so the fire-and-forget `void recordGitCommand(...)` inside
    // `gitService.runGit` never fires — they validate the result type
    // but can't reproduce the race.
    //
    // This test pokes one layer down: stub `environmentService.run`
    // (the real RPC surface) and let the real `gitService` code run.
    // Every git op flows through `runGit`, which fires the same
    // `void recordGitCommand` calls production hits, racing against
    // `writeFinalFilesSnapshot` and `persistAutoCommitStatus`. With
    // the per-task mutex they all serialize; without it, the
    // commit-step entry vanishes. Asserts the gitLog contains every
    // expected command in order, AND that autoCommit + finalFiles
    // both made it through unscathed.
    const id = await insertTask({});
    vi.restoreAllMocks();
    // Re-seed the AI mock that the outer suite installed.
    vi.spyOn(ai, 'generateCommitMessage').mockResolvedValue('fix: real-run commit');

    // Drive the real `runGit` via a programmatic environmentService.run
    // stub. Every git command exits 0 except the staged-check (which
    // exits 1, signalling "there are staged changes" so commitAll
    // proceeds to actually commit).
    vi.spyOn(environmentService, 'run').mockImplementation(
      async (_envId, binary, args) => {
        const command = `${binary} ${args.join(' ')}`;
        if (command.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: 'fastowl/abc\n', stderr: '', code: 0 };
        }
        if (command.includes('rev-parse HEAD')) {
          return { stdout: 'newSha1234567890abcdef\n', stderr: '', code: 0 };
        }
        if (command.includes('status --porcelain')) {
          return { stdout: '', stderr: '', code: 0 };
        }
        if (command.includes('diff --cached --quiet')) {
          // Exit 1 = there ARE staged changes; commitAll proceeds.
          return { stdout: '', stderr: '', code: 1 };
        }
        if (command.startsWith('git diff -M --name-status')) {
          return { stdout: 'A\tsrc/a.ts\n', stderr: '', code: 0 };
        }
        if (command.startsWith('git diff -M --numstat')) {
          return { stdout: '5\t0\tsrc/a.ts\n', stderr: '', code: 0 };
        }
        if (command.startsWith('git ls-files --others')) {
          return { stdout: '', stderr: '', code: 0 };
        }
        if (command.startsWith('git rev-list --count')) {
          return { stdout: '1\n', stderr: '', code: 0 };
        }
        // Default: success with empty stdout (covers add, commit, diff,
        // diff-stat, file-diff, etc).
        return { stdout: '', stderr: '', code: 0 };
      }
    );

    const result = await autoCommitAndSnapshot(id);
    expect(result).toMatchObject({
      committed: true,
      sha: 'newSha1234567890abcdef',
      advanceOk: true,
    });

    // Drain the chain — `void recordGitCommand` calls don't block
    // runGit, so a few may still be in flight when autoCommit returns.
    await drainTaskMetadata(id);

    const meta = await readMeta(id);

    // The `git commit -F -` entry MUST be in the persisted log. This
    // is the user's specific complaint — pre-mutex, this entry was
    // exactly the kind that got eaten by writeFinalFilesSnapshot's
    // stale-metadata UPDATE.
    const log = (meta.gitLog as Array<{ command: string }> | undefined) ?? [];
    const commands = log.map((e) => e.command);
    expect(commands).toContain('git rev-parse --abbrev-ref HEAD');
    expect(commands).toContain('git status --porcelain');
    expect(commands).toContain('git add -A');
    expect(commands).toContain('git diff --cached --quiet');
    // `git commit -F -` is rewritten to `git commit -m "<subject>"`
    // by `formatLoggedCommand` so the audit shows the actual message.
    expect(
      commands.some((c) => c.startsWith('git commit -m'))
    ).toBe(true);
    expect(commands).toContain('git rev-parse HEAD');
    // Snapshot diffs from writeFinalFilesSnapshot also land in the log.
    expect(commands.some((c) => c.startsWith('git diff -M --name-status'))).toBe(true);
    expect(commands.some((c) => c.startsWith('git diff -M --numstat'))).toBe(true);

    // And the metadata patches that race against gitLog appends — both
    // survive end-to-end through the same chain.
    expect(meta.autoCommit).toMatchObject({
      committed: true,
      sha: 'newSha1234567890abcdef',
      advanceOk: true,
    });
    expect(Array.isArray(meta.finalFiles)).toBe(true);
  });
});
