import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  createTaskBranch,
  checkoutBranch,
  getCurrentBranch,
  hasUncommittedChanges,
  stashChanges,
  getDiff,
  deleteBranch,
  gitDispatch,
} from '../git.js';

/**
 * Spin up a fresh git repo per test. We deliberately use real git so
 * the tests exercise the same subprocess path the daemon ships in
 * production — same argv handling, same exit codes, same branch-
 * detection logic. Avoids a mock of `run` that could silently drift
 * from reality.
 */
function makeRepo(): string {
  const dir = path.join(
    os.tmpdir(),
    `fastowl-daemon-git-test-${randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  // `-b main` pins the default branch so `deleteBranch` can rely on
  // the existence of a `main` to fall back to across CI git versions.
  run(dir, 'git', ['init', '-b', 'main']);
  run(dir, 'git', ['config', 'user.email', 'test@fastowl.example']);
  run(dir, 'git', ['config', 'user.name', 'Test']);
  run(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  run(dir, 'git', ['add', '.']);
  run(dir, 'git', ['commit', '-m', 'init']);
  return dir;
}

function run(cwd: string, bin: string, args: string[]): void {
  const res = spawnSync(bin, args, { cwd, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(
      `git setup failed (${bin} ${args.join(' ')}): ${res.stderr || res.stdout}`,
    );
  }
}

let repo: string;

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
});

describe('createTaskBranch', () => {
  it('slugifies the title and returns fastowl/<id>-<slug>', async () => {
    const name = await createTaskBranch('task-42', 'Fix the Thing: (urgent!!)', repo);
    expect(name).toBe('fastowl/task-42-fix-the-thing-urgent');
    expect(await getCurrentBranch(repo)).toBe(name);
  });

  it('clamps slug to 40 chars', async () => {
    const longTitle = 'a'.repeat(100);
    const name = await createTaskBranch('t-long', longTitle, repo);
    // 'fastowl/t-long-' prefix + 40-char slug capped at 40 of 'a's
    const slug = name.split('-').slice(2).join('-');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('checks out an already-existing branch instead of re-creating', async () => {
    // First call creates the branch.
    const name = await createTaskBranch('t-1', 'Same title', repo);
    // Move back to main and dirty the working tree so a failed
    // re-create would surface. Then call again — we expect a
    // checkout of the existing branch, not an error.
    run(repo, 'git', ['checkout', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    run(repo, 'git', ['add', '.']);
    run(repo, 'git', ['commit', '-m', 'second main commit']);

    const second = await createTaskBranch('t-1', 'Same title', repo);
    expect(second).toBe(name);
    expect(await getCurrentBranch(repo)).toBe(name);
  });

  it('propagates the underlying git stderr when checkout -b fails', async () => {
    // Simulate failure: spawn inside a non-git directory. createTaskBranch's
    // first rev-parse returns code!=0 (good, means "branch doesn't exist"),
    // then checkout -b runs and fails with "not a git repository".
    const notARepo = path.join(os.tmpdir(), `fastowl-daemon-notgit-${randomBytes(3).toString('hex')}`);
    fs.mkdirSync(notARepo, { recursive: true });
    try {
      await expect(createTaskBranch('t-x', 'whatever', notARepo)).rejects.toThrow(
        /git checkout -b failed/,
      );
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('checkoutBranch + getCurrentBranch', () => {
  it('round-trips a branch name', async () => {
    run(repo, 'git', ['checkout', '-b', 'feature-x']);
    run(repo, 'git', ['checkout', 'main']);
    await checkoutBranch('feature-x', repo);
    expect(await getCurrentBranch(repo)).toBe('feature-x');
  });

  it('throws when the branch does not exist', async () => {
    await expect(checkoutBranch('does-not-exist', repo)).rejects.toThrow(
      /git checkout failed/,
    );
  });
});

describe('hasUncommittedChanges', () => {
  it('returns false on a clean tree', async () => {
    expect(await hasUncommittedChanges(repo)).toBe(false);
  });

  it('returns true when there are unstaged edits', async () => {
    fs.writeFileSync(path.join(repo, 'README.md'), '# edited\n');
    expect(await hasUncommittedChanges(repo)).toBe(true);
  });

  it('returns true for untracked files (git status -u is default)', async () => {
    fs.writeFileSync(path.join(repo, 'new-file.txt'), 'data\n');
    expect(await hasUncommittedChanges(repo)).toBe(true);
  });
});

describe('stashChanges', () => {
  it('stashes unstaged + untracked changes and cleans the tree', async () => {
    fs.writeFileSync(path.join(repo, 'README.md'), '# edited\n');
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'extra\n');
    expect(await hasUncommittedChanges(repo)).toBe(true);

    await stashChanges('wip: test stash', repo);

    expect(await hasUncommittedChanges(repo)).toBe(false);
    // The message landed as a single argv item — shell metacharacters
    // in the middle of the string can't create a second entry.
    const list = spawnSync('git', ['stash', 'list'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    expect(list.stdout).toContain('wip: test stash');
  });

  it('accepts a message containing shell metacharacters safely', async () => {
    fs.writeFileSync(path.join(repo, 'README.md'), '# edited\n');
    await stashChanges('weird "msg" $(echo pwned); rm -rf /', repo);
    const list = spawnSync('git', ['stash', 'list'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    // The metacharacters are preserved as-is in the message — proves
    // we never went through a shell.
    expect(list.stdout).toContain('$(echo pwned)');
  });

  it('throws when there are no changes to stash (exit code 1 path)', async () => {
    // A clean tree makes `git stash push` exit non-zero in some git
    // versions; in others it exits 0 with "No local changes". Skip
    // this if the host's git exits 0 — we only want to assert the
    // error-propagation path, not platform-specific behaviour.
    const probe = spawnSync('git', ['stash', 'push', '-u', '-m', 'probe'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    if (probe.status !== 0) {
      await expect(stashChanges('empty', repo)).rejects.toThrow(/git stash failed/);
    }
  });
});

describe('getDiff', () => {
  it('returns concatenated committed + uncommitted diff', async () => {
    // Commit a change on a feature branch.
    run(repo, 'git', ['checkout', '-b', 'feat']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# feat commit\n');
    run(repo, 'git', ['commit', '-am', 'feat change']);
    // Add an uncommitted edit on top.
    fs.writeFileSync(path.join(repo, 'README.md'), '# feat + uncommitted\n');

    const diff = await getDiff('feat', 'main', repo);
    // Committed part: README change vs main.
    expect(diff).toContain('feat commit');
    // Uncommitted part: the extra line atop.
    expect(diff).toContain('feat + uncommitted');
  });

  it('defaults base to "main" when not provided', async () => {
    run(repo, 'git', ['checkout', '-b', 'feat2']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# feat2\n');
    run(repo, 'git', ['commit', '-am', 'c2']);
    const diff = await getDiff('feat2', undefined as unknown as string, repo);
    expect(diff).toContain('feat2');
  });
});

describe('deleteBranch', () => {
  it('deletes a merged branch from outside it', async () => {
    run(repo, 'git', ['checkout', '-b', 'to-delete']);
    // Merge back to main so `branch -d` doesn't refuse.
    run(repo, 'git', ['checkout', 'main']);
    run(repo, 'git', ['merge', '--ff-only', 'to-delete']);
    await deleteBranch('to-delete', repo);

    const list = spawnSync('git', ['branch'], { cwd: repo, encoding: 'utf-8' });
    expect(list.stdout).not.toContain('to-delete');
  });

  it('switches off the branch first when currently checked out on it', async () => {
    run(repo, 'git', ['checkout', '-b', 'tmp-branch']);
    // Commit something so main can ff-merge the change.
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    run(repo, 'git', ['commit', '-am', 'change']);
    run(repo, 'git', ['checkout', 'main']);
    run(repo, 'git', ['merge', '--ff-only', 'tmp-branch']);
    // Re-check it out so deleteBranch has to switch off it.
    run(repo, 'git', ['checkout', 'tmp-branch']);

    await deleteBranch('tmp-branch', repo);

    expect(await getCurrentBranch(repo)).toBe('main');
    const list = spawnSync('git', ['branch'], { cwd: repo, encoding: 'utf-8' });
    expect(list.stdout).not.toContain('tmp-branch');
  });

  it('throws when the branch has unmerged commits', async () => {
    run(repo, 'git', ['checkout', '-b', 'unmerged']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# wip\n');
    run(repo, 'git', ['commit', '-am', 'wip']);
    run(repo, 'git', ['checkout', 'main']);
    // `branch -d` refuses unmerged branches — that's the "safety" flag.
    // The code doesn't use -D, so we get the error.
    await expect(deleteBranch('unmerged', repo)).rejects.toThrow(
      /git branch -d failed/,
    );
  });
});

describe('gitDispatch', () => {
  it('wires each method to a working handler', async () => {
    // Create a branch via the dispatch — same code path the WS layer hits.
    const created = await gitDispatch.createTaskBranch(['t-dispatch', 'dispatched'], repo);
    expect(created).toBe('fastowl/t-dispatch-dispatched');
    expect(await gitDispatch.getCurrentBranch([], repo)).toBe(
      'fastowl/t-dispatch-dispatched',
    );

    // Check-out + has-uncommitted + stash via dispatch.
    await gitDispatch.checkoutBranch(['main'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# dirty\n');
    expect(await gitDispatch.hasUncommittedChanges([], repo)).toBe(true);
    await gitDispatch.stashChanges(['stash-via-dispatch'], repo);
    expect(await gitDispatch.hasUncommittedChanges([], repo)).toBe(false);
  });

  it('getDiff dispatch defaults base to "main"', async () => {
    await gitDispatch.createTaskBranch(['t-diff', 'diff branch'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# diffed\n');
    run(repo, 'git', ['commit', '-am', 'd']);
    // Omit base arg: dispatch should default to 'main'.
    const diff = await gitDispatch.getDiff(['fastowl/t-diff-diff-branch'], repo);
    expect(diff).toContain('diffed');
  });
});
