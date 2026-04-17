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
      fake = installFakeEnvironment({
        outputs: {
          'git rev-parse --verify': 'not-exists\n',
        },
      });

      const branch = await gitService.createTaskBranch(
        'env1',
        'abcdef1234',
        'Fix the login bug with tokens!',
        '/repo'
      );

      expect(branch).toBe('fastowl/abcdef12-fix-the-login-bug-with-tokens');

      const commands = fake.commands.map((c) => c.command);
      // First command checks for existence
      expect(commands[0]).toContain(`git rev-parse --verify ${branch}`);
      // Second command creates a new branch
      expect(commands[1]).toBe(`git checkout -b ${branch}`);
      // All commands ran in the right cwd
      for (const c of fake.commands) {
        expect(c.cwd).toBe('/repo');
      }
    });

    it('checks out an existing branch instead of recreating it', async () => {
      fake = installFakeEnvironment({
        outputs: {
          'git rev-parse --verify': 'exists\n',
        },
      });

      const branch = await gitService.createTaskBranch('env1', 'abcdef1234', 'same task', '/repo');

      const commands = fake.commands.map((c) => c.command);
      expect(commands).toEqual([
        `git rev-parse --verify ${branch} 2>/dev/null && echo "exists" || echo "not-exists"`,
        `git checkout ${branch}`,
      ]);
    });

    it('slugs the task title safely (lowercase, ascii, max 30 chars)', async () => {
      fake = installFakeEnvironment({
        outputs: { 'git rev-parse --verify': 'not-exists\n' },
      });

      const branch = await gitService.createTaskBranch(
        'env1',
        'aaaaaaaaXX',
        '  Whitespace AND symbols $%^ !! very-long title that keeps going forever  ',
        '/repo'
      );

      // Leading hyphens from "$%^ !!" leading group are trimmed; length ≤ 30 after slug
      const slug = branch.replace(/^fastowl\/aaaaaaaa-/, '');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug.length).toBeLessThanOrEqual(30);
      expect(slug).not.toMatch(/^-/);
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
          // no match for `git diff HEAD` → empty uncommitted
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
