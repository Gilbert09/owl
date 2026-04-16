import { environmentService } from './environment.js';

/**
 * Git service for managing branches and git operations on environments
 */
class GitService {
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

    try {
      // Check if branch already exists
      const checkResult = await this.executeGitCommand(
        environmentId,
        sessionId,
        `git rev-parse --verify ${branchName} 2>/dev/null && echo "exists" || echo "not-exists"`,
        workingDirectory
      );

      if (checkResult.trim() === 'exists') {
        // Branch exists, just checkout
        await this.executeGitCommand(
          environmentId,
          sessionId,
          `git checkout ${branchName}`,
          workingDirectory
        );
      } else {
        // Create and checkout new branch from current HEAD
        await this.executeGitCommand(
          environmentId,
          sessionId,
          `git checkout -b ${branchName}`,
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
      `git checkout ${branchName}`,
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
    await this.executeGitCommand(
      environmentId,
      sessionId,
      `git stash push -m "${message}"`,
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
      `git branch -d ${branchName}`,
      workingDirectory
    );
  }

  /**
   * Execute a git command and return the output
   */
  private async executeGitCommand(
    environmentId: string,
    sessionId: string,
    command: string,
    workingDirectory?: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = '';
      let errorOutput = '';

      // Listen for data
      const dataHandler = (sid: string, data: Buffer) => {
        if (sid === sessionId) {
          output += data.toString();
        }
      };

      // Listen for errors
      const closeHandler = (sid: string, code: number | null) => {
        if (sid === sessionId) {
          environmentService.removeListener('session:data', dataHandler);
          environmentService.removeListener('session:close', closeHandler);

          if (code === 0 || code === null) {
            resolve(output);
          } else {
            reject(new Error(`Git command failed: ${errorOutput || output}`));
          }
        }
      };

      environmentService.on('session:data', dataHandler);
      environmentService.on('session:close', closeHandler);

      // Execute command
      environmentService
        .spawnInteractive(environmentId, sessionId, command, {
          cwd: workingDirectory,
          rows: 10,
          cols: 80,
        })
        .catch((err) => {
          environmentService.removeListener('session:data', dataHandler);
          environmentService.removeListener('session:close', closeHandler);
          reject(err);
        });

      // Set a timeout
      setTimeout(() => {
        environmentService.removeListener('session:data', dataHandler);
        environmentService.removeListener('session:close', closeHandler);
        environmentService.killSession(sessionId);
        resolve(output); // Return whatever we got
      }, 5000);
    });
  }
}

export const gitService = new GitService();
