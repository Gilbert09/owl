import { environmentService } from './environment.js';
import { recordGitCommand } from './gitLogService.js';

/**
 * Single-quote a string for POSIX shell. Every embedded `'` is escaped
 * by closing the quote, writing a literal `'`, and reopening —
 * `'\''` inside single quotes. Safe for arbitrary filenames; no
 * interpolation happens inside single quotes.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Git service for managing branches and git operations on environments
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
    const qBase = shellQuote(baseBranch);
    try {
      await this.executeGitCommand(
        environmentId,
        `git:fetch:${Date.now()}`,
        `git fetch origin ${qBase}`,
        workingDirectory
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`git fetch origin ${baseBranch} failed: ${msg}`);
    }

    await this.executeGitCommand(
      environmentId,
      `git:checkout-base:${Date.now()}`,
      `git checkout ${qBase}`,
      workingDirectory
    );

    try {
      await this.executeGitCommand(
        environmentId,
        `git:pull:${Date.now()}`,
        `git pull --ff-only origin ${qBase}`,
        workingDirectory
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `'${baseBranch}' has diverged from origin; resolve manually before starting a task: ${msg}`
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
    // Create a URL-safe branch name from the task title
    const slug = taskTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);

    // Short task ID for uniqueness
    const shortId = taskId.slice(0, 8);
    const branchName = `fastowl/${shortId}-${slug}`;

    // Execute git commands to create and checkout the branch
    const sessionId = `git:${taskId}`;

    const qBranch = shellQuote(branchName);
    try {
      // Check if branch already exists
      const checkResult = await this.executeGitCommand(
        environmentId,
        sessionId,
        `git rev-parse --verify ${qBranch} 2>/dev/null && echo "exists" || echo "not-exists"`,
        workingDirectory
      );

      if (checkResult.trim() === 'exists') {
        // Branch exists, just checkout
        await this.executeGitCommand(
          environmentId,
          sessionId,
          `git checkout ${qBranch}`,
          workingDirectory
        );
      } else {
        // Create and checkout new branch from current HEAD
        await this.executeGitCommand(
          environmentId,
          sessionId,
          `git checkout -b ${qBranch}`,
          workingDirectory
        );
      }

      return branchName;
    } catch (err) {
      console.error('Failed to create task branch:', err);
      // Don't fail the task start if git fails
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
    const sessionId = `git:checkout:${Date.now()}`;
    await this.executeGitCommand(
      environmentId,
      sessionId,
      `git checkout ${shellQuote(branchName)}`,
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
    const sessionId = `git:branch:${Date.now()}`;
    const result = await this.executeGitCommand(
      environmentId,
      sessionId,
      'git rev-parse --abbrev-ref HEAD',
      workingDirectory
    );
    return result.trim();
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasUncommittedChanges(
    environmentId: string,
    workingDirectory?: string
  ): Promise<boolean> {
    const sessionId = `git:status:${Date.now()}`;
    const result = await this.executeGitCommand(
      environmentId,
      sessionId,
      'git status --porcelain',
      workingDirectory
    );
    return result.trim().length > 0;
  }

  /**
   * Stash current changes with a message
   */
  async stashChanges(
    environmentId: string,
    message: string,
    workingDirectory?: string
  ): Promise<void> {
    const sessionId = `git:stash:${Date.now()}`;
    // Pass message via base64 → decoded into a shell var → single-arg
    // expansion ("$msg"). No interpolation inside double-quoted var
    // expansion, so arbitrary bytes (quotes, backticks, $()) are safe.
    const b64 = Buffer.from(message, 'utf8').toString('base64');
    await this.executeGitCommand(
      environmentId,
      sessionId,
      `msg=$(printf '%s' '${b64}' | base64 -d) && git stash push -m "$msg"`,
      workingDirectory
    );
  }

  /**
   * Stage everything and commit with the given message. Message is
   * passed via base64 → stdin (`git commit -F -`) so arbitrary content
   * (newlines, quotes, emoji, backticks) survives without any shell
   * escaping concerns. Returns the new commit SHA, or null if there
   * was nothing to commit.
   */
  async commitAll(
    environmentId: string,
    message: string,
    workingDirectory?: string
  ): Promise<string | null> {
    await this.executeGitCommand(
      environmentId,
      `git:add:${Date.now()}`,
      'git add -A',
      workingDirectory
    );

    // Fast check: `git diff --cached --quiet` exits 1 if there are staged
    // changes. We use the exec result's exit code rather than parsing
    // output. executeGitCommand throws on non-zero, so wrap and inspect.
    const staged = await environmentService.exec(
      environmentId,
      'git diff --cached --quiet',
      { cwd: workingDirectory }
    );
    if (staged.code === 0) {
      // Nothing staged after `git add -A` — working tree was clean.
      return null;
    }

    const b64 = Buffer.from(message, 'utf8').toString('base64');
    await this.executeGitCommand(
      environmentId,
      `git:commit:${Date.now()}`,
      `printf '%s' '${b64}' | base64 -d | git commit -F -`,
      workingDirectory
    );

    const sha = await this.executeGitCommand(
      environmentId,
      `git:rev-parse:${Date.now()}`,
      'git rev-parse HEAD',
      workingDirectory
    );
    return sha.trim();
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
    await this.executeGitCommand(
      environmentId,
      `git:push:${Date.now()}`,
      `git push -u origin ${shellQuote(branch)}`,
      workingDirectory
    );
  }

  /**
   * Return the list of files changed on this branch vs base, including
   * still-uncommitted working-tree changes AND not-yet-added untracked
   * files. One entry per path — the shape that drives the desktop
   * Files tab.
   *
   * Tracked changes come from `git diff --name-status/--numstat <base>`
   * (working tree vs base, so both committed and uncommitted are
   * included). Untracked files come from `ls-files --others` since
   * `git diff` doesn't see them until they're added.
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
    const safeExec = async (command: string): Promise<string> => {
      try {
        return await this.executeGitCommand(
          environmentId,
          `git:files:${Date.now()}`,
          command,
          workingDirectory
        );
      } catch {
        // `git diff <base>` can fail if base doesn't resolve locally —
        // return empty rather than bubbling; the Files tab should
        // degrade to "untracked only" in that case.
        return '';
      }
    };

    const qBase = shellQuote(base);
    const [nameStatusOut, numStatOut, untrackedOut] = await Promise.all([
      safeExec(`git diff -M --name-status ${qBase}`),
      safeExec(`git diff -M --numstat ${qBase}`),
      safeExec('git ls-files --others --exclude-standard'),
    ]);

    type Stat = { added: number; removed: number; binary: boolean };
    const statMap = new Map<string, Stat>();
    for (const line of numStatOut.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [aRaw, rRaw, ...rest] = parts;
      const binary = aRaw === '-' && rRaw === '-';
      const path = rest[rest.length - 1]; // rename: "old => new" — take new
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
    // For untracked files `git diff <base> -- <path>` shows nothing;
    // use `--no-index /dev/null <path>` to render them as new.
    const tracked = await this.executeGitCommand(
      environmentId,
      `git:file-diff:${Date.now()}`,
      `git diff ${base} -- ${shellQuote(path)}`,
      workingDirectory
    );
    if (tracked.trim().length > 0) return tracked;

    try {
      // `--no-index` returns exit code 1 when files differ (which is
      // always, for a non-empty new file). executeGitCommand throws on
      // non-zero, so we catch.
      return await this.executeGitCommand(
        environmentId,
        `git:file-diff-untracked:${Date.now()}`,
        `git --no-pager diff --no-index -- /dev/null ${shellQuote(path)} || true`,
        workingDirectory
      );
    } catch {
      return tracked; // fall back to the (empty) tracked result
    }
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
    const qBase = shellQuote(base);
    const qBranch = shellQuote(branch);
    const out = await this.executeGitCommand(
      environmentId,
      `git:diff-stat:${Date.now()}`,
      `git diff --stat ${qBase}...${qBranch} 2>/dev/null || git diff --stat`,
      workingDirectory
    );
    return out;
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
    const sessionId = `git:diff:${Date.now()}`;
    // git diff <base>...<branch> shows changes from base merge-base to branch tip
    // Append working tree changes (uncommitted) with git diff HEAD
    const qBase = shellQuote(base);
    const qBranch = shellQuote(branch);
    const committed = await this.executeGitCommand(
      environmentId,
      `${sessionId}:committed`,
      `git diff ${qBase}...${qBranch} 2>/dev/null || git diff ${qBranch}`,
      workingDirectory
    );
    const uncommitted = await this.executeGitCommand(
      environmentId,
      `${sessionId}:uncommitted`,
      'git diff HEAD 2>/dev/null',
      workingDirectory
    );
    if (uncommitted.trim().length === 0) return committed;
    return committed + '\n\n--- Uncommitted changes ---\n' + uncommitted;
  }

  /**
   * Preserve the task's current state as a ref under
   * `refs/fastowl/rejected/<taskId>`. If the working tree is dirty we
   * use `git stash create` (a tree + index snapshot with HEAD as
   * parent). If the tree is clean we still back up HEAD so the branch
   * history is recoverable after we delete the branch.
   *
   * Returns the ref we wrote, or null if nothing could be backed up
   * (shouldn't happen in practice — HEAD always exists).
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

    const createOut = await this.executeGitCommand(
      environmentId,
      `git:stash-create:${Date.now()}`,
      'git stash create',
      workingDirectory
    );
    const stashSha = createOut.trim();
    if (stashSha) {
      if (!/^[0-9a-f]{40}$/.test(stashSha)) {
        throw new Error(`stash create returned unexpected value: ${stashSha}`);
      }
      await this.executeGitCommand(
        environmentId,
        `git:update-ref:${Date.now()}`,
        `git update-ref ${shellQuote(ref)} ${stashSha}`,
        workingDirectory
      );
      return ref;
    }

    // Clean tree — back up HEAD so branch history survives the delete.
    const headOut = await this.executeGitCommand(
      environmentId,
      `git:rev-parse-head:${Date.now()}`,
      'git rev-parse HEAD',
      workingDirectory
    );
    const headSha = headOut.trim();
    if (!headSha) return null;
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      throw new Error(`rev-parse HEAD returned unexpected value: ${headSha}`);
    }
    await this.executeGitCommand(
      environmentId,
      `git:update-ref-head:${Date.now()}`,
      `git update-ref ${shellQuote(ref)} ${headSha}`,
      workingDirectory
    );
    return ref;
  }

  /**
   * Force-checkout the base branch and hard-reset to origin's tip,
   * dropping any local commits or uncommitted tree state. Caller is
   * responsible for having already preserved anything worth keeping
   * (see `stashToBackupRef`). Untracked files are removed so the next
   * task starts from a pristine tree.
   */
  async resetToBase(
    environmentId: string,
    baseBranch: string,
    workingDirectory?: string
  ): Promise<void> {
    const qBase = shellQuote(baseBranch);
    await this.executeGitCommand(
      environmentId,
      `git:checkout-base-f:${Date.now()}`,
      `git checkout -f ${qBase}`,
      workingDirectory
    );
    await this.executeGitCommand(
      environmentId,
      `git:reset-hard:${Date.now()}`,
      `git reset --hard origin/${qBase}`,
      workingDirectory
    );
    await this.executeGitCommand(
      environmentId,
      `git:clean:${Date.now()}`,
      'git clean -fd',
      workingDirectory
    );
  }

  /**
   * Force-delete a branch without checking out default first. Assumes
   * caller has already checked out somewhere else (e.g. via
   * `resetToBase`). Uses `-D` so branches that never got pushed can be
   * removed without git refusing to delete "unmerged" work.
   */
  async forceDeleteBranch(
    environmentId: string,
    branchName: string,
    workingDirectory?: string
  ): Promise<void> {
    await this.executeGitCommand(
      environmentId,
      `git:branch-D:${Date.now()}`,
      `git branch -D ${shellQuote(branchName)}`,
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
    const sessionId = `git:delete:${Date.now()}`;
    // First checkout main/master to avoid "cannot delete checked out branch"
    await this.executeGitCommand(
      environmentId,
      sessionId,
      'git checkout main 2>/dev/null || git checkout master',
      workingDirectory
    );
    await this.executeGitCommand(
      environmentId,
      sessionId,
      `git branch -d ${shellQuote(branchName)}`,
      workingDirectory
    );
  }

  /**
   * Execute a git command and return stdout. Uses the one-shot
   * `exec` path on environmentService (no PTY) — we don't need
   * an interactive shell for plumbing.
   */
  private async executeGitCommand(
    environmentId: string,
    _sessionId: string,
    command: string,
    workingDirectory?: string
  ): Promise<string> {
    const start = Date.now();
    const { stdout, stderr, code } = await environmentService.exec(environmentId, command, {
      cwd: workingDirectory,
    });
    const durationMs = Date.now() - start;

    // Best-effort audit log so the desktop's Git tab can show what
    // FastOwl actually did. No-op when no task context is active.
    void recordGitCommand({
      ts: new Date().toISOString(),
      command,
      cwd: workingDirectory,
      exitCode: code,
      stdoutPreview: stdout.slice(0, 500),
      stderrPreview: stderr.slice(0, 500),
      durationMs,
    });

    if (code !== 0) {
      throw new Error(`Git command failed: ${stderr || stdout}`);
    }
    return stdout;
  }
}

export const gitService = new GitService();
