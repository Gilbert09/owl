import { exec } from './executor.js';

/**
 * Mirror of backend's `gitService` — the backend used to shell out to
 * `environmentService.exec` for every git call, but the env service is
 * now on this side of the WS. Moving git here means the backend just
 * sends `{ op: 'git', method: 'createTaskBranch', args: [...] }` and
 * the work happens locally.
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

  const exists = await exec(
    `git rev-parse --verify refs/heads/${branchName} 2>/dev/null && echo exists || true`,
    cwd
  );
  if (exists.stdout.trim() === 'exists') {
    await exec(`git checkout ${branchName}`, cwd);
    return branchName;
  }

  await exec(`git checkout -b ${branchName}`, cwd);
  return branchName;
}

export async function checkoutBranch(branch: string, cwd?: string): Promise<void> {
  const res = await exec(`git checkout ${branch}`, cwd);
  if (res.code !== 0) {
    throw new Error(`git checkout failed: ${res.stderr || res.stdout}`);
  }
}

export async function getCurrentBranch(cwd?: string): Promise<string> {
  const res = await exec(`git rev-parse --abbrev-ref HEAD`, cwd);
  if (res.code !== 0) {
    throw new Error(`git rev-parse failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  const res = await exec(`git status --porcelain`, cwd);
  if (res.code !== 0) {
    throw new Error(`git status failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim().length > 0;
}

export async function stashChanges(message: string, cwd?: string): Promise<void> {
  // Escape the message so shell doesn't mangle quotes
  const safe = message.replace(/"/g, '\\"');
  const res = await exec(`git stash push -u -m "${safe}"`, cwd);
  if (res.code !== 0) {
    throw new Error(`git stash failed: ${res.stderr || res.stdout}`);
  }
}

export async function getDiff(
  branch: string,
  base: string = 'main',
  cwd?: string
): Promise<string> {
  const committed = await exec(`git diff ${base}...${branch}`, cwd);
  const uncommitted = await exec(`git diff HEAD`, cwd);
  // Committed diff first, uncommitted second — matches the old backend
  // concatenation order so the desktop's diff view isn't surprised.
  return (committed.stdout || '') + (uncommitted.stdout || '');
}

export async function deleteBranch(branch: string, cwd?: string): Promise<void> {
  const current = await getCurrentBranch(cwd);
  if (current === branch) {
    // Can't delete the branch you're on. Switch to main/master first.
    const tryMain = await exec(`git checkout main`, cwd);
    if (tryMain.code !== 0) {
      await exec(`git checkout master`, cwd);
    }
  }
  const res = await exec(`git branch -d ${branch}`, cwd);
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
