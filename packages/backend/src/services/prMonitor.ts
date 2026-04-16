import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { DB } from '../db/index.js';
import { githubService } from './github.js';
import { broadcast } from './websocket.js';

interface WatchedRepo {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  fullName: string;
}

interface PRState {
  prNumber: number;
  lastReviewId: number;
  lastReviewCommentId: number;
  lastCommentId: number;
  lastCheckStatus: string | null;
  wasMergeable: boolean | null;
}

interface MonitorState {
  repos: Map<string, Map<number, PRState>>; // repoFullName -> prNumber -> state
  lastPoll: Map<string, string>; // repoFullName -> ISO timestamp
}

const POLL_INTERVAL_MS = 60000; // 1 minute

class PRMonitorService extends EventEmitter {
  private db: DB | null = null;
  private state: MonitorState = {
    repos: new Map(),
    lastPoll: new Map(),
  };
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;

  /**
   * Initialize the PR monitor service
   */
  init(db: DB): void {
    this.db = db;
    this.startPolling();
  }

  /**
   * Shutdown the service
   */
  shutdown(): void {
    this.stopPolling();
  }

  /**
   * Start the polling loop
   */
  private startPolling(): void {
    if (this.pollTimer) return;

    console.log('Starting PR monitor polling...');
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);

    // Initial poll after a short delay
    setTimeout(() => this.poll(), 5000);
  }

  /**
   * Stop the polling loop
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Get watched repositories for a workspace
   */
  getWatchedRepos(workspaceId: string): WatchedRepo[] {
    if (!this.db) return [];

    const rows = this.db.prepare(`
      SELECT id, workspace_id, name, url FROM repositories
      WHERE workspace_id = ?
    `).all(workspaceId) as Array<{ id: string; workspace_id: string; name: string; url: string }>;

    return rows.map(row => {
      // Parse GitHub URL to get owner/repo
      const match = row.url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
      if (!match) return null;

      return {
        id: row.id,
        workspaceId: row.workspace_id,
        owner: match[1],
        repo: match[2].replace(/\.git$/, ''),
        fullName: `${match[1]}/${match[2].replace(/\.git$/, '')}`,
      };
    }).filter((r): r is WatchedRepo => r !== null);
  }

  /**
   * Add a repository to watch
   */
  addWatchedRepo(workspaceId: string, owner: string, repo: string, url?: string): WatchedRepo {
    if (!this.db) throw new Error('Database not initialized');

    const id = uuid();
    const fullName = `${owner}/${repo}`;
    const repoUrl = url || `https://github.com/${fullName}`;

    this.db.prepare(`
      INSERT INTO repositories (id, workspace_id, name, url, default_branch)
      VALUES (?, ?, ?, ?, 'main')
    `).run(id, workspaceId, fullName, repoUrl);

    const watched: WatchedRepo = {
      id,
      workspaceId,
      owner,
      repo,
      fullName,
    };

    // Initialize state for this repo
    this.state.repos.set(fullName, new Map());

    return watched;
  }

  /**
   * Remove a watched repository
   */
  removeWatchedRepo(repoId: string): void {
    if (!this.db) return;

    // Get repo info before deletion
    const row = this.db.prepare(`SELECT name FROM repositories WHERE id = ?`).get(repoId) as { name: string } | undefined;

    this.db.prepare(`DELETE FROM repositories WHERE id = ?`).run(repoId);

    // Clear state
    if (row) {
      this.state.repos.delete(row.name);
      this.state.lastPoll.delete(row.name);
    }
  }

  /**
   * Main polling function
   */
  private async poll(): Promise<void> {
    if (this.isPolling || !this.db) return;
    this.isPolling = true;

    try {
      // Get all workspaces with GitHub connected
      const connectedWorkspaces = githubService.getConnectedWorkspaces();

      for (const workspaceId of connectedWorkspaces) {
        const repos = this.getWatchedRepos(workspaceId);

        for (const repo of repos) {
          try {
            await this.pollRepo(workspaceId, repo);
          } catch (err: any) {
            console.error(`Failed to poll ${repo.fullName}:`, err.message);
          }
        }
      }
    } catch (err: any) {
      console.error('PR monitor poll error:', err.message);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Poll a single repository for PR updates
   */
  private async pollRepo(workspaceId: string, repo: WatchedRepo): Promise<void> {
    // Get open PRs for this repo
    const prs = await githubService.listPullRequests(workspaceId, repo.owner, repo.repo, {
      state: 'open',
      per_page: 30,
    });

    // Get or initialize repo state
    let repoState = this.state.repos.get(repo.fullName);
    if (!repoState) {
      repoState = new Map();
      this.state.repos.set(repo.fullName, repoState);
    }

    // Get the authenticated user to filter out their own PRs
    let currentUser: string | null = null;
    try {
      const user = await githubService.getUser(workspaceId);
      currentUser = user.login;
    } catch (_e) {
      // Ignore
    }

    for (const pr of prs) {
      // Skip user's own PRs for review notifications
      const isOwnPR = currentUser && pr.user.login === currentUser;

      // Get or initialize PR state
      let prState = repoState.get(pr.number);
      const isFirstSeen = !prState;

      if (!prState) {
        prState = {
          prNumber: pr.number,
          lastReviewId: 0,
          lastReviewCommentId: 0,
          lastCommentId: 0,
          lastCheckStatus: null,
          wasMergeable: null,
        };
        repoState.set(pr.number, prState);
      }

      // Don't create notifications on first poll (just initialize state)
      if (isFirstSeen) {
        // Fetch current state to initialize
        try {
          const reviews = await githubService.getPRReviews(workspaceId, repo.owner, repo.repo, pr.number);
          if (reviews.length > 0) {
            prState.lastReviewId = Math.max(...reviews.map(r => r.id));
          }

          const reviewComments = await githubService.getPRReviewComments(workspaceId, repo.owner, repo.repo, pr.number);
          if (reviewComments.length > 0) {
            prState.lastReviewCommentId = Math.max(...reviewComments.map(c => c.id));
          }

          const comments = await githubService.getPRComments(workspaceId, repo.owner, repo.repo, pr.number);
          if (comments.length > 0) {
            prState.lastCommentId = Math.max(...comments.map(c => c.id));
          }

          const checks = await githubService.getCheckRuns(workspaceId, repo.owner, repo.repo, pr.head.sha);
          prState.lastCheckStatus = this.getOverallCheckStatus(checks.check_runs);
          prState.wasMergeable = pr.mergeable;
        } catch (_e) {
          // Ignore initialization errors
        }
        continue;
      }

      // Check for new reviews (only on own PRs)
      if (isOwnPR) {
        await this.checkNewReviews(workspaceId, repo, pr, prState);
      }

      // Check for new review comments (always)
      await this.checkNewReviewComments(workspaceId, repo, pr, prState, currentUser);

      // Check for new general comments (always)
      await this.checkNewComments(workspaceId, repo, pr, prState, currentUser);

      // Check CI status (only on own PRs)
      if (isOwnPR) {
        await this.checkCIStatus(workspaceId, repo, pr, prState);
      }

      // Check if PR became mergeable (only on own PRs)
      if (isOwnPR) {
        this.checkMergeability(workspaceId, repo, pr, prState);
      }
    }

    this.state.lastPoll.set(repo.fullName, new Date().toISOString());
  }

  /**
   * Check for new reviews on a PR
   */
  private async checkNewReviews(
    workspaceId: string,
    repo: WatchedRepo,
    pr: { number: number; title: string; html_url: string },
    state: PRState
  ): Promise<void> {
    try {
      const reviews = await githubService.getPRReviews(workspaceId, repo.owner, repo.repo, pr.number);
      const newReviews = reviews.filter(r => r.id > state.lastReviewId);

      for (const review of newReviews) {
        // Skip pending reviews
        if (review.state === 'PENDING') continue;

        this.createInboxItem(workspaceId, {
          type: 'pr_review',
          priority: review.state === 'CHANGES_REQUESTED' ? 'high' : 'medium',
          title: `${review.state === 'APPROVED' ? 'Approved' : review.state === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Review'}: ${pr.title}`,
          summary: `@${review.user.login} ${review.state.toLowerCase().replace('_', ' ')} on ${repo.fullName}#${pr.number}`,
          source: 'github',
          actions: [
            { label: 'View Review', action: 'open_url', data: review.html_url },
            { label: 'View PR', action: 'open_url', data: pr.html_url },
          ],
          data: {
            repo: repo.fullName,
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            reviewId: review.id,
            reviewState: review.state,
            reviewer: review.user.login,
          },
        });
      }

      if (reviews.length > 0) {
        state.lastReviewId = Math.max(...reviews.map(r => r.id));
      }
    } catch (err: any) {
      console.error(`Failed to check reviews for ${repo.fullName}#${pr.number}:`, err.message);
    }
  }

  /**
   * Check for new review comments on a PR
   */
  private async checkNewReviewComments(
    workspaceId: string,
    repo: WatchedRepo,
    pr: { number: number; title: string; html_url: string },
    state: PRState,
    currentUser: string | null
  ): Promise<void> {
    try {
      const comments = await githubService.getPRReviewComments(workspaceId, repo.owner, repo.repo, pr.number);
      const newComments = comments.filter(c =>
        c.id > state.lastReviewCommentId &&
        c.user.login !== currentUser // Don't notify about own comments
      );

      if (newComments.length > 0) {
        // Group comments by user
        const commentCount = newComments.length;
        const users = [...new Set(newComments.map(c => c.user.login))];

        this.createInboxItem(workspaceId, {
          type: 'pr_comment',
          priority: 'medium',
          title: `${commentCount} new review comment${commentCount > 1 ? 's' : ''} on ${pr.title}`,
          summary: `${users.map(u => `@${u}`).join(', ')} commented on ${repo.fullName}#${pr.number}`,
          source: 'github',
          actions: [
            { label: 'View Comments', action: 'open_url', data: newComments[0].html_url },
            { label: 'View PR', action: 'open_url', data: pr.html_url },
          ],
          data: {
            repo: repo.fullName,
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            commentCount,
            commenters: users,
          },
        });
      }

      if (comments.length > 0) {
        state.lastReviewCommentId = Math.max(...comments.map(c => c.id));
      }
    } catch (err: any) {
      console.error(`Failed to check review comments for ${repo.fullName}#${pr.number}:`, err.message);
    }
  }

  /**
   * Check for new general comments on a PR
   */
  private async checkNewComments(
    workspaceId: string,
    repo: WatchedRepo,
    pr: { number: number; title: string; html_url: string },
    state: PRState,
    currentUser: string | null
  ): Promise<void> {
    try {
      const comments = await githubService.getPRComments(workspaceId, repo.owner, repo.repo, pr.number);
      const newComments = comments.filter(c =>
        c.id > state.lastCommentId &&
        c.user.login !== currentUser // Don't notify about own comments
      );

      if (newComments.length > 0) {
        const commentCount = newComments.length;
        const users = [...new Set(newComments.map(c => c.user.login))];

        this.createInboxItem(workspaceId, {
          type: 'pr_comment',
          priority: 'low',
          title: `${commentCount} new comment${commentCount > 1 ? 's' : ''} on ${pr.title}`,
          summary: `${users.map(u => `@${u}`).join(', ')} commented on ${repo.fullName}#${pr.number}`,
          source: 'github',
          actions: [
            { label: 'View Comment', action: 'open_url', data: newComments[0].html_url },
            { label: 'View PR', action: 'open_url', data: pr.html_url },
          ],
          data: {
            repo: repo.fullName,
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            commentCount,
            commenters: users,
          },
        });
      }

      if (comments.length > 0) {
        state.lastCommentId = Math.max(...comments.map(c => c.id));
      }
    } catch (err: any) {
      console.error(`Failed to check comments for ${repo.fullName}#${pr.number}:`, err.message);
    }
  }

  /**
   * Check CI status changes
   */
  private async checkCIStatus(
    workspaceId: string,
    repo: WatchedRepo,
    pr: { number: number; title: string; html_url: string; head: { sha: string } },
    state: PRState
  ): Promise<void> {
    try {
      const checks = await githubService.getCheckRuns(workspaceId, repo.owner, repo.repo, pr.head.sha);
      const overallStatus = this.getOverallCheckStatus(checks.check_runs);

      // Notify on failure (only if status changed to failure)
      if (overallStatus === 'failure' && state.lastCheckStatus !== 'failure') {
        const failedChecks = checks.check_runs.filter(c => c.conclusion === 'failure');

        this.createInboxItem(workspaceId, {
          type: 'ci_failure',
          priority: 'high',
          title: `CI failed: ${pr.title}`,
          summary: `${failedChecks.length} check${failedChecks.length > 1 ? 's' : ''} failed on ${repo.fullName}#${pr.number}`,
          source: 'github',
          actions: [
            { label: 'View Checks', action: 'open_url', data: `${pr.html_url}/checks` },
            { label: 'View PR', action: 'open_url', data: pr.html_url },
          ],
          data: {
            repo: repo.fullName,
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            failedChecks: failedChecks.map(c => ({ name: c.name, url: c.html_url })),
          },
        });
      }

      state.lastCheckStatus = overallStatus;
    } catch (err: any) {
      console.error(`Failed to check CI status for ${repo.fullName}#${pr.number}:`, err.message);
    }
  }

  /**
   * Check if PR became mergeable
   */
  private checkMergeability(
    workspaceId: string,
    repo: WatchedRepo,
    pr: { number: number; title: string; html_url: string; mergeable: boolean | null; mergeable_state: string },
    state: PRState
  ): void {
    // Notify when PR becomes mergeable (was not mergeable before, now is)
    if (
      pr.mergeable === true &&
      pr.mergeable_state === 'clean' &&
      state.wasMergeable !== true
    ) {
      this.createInboxItem(workspaceId, {
        type: 'pr_ready',
        priority: 'medium',
        title: `Ready to merge: ${pr.title}`,
        summary: `${repo.fullName}#${pr.number} has all checks passing and is ready to merge`,
        source: 'github',
        actions: [
          { label: 'Merge PR', action: 'open_url', data: pr.html_url },
          { label: 'View PR', action: 'open_url', data: pr.html_url },
        ],
        data: {
          repo: repo.fullName,
          prNumber: pr.number,
          prTitle: pr.title,
          prUrl: pr.html_url,
        },
      });
    }

    state.wasMergeable = pr.mergeable;
  }

  /**
   * Get overall check status from check runs
   */
  private getOverallCheckStatus(checkRuns: Array<{ status: string; conclusion: string | null }>): string | null {
    if (checkRuns.length === 0) return null;

    const hasFailure = checkRuns.some(c => c.conclusion === 'failure');
    if (hasFailure) return 'failure';

    const hasPending = checkRuns.some(c => c.status !== 'completed');
    if (hasPending) return 'pending';

    const allSuccess = checkRuns.every(c =>
      c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral'
    );
    if (allSuccess) return 'success';

    return 'unknown';
  }

  /**
   * Create an inbox item
   */
  private createInboxItem(
    workspaceId: string,
    item: {
      type: string;
      priority: string;
      title: string;
      summary: string;
      source: string;
      actions: Array<{ label: string; action: string; data: string }>;
      data: Record<string, unknown>;
    }
  ): void {
    if (!this.db) return;

    const id = uuid();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO inbox_items (id, workspace_id, type, status, priority, title, summary, source, actions, data, created_at)
      VALUES (?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      workspaceId,
      item.type,
      item.priority,
      item.title,
      item.summary,
      item.source,
      JSON.stringify(item.actions),
      JSON.stringify(item.data),
      now
    );

    // Broadcast the new inbox item
    const inboxItem = {
      id,
      workspaceId,
      type: item.type,
      status: 'unread',
      priority: item.priority,
      title: item.title,
      summary: item.summary,
      source: item.source,
      actions: item.actions,
      data: item.data,
      createdAt: now,
    };

    broadcast(workspaceId, {
      type: 'inbox:created',
      payload: inboxItem,
    });

    this.emit('inbox_item_created', inboxItem);
  }

  /**
   * Force a poll (for testing or manual refresh)
   */
  async forcePoll(): Promise<void> {
    await this.poll();
  }
}

// Singleton instance
export const prMonitorService = new PRMonitorService();
