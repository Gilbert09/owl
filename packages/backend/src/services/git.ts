import { environmentService } from './environment.js';
import { recordGitCommand } from './gitLogService.js';

/**
 * Git service for managing branches and git operations on environments.
 *
 * Every method ultimately calls `environmentService.run()` — the daemon
 * spawns git directly with an argv array, no shell in the loop. This
 * means attacker-controlled branch/base/message strings can't inject
 * shell metacharacters into any of these commands.
 *
 * Short-circuits that used to rely on shell `&&`/`||` are implemented
 * as exit-code branches in this file.
 */
class GitService {
  /**
   * Prepare a fresh task branch on a synced base.
   *
   * The high-level entry point for "start a task on this repo". Fetches
   * the base branch, fast-forwards it to origin, then creates the task
   * branch off it. Fails loud on any of:
   *   - working tree is dirty (the env+repo slot guard should have
   *     prevented this; surface the inconsistency rather than branching
   *     off half-written state)
   *   - `git fetch` fails (no remote, auth, network)
   *   - base branch has diverged from origin (fast-forward pull fails)
   *
   * We'd rather refuse to start than silently branch off stale state —
   * a task that committed against old `main` and pushed would look
   * diverged at approve time and require a manual rebase anyway.
   */
  async prepareTaskBranch(opts: {
    environmentId: string;
    taskId: string;
    taskTitle: string;
    workingDirectory: string;
    baseBranch: string;
  }): Promise<string> {
    const { environmentId, taskId, taskTitle, workingDirectory, baseBranch } = opts;

    if (await this.hasUncommittedChanges(environmentId, workingDirectory)) {
      throw new Error(
        'Working tree has uncommitted changes; refuse to prepare task branch. ' +
          'The env+repo single-slot guard should have blocked this — check for leaked state from a prior task.'
      );
    }

    await this.syncBaseBranch(environmentId, baseBranch, workingDirectory);

    return this.createTaskBranch(environmentId, taskId, taskTitle, workingDirectory);
  }

  /**
   * Fetch origin's copy of `baseBranch`, checkout locally, and
   * fast-forward. Refuses to proceed if the local base has diverged —
   * see `prepareTaskBranch` for reasoning.
   */
  async syncBaseBranch(
    environmentId: string,
    baseBranch: string,
    workingDirectory?: string
  ): Promise<void> {
    const fetch = await this.runGit(
      environmentId,
      ['fetch', 'origin', baseBranch],
      workingDirectory
    );
    if (fetch.code !== 0) {
      throw new Error(
        `git fetch origin ${baseBranch} failed: ${fetch.stderr || fetch.stdout}`
      );
    }

    const checkout = await this.runGit(
      environmentId,
      ['checkout', baseBranch],
      workingDirectory
    );
    if (checkout.code !== 0) {
      throw new Error(
        `git checkout ${baseBranch} failed: ${checkout.stderr || checkout.stdout}`
      );
    }

    const pull = await this.runGit(
      environmentId,
      ['pull', '--ff-only', 'origin', baseBranch],
      workingDirectory
    );
    if (pull.code !== 0) {
      throw new Error(
        `'${baseBranch}' has diverged from origin; resolve manually before starting a task: ${pull.stderr || pull.stdout}`
      );
    }
  }

  /**
   * Create a new branch for a task
   * Returns the branch name
   */
  async createTaskBranch(
    environmentId: string,
    taskId: string,
    taskTitle: string,
    workingDirectory?: string
  ): Promise<string> {
    const slug = taskTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);

    const shortId = taskId.slice(0, 8);
    const branchName = `fastowl/${shortId}-${slug}`;

    try {
      // Existence check via exit code — no shell `&&`/`||` needed.
      const exists = await this.runGit(
        environmentId,
        ['rev-parse', '--verify', branchName],
        workingDirectory
      );

      if (exists.code === 0) {
        await this.runGitOrThrow(
          environmentId,
          ['checkout', branchName],
          workingDirectory
        );
      } else {
        await this.runGitOrThrow(
          environmentId,
          ['checkout', '-b', branchName],
          workingDirectory
        );
      }

      return branchName;
    } catch (err) {
      console.error('Failed to create task branch:', err);
      throw err;
    }
  }

  /**
   * Checkout an existing branch
   */
  async checkoutBranch(
    environmentId: string,
    branchName: string,
    workingDirectory?: string
  ): Promise<void> {
    await this.runGitOrThrow(
      environmentId,
      ['checkout', branchName],
      workingDirectory
    );
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(
    environmentId: string,
    workingDirectory?: string
  ): Promise<string> {
    const res = await this.runGitOrThrow(
      environmentId,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      workingDirectory
    );
    return res.stdout.trim();
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasUncommittedChanges(
    environmentId: string,
    workingDirectory?: string
  ): Promise<boolean> {
    const res = await this.runGitOrThrow(
      environmentId,
      ['status', '--porcelain'],
      workingDirectory
    );
    return res.stdout.trim().length > 0;
  }

  /**
   * Stash current changes with a message. Message flows as a single
   * argv element; arbitrary bytes (newlines, quotes, etc.) are safe.
   */
  async stashChanges(
    environmentId: string,
    message: string,
    workingDirectory?: string
  ): Promise<void> {
    await this.runGitOrThrow(
      environmentId,
      ['stash', 'push', '-m', message],
      workingDirectory
    );
  }

  /**
   * Stage everything and commit with the given message. Message is
   * passed via stdin (`git commit -F -`) so arbitrary content
   * (newlines, quotes, emoji, backticks) survives without any shell
   * escaping concerns. Returns the new commit SHA, or null if there
   * was nothing to commit.
   */
  async commitAll(
    environmentId: string,
    message: string,
    workingDirectory?: string
  ): Promise<string | null> {
    await this.runGitOrThrow(environmentId, ['add', '-A'], workingDirectory);

    const staged = await this.runGit(
      environmentId,
      ['diff', '--cached', '--quiet'],
      workingDirectory
    );
    if (staged.code === 0) {
      return null;
    }

    const b64 = Buffer.from(message, 'utf8').toString('base64');
    await this.runGitOrThrow(
      environmentId,
      ['commit', '-F', '-'],
      workingDirectory,
      b64
    );

    const sha = await this.runGitOrThrow(
      environmentId,
      ['rev-parse', 'HEAD'],
      workingDirectory
    );
    return sha.stdout.trim();
  }

  /**
   * Push the branch to origin with upstream tracking. First push
   * sets the upstream so follow-up pushes (amend, continue) are
   * a simple `git push`.
   */
  async pushBranch(
    environmentId: string,
    branch: string,
    workingDirectory?: string
  ): Promise<void> {
    if (!/^[a-zA-Z0-9/_.-]+$/.test(branch)) {
      throw new Error(`Refusing to push suspicious branch name: ${branch}`);
    }
    await this.runGitOrThrow(
      environmentId,
      ['push', '-u', 'origin', branch],
      workingDirectory
    );
  }

  /**
   * Return the list of files changed on this branch vs base, including
   * still-uncommitted working-tree changes AND not-yet-added untracked
   * files. One entry per path — the shape that drives the desktop
   * Files tab.
   */
  async getChangedFiles(
    environmentId: string,
    base: string,
    workingDirectory: string
  ): Promise<
    Array<{
      path: string;
      status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
      added: number;
      removed: number;
      binary: boolean;
    }>
  > {
    const safeRun = async (args: string[]): Promise<string> => {
      const res = await this.runGit(environmentId, args, workingDirectory);
      // `git diff <base>` can fail if base doesn't resolve locally —
      // return empty rather than bubbling; the Files tab should
      // degrade to "untracked only" in that case.
      return res.code === 0 ? res.stdout : '';
    };

    const [nameStatusOut, numStatOut, untrackedOut] = await Promise.all([
      safeRun(['diff', '-M', '--name-status', base]),
      safeRun(['diff', '-M', '--numstat', base]),
      safeRun(['ls-files', '--others', '--exclude-standard']),
    ]);

    type Stat = { added: number; removed: number; binary: boolean };
    const statMap = new Map<string, Stat>();
    for (const line of numStatOut.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [aRaw, rRaw, ...rest] = parts;
      const binary = aRaw === '-' && rRaw === '-';
      const path = rest[rest.length - 1];
      statMap.set(path, {
        added: binary ? 0 : Number.parseInt(aRaw, 10) || 0,
        removed: binary ? 0 : Number.parseInt(rRaw, 10) || 0,
        binary,
      });
    }

    const statusToLabel = (code: string): 'added' | 'modified' | 'deleted' | 'renamed' => {
      if (code.startsWith('A')) return 'added';
      if (code.startsWith('D')) return 'deleted';
      if (code.startsWith('R')) return 'renamed';
      return 'modified';
    };

    const result: Awaited<ReturnType<GitService['getChangedFiles']>> = [];
    const seen = new Set<string>();

    for (const line of nameStatusOut.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const code = parts[0];
      const path = parts[parts.length - 1];
      if (seen.has(path)) continue;
      seen.add(path);
      const stat = statMap.get(path) ?? { added: 0, removed: 0, binary: false };
      result.push({ path, status: statusToLabel(code), ...stat });
    }

    for (const rawPath of untrackedOut.split('\n')) {
      const path = rawPath.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      result.push({ path, status: 'untracked', added: 0, removed: 0, binary: false });
    }

    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Unified diff for a single file, working tree vs `base`. Includes
   * uncommitted changes. For untracked files, shows the file as a
   * "new file" diff so the Files tab can render it.
   */
  async getFileDiff(
    environmentId: string,
    base: string,
    path: string,
    workingDirectory: string
  ): Promise<string> {
    // Cheap defensive check — path comes from the query string.
    if (path.includes('\0') || path.startsWith('-')) {
      throw new Error(`Refusing suspicious path: ${path}`);
    }
    const tracked = await this.runGit(
      environmentId,
      ['diff', base, '--', path],
      workingDirectory
    );
    if (tracked.code === 0 && tracked.stdout.trim().length > 0) {
      return tracked.stdout;
    }

    // `--no-index` returns exit code 1 when files differ (which is
    // always, for a non-empty new file). Accept non-zero here.
    const untracked = await this.runGit(
      environmentId,
      ['--no-pager', 'diff', '--no-index', '--', '/dev/null', path],
      workingDirectory
    );
    return untracked.stdout;
  }

  /**
   * Return `git diff --stat` for the task branch vs base. Used by the
   * commit-message generator — cheap, summarises every changed file in
   * a few dozen bytes, and always fits inside the LLM prompt budget.
   */
  async getDiffStat(
    environmentId: string,
    branch: string,
    base: string = 'main',
    workingDirectory?: string
  ): Promise<string> {
    const primary = await this.runGit(
      environmentId,
      ['diff', '--stat', `${base}...${branch}`],
      workingDirectory
    );
    if (primary.code === 0) return primary.stdout;
    // Base didn't resolve — fall back to "stat of whatever's staged".
    const fallback = await this.runGit(
      environmentId,
      ['diff', '--stat'],
      workingDirectory
    );
    return fallback.stdout;
  }

  /**
   * Get diff for the given branch vs a base branch (default: main).
   * Includes both committed changes and uncommitted working tree changes.
   */
  async getDiff(
    environmentId: string,
    branch: string,
    base: string = 'main',
    workingDirectory?: string
  ): Promise<string> {
    const committedPrimary = await this.runGit(
      environmentId,
      ['diff', `${base}...${branch}`],
      workingDirectory
    );
    const committed =
      committedPrimary.code === 0
        ? committedPrimary.stdout
        : (await this.runGit(environmentId, ['diff', branch], workingDirectory)).stdout;

    const uncommittedRes = await this.runGit(
      environmentId,
      ['diff', 'HEAD'],
      workingDirectory
    );
    const uncommitted = uncommittedRes.code === 0 ? uncommittedRes.stdout : '';

    if (uncommitted.trim().length === 0) return committed;
    return committed + '\n\n--- Uncommitted changes ---\n' + uncommitted;
  }

  /**
   * Preserve the task's current state as a ref under
   * `refs/fastowl/<namespace>/<taskId>`. If the working tree is dirty
   * we use `git stash create`; if clean we still back up HEAD so the
   * branch history is recoverable after we delete the branch.
   */
  async stashToBackupRef(
    environmentId: string,
    refNamespace: string,
    taskId: string,
    workingDirectory?: string
  ): Promise<string | null> {
    const ref = `refs/fastowl/${refNamespace}/${taskId}`;
    if (!/^refs\/fastowl\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(ref)) {
      throw new Error(`Refusing suspicious ref: ${ref}`);
    }

    const createOut = await this.runGitOrThrow(
      environmentId,
      ['stash', 'create'],
      workingDirectory
    );
    const stashSha = createOut.stdout.trim();
    if (stashSha) {
      if (!/^[0-9a-f]{40}$/.test(stashSha)) {
        throw new Error(`stash create returned unexpected value: ${stashSha}`);
      }
      await this.runGitOrThrow(
        environmentId,
        ['update-ref', ref, stashSha],
        workingDirectory
      );
      return ref;
    }

    const headOut = await this.runGitOrThrow(
      environmentId,
      ['rev-parse', 'HEAD'],
      workingDirectory
    );
    const headSha = headOut.stdout.trim();
    if (!headSha) return null;
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      throw new Error(`rev-parse HEAD returned unexpected value: ${headSha}`);
    }
    await this.runGitOrThrow(
      environmentId,
      ['update-ref', ref, headSha],
      workingDirectory
    );
    return ref;
  }

  /**
   * Force-checkout the base branch and hard-reset to origin's tip,
   * dropping any local commits or uncommitted tree state.
   */
  async resetToBase(
    environmentId: string,
    baseBranch: string,
    workingDirectory?: string
  ): Promise<void> {
    await this.runGitOrThrow(
      environmentId,
      ['checkout', '-f', baseBranch],
      workingDirectory
    );
    await this.runGitOrThrow(
      environmentId,
      ['reset', '--hard', `origin/${baseBranch}`],
      workingDirectory
    );
    await this.runGitOrThrow(
      environmentId,
      ['clean', '-fd'],
      workingDirectory
    );
  }

  /**
   * Force-delete a branch without checking out default first.
   */
  async forceDeleteBranch(
    environmentId: string,
    branchName: string,
    workingDirectory?: string
  ): Promise<void> {
    await this.runGitOrThrow(
      environmentId,
      ['branch', '-D', branchName],
      workingDirectory
    );
  }

  /**
   * Delete a branch
   */
  async deleteBranch(
    environmentId: string,
    branchName: string,
    workingDirectory?: string
  ): Promise<void> {
    // Switch off the branch first to avoid "cannot delete checked out"
    const tryMain = await this.runGit(
      environmentId,
      ['checkout', 'main'],
      workingDirectory
    );
    if (tryMain.code !== 0) {
      await this.runGitOrThrow(
        environmentId,
        ['checkout', 'master'],
        workingDirectory
      );
    }
    await this.runGitOrThrow(
      environmentId,
      ['branch', '-d', branchName],
      workingDirectory
    );
  }

  /**
   * Execute a git subcommand and return the raw result (no throw on
   * non-zero exit). Callers inspect `code` themselves. Logs to the
   * gitLogService for the desktop's Git tab.
   */
  private async runGit(
    environmentId: string,
    args: string[],
    workingDirectory?: string,
    stdinBase64?: string
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const start = Date.now();
    const result = await environmentService.run(environmentId, 'git', args, {
      cwd: workingDirectory,
      stdinBase64,
    });
    const durationMs = Date.now() - start;

    void recordGitCommand({
      ts: new Date().toISOString(),
      command: `git ${args.join(' ')}`,
      cwd: workingDirectory,
      exitCode: result.code,
      stdoutPreview: result.stdout.slice(0, 500),
      stderrPreview: result.stderr.slice(0, 500),
      durationMs,
    });

    return result;
  }

  /**
   * Same as `runGit` but throws on non-zero exit. Use when callers
   * would otherwise do `if (code !== 0) throw`.
   */
  private async runGitOrThrow(
    environmentId: string,
    args: string[],
    workingDirectory?: string,
    stdinBase64?: string
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const res = await this.runGit(environmentId, args, workingDirectory, stdinBase64);
    if (res.code !== 0) {
      throw new Error(`Git command failed: ${res.stderr || res.stdout}`);
    }
    return res;
  }
}

export const gitService = new GitService();
