import { describe, it, expect, afterEach } from 'vitest';
import { gitService } from '../services/git.js';
import { installFakeEnvironment, type FakeEnvironmentHandle } from './helpers/fakeEnvironment.js';

describe('gitService', () => {
  let fake: FakeEnvironmentHandle | null = null;

  afterEach(() => {
    fake?.restore();
    fake = null;
  });

  describe('createTaskBranch', () => {
    it('creates a new branch when it does not already exist', async () => {
      // rev-parse --verify on a missing branch → non-zero exit. Every
      // other command defaults to success.
      fake = installFakeEnvironment({
        exitCodes: { 'git rev-parse --verify': 1 },
      });

      const branch = await gitService.createTaskBranch(
        'env1',
        'abcdef1234',
        'Fix the login bug with tokens!',
        '/repo'
      );

      expect(branch).toBe('fastowl/abcdef12-fix-the-login-bug-with-tokens');

      const commands = fake.commands.map((c) => c.command);
      // First command checks for existence, second creates the branch.
      expect(commands[0]).toBe(`git rev-parse --verify ${branch}`);
      expect(commands[1]).toBe(`git checkout -b ${branch}`);
      for (const c of fake.commands) {
        expect(c.cwd).toBe('/repo');
      }
    });

    it('checks out an existing branch instead of recreating it', async () => {
      // rev-parse --verify succeeds → branch exists → checkout (no -b).
      fake = installFakeEnvironment({ exitCode: 0 });

      const branch = await gitService.createTaskBranch('env1', 'abcdef1234', 'same task', '/repo');

      const commands = fake.commands.map((c) => c.command);
      expect(commands).toEqual([
        `git rev-parse --verify ${branch}`,
        `git checkout ${branch}`,
      ]);
    });

    it('slugs the task title safely (lowercase, ascii, max 30 chars)', async () => {
      fake = installFakeEnvironment({
        exitCodes: { 'git rev-parse --verify': 1 },
      });

      const branch = await gitService.createTaskBranch(
        'env1',
        'aaaaaaaaXX',
        '  Whitespace AND symbols $%^ !! very-long title that keeps going forever  ',
        '/repo'
      );

      const slug = branch.replace(/^fastowl\/aaaaaaaa-/, '');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug.length).toBeLessThanOrEqual(30);
      expect(slug).not.toMatch(/^-/);
    });
  });

  describe('prepareTaskBranch', () => {
    it('fetches, fast-forwards the base, then creates the task branch off it', async () => {
      // Fake always returns exit 0; the git status stdout is empty by
      // default so `hasUncommittedChanges` reports false. rev-parse --
      // verify returns 0 which means "branch exists" — we take the
      // checkout path. That's fine for this test since we only care
      // about the order of fetch/checkout/pull commands.
      fake = installFakeEnvironment({ exitCode: 0 });

      const branch = await gitService.prepareTaskBranch({
        environmentId: 'env1',
        taskId: 'abcdef1234',
        taskTitle: 'Add login',
        workingDirectory: '/repo',
        baseBranch: 'main',
      });

      expect(branch).toBe('fastowl/abcdef12-add-login');

      const commands = fake.commands.map((c) => c.command);
      const fetchIdx = commands.findIndex((c) => c === 'git fetch origin main');
      const checkoutBaseIdx = commands.findIndex((c) => c === 'git checkout main');
      const pullIdx = commands.findIndex((c) => c === 'git pull --ff-only origin main');

      expect(fetchIdx).toBeGreaterThanOrEqual(0);
      expect(checkoutBaseIdx).toBeGreaterThan(fetchIdx);
      expect(pullIdx).toBeGreaterThan(checkoutBaseIdx);
    });

    it('refuses to prepare when the working tree is dirty', async () => {
      fake = installFakeEnvironment({
        outputs: {
          'git status --porcelain': ' M src/foo.ts\n',
        },
      });

      await expect(
        gitService.prepareTaskBranch({
          environmentId: 'env1',
          taskId: 'abcdef1234',
          taskTitle: 'Add login',
          workingDirectory: '/repo',
          baseBranch: 'main',
        })
      ).rejects.toThrow(/uncommitted changes/i);

      const commands = fake.commands.map((c) => c.command);
      expect(commands.some((c) => c.startsWith('git fetch'))).toBe(false);
      expect(commands.some((c) => c.startsWith('git checkout'))).toBe(false);
    });
  });

  describe('getDiff', () => {
    it('runs both committed and uncommitted diff commands and concatenates when both present', async () => {
      fake = installFakeEnvironment({
        outputs: {
          'git diff main...feature': '+added line\n',
          'git diff HEAD': '+uncommitted change\n',
        },
      });

      const diff = await gitService.getDiff('env1', 'feature', 'main', '/repo');

      expect(diff).toContain('+added line');
      expect(diff).toContain('--- Uncommitted changes ---');
      expect(diff).toContain('+uncommitted change');

      const commands = fake.commands.map((c) => c.command);
      expect(commands.some((c) => c.startsWith('git diff main...feature'))).toBe(true);
      expect(commands.some((c) => c.startsWith('git diff HEAD'))).toBe(true);
    });

    it('returns only the committed diff when there are no uncommitted changes', async () => {
      fake = installFakeEnvironment({
        outputs: {
          'git diff main...feature': '+committed only\n',
        },
      });

      const diff = await gitService.getDiff('env1', 'feature', 'main', '/repo');
      expect(diff).toBe('+committed only\n');
      expect(diff).not.toContain('--- Uncommitted changes ---');
    });
  });

  describe('getChangedFiles', () => {
    it('uses working-tree comparison (git diff <base>) when no branch is passed', async () => {
      fake = installFakeEnvironment({
        outputs: {
          'git diff -M --name-status main': 'M\tsrc/a.ts\n',
          'git diff -M --numstat main': '3\t1\tsrc/a.ts\n',
          'git ls-files --others --exclude-standard': 'scratch.txt\n',
        },
      });

      const files = await gitService.getChangedFiles('env1', 'main', '/repo');

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.path)).toEqual(['scratch.txt', 'src/a.ts']);
      const commands = fake.commands.map((c) => c.command);
      expect(commands).toContain('git diff -M --name-status main');
      expect(commands).toContain('git ls-files --others --exclude-standard');
    });

    it('uses commit-range comparison when a branch is passed, skipping untracked scan', async () => {
      fake = installFakeEnvironment({
        outputs: {
          'git diff -M --name-status main...feature': 'A\tsrc/b.ts\n',
          'git diff -M --numstat main...feature': '10\t0\tsrc/b.ts\n',
        },
      });

      const files = await gitService.getChangedFiles('env1', 'main', '/repo', 'feature');

      expect(files).toEqual([
        { path: 'src/b.ts', status: 'added', added: 10, removed: 0, binary: false },
      ]);
      const commands = fake.commands.map((c) => c.command);
      expect(commands).toContain('git diff -M --name-status main...feature');
      // Untracked scan is intentionally skipped in commit-range mode —
      // untracked files aren't part of the committed task range.
      expect(commands.some((c) => c.startsWith('git ls-files'))).toBe(false);
    });
  });

  describe('getFileDiff', () => {
    it('uses working-tree comparison when no branch is passed', async () => {
      fake = installFakeEnvironment({
        outputs: { 'git diff main -- src/a.ts': '@@ -1 +1 @@\n-old\n+new\n' },
      });
      const diff = await gitService.getFileDiff('env1', 'main', 'src/a.ts', '/repo');
      expect(diff).toContain('+new');
      expect(fake.commands.some((c) => c.command === 'git diff main -- src/a.ts')).toBe(true);
    });

    it('uses commit-range comparison when a branch is passed', async () => {
      fake = installFakeEnvironment({
        outputs: { 'git diff main...feature -- src/b.ts': '+committed\n' },
      });
      const diff = await gitService.getFileDiff(
        'env1',
        'main',
        'src/b.ts',
        '/repo',
        'feature'
      );
      expect(diff).toBe('+committed\n');
      expect(
        fake.commands.some((c) => c.command === 'git diff main...feature -- src/b.ts')
      ).toBe(true);
    });
  });

  describe('getCurrentBranch', () => {
    it('returns the trimmed branch name', async () => {
      fake = installFakeEnvironment({
        outputs: { 'git rev-parse --abbrev-ref HEAD': '  main\n' },
      });

      const branch = await gitService.getCurrentBranch('env1', '/repo');
      expect(branch).toBe('main');
    });
  });

  describe('hasUncommittedChanges', () => {
    it('returns true when git status --porcelain has output', async () => {
      fake = installFakeEnvironment({
        outputs: { 'git status --porcelain': ' M src/foo.ts\n' },
      });

      expect(await gitService.hasUncommittedChanges('env1', '/repo')).toBe(true);
    });

    it('returns false when working tree is clean', async () => {
      fake = installFakeEnvironment({
        outputs: { 'git status --porcelain': '' },
      });

      expect(await gitService.hasUncommittedChanges('env1', '/repo')).toBe(false);
    });
  });

  describe('commitAll', () => {
    it('returns null when there is nothing staged', async () => {
      // git add -A → staged check exits 0 (nothing staged) → return null.
      fake = installFakeEnvironment({
        exitCodes: { 'git diff --cached --quiet': 0 },
      });

      const sha = await gitService.commitAll('env1', 'msg', '/repo');
      expect(sha).toBeNull();
    });

    it('commits through stdin + returns the new HEAD sha on success', async () => {
      fake = installFakeEnvironment({
        outputs: { 'git rev-parse HEAD': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' },
        // Non-zero on the stage check → proceed to commit.
        exitCodes: { 'git diff --cached --quiet': 1 },
      });

      const sha = await gitService.commitAll('env1', 'multi\nline\n`message`', '/repo');
      expect(sha).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      const commands = fake.commands.map((c) => c.command);
      // Verify the commit command was issued (message flows via stdin).
      expect(commands).toContain('git add -A');
      expect(commands).toContain('git commit -F -');
    });
  });

  describe('pushBranch', () => {
    it('refuses to push a branch name containing shell metacharacters', async () => {
      fake = installFakeEnvironment();
      await expect(
        gitService.pushBranch('env1', 'main; rm -rf /', '/repo')
      ).rejects.toThrow(/suspicious/);
    });

    it('pushes a normal branch', async () => {
      fake = installFakeEnvironment();
      await gitService.pushBranch('env1', 'fastowl/abc-do-thing', '/repo');
      const commands = fake.commands.map((c) => c.command);
      expect(commands).toContain('git push -u origin fastowl/abc-do-thing');
    });
  });

  describe('stashToBackupRef', () => {
    it('refuses a suspicious namespace/taskId combination', async () => {
      fake = installFakeEnvironment();
      await expect(
        gitService.stashToBackupRef('env1', 'rejected', '../attack', '/repo')
      ).rejects.toThrow(/suspicious ref/);
    });

    it('stores the stash sha under refs/fastowl/<namespace>/<taskId>', async () => {
      const stashSha = 'aabbccddeeff00112233445566778899aabbccdd';
      fake = installFakeEnvironment({
        outputs: { 'git stash create': `${stashSha}\n` },
      });

      const ref = await gitService.stashToBackupRef('env1', 'rejected', 'task-abc', '/repo');
      expect(ref).toBe('refs/fastowl/rejected/task-abc');
      const commands = fake.commands.map((c) => c.command);
      expect(commands).toContain(
        `git update-ref refs/fastowl/rejected/task-abc ${stashSha}`
      );
    });

    it('falls back to backing up HEAD when the tree is clean (no stash created)', async () => {
      const headSha = '1122334455667788112233445566778811223344';
      fake = installFakeEnvironment({
        outputs: {
          'git stash create': '\n', // empty → clean tree
          'git rev-parse HEAD': `${headSha}\n`,
        },
      });

      const ref = await gitService.stashToBackupRef('env1', 'rejected', 'task-abc', '/repo');
      expect(ref).toBe('refs/fastowl/rejected/task-abc');
      const commands = fake.commands.map((c) => c.command);
      expect(commands).toContain(
        `git update-ref refs/fastowl/rejected/task-abc ${headSha}`
      );
    });
  });

  describe('resetToBase', () => {
    it('runs checkout -f → reset --hard origin/<base> → clean -fd', async () => {
      fake = installFakeEnvironment();
      await gitService.resetToBase('env1', 'main', '/repo');

      const commands = fake.commands.map((c) => c.command);
      const checkoutIdx = commands.indexOf('git checkout -f main');
      const resetIdx = commands.indexOf('git reset --hard origin/main');
      const cleanIdx = commands.indexOf('git clean -fd');
      expect(checkoutIdx).toBeGreaterThanOrEqual(0);
      expect(resetIdx).toBeGreaterThan(checkoutIdx);
      expect(cleanIdx).toBeGreaterThan(resetIdx);
    });
  });

  describe('forceDeleteBranch', () => {
    it('issues git branch -D on the branch', async () => {
      fake = installFakeEnvironment();
      await gitService.forceDeleteBranch('env1', 'fastowl/old', '/repo');
      const commands = fake.commands.map((c) => c.command);
      expect(commands).toContain('git branch -D fastowl/old');
    });
  });

  describe('deleteBranch', () => {
    it('falls back to master when main checkout fails', async () => {
      fake = installFakeEnvironment({
        // Scripted: `git checkout main` fails (exit 1), master succeeds (0).
        exitCodes: { 'git checkout main': 1 },
      });
      await gitService.deleteBranch('env1', 'fastowl/old', '/repo');
      const commands = fake.commands.map((c) => c.command);
      expect(commands).toContain("git checkout master");
      expect(commands).toContain('git branch -d fastowl/old');
    });
  });
});
