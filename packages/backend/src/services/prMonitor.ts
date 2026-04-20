import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { getDbClient, type Database } from '../db/client.js';
import {
  repositories as repositoriesTable,
  inboxItems as inboxItemsTable,
} from '../db/schema.js';
import { githubService } from './github.js';
import { broadcastToWorkspace } from './websocket.js';

interface WatchedRepo {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  fullName: string;
  /**
   * Absolute path where this repo is cloned on the environment's host.
   * Required before any agent task can run against the repo — the
   * create-task modal filters out repos without one.
   */
  localPath?: string;
  defaultBranch: string;
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
  repos: Map<string, Map<number, PRState>>;
  lastPoll: Map<string, string>;
}

const POLL_INTERVAL_MS = 60000;

class PRMonitorService extends EventEmitter {
  private state: MonitorState = {
    repos: new Map(),
    lastPoll: new Map(),
  };
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;

  private get db(): Database {
    return getDbClient();
  }

  async init(): Promise<void> {
    this.startPolling();
  }

  shutdown(): void {
    this.stopPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    console.log('Starting PR monitor polling...');
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    setTimeout(() => this.poll(), 5000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async getWatchedRepos(workspaceId: string): Promise<WatchedRepo[]> {
    const rows = await this.db
      .select({
        id: repositoriesTable.id,
        workspaceId: repositoriesTable.workspaceId,
        name: repositoriesTable.name,
        url: repositoriesTable.url,
        localPath: repositoriesTable.localPath,
        defaultBranch: repositoriesTable.defaultBranch,
      })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.workspaceId, workspaceId));

    return rows
      .map((row): WatchedRepo | null => {
        const match = row.url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
        if (!match) return null;
        const entry: WatchedRepo = {
          id: row.id,
          workspaceId: row.workspaceId,
          owner: match[1],
          repo: match[2].replace(/\.git$/, ''),
          fullName: `${match[1]}/${match[2].replace(/\.git$/, '')}`,
          defaultBranch: row.defaultBranch,
        };
        if (row.localPath) entry.localPath = row.localPath;
        return entry;
      })
      .filter((r): r is WatchedRepo => r !== null);
  }

  async addWatchedRepo(
    workspaceId: string,
    owner: string,
    repo: string,
    url?: string,
    localPath?: string
  ): Promise<WatchedRepo> {
    const id = uuid();
    const fullName = `${owner}/${repo}`;
    const repoUrl = url || `https://github.com/${fullName}`;
    const defaultBranch = 'main';

    await this.db.insert(repositoriesTable).values({
      id,
      workspaceId,
      name: fullName,
      url: repoUrl,
      localPath: localPath ?? null,
      defaultBranch,
      createdAt: new Date(),
    });

    const watched: WatchedRepo = {
      id,
      workspaceId,
      owner,
      repo,
      fullName,
      localPath,
      defaultBranch,
    };
    this.state.repos.set(fullName, new Map());
    return watched;
  }

  /**
   * Patch a watched repo's editable fields. Currently just `localPath`
   * — the user sets this after clicking Add so the repo has somewhere
   * to run tasks against.
   */
  async updateWatchedRepo(
    id: string,
    updates: { localPath?: string | null }
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (updates.localPath !== undefined) patch.localPath = updates.localPath;
    if (Object.keys(patch).length === 0) return;
    await this.db
      .update(repositoriesTable)
      .set(patch)
      .where(eq(repositoriesTable.id, id));
  }

  async removeWatchedRepo(repoId: string): Promise<void> {
    const rows = await this.db
      .select({ name: repositoriesTable.name })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, repoId))
      .limit(1);
    const row = rows[0];

    await this.db.delete(repositoriesTable).where(eq(repositoriesTable.id, repoId));

    if (row) {
      this.state.repos.delete(row.name);
      this.state.lastPoll.delete(row.name);
    }
  }

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const connectedWorkspaces = githubService.getConnectedWorkspaces();
      for (const workspaceId of connectedWorkspaces) {
        const repos = await this.getWatchedRepos(workspaceId);
        for (const repo of repos) {
          try {
            await this.pollRepo(workspaceId, repo);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'unknown error';
            console.error(`Failed to poll ${repo.fullName}:`, msg);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error('PR monitor poll error:', msg);
    } finally {
      this.isPolling = false;
    }
  }

  private async pollRepo(workspaceId: string, repo: WatchedRepo): Promise<void> {
    const prs = await githubService.listPullRequests(workspaceId, repo.owner, repo.repo, {
      state: 'open',
      per_page: 30,
    });

    let repoState = this.state.repos.get(repo.fullName);
    if (!repoState) {
      repoState = new Map();
      this.state.repos.set(repo.fullName, repoState);
    }

    let currentUser: string | null = null;
    try {
      const user = await githubService.getUser(workspaceId);
      currentUser = user.login;
    } catch {
      // Ignore
    }

    for (const pr of prs) {
      const isOwnPR = currentUser && pr.user.login === currentUser;
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

      if (isFirstSeen) {
        try {
          const reviews = await githubService.getPRReviews(workspaceId, repo.owner, repo.repo, pr.number);
          if (reviews.length > 0) prState.lastReviewId = Math.max(...reviews.map((r) => r.id));

          const reviewComments = await githubService.getPRReviewComments(
            workspaceId, repo.owner, repo.repo, pr.number
          );
          if (reviewComments.length > 0)
            prState.lastReviewCommentId = Math.max(...reviewComments.map((c) => c.id));

          const comments = await githubService.getPRComments(workspaceId, repo.owner, repo.repo, pr.number);
          if (comments.length > 0) prState.lastCommentId = Math.max(...comments.map((c) => c.id));

          const checks = await githubService.getCheckRuns(workspaceId, repo.owner, repo.repo, pr.head.sha);
          prState.lastCheckStatus = this.getOverallCheckStatus(checks.check_runs);
          prState.wasMergeable = pr.mergeable;
        } catch {
          // Ignore initialization errors
        }
        continue;
      }

      if (isOwnPR) await this.checkNewReviews(workspaceId, repo, pr, prState);
      await this.checkNewReviewComments(workspaceId, repo, pr, prState, currentUser);
      await this.checkNewComments(workspaceId, repo, pr, prState, currentUser);
      if (isOwnPR) await this.checkCIStatus(workspaceId, repo, pr, prState);
      if (isOwnPR) await this.checkMergeability(workspaceId, repo, pr, prState);
    }

    this.state.lastPoll.set(repo.fullName, new Date().toISOString());
  }

  private async checkNewReviews(
    workspaceId: string,
    repo: WatchedRepo,
    pr: { number: number; title: string; html_url: string },
    state: PRState
  ): Promise<void> {
    try {
      const reviews = await githubService.getPRReviews(workspaceId, repo.owner, repo.repo, pr.number);
      const newReviews = reviews.filter((r) => r.id > state.lastReviewId);

      for (const review of newReviews) {
        if (review.state === 'PENDING') continue;
        await this.createInboxItem(workspaceId, {
          type: 'pr_review',
          priority: review.state === 'CHANGES_REQUESTED' ? 'high' : 'medium',
          title: `${
            review.state === 'APPROVED'
              ? 'Approved'
              : review.state === 'CHANGES_REQUESTED'
                ? 'Changes requested'
                : 'Review'
          }: ${pr.title}`,
          summary: `@${review.user.login} ${review.state.toLowerCase().replace('_', ' ')} on ${repo.fullName}#${pr.number}`,
          prUrl: pr.html_url,
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

      if (reviews.length > 0) state.lastReviewId = Math.max(...reviews.map((r) => r.id));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`Failed to check reviews for ${repo.fullName}#${pr.number}:`, msg);
    }
  }

  private async checkNewReviewComments(
    workspaceId: string,
    repo: WatchedRepo,
    pr: { number: number; title: string; html_url: string },
    state: PRState,
    currentUser: string | null
  ): Promise<void> {
    try {
      const comments = await githubService.getPRReviewComments(
        workspaceId, repo.owner, repo.repo, pr.number
      );
      const newComments = comments.filter(
        (c) => c.id > state.lastReviewCommentId && c.user.login !== currentUser
      );

      if (newComments.length > 0) {
        const commentCount = newComments.length;
        const users = [...new Set(newComments.map((c) => c.user.login))];
        await this.createInboxItem(workspaceId, {
          type: 'pr_comment',
          priority: 'medium',
          title: `${commentCount} new review comment${commentCount > 1 ? 's' : ''} on ${pr.title}`,
          summary: `${users.map((u) => `@${u}`).join(', ')} commented on ${repo.fullName}#${pr.number}`,
          prUrl: pr.html_url,
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

      if (comments.length > 0) state.lastReviewCommentId = Math.max(...comments.map((c) => c.id));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`Failed to check review comments for ${repo.fullName}#${pr.number}:`, msg);
    }
  }

  private async checkNewComments(
    workspaceId: string,
    repo: WatchedRepo,
    pr: { number: number; title: string; html_url: string },
    state: PRState,
    currentUser: string | null
  ): Promise<void> {
    try {
      const comments = await githubService.getPRComments(workspaceId, repo.owner, repo.repo, pr.number);
      const newComments = comments.filter(
        (c) => c.id > state.lastCommentId && c.user.login !== currentUser
      );

      if (newComments.length > 0) {
        const commentCount = newComments.length;
        const users = [...new Set(newComments.map((c) => c.user.login))];
        await this.createInboxItem(workspaceId, {
          type: 'pr_comment',
          priority: 'low',
          title: `${commentCount} new comment${commentCount > 1 ? 's' : ''} on ${pr.title}`,
          summary: `${users.map((u) => `@${u}`).join(', ')} commented on ${repo.fullName}#${pr.number}`,
          prUrl: pr.html_url,
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

      if (comments.length > 0) state.lastCommentId = Math.max(...comments.map((c) => c.id));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`Failed to check comments for ${repo.fullName}#${pr.number}:`, msg);
    }
  }

  private async checkCIStatus(
    workspaceId: string,
    repo: WatchedRepo,
    pr: { number: number; title: string; html_url: string; head: { sha: string } },
    state: PRState
  ): Promise<void> {
    try {
      const checks = await githubService.getCheckRuns(workspaceId, repo.owner, repo.repo, pr.head.sha);
      const overallStatus = this.getOverallCheckStatus(checks.check_runs);

      if (overallStatus === 'failure' && state.lastCheckStatus !== 'failure') {
        const failedChecks = checks.check_runs.filter((c) => c.conclusion === 'failure');
        await this.createInboxItem(workspaceId, {
          type: 'ci_failure',
          priority: 'high',
          title: `CI failed: ${pr.title}`,
          summary: `${failedChecks.length} check${failedChecks.length > 1 ? 's' : ''} failed on ${repo.fullName}#${pr.number}`,
          prUrl: pr.html_url,
          actions: [
            { label: 'View Checks', action: 'open_url', data: `${pr.html_url}/checks` },
            { label: 'View PR', action: 'open_url', data: pr.html_url },
          ],
          data: {
            repo: repo.fullName,
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            failedChecks: failedChecks.map((c) => ({ name: c.name, url: c.html_url })),
          },
        });
      }

      state.lastCheckStatus = overallStatus;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`Failed to check CI status for ${repo.fullName}#${pr.number}:`, msg);
    }
  }

  private async checkMergeability(
    workspaceId: string,
    repo: WatchedRepo,
    pr: {
      number: number;
      title: string;
      html_url: string;
      mergeable: boolean | null;
      mergeable_state: string;
    },
    state: PRState
  ): Promise<void> {
    if (pr.mergeable === true && pr.mergeable_state === 'clean' && state.wasMergeable !== true) {
      await this.createInboxItem(workspaceId, {
        type: 'pr_ready',
        priority: 'medium',
        title: `Ready to merge: ${pr.title}`,
        summary: `${repo.fullName}#${pr.number} has all checks passing and is ready to merge`,
        prUrl: pr.html_url,
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

  private getOverallCheckStatus(
    checkRuns: Array<{ status: string; conclusion: string | null }>
  ): string | null {
    if (checkRuns.length === 0) return null;
    const hasFailure = checkRuns.some((c) => c.conclusion === 'failure');
    if (hasFailure) return 'failure';
    const hasPending = checkRuns.some((c) => c.status !== 'completed');
    if (hasPending) return 'pending';
    const allSuccess = checkRuns.every(
      (c) => c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral'
    );
    if (allSuccess) return 'success';
    return 'unknown';
  }

  private async createInboxItem(
    workspaceId: string,
    item: {
      type: string;
      priority: string;
      title: string;
      summary: string;
      /** The PR URL — used as the item's source id so dupes can be collapsed later. */
      prUrl: string;
      actions: Array<{ label: string; action: string; data: string }>;
      data: Record<string, unknown>;
    }
  ): Promise<void> {
    const id = uuid();
    const now = new Date();

    // source is stored as jsonb; prMonitor used to pass a plain 'github'
    // string which only worked under SQLite. Normalize to the same
    // { type, id, name } shape the rest of the app uses.
    const source = { type: 'github', id: item.prUrl, name: item.data.prTitle ?? 'GitHub' };

    await this.db.insert(inboxItemsTable).values({
      id,
      workspaceId,
      type: item.type,
      status: 'unread',
      priority: item.priority,
      title: item.title,
      summary: item.summary,
      source,
      actions: item.actions,
      data: item.data,
      createdAt: now,
    });

    const inboxItem = {
      id,
      workspaceId,
      type: item.type,
      status: 'unread',
      priority: item.priority,
      title: item.title,
      summary: item.summary,
      source,
      actions: item.actions,
      data: item.data,
      createdAt: now.toISOString(),
    };

    broadcastToWorkspace(workspaceId, {
      type: 'inbox:new',
      payload: { item: inboxItem },
      timestamp: new Date().toISOString(),
    });

    this.emit('inbox_item_created', inboxItem);
  }

  async forcePoll(): Promise<void> {
    await this.poll();
  }
}

export const prMonitorService = new PRMonitorService();
