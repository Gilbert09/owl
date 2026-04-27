import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { getDbClient, type Database } from '../db/client.js';
import {
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';
import { githubService } from './github.js';
import { batchPullRequests } from './githubGraphql.js';
import {
  upsertFromBatchResult,
  DEFAULT_TTL_MS,
} from './prCache.js';

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

const POLL_INTERVAL_MS = 60_000;

class PRMonitorService extends EventEmitter {
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  /** Cached current-user logins keyed by workspaceId — saves a round-trip
   *  per poll. Cleared when the OAuth token rotates (via removeToken). */
  private userLoginCache: Map<string, string> = new Map();

  private get db(): Database {
    return getDbClient();
  }

  async init(): Promise<void> {
    // Drop the cached login if the OAuth token gets revoked or
    // disconnected — otherwise the next poll would still try to use
    // the previous user's login as a filter.
    githubService.on('disconnected', (workspaceId: string) => {
      this.invalidateUserLogin(workspaceId);
    });
    this.startPolling();
  }

  shutdown(): void {
    this.stopPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    console.log('Starting PR monitor polling...');
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    setTimeout(() => this.poll(), 5_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------- Repo CRUD (unchanged surface, used by /repositories) ----------

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

    return {
      id,
      workspaceId,
      owner,
      repo,
      fullName,
      localPath,
      defaultBranch,
    };
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
    await this.db.delete(repositoriesTable).where(eq(repositoriesTable.id, repoId));
  }

  // ---------- Polling ----------

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const connectedWorkspaces = githubService.getConnectedWorkspaces();
      for (const workspaceId of connectedWorkspaces) {
        try {
          await this.pollWorkspace(workspaceId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.error(`PR monitor: workspace ${workspaceId.slice(0, 8)} poll failed:`, msg);
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * One workspace per tick. Per repo:
   *   1. List open PRs (REST, single page of 100) and filter to ones
   *      authored by the connected user. This is the "all PRs owned
   *      by the authed user in watched repos" scope.
   *   2. Group their head branches and call `batchPullRequests` for
   *      the GraphQL summary + checks rollup in one round-trip per
   *      chunk of 25.
   *   3. For each result, hand off to `prCache.upsertFromBatchResult`
   *      — that's where the cursor diff runs and inbox items get
   *      emitted.
   *   4. Sweep any tracked PRs we own in the DB but didn't see in the
   *      open list and mark them closed/merged so the GitHub page
   *      stops actively polling them.
   */
  private async pollWorkspace(workspaceId: string): Promise<void> {
    const login = await this.resolveCurrentUser(workspaceId);
    if (!login) return;
    const repos = await this.getWatchedRepos(workspaceId);

    for (const repo of repos) {
      try {
        await this.pollRepo(workspaceId, repo, login);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.error(`PR monitor: ${repo.fullName} poll failed:`, msg);
      }
    }
  }

  private async pollRepo(
    workspaceId: string,
    repo: WatchedRepo,
    currentUserLogin: string
  ): Promise<void> {
    // REST list is cheap: one paginated call returns up to 100 open
    // PRs with author. Filter to user-authored. We don't need the full
    // detail here — the GraphQL batch fetch supplies that.
    const all = await githubService.listPullRequests(workspaceId, repo.owner, repo.repo, {
      state: 'open',
      per_page: 100,
    });
    const ownPRs = all.filter((pr) => pr.user.login === currentUserLogin);

    if (ownPRs.length === 0) {
      await this.sweepClosed(workspaceId, repo.id, []);
      return;
    }

    // Determine which PRs are actually stale enough to need a refetch
    // (saves the GraphQL call when nothing has aged past the TTL).
    const stalePrs = await this.filterStale(workspaceId, repo.id, ownPRs);
    if (stalePrs.length === 0) {
      // Still sweep closed — the user might have merged something
      // outside the TTL window.
      await this.sweepClosed(workspaceId, repo.id, ownPRs.map((p) => p.number));
      return;
    }

    const branches = stalePrs.map((p) => p.head.ref);
    const results = await batchPullRequests({
      workspaceId,
      owner: repo.owner,
      repo: repo.repo,
      branches,
    });

    for (const result of results) {
      if (!result.pr) continue;
      await upsertFromBatchResult({
        workspaceId,
        repositoryId: repo.id,
        summary: result.pr,
      });
    }

    await this.sweepClosed(workspaceId, repo.id, ownPRs.map((p) => p.number));
  }

  private async filterStale(
    workspaceId: string,
    repositoryId: string,
    prs: Array<{ number: number; head: { ref: string } }>
  ): Promise<Array<{ number: number; head: { ref: string } }>> {
    if (prs.length === 0) return [];
    const numbers = prs.map((p) => p.number);
    const rows = await this.db
      .select({
        number: pullRequestsTable.number,
        lastPolledAt: pullRequestsTable.lastPolledAt,
      })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId)
        )
      );
    const cached = new Map<number, Date>();
    for (const row of rows) {
      if (numbers.includes(row.number)) cached.set(row.number, row.lastPolledAt);
    }
    const now = Date.now();
    return prs.filter((p) => {
      const polledAt = cached.get(p.number);
      if (!polledAt) return true; // never seen; always stale
      return now - polledAt.getTime() >= DEFAULT_TTL_MS;
    });
  }

  /**
   * Mark any DB row we've been polling as closed/merged once it stops
   * appearing in the open-PR list. Stops the row from being repolled
   * but keeps the row around so the user can filter "merged PRs from
   * my old tasks" on the GitHub page.
   *
   * Not strict about "merged" vs "closed" — the next time the user
   * opens the detail panel a fresh GraphQL fetch will populate the
   * exact state. We just need the row out of the active-poll set.
   */
  private async sweepClosed(
    workspaceId: string,
    repositoryId: string,
    seenNumbers: number[]
  ): Promise<void> {
    const rows = await this.db
      .select({ number: pullRequestsTable.number, id: pullRequestsTable.id })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId),
          eq(pullRequestsTable.state, 'open')
        )
      );
    const seen = new Set(seenNumbers);
    const stale = rows.filter((r) => !seen.has(r.number));
    if (stale.length === 0) return;
    for (const row of stale) {
      await this.db
        .update(pullRequestsTable)
        .set({ state: 'closed', updatedAt: new Date() })
        .where(eq(pullRequestsTable.id, row.id));
    }
  }

  private async resolveCurrentUser(workspaceId: string): Promise<string | null> {
    const cached = this.userLoginCache.get(workspaceId);
    if (cached) return cached;
    try {
      const user = await githubService.getUser(workspaceId);
      this.userLoginCache.set(workspaceId, user.login);
      return user.login;
    } catch {
      return null;
    }
  }

  /**
   * Test/admin entry point. Drains any in-flight tick before running a
   * fresh one, so callers can rely on "after this resolves, every
   * connected workspace's PRs were just refreshed".
   */
  async forcePoll(): Promise<void> {
    while (this.isPolling) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await this.poll();
  }

  /**
   * Drop a cached login — called when a workspace's GitHub OAuth token
   * is removed (revoked / disconnected). Without this, the next poll
   * would still try to use the previous user's login as a filter.
   */
  invalidateUserLogin(workspaceId: string): void {
    this.userLoginCache.delete(workspaceId);
  }
}

export const prMonitorService = new PRMonitorService();
