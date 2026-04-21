import { run } from './executor.js';

/**
 * Mirror of backend's `gitService` — the backend used to shell out to
 * `environmentService.exec` for every git call, but the env service is
 * now on this side of the WS. Moving git here means the backend just
 * sends `{ op: 'git', method: 'createTaskBranch', args: [...] }` and
 * the work happens locally.
 *
 * All commands use argv-based spawn (`run`) — no shell, no quoting,
 * caller-supplied strings cannot inject metacharacters.
 *
 * All methods take an optional `cwd` — the repo path on this machine.
 */

export async function createTaskBranch(
  taskId: string,
  taskTitle: string,
  cwd?: string
): Promise<string> {
  const slug = slugify(taskTitle);
  const branchName = `fastowl/${taskId}-${slug}`;

  const exists = await run('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], { cwd });
  if (exists.code === 0 && exists.stdout.trim().length > 0) {
    const checkout = await run('git', ['checkout', branchName], { cwd });
    if (checkout.code !== 0) {
      throw new Error(`git checkout failed: ${checkout.stderr || checkout.stdout}`);
    }
    return branchName;
  }

  const create = await run('git', ['checkout', '-b', branchName], { cwd });
  if (create.code !== 0) {
    throw new Error(`git checkout -b failed: ${create.stderr || create.stdout}`);
  }
  return branchName;
}

export async function checkoutBranch(branch: string, cwd?: string): Promise<void> {
  const res = await run('git', ['checkout', branch], { cwd });
  if (res.code !== 0) {
    throw new Error(`git checkout failed: ${res.stderr || res.stdout}`);
  }
}

export async function getCurrentBranch(cwd?: string): Promise<string> {
  const res = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (res.code !== 0) {
    throw new Error(`git rev-parse failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  const res = await run('git', ['status', '--porcelain'], { cwd });
  if (res.code !== 0) {
    throw new Error(`git status failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim().length > 0;
}

export async function stashChanges(message: string, cwd?: string): Promise<void> {
  // No shell, no quoting — message is passed as a single argv[n].
  const res = await run('git', ['stash', 'push', '-u', '-m', message], { cwd });
  if (res.code !== 0) {
    throw new Error(`git stash failed: ${res.stderr || res.stdout}`);
  }
}

export async function getDiff(
  branch: string,
  base: string = 'main',
  cwd?: string
): Promise<string> {
  const committed = await run('git', ['diff', `${base}...${branch}`], { cwd });
  const uncommitted = await run('git', ['diff', 'HEAD'], { cwd });
  return (committed.stdout || '') + (uncommitted.stdout || '');
}

export async function deleteBranch(branch: string, cwd?: string): Promise<void> {
  const current = await getCurrentBranch(cwd);
  if (current === branch) {
    const tryMain = await run('git', ['checkout', 'main'], { cwd });
    if (tryMain.code !== 0) {
      const tryMaster = await run('git', ['checkout', 'master'], { cwd });
      if (tryMaster.code !== 0) {
        throw new Error(
          `cannot switch off ${branch} before delete: ${tryMaster.stderr || tryMaster.stdout}`
        );
      }
    }
  }
  const res = await run('git', ['branch', '-d', branch], { cwd });
  if (res.code !== 0) {
    throw new Error(`git branch -d failed: ${res.stderr || res.stdout}`);
  }
}

/**
 * Dispatch table used by the WS handler — matches the protocol's
 * `GitCommandRequest.method` union. Stays in sync because both sides
 * import the same union from `@fastowl/shared`.
 */
export const gitDispatch = {
  createTaskBranch: (args: unknown[], cwd?: string) =>
    createTaskBranch(args[0] as string, args[1] as string, cwd),
  checkoutBranch: (args: unknown[], cwd?: string) =>
    checkoutBranch(args[0] as string, cwd),
  getCurrentBranch: (_args: unknown[], cwd?: string) => getCurrentBranch(cwd),
  hasUncommittedChanges: (_args: unknown[], cwd?: string) =>
    hasUncommittedChanges(cwd),
  stashChanges: (args: unknown[], cwd?: string) =>
    stashChanges(args[0] as string, cwd),
  getDiff: (args: unknown[], cwd?: string) =>
    getDiff(args[0] as string, (args[1] as string | undefined) ?? 'main', cwd),
  deleteBranch: (args: unknown[], cwd?: string) =>
    deleteBranch(args[0] as string, cwd),
} as const;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
