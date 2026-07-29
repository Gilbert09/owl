import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getPoolDbClient, type Database } from '../db/client.js';
import {
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { githubService } from './github.js';
import { parseRepoUrl } from './repoIdentity.js';
import {
  batchPullRequestsByNumber,
  type BatchPRByNumberResult,
  type PRSummary,
} from './githubGraphql.js';
import { upsertFromBatchResult } from './prCache.js';
import { ttlFor, isCohortActive } from './prFocus.js';
import { emitPullRequestUpdated } from './websocket.js';
import { domainEvents } from './events.js';
import {
  broadcastMergeQueuePositions,
  QUEUE_RESET_COLUMNS,
} from './mergeQueueBroadcast.js';
import { TickGuard } from './tickGuard.js';

interface WatchedRepo {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
}

/** The minimal tracked-open row shape the close-out paths carry (no lastSummary blob). */
interface TrackedOpenRow {
  id: string;
  taskId: string | null;
  owner: string;
  repo: string;
  number: number;
  mergeQueued: boolean;
}

/**
 * Tick-scoped cache for `sweepClosedViaRest`, shared across every workspace in
 * one reconcile-sweep tick: N workspaces watching the same repo reuse ONE
 * open-list fetch and ONE per-PR lookup (promises, so concurrent callers
 * coalesce too). Create a fresh one per tick — a stale open list must not
 * outlive the tick that fetched it.
 */
export interface RestSweepCache {
  openLists: Map<string, Promise<Set<number> | null>>;
  prLookups: Map<string, Promise<{ state: 'open' | 'closed'; mergedAt: string | null } | null>>;
}

export function createRestSweepCache(): RestSweepCache {
  return { openLists: new Map(), prLookups: new Map() };
}

// GitHub computes `mergeable` lazily: the first query kicks off a
// background job and returns UNKNOWN, and every base-branch push resets it
// to UNKNOWN until recomputed. On a busy repo a single poll usually lands
// on UNKNOWN, which renders as a blank status pill. Re-query the still-
// UNKNOWN open PRs a few times with a short backoff so we persist the
// resolved MERGEABLE/CONFLICTING instead.
const UNKNOWN_MERGEABLE_RETRIES = 3;
const UNKNOWN_MERGEABLE_BACKOFF_MS = 1_500;

// Cross-workspace fetch de-dup window for the bulk poll. When many workspaces
// track one shared org, a PR fetched for one this window serves the rest (see
// `batchPullRequestsByNumber`'s dedupe note). 60s = the active-cohort freshness
// bound, so this never serves data staler than the poll already tolerates, while
// collapsing the same-PR-across-workspaces amplification within a poll pass.
const BULK_POLL_DEDUPE_MS = 60_000;

// How long a forced poll (user-facing Refresh) waits for an in-flight tick
// before giving up. Keeps `POST /repositories/poll` bounded — see
// `drainInFlightTick`.
const FORCE_POLL_DRAIN_MS = 15_000;

// Mirrors webhookWorker's WEBHOOK_TRACE switch (kept local to dodge the import
// cycle — webhookWorker already imports prMonitor). Lets `refreshPr` log the
// state it actually resolved + whether it upserted/emitted, which is the
// missing piece when tracing a merge that didn't propagate.
const WEBHOOK_TRACE =
  process.env.WEBHOOK_TRACE === '1' || process.env.WEBHOOK_TRACE === 'true';
function whTrace(msg: string): void {
  if (WEBHOOK_TRACE) console.log(`[wh-trace] ${msg}`);
}

class PRMonitorService extends EventEmitter {
  // Wedge watchdog for the on-demand full poll (user Refresh + reconcile sweep):
  // a single stalled await must never let two refreshes overlap. See TickGuard.
  // The periodic 30s/10s loops are gone — PR freshness is webhook-driven, with
  // the reconcile sweep (15 min) as the bucket/closed-PR backstop.
  private pollGuard = new TickGuard('prMonitor');
  /** Cached current-user logins keyed by workspaceId — saves a round-trip
   *  per poll. Cleared when the token rotates / disconnects (via removeToken). */
  private userLoginCache: Map<string, string> = new Map();
  // Watched repos the GitHub App can't access (private repo not in the
  // installation's selected list). Tracked `${workspaceId}:${fullName}` so we
  // log the "grant access" notice ONCE, not every sweep, and log recovery once.
  private inaccessibleRepos: Set<string> = new Set();

  private get db(): Database {
    // The monitor is a background, cross-owner service: its global poll
    // (incl. the admin-triggered forcePoll) must see every workspace, so it
    // always uses the pool — never an owner-scoped request transaction.
    return getPoolDbClient();
  }

  async init(): Promise<void> {
    // Drop the cached login if the OAuth token gets revoked or
    // disconnected — otherwise the next poll would still try to use
    // the previous user's login as a filter.
    githubService.on('disconnected', (workspaceId: string) => {
      this.invalidateUserLogin(workspaceId);
    });
    // No periodic loop and no poller tile: webhooks drive realtime freshness +
    // buckets, and the reconcile sweep is the backstop. `poll()` survives only
    // as the on-demand entry point (user Refresh / forced).
  }

  shutdown(): void {
    // No periodic timers to stop — kept for the index.ts shutdown contract.
  }

  // ---------- Repo CRUD (unchanged surface, used by /repositories) ----------

  async getWatchedRepos(workspaceId: string): Promise<WatchedRepo[]> {
    const rows = await this.db
      .select({
        id: repositoriesTable.id,
        workspaceId: repositoriesTable.workspaceId,
        name: repositoriesTable.name,
        url: repositoriesTable.url,
        defaultBranch: repositoriesTable.defaultBranch,
      })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.workspaceId, workspaceId));

    return rows
      .map((row): WatchedRepo | null => {
        const identity = parseRepoUrl(row.url);
        if (!identity) return null;
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          owner: identity.owner,
          repo: identity.repo,
          fullName: identity.fullName,
          defaultBranch: row.defaultBranch,
        };
      })
      .filter((r): r is WatchedRepo => r !== null);
  }

  async addWatchedRepo(
    workspaceId: string,
    owner: string,
    repo: string,
    url?: string
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
      defaultBranch,
      createdAt: new Date(),
    });

    return { id, workspaceId, owner, repo, fullName, defaultBranch };
  }

  async removeWatchedRepo(repoId: string): Promise<void> {
    await this.db.delete(repositoriesTable).where(eq(repositoriesTable.id, repoId));
  }

  // ---------- Polling ----------

  private async poll(): Promise<void> {
    if (!this.pollGuard.tryBegin()) return;
    try {
      for (const workspaceId of githubService.getConnectedWorkspaces()) {
        try {
          await this.pollWorkspace(workspaceId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.error(`PR monitor: workspace ${workspaceId.slice(0, 8)} poll failed:`, msg);
        }
      }
    } finally {
      this.pollGuard.end();
    }
  }

  /**
   * One workspace per tick. Per repo:
   *   1. Search for the connected user's open PRs (authored +
   *      review-requested). Search — not "list the repo's open PRs and
   *      filter" — because a big repo (hundreds of open PRs) buries the
   *      user's own beyond the first page, dropping them silently.
   *   2. For the stale ones, call `batchPullRequestsByNumber` for the
   *      GraphQL summary + checks rollup in one round-trip per chunk.
   *   3. For each result, hand off to `prCache.upsertFromBatchResult`
   *      — that's where the cursor diff runs and the row's PR-event
   *      cursors are advanced.
   *   4. Sweep any tracked PRs we own in the DB but didn't see in the
   *      search and mark them closed/merged so the GitHub page stops
   *      actively polling them.
   */
  /**
   * Full re-poll of one workspace, on demand. The bulk-refresh fallback: run on
   * App (re)connect, after a paused→active transition, and by the low-frequency
   * reconcile sweep to catch any webhook deliveries that were dropped or missed.
   * Re-derives buckets + summaries exactly as a scheduled tick would.
   */
  async refreshWorkspaceNow(workspaceId: string): Promise<void> {
    await this.pollWorkspace(workspaceId);
  }

  private async pollWorkspace(workspaceId: string): Promise<void> {
    const login = await this.resolveCurrentUser(workspaceId);
    if (!login) return;
    const repos = await this.getWatchedRepos(workspaceId);

    for (const repo of repos) {
      const accessKey = `${workspaceId}:${repo.fullName}`;
      try {
        await this.pollRepo(workspaceId, repo, login);
        // Recovered (e.g. the App was just granted access) — note it once.
        if (this.inaccessibleRepos.delete(accessKey)) {
          console.log(`PR monitor: ${repo.fullName} is now accessible to the GitHub App`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        // A watched repo the App can't reach (private repo not in the
        // installation's selected list): no token can read it until access is
        // granted on GitHub. Log the actionable notice ONCE, then stay quiet —
        // don't spam this every 5-min sweep.
        if (isRepoAccessError(msg)) {
          if (!this.inaccessibleRepos.has(accessKey)) {
            this.inaccessibleRepos.add(accessKey);
            console.warn(
              `PR monitor: the GitHub App has no access to ${repo.fullName} — grant it on GitHub (org → Installed GitHub Apps → Repository access). Skipping until then.`
            );
          }
          continue;
        }
        console.error(`PR monitor: ${repo.fullName} poll failed:`, msg);
      }
    }
  }

  private async pollRepo(
    workspaceId: string,
    repo: WatchedRepo,
    currentUserLogin: string
  ): Promise<void> {
    // Two scoped searches: PRs the user authored, and PRs awaiting their
    // review. Each returns exactly the matches regardless of how many
    // open PRs the repo has overall.
    const full = `${repo.owner}/${repo.repo}`;
    // Three scoped searches:
    //   - authored: PRs the user opened ("Mine").
    //   - review-requested: PRs the user is asked to review, INCLUDING ones
    //     where only a team they're on was asked.
    //   - reviewed-by: PRs the user has already reviewed (approved, requested
    //     changes, or commented).
    // "Awaiting my review" = review-requested MINUS reviewed-by (and minus my
    // own PRs). GitHub drops you from a PR's *individual* request once you
    // review it, but leaves a *team* request standing — so subtracting
    // reviewed-by is what actually clears an approved PR off the list.
    // Run the three searches SERIALLY, not concurrently. GitHub explicitly asks
    // for serial requests per user and is most aggressive about secondary rate
    // limits on the tight `search` budget (30/min) — three concurrent searches
    // per repo was the main trigger for the "exceeded a secondary rate limit"
    // 403s. (The github layer also serializes searches per account as a backstop
    // across repos/workspaces.)
    const authoredNums = await githubService.searchPullRequestNumbers(
      workspaceId,
      `repo:${full} is:pr is:open author:${currentUserLogin}`
    );
    const requestedNums = await githubService.searchPullRequestNumbers(
      workspaceId,
      `repo:${full} is:pr is:open review-requested:${currentUserLogin}`
    );
    const reviewedNums = await githubService.searchPullRequestNumbers(
      workspaceId,
      `repo:${full} is:pr is:open reviewed-by:${currentUserLogin}`
    );
    const authoredSet = new Set(authoredNums);
    const reviewedSet = new Set(reviewedNums);
    const pendingSet = new Set<number>();
    for (const n of requestedNums) {
      if (!reviewedSet.has(n) && !authoredSet.has(n)) pendingSet.add(n);
    }
    // Watch everything we have any relationship with — incl. reviewed
    // review-requested PRs, so their summary stays fresh and the reconcile
    // pass below sees them — but only pendingSet drives the review flag.
    const watchedNumbers = Array.from(new Set([...authoredNums, ...requestedNums]));

    // Tracked-open rows that have fallen out of all three searches (e.g. a PR
    // we were review-requested on, then reviewed, that's still open on
    // GitHub). They never reappear in the search, so without folding them in
    // here their summary — CI, mergeable, title — would freeze forever while
    // the row stays visible on the GitHub page. Refresh them too, on the
    // slacker UNTRACKED TTL (focus still overrides via `filterStale`).
    const watchedSet = new Set(watchedNumbers);
    const untrackedOpen = (await this.getTrackedOpenNumbers(workspaceId, repo.id)).filter(
      (n) => !watchedSet.has(n)
    );
    const untrackedSet = new Set(untrackedOpen);
    const candidateNumbers = [...watchedNumbers, ...untrackedOpen];

    // Determine which PRs are actually stale enough to need a refetch
    // (saves the GraphQL call when nothing has aged past the TTL).
    const staleNumbers = candidateNumbers.length
      ? await this.filterStale(workspaceId, repo.id, candidateNumbers, untrackedSet)
      : [];

    if (staleNumbers.length > 0) {
      const results = await this.resolveUnknownMergeable(
        workspaceId,
        repo,
        await batchPullRequestsByNumber({
          workspaceId,
          owner: repo.owner,
          repo: repo.repo,
          numbers: staleNumbers,
          // De-dup the shared-repo amplification: when many workspaces poll the
          // same big org (16 track PostHog/posthog), each re-fetches the same PRs
          // against one GraphQL budget. A PR fetched for one workspace this window
          // serves the others too. Window ≤ the poll's own freshness tolerance,
          // so no workspace sees data staler than it already accepts.
          dedupeWindowMs: BULK_POLL_DEDUPE_MS,
        })
      );

      for (const result of results) {
        if (!result.pr) continue;
        await this.annotateReviewRequest(workspaceId, result.pr);
        await upsertFromBatchResult({
          workspaceId,
          repositoryId: repo.id,
          summary: result.pr,
          reviewRequested: pendingSet.has(result.pr.number),
          authored: authoredSet.has(result.pr.number),
        });
      }
    }

    await this.sweepClosed(workspaceId, repo, watchedNumbers);
    // Reconcile relationship flags against the authoritative search results
    // for EVERY tracked-open row — not just the freshly-upserted ones — so a
    // PR whose flag should change but which didn't need a summary refetch
    // (e.g. it fell out of review-requested, or the user just reviewed it)
    // still flips. Without this an approved PR lingers on the Review list.
    await this.reconcileRelationshipFlags(workspaceId, repo.id, authoredSet, pendingSet);
  }

  /**
   * Bring each tracked-open row's `authored` / `reviewRequested` flags into
   * line with the current search results, emitting `pull_request:updated`
   * for any row that changed so the GitHub page re-buckets it live. Only
   * touches rows whose flags actually differ.
   */
  private async reconcileRelationshipFlags(
    workspaceId: string,
    repositoryId: string,
    authoredSet: Set<number>,
    pendingSet: Set<number>
  ): Promise<void> {
    // Note: `lastSummary` is deliberately NOT selected here — most ticks
    // change zero rows, so pulling the ~2KB summary jsonb for every open PR
    // was pure egress waste. The rare changed row re-fetches just its own
    // summary below before emitting.
    const rows = await this.db
      .select({
        id: pullRequestsTable.id,
        number: pullRequestsTable.number,
        taskId: pullRequestsTable.taskId,
        owner: pullRequestsTable.owner,
        repo: pullRequestsTable.repo,
        state: pullRequestsTable.state,
        reviewRequested: pullRequestsTable.reviewRequested,
        authored: pullRequestsTable.authored,
      })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId),
          eq(pullRequestsTable.state, 'open')
        )
      );

    for (const row of rows) {
      const authored = authoredSet.has(row.number);
      const reviewRequested = pendingSet.has(row.number);
      if (authored === row.authored && reviewRequested === row.reviewRequested) {
        continue;
      }
      await this.db
        .update(pullRequestsTable)
        .set({ authored, reviewRequested, updatedAt: new Date() })
        .where(eq(pullRequestsTable.id, row.id));
      // The flag UPDATE above doesn't touch `lastSummary`, so this reads the
      // current value. Fetched per changed row (usually 0/tick), not in bulk.
      const [summaryRow] = await this.db
        .select({ lastSummary: pullRequestsTable.lastSummary })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, row.id))
        .limit(1);
      emitPullRequestUpdated(workspaceId, {
        id: row.id,
        taskId: row.taskId,
        repositoryId,
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        state: row.state,
        lastSummary: (summaryRow?.lastSummary as Record<string, unknown> | null) ?? {},
        reviewRequested,
        authored,
      });
    }
  }

  /**
   * Resolve PRs GitHub returned with `mergeable: UNKNOWN` (open PRs only —
   * merged/closed have no meaningful mergeability). GitHub computes it
   * lazily, so the first query triggers the job and a follow-up a moment
   * later returns the real value. Re-query the UNKNOWN ones a few times
   * with a short backoff and splice resolved summaries back in. Returns a
   * new results array; gives up (keeping UNKNOWN) after the retry budget.
   */
  private async resolveUnknownMergeable(
    workspaceId: string,
    repo: WatchedRepo,
    results: BatchPRByNumberResult[]
  ): Promise<BatchPRByNumberResult[]> {
    const byNumber = new Map(results.map((r) => [r.number, r]));
    let pending = results
      .filter((r) => r.pr?.state === 'open' && r.pr.mergeable === 'UNKNOWN')
      .map((r) => r.number);
    if (pending.length === 0) return results;

    for (let attempt = 0; attempt < UNKNOWN_MERGEABLE_RETRIES && pending.length > 0; attempt++) {
      await delay(UNKNOWN_MERGEABLE_BACKOFF_MS);
      const refetched = await batchPullRequestsByNumber({
        workspaceId,
        owner: repo.owner,
        repo: repo.repo,
        numbers: pending,
      });
      const stillPending: number[] = [];
      for (const r of refetched) {
        if (r.pr) byNumber.set(r.number, r);
        if (r.pr?.state === 'open' && r.pr.mergeable === 'UNKNOWN') {
          stillPending.push(r.number);
        }
      }
      pending = stillPending;
    }
    if (pending.length > 0) {
      console.log(
        `[prMonitor] ${repo.owner}/${repo.repo}: ${pending.length} PR(s) still UNKNOWN mergeable after ${UNKNOWN_MERGEABLE_RETRIES} retries — GitHub still computing`
      );
    }
    return results.map((r) => byNumber.get(r.number) ?? r);
  }

  /**
   * Open PR numbers we're already tracking in the DB for this repo. Used to
   * keep refreshing rows that have dropped out of the live search but remain
   * open on GitHub.
   */
  private async getTrackedOpenNumbers(
    workspaceId: string,
    repositoryId: string
  ): Promise<number[]> {
    const rows = await this.db
      .select({ number: pullRequestsTable.number })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId),
          eq(pullRequestsTable.state, 'open')
        )
      );
    return rows.map((r) => r.number);
  }

  /**
   * Which of `numbers` are tracked OPEN, across ALL the given repositories, in a
   * SINGLE query — returned as `repositoryId → tracked numbers`. The webhook
   * fan-out calls this once per delivery (a repo watched in N workspaces has N
   * distinct repository rows) instead of one query per workspace. Each
   * `repositoryId` is unique to one (workspace, repo), so `repository_id IN (…)`
   * already disambiguates the workspace. Drops the high-volume check events (a
   * check_run can list several PRs, incl. cross-fork junk) for PRs we don't
   * track — the overwhelming majority on a busy repo — for one round-trip total.
   */
  async filterTrackedOpenAcross(
    repositoryIds: string[],
    numbers: number[]
  ): Promise<Map<string, Set<number>>> {
    const byRepo = new Map<string, Set<number>>();
    if (repositoryIds.length === 0 || numbers.length === 0) return byRepo;
    const rows = await this.db
      .select({
        repositoryId: pullRequestsTable.repositoryId,
        number: pullRequestsTable.number,
      })
      .from(pullRequestsTable)
      .where(
        and(
          inArray(pullRequestsTable.repositoryId, repositoryIds),
          eq(pullRequestsTable.state, 'open'),
          inArray(pullRequestsTable.number, numbers)
        )
      );
    for (const r of rows) {
      let set = byRepo.get(r.repositoryId);
      if (!set) {
        set = new Set();
        byRepo.set(r.repositoryId, set);
      }
      set.add(r.number);
    }
    return byRepo;
  }

  private async filterStale(
    workspaceId: string,
    repositoryId: string,
    numbers: number[],
    untracked?: Set<number>
  ): Promise<number[]> {
    if (numbers.length === 0) return [];
    const rows = await this.db
      .select({
        id: pullRequestsTable.id,
        number: pullRequestsTable.number,
        lastPolledAt: pullRequestsTable.lastPolledAt,
        authored: pullRequestsTable.authored,
        reviewRequested: pullRequestsTable.reviewRequested,
      })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId)
        )
      );
    // Build (number → row) so we can ask prFocus whether each PR is
    // focused/in-cooldown and whether its cohort is the one being viewed.
    // The id matches the `pull_requests.id` we hand out in /focus.
    const cached = new Map<
      number,
      { id: string; lastPolledAt: Date; authored: boolean; reviewRequested: boolean }
    >();
    for (const row of rows) {
      if (numbers.includes(row.number)) {
        cached.set(row.number, {
          id: row.id,
          lastPolledAt: row.lastPolledAt,
          authored: row.authored,
          reviewRequested: row.reviewRequested,
        });
      }
    }
    const now = Date.now();
    return numbers.filter((number) => {
      const entry = cached.get(number);
      if (!entry) return true; // never seen; always stale
      // Per-PR TTL: focused = 30 s, active-cohort settled = 60 s, untracked
      // or inactive-cohort = 5 min, cooldown = effectively infinite. The poll
      // tick fires every 30 s so a focused PR can refetch the moment it ages.
      const ttl = ttlFor(workspaceId, entry.id, {
        cohortActive: isCohortActive(workspaceId, entry),
        untracked: untracked?.has(number) ?? false,
      });
      return now - entry.lastPolledAt.getTime() >= ttl;
    });
  }

  /**
   * Mark any DB row we've been polling as closed/merged once it stops
   * appearing in the open-PR list. Stops the row from being repolled
   * but keeps the row around so the user can filter "merged PRs from
   * my old tasks" on the GitHub page.
   *
   * Disambiguates merged vs closed by hitting the per-PR REST endpoint
   * (`merged_at` is the canonical signal). The batch GraphQL query
   * filters on `states: [OPEN]`, so it can't tell us — and without
   * this distinction every merged PR ends up wrongly stuck in the
   * Closed tab. On REST failure we fall back to 'closed' so a flaky
   * call doesn't keep repolling the row forever.
   */
  private async sweepClosed(
    workspaceId: string,
    repo: WatchedRepo,
    seenNumbers: number[]
  ): Promise<void> {
    const rows = await this.getTrackedOpenRows(workspaceId, repo.id);
    const seen = new Set(seenNumbers);
    const stale = rows.filter((r) => !seen.has(r.number));
    if (stale.length === 0) return;

    // Resolve merged-vs-closed for every stale row in ONE batched GraphQL call
    // (`pullRequest(number:)` returns merged/closed PRs too) instead of an N+1
    // chain of per-PR REST lookups. The serial REST chain dragged the tick out
    // and burned the REST rate-limit budget on repos with many fallen-out PRs,
    // which then stretched the adaptive poller — the dominant slowdown when a
    // user has a lot of PRs in flight.
    let byNumber: Map<number, PRSummary | null>;
    try {
      const results = await batchPullRequestsByNumber({
        workspaceId,
        owner: repo.owner,
        repo: repo.repo,
        numbers: stale.map((r) => r.number),
      });
      byNumber = new Map(results.map((r) => [r.number, r.pr]));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.warn(`[pr-monitor] sweep batch lookup failed for ${repo.fullName}: ${msg}`);
      return; // skip this tick and retry — never mass-close on a transient error.
    }
    // A successful response that resolved NOTHING (every PR null) means the repo
    // node came back empty (access/transient blip), not that N PRs all closed —
    // a genuinely closed/merged PR still resolves with a non-null summary. Skip
    // rather than risk mass-closing open rows.
    if (![...byNumber.values()].some((pr) => pr !== null)) return;

    let sweptQueued = false;
    for (const row of stale) {
      const pr = byNumber.get(row.number) ?? null;
      // A review-requested PR drops out of our watch list the moment the user
      // submits their review, but stays OPEN on GitHub — leave it untouched.
      if (pr && pr.state === 'open' && !pr.mergedAt) continue;
      // `pr == null` here is a number GitHub returned no node for while others
      // resolved — treat it as closed so a vanished PR doesn't re-poll forever.
      const merged = Boolean(pr && (pr.mergedAt || pr.state === 'merged'));
      const mergedAt: Date | null = merged
        ? pr?.mergedAt
          ? new Date(pr.mergedAt)
          : new Date()
        : null;
      await this.closeTrackedRow(workspaceId, repo.id, row, merged ? 'merged' : 'closed', mergedAt);
      if (row.mergeQueued) sweptQueued = true;
    }
    // A queued PR left the group — reshuffle the survivors' "#N" badges now
    // rather than waiting for the next processor action or a manual refresh.
    if (sweptQueued) await broadcastMergeQueuePositions(workspaceId);
  }

  /**
   * REST-only closed-PR reconcile for one workspace — the sweep's cheap
   * fallback when the account's GraphQL budget is in reserve and the full
   * (GraphQL) re-poll is deferred. Without it, a merged/closed PR whose
   * webhook delivery was dropped stays "open" in the UI until a manual
   * refresh (June 2026: an ~8-min GitHub delivery outage during a
   * budget-reserve window left merged PRs stuck on the open list).
   *
   * Diffs the tracked-open rows against the repo's REST open-PR list, then
   * confirms each candidate with a direct per-PR REST fetch before closing —
   * the list is a cheap prefilter, the direct fetch is authoritative (it also
   * guards against pagination races and gives merged-vs-closed via
   * `merged_at`). A failed list or lookup skips the repo/row; we never close
   * on missing data. Spends core REST budget only, zero GraphQL points.
   *
   * `cache` is shared across one sweep tick so the N workspaces watching the
   * same repo make ONE list call and ONE lookup per closed PR (the same
   * dedup principle as refreshPrAcrossWorkspaces). Returns rows closed.
   */
  async sweepClosedViaRest(workspaceId: string, cache: RestSweepCache): Promise<number> {
    const repos = await this.getWatchedRepos(workspaceId);
    let closedCount = 0;
    for (const repo of repos) {
      const rows = await this.getTrackedOpenRows(workspaceId, repo.id);
      if (rows.length === 0) continue;
      const repoKey = repo.fullName.toLowerCase();
      let listPromise = cache.openLists.get(repoKey);
      if (!listPromise) {
        listPromise = githubService
          .listOpenPullRequestNumbers(workspaceId, repo.owner, repo.repo)
          .then((nums) => new Set(nums))
          .catch(() => null);
        cache.openLists.set(repoKey, listPromise);
      }
      const openSet = await listPromise;
      if (!openSet) continue;
      let sweptQueued = false;
      for (const row of rows) {
        if (openSet.has(row.number)) continue;
        const prKey = `${repoKey}#${row.number}`;
        let lookup = cache.prLookups.get(prKey);
        if (!lookup) {
          lookup = githubService
            .getPullRequest(workspaceId, repo.owner, repo.repo, row.number)
            .then((pr) => ({ state: pr.state, mergedAt: pr.merged_at ?? null }))
            .catch(() => null);
          cache.prLookups.set(prKey, lookup);
        }
        const pr = await lookup;
        if (!pr || pr.state === 'open') continue;
        const mergedAt = pr.mergedAt ? new Date(pr.mergedAt) : null;
        await this.closeTrackedRow(
          workspaceId,
          repo.id,
          row,
          mergedAt ? 'merged' : 'closed',
          mergedAt
        );
        if (row.mergeQueued) sweptQueued = true;
        closedCount++;
      }
      if (sweptQueued) await broadcastMergeQueuePositions(workspaceId);
    }
    return closedCount;
  }

  /**
   * Tracked-open rows for a repo, in the minimal shape the close-out paths
   * need. `lastSummary` is deliberately NOT selected — most ticks close zero
   * rows, so shipping the ~2KB jsonb for every open row was pure egress waste;
   * closeTrackedRow re-fetches it for the rare row that actually closes.
   */
  private async getTrackedOpenRows(
    workspaceId: string,
    repositoryId: string
  ): Promise<TrackedOpenRow[]> {
    return this.db
      .select({
        number: pullRequestsTable.number,
        id: pullRequestsTable.id,
        taskId: pullRequestsTable.taskId,
        owner: pullRequestsTable.owner,
        repo: pullRequestsTable.repo,
        mergeQueued: pullRequestsTable.mergeQueued,
      })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId),
          eq(pullRequestsTable.state, 'open')
        )
      );
  }

  /**
   * Mark one tracked row merged/closed and tell the desktop, clearing the
   * merge-queue bookkeeping in the same write — a PR that left `open` can't
   * be merged by the queue, and leaving the flags set once stalled the whole
   * (repo, base) group: the merged head kept its "#1" slot while being
   * invisible to the processor's open-only select. The broadcast lets the
   * open-only GitHub list drop the row live instead of waiting for a refresh.
   */
  private async closeTrackedRow(
    workspaceId: string,
    repositoryId: string,
    row: TrackedOpenRow,
    nextState: 'merged' | 'closed',
    mergedAt: Date | null
  ): Promise<void> {
    const prev = await this.db
      .select({ lastSummary: pullRequestsTable.lastSummary })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, row.id))
      .limit(1);
    await this.db
      .update(pullRequestsTable)
      .set({ state: nextState, mergedAt, updatedAt: new Date(), ...QUEUE_RESET_COLUMNS })
      .where(eq(pullRequestsTable.id, row.id));
    emitPullRequestUpdated(workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: nextState,
      lastSummary: (prev[0]?.lastSummary as Record<string, unknown> | null) ?? {},
      mergeQueued: false,
      mergeQueueState: null,
    });
  }

  /**
   * Derive `reviewRequestVia` (was I asked directly, via a team, or both?)
   * from the summary's raw `reviewRequests` and the viewer's identity +
   * teams (both cached). Mutates the summary in place; no-op when there's no
   * request data. Cheap — login + teams are cache hits on the hot path.
   */
  private async annotateReviewRequest(workspaceId: string, summary: PRSummary): Promise<void> {
    const raw = summary.reviewRequests;
    if (!raw) return;
    const login = await this.resolveCurrentUser(workspaceId);
    const myTeams = await githubService.getViewerTeamSlugs(workspaceId);
    const direct = login
      ? raw.users.some((u) => u.toLowerCase() === login.toLowerCase())
      : false;
    const teams = raw.teams
      .filter((t) => myTeams.has(t.combinedSlug.toLowerCase()))
      .map((t) => t.combinedSlug);
    summary.reviewRequestVia = { direct, teams };
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
    if (!(await this.drainInFlightTick())) return;
    await this.poll();
  }

  /**
   * Wait for an in-flight tick to finish, bounded by {@link FORCE_POLL_DRAIN_MS}.
   * Returns false when the tick is still running past the deadline — under
   * GitHub throttling a tick can run for minutes, and an unbounded wait here
   * left `POST /repositories/poll` hanging until the client's 300s timeout
   * (observed in prod, June 2026). Skipping is safe: the tick that's blocking
   * us is itself refreshing every connected workspace, so the caller's
   * follow-up read still gets fresh rows.
   */
  private async drainInFlightTick(): Promise<boolean> {
    const deadline = Date.now() + FORCE_POLL_DRAIN_MS;
    while (this.pollGuard.active) {
      if (Date.now() >= deadline) {
        console.warn('PR monitor: forced poll skipped — a poll tick is still in flight');
        return false;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  }

  /**
   * Refresh just the given workspaces' PRs. Drains any in-flight full tick
   * first (and holds the same guard) so it can't race the background poll.
   */
  async forcePollWorkspaces(workspaceIds: string[]): Promise<void> {
    if (workspaceIds.length === 0) return;
    if (!(await this.drainInFlightTick())) return;
    if (!this.pollGuard.tryBegin()) return;
    try {
      for (const workspaceId of workspaceIds) {
        try {
          await this.pollWorkspace(workspaceId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.error(`PR monitor: workspace ${workspaceId.slice(0, 8)} forced poll failed:`, msg);
        }
      }
    } finally {
      this.pollGuard.end();
    }
  }

  /**
   * The user-facing "Refresh" entry point: polls only the caller's own
   * connected workspaces. A single user must not be able to fan a refresh out
   * across every tenant's repos (that's what the unscoped {@link forcePoll}
   * does, which is why it's background/test-only).
   */
  async forcePollForOwner(ownerId: string): Promise<void> {
    const connected = new Set(githubService.getConnectedWorkspaces());
    const owned = await this.db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.ownerId, ownerId));
    await this.forcePollWorkspaces(owned.map((r) => r.id).filter((id) => connected.has(id)));
  }

  /**
   * Refetch a single PR's summary now — the per-PR trigger the webhook worker
   * fires on activity. GraphQL-only. Unlike the old notifications trigger, this
   * ALSO derives the relationship flags (authored / reviewRequested) from the
   * fetched summary + viewer identity, so webhooks keep the Mine / Review
   * buckets realtime without a Search call. Only tracks a PR the viewer has a
   * relationship with (or one already tracked) — an unrelated PR in a watched
   * repo is not materialized. No-op if the repo isn't watched in this workspace.
   */
  async refreshPr(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number,
    opts: { resolveMergeable?: boolean; repositoryId?: string } = {}
  ): Promise<void> {
    // The webhook fan-out already resolved the repo (id + canonical owner/repo
    // from the in-memory watch index), so it passes `repositoryId` to skip the
    // getWatchedRepos DB round-trip + URL parse on the hot path. Other callers
    // (merge queue, auto-merge) omit it and resolve from the DB.
    const watched = await this.resolveWatchedForRefresh(workspaceId, owner, repo, opts.repositoryId);
    if (!watched) return;
    const results = await this.fetchPrSummaries(workspaceId, watched, [number], opts);
    await this.applyPrResults(
      { workspaceId, repositoryId: watched.id, fullName: watched.fullName },
      number,
      results
    );
  }

  /**
   * Refresh one PR across EVERY workspace watching it while making a SINGLE
   * GitHub fetch. `resolveAuth` resolves the data-plane token by the repo
   * OWNER, so every workspace on the same installation gets a byte-identical
   * GraphQL result — fetching per-workspace (the old webhook fan-out) was pure
   * amplification: N identical calls against ONE shared GraphQL point budget,
   * which exhausted installation 140694558 in prod and produced the sustained
   * rate-limit storm. We group targets by the account their call actually
   * authenticates as, fetch once per group, then run only the cheap
   * per-workspace post-processing (viewer relationship flags + upsert).
   *
   * Webhook-only, so `resolveMergeable` is always false (a follow-up event or
   * the reconcile sweep settles UNKNOWN). A fetch error propagates to the caller
   * so a rate-limit is logged ONCE for the group, not once per workspace.
   */
  async refreshPrAcrossWorkspaces(
    targets: Array<{ workspaceId: string; owner: string; repo: string; repositoryId: string }>,
    number: number
  ): Promise<void> {
    if (targets.length === 0) return;
    // Group by the account the fetch will authenticate as. Normally every target
    // shares one installation → a single group → a single fetch; only owner-less
    // user-token fallbacks (no installation covers the owner) split per workspace.
    const groups = new Map<string, typeof targets>();
    for (const t of targets) {
      const key = githubService.graphqlAccountKeyForOwner(t.workspaceId, t.owner);
      const list = groups.get(key) ?? [];
      list.push(t);
      groups.set(key, list);
    }
    for (const group of groups.values()) {
      const lead = group[0];
      const watched = this.watchedFromTarget(lead);
      const results = await this.fetchPrSummaries(lead.workspaceId, watched, [number], {
        resolveMergeable: false,
      });
      for (const target of group) {
        await this.applyPrResults(
          { workspaceId: target.workspaceId, repositoryId: target.repositoryId, fullName: watched.fullName },
          number,
          results
        );
      }
    }
  }

  /** Resolve the WatchedRepo for a refresh — from a passed repositoryId (hot path) or the DB. */
  private async resolveWatchedForRefresh(
    workspaceId: string,
    owner: string,
    repo: string,
    repositoryId?: string
  ): Promise<WatchedRepo | undefined> {
    if (repositoryId) return this.watchedFromTarget({ workspaceId, owner, repo, repositoryId });
    return (await this.getWatchedRepos(workspaceId)).find(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.repo.toLowerCase() === repo.toLowerCase()
    );
  }

  /** Build the minimal WatchedRepo the fetch/apply path needs from an index target. */
  private watchedFromTarget(t: {
    workspaceId: string;
    owner: string;
    repo: string;
    repositoryId: string;
  }): WatchedRepo {
    return {
      id: t.repositoryId,
      workspaceId: t.workspaceId,
      owner: t.owner,
      repo: t.repo,
      fullName: `${t.owner}/${t.repo}`,
      defaultBranch: '',
    };
  }

  /** GraphQL fetch for a set of PR numbers, optionally resolving UNKNOWN mergeable. */
  private async fetchPrSummaries(
    workspaceId: string,
    watched: WatchedRepo,
    numbers: number[],
    opts: { resolveMergeable?: boolean }
  ): Promise<BatchPRByNumberResult[]> {
    const fetched = await batchPullRequestsByNumber({
      workspaceId,
      owner: watched.owner,
      repo: watched.repo,
      numbers,
    });
    // GitHub returns `mergeable: UNKNOWN` on a fresh fetch and recomputes it in
    // the background. Resolving it inline is a 3×1.5s blocking retry — fine for
    // the merge-queue / auto-merge callers that need an authoritative answer
    // (default), but a major backlog source on the webhook hot path. Webhook
    // refreshes pass resolveMergeable:false and let a follow-up event or the
    // reconcile sweep settle UNKNOWN.
    return opts.resolveMergeable === false
      ? fetched
      : this.resolveUnknownMergeable(workspaceId, watched, fetched);
  }

  /**
   * Per-workspace post-processing for already-fetched PR summaries: derive the
   * viewer relationship and upsert+broadcast when the PR is relevant (or a row
   * already exists). Clones each summary so the shared fetched object isn't
   * mutated across workspaces (`annotateReviewRequest` writes `reviewRequestVia`).
   */
  private async applyPrResults(
    target: { workspaceId: string; repositoryId: string; fullName: string },
    number: number,
    results: BatchPRByNumberResult[]
  ): Promise<void> {
    const login = await this.resolveCurrentUser(target.workspaceId);
    for (const result of results) {
      if (!result.pr) {
        if (WEBHOOK_TRACE) {
          whTrace(
            `      refreshPr ${target.fullName}#${number}: GitHub returned no PR ` +
              `(deleted/transferred or not visible) — nothing to update`
          );
        }
        continue;
      }
      // Isolate per-workspace mutation: annotateReviewRequest writes
      // reviewRequestVia onto the summary, and the same fetched object is shared
      // across every workspace in the group.
      const summary = structuredClone(result.pr);
      await this.annotateReviewRequest(target.workspaceId, summary);
      const { authored, reviewRequested } = relationshipFlags(summary, login);
      // Keep the cache scoped to PRs the viewer actually cares about: only
      // materialize a row if there's a relationship now, or one already exists
      // (so a PR that just lost its relationship still gets updated/cleared).
      const relevant = authored || reviewRequested;
      const exists =
        relevant || (await this.prRowExists(target.workspaceId, target.repositoryId, summary.number));
      whTrace(
        `      refreshPr ${target.fullName}#${summary.number}: state=${summary.state} ` +
          `authored=${authored} reviewRequested=${reviewRequested} ` +
          `${exists ? 'upsert+emit' : 'skip (no relationship, untracked)'}`
      );
      if (!exists) continue;
      await upsertFromBatchResult({
        workspaceId: target.workspaceId,
        repositoryId: target.repositoryId,
        summary,
        reviewRequested,
        authored,
      });
    }
  }

  /**
   * Patch metadata fields on the matching tracked OPEN PR rows directly from a
   * webhook payload — NO GitHub fetch. For `pull_request` actions whose only
   * effect is a field we already persist verbatim (title, draft) and that feeds
   * no derived/aggregate state (mergeability, review decision, checks), a full
   * `refreshPr` is wasted work; we `jsonb_set` just the changed key(s) and
   * broadcast the partial so the desktop merges it live.
   *
   * Updates every workspace's row for `(repo, number)` via the resolved targets,
   * never reads the `last_summary` blob back (chained `jsonb_set`), and returns
   * the number of rows patched.
   */
  async patchOpenPrSummary(
    targets: Array<{ repositoryId: string }>,
    number: number,
    patch: { title?: string; draft?: boolean; labels?: string[] }
  ): Promise<number> {
    const repoIds = [...new Set(targets.map((t) => t.repositoryId))];
    if (repoIds.length === 0) return 0;
    let expr = sql`${pullRequestsTable.lastSummary}`;
    if (patch.title !== undefined)
      expr = sql`jsonb_set(${expr}, '{title}', ${JSON.stringify(patch.title)}::jsonb)`;
    if (patch.draft !== undefined)
      expr = sql`jsonb_set(${expr}, '{draft}', ${JSON.stringify(patch.draft)}::jsonb)`;
    if (patch.labels !== undefined)
      expr = sql`jsonb_set(${expr}, '{labels}', ${JSON.stringify(patch.labels)}::jsonb)`;
    if (patch.title === undefined && patch.draft === undefined && patch.labels === undefined) {
      return 0;
    }

    const rows = await this.db
      .update(pullRequestsTable)
      .set({ lastSummary: expr, updatedAt: new Date() })
      .where(
        and(
          inArray(pullRequestsTable.repositoryId, repoIds),
          eq(pullRequestsTable.number, number),
          eq(pullRequestsTable.state, 'open')
        )
      )
      .returning({
        id: pullRequestsTable.id,
        workspaceId: pullRequestsTable.workspaceId,
        repositoryId: pullRequestsTable.repositoryId,
        owner: pullRequestsTable.owner,
        repo: pullRequestsTable.repo,
        number: pullRequestsTable.number,
        taskId: pullRequestsTable.taskId,
      });

    const partial: Record<string, unknown> = {};
    if (patch.title !== undefined) partial.title = patch.title;
    if (patch.draft !== undefined) partial.draft = patch.draft;
    if (patch.labels !== undefined) partial.labels = patch.labels;
    for (const row of rows) {
      emitPullRequestUpdated(row.workspaceId, {
        id: row.id,
        taskId: row.taskId,
        repositoryId: row.repositoryId,
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        state: 'open',
        lastSummary: partial,
      });
      // Merge-queue v2 trigger: a draft flip is exactly the self-heal signal a
      // blocked(draft) entry waits for, and a label change is how an external
      // merge queue (trunk.io) reports progress on a PR we submitted — queued →
      // testing → failed. baseBranch isn't at hand on this incremental path —
      // the trigger resolves the entry's stored group.
      if (patch.draft !== undefined || patch.labels !== undefined) {
        domainEvents.emit('pr:snapshot', {
          workspaceId: row.workspaceId,
          repositoryId: row.repositoryId,
          prId: row.id,
          baseBranch: '',
          state: 'open',
          trigger: patch.labels !== undefined ? 'webhook:label-patch' : 'webhook:draft-patch',
        });
      }
    }
    return rows.length;
  }

  /**
   * Open PR numbers in a repo whose BASE branch is `baseBranch`. Used by the
   * `push` webhook handler: when a branch advances, every open PR targeting it
   * may have just become (un)conflicting, and GitHub sends no per-PR event.
   * Selects only `number` — never ships the `lastSummary` blob.
   */
  async openPrNumbersForBase(
    workspaceId: string,
    repositoryId: string,
    baseBranch: string
  ): Promise<number[]> {
    const rows = await this.db
      .select({ number: pullRequestsTable.number })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId),
          eq(pullRequestsTable.state, 'open'),
          sql`${pullRequestsTable.lastSummary} ->> 'baseBranch' = ${baseBranch}`
        )
      );
    return rows.map((r) => r.number);
  }

  /** Whether a pull_requests row already exists for this (workspace, repo, number). */
  private async prRowExists(
    workspaceId: string,
    repositoryId: string,
    number: number
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: pullRequestsTable.id })
      .from(pullRequestsTable)
      .where(
        and(
          eq(pullRequestsTable.workspaceId, workspaceId),
          eq(pullRequestsTable.repositoryId, repositoryId),
          eq(pullRequestsTable.number, number)
        )
      )
      .limit(1);
    return rows.length > 0;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Does this error mean the GitHub App simply can't reach the repo (vs a
 * transient failure)? Covers the Search API's 422 ("cannot be searched … do
 * not have permission to view them"), the GraphQL 403 ("Resource not accessible
 * by integration"), and a repo node that won't resolve. These all mean: grant
 * the App access to the repo — retrying won't help until then.
 */
export function isRepoAccessError(message: string): boolean {
  return (
    /Resource not accessible by integration/i.test(message) ||
    /cannot be searched|do not have permission to view/i.test(message) ||
    /Could not resolve to a Repository/i.test(message)
  );
}

/**
 * Derive the viewer's relationship to a PR from its fetched summary — the same
 * Mine / Review buckets the Search poll computes, but from a single PR's data
 * so a webhook refresh can set them without a Search call.
 *
 *   - authored: the viewer opened it.
 *   - reviewRequested: the viewer is a requested reviewer (directly, or via a
 *     team — `reviewRequestVia` is set by `annotateReviewRequest`), AND hasn't
 *     already reviewed it, AND isn't the author. GitHub drops an individual
 *     request once you review, but leaves a team request standing, so we also
 *     subtract "the viewer appears in recentReviews" (mirrors the Search
 *     `review-requested MINUS reviewed-by` logic; the reconcile sweep is the
 *     authoritative backstop for the recentReviews-window edge cases).
 */
export function relationshipFlags(
  summary: PRSummary,
  login: string | null
): { authored: boolean; reviewRequested: boolean } {
  if (!login) return { authored: false, reviewRequested: false };
  const me = login.toLowerCase();
  const authored = summary.author?.toLowerCase() === me;
  const via = summary.reviewRequestVia;
  const requested = via ? via.direct || via.teams.length > 0 : false;
  const reviewedByViewer = (summary.recentReviews ?? []).some(
    (r) => r.author?.toLowerCase() === me
  );
  return { authored, reviewRequested: requested && !reviewedByViewer && !authored };
}

export const prMonitorService = new PRMonitorService();
