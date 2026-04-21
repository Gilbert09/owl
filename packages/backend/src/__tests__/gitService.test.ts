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
});
