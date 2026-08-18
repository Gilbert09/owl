import { and, eq, ne } from 'drizzle-orm';
import {
  prNeedsFollowup,
  mergeBlockerReason,
  buildMergeablePrompt,
  type PRMergeableSummary,
} from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import { guardCrossReplica } from './advisoryLock.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { createCloudTask } from './taskCreate.js';
import { TaskLimitError } from './billing/entitlements.js';
import { prMonitorService } from './prMonitor.js';
import { githubService, MergeNotPermittedForAppError } from './github.js';
import { fetchUnsignedCommitCount } from './githubGraphql.js';
import { requiresSignedCommits, markSigningRequired } from './repoSigning.js';
import { githubRateGate } from './githubRateGate.js';
import { graphqlBudget } from './graphqlBudget.js';
import { emitPullRequestUpdated, emitMergeQueueBlocked } from './websocket.js';
import {
  broadcastMergeQueuePositions,
  QUEUE_RESET_COLUMNS,
} from './mergeQueueBroadcast.js';
import { debugBus } from './debugBus.js';
import { TickGuard } from './tickGuard.js';
import { ACTIVE_STATUSES, linkedTaskStatus, resolveCloudEnv } from './prCloudFix.js';
import { workspacePromptTemplate } from './promptTemplates.js';
import { getMergeQueueEngine } from './mergeQueue/store.js';

const POLL_INTERVAL_MS = 10_000;
/**
 * Hard bound on how long one tick may spend walking queue groups. Heads not
 * reached by the deadline simply wait for the next tick — FIFO order is
 * preserved. Exported for tests.
 */
export const TICK_DEADLINE_MS = 60_000;
/** Re-poll a queued PR if its cached summary is older than this. */
const FRESHNESS_MS = 90_000;
/** Stop auto-firing fix runs after this many consecutive un-mergeable runs. */
const MAX_ATTEMPTS = 3;

type MergeMethod = 'merge' | 'squash' | 'rebase';
type QueueStatus = 'waiting' | 'fixing' | 'merging' | 'blocked';

/**
 * What a processed PR means for the rest of its queue group this tick:
 * `hold` — the PR is being actively worked (merged, fixing, waiting on a run),
 * so it keeps the group's turn; `advance` — the PR can't make progress (gave
 * up as blocked, or left the queue), so the next queued PR gets a go now
 * instead of sitting behind it.
 */
type HeadVerdict = 'hold' | 'advance';

interface MergeQueueState {
  attempts: number;
  lastFixTaskId?: string;
  /** Whether `lastFixTaskId`'s terminal result has been folded into attempts. */
  accounted?: boolean;
  status: QueueStatus;
  lastError?: string;
  lastErrorAt?: string;
  /** Why the PR is blocked, captured at the transition into `blocked`. */
  blockReason?: string;
  /**
   * GitHub refused the merge for the App's tokens (MergeNotPermittedForAppError).
   * `'failing-checks'` — the head had a failing check at refusal time (even an
   * "optional" one humans can merge past, Apps can't); the gate self-clears
   * and the merge retries once the summary shows no failing checks (rerun
   * went green, or a new head reset them). `'hard'` — refused with no failing
   * check to blame; unknown cause, so stay blocked until dequeue/requeue
   * (QUEUE_RESET) rather than re-attempt a doomed merge every tick.
   * `'unsigned-commits'` — the base branch requires signed commits and this PR
   * has unsigned ones; re-signing (via the fix task) couldn't resolve it within
   * budget, so it's blocked until the branch is signed + re-queued.
   * Legacy `true` (one deploy's worth) is normalized at the gate.
   */
  mergeForbidden?: 'failing-checks' | 'hard' | 'unsigned-commits' | boolean;
  /**
   * How many times the queue has re-run this head's failing checks after an
   * App-refused merge (its own budget, separate from the fix-run `attempts`;
   * both share the MAX_ATTEMPTS cap). Reset when the gate self-clears (new
   * head / checks green) and by dequeue.
   */
  rerunAttempts?: number;
  /**
   * How many re-sign fix runs the queue has fired for a base branch that
   * requires signed commits (its own budget, capped by MAX_ATTEMPTS). Reset by
   * dequeue/requeue.
   */
  resignAttempts?: number;
}

// Only the columns this processor touches — avoids `select()`-ing every PR
// column (and any large one added to the table later) on each 10s tick. The
// `Pick` makes the compiler enforce completeness: read a column not listed
// here and tsc fails, so the projection can't silently drift out of sync.
const QUEUE_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  repositoryId: pullRequestsTable.repositoryId,
  taskId: pullRequestsTable.taskId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  lastPolledAt: pullRequestsTable.lastPolledAt,
  lastSummary: pullRequestsTable.lastSummary,
  mergeQueued: pullRequestsTable.mergeQueued,
  mergeQueueState: pullRequestsTable.mergeQueueState,
  mergeMethod: pullRequestsTable.mergeMethod,
} as const;

type PRRow = Pick<typeof pullRequestsTable.$inferSelect, keyof typeof QUEUE_COLUMNS>;

function readState(row: PRRow): MergeQueueState {
  const s = (row.mergeQueueState as MergeQueueState | null) ?? null;
  return {
    attempts: s?.attempts ?? 0,
    lastFixTaskId: s?.lastFixTaskId,
    accounted: s?.accounted ?? true,
    status: s?.status ?? 'waiting',
    lastError: s?.lastError,
    lastErrorAt: s?.lastErrorAt,
    blockReason: s?.blockReason,
    mergeForbidden: s?.mergeForbidden,
    rerunAttempts: s?.rerunAttempts,
    resignAttempts: s?.resignAttempts,
  };
}

/**
 * The blocked-badge reason for an App-refused merge over failing head checks,
 * matched to why the automatic re-run couldn't save it.
 */
function buildFailingChecksBlockReason(
  rerunReason: 'no-failing-check-runs' | 'needs-actions-permission' | 'not-rerequestable' | undefined,
  rerunAttempts: number
): string {
  const preamble =
    `GitHub won't let the Talyn App merge while a check is failing on the head ` +
    `commit — even an "optional" one a human can merge past. `;
  if (rerunReason === 'needs-actions-permission') {
    return (
      preamble +
      `Talyn couldn't re-run it (the App needs the "Actions: Read & write" permission ` +
      `for GitHub-Actions checks). Re-run the check on GitHub and the queue will retry, ` +
      `or merge manually.`
    );
  }
  if (rerunReason === 'not-rerequestable') {
    return (
      preamble +
      `Talyn can't re-run this check (GitHub only lets the app that created it — or a ` +
      `human on github.com — re-run it), and the branch is already up to date with its ` +
      `base, so re-triggering the checks via a branch update wasn't possible either. ` +
      `Re-run the check on GitHub and the queue will retry, or merge manually.`
    );
  }
  if (rerunAttempts >= MAX_ATTEMPTS) {
    return (
      preamble +
      `Talyn re-ran the failing checks ${MAX_ATTEMPTS}× and they kept failing — fix the ` +
      `check (or merge manually on GitHub); the queue retries once it's green.`
    );
  }
  return (
    preamble +
    `Re-run or fix the failing check and the queue will retry automatically, or merge ` +
    `manually on GitHub.`
  );
}

/** Compact queue state for the desktop (toggle + badge). `position` is 1-based. */
function publicState(s: MergeQueueState, position: number): {
  status: QueueStatus;
  attempts: number;
  position: number;
  reason?: string;
} {
  return {
    status: s.status,
    attempts: s.attempts,
    position,
    // The blocked badge's tooltip explains *why* it gave up.
    ...(s.status === 'blocked' && s.blockReason ? { reason: s.blockReason } : {}),
  };
}

/**
 * A short, human reason a queued PR is blocked — for the notification + badge.
 * Conflicts/changes/CI come from the summary; "behind the base" is read off
 * `mergeStateStatus`, which `mergeBlockerReason` doesn't see, so check it here.
 */
function blockerReason(row: PRRow, summary: PRMergeableSummary): string {
  if (prNeedsFollowup(summary)) return mergeBlockerReason(summary);
  if (needsUpdate(row)) return 'the branch is behind its base';
  return 'needs attention';
}

function baseBranchOf(row: PRRow): string {
  return (row.lastSummary as { baseBranch?: string } | null)?.baseBranch ?? '';
}

function mergeStateOf(row: PRRow): string {
  return (
    (row.lastSummary as { mergeStateStatus?: string } | null)?.mergeStateStatus ?? 'UNKNOWN'
  ).toUpperCase();
}

/**
 * Behind / blocked-by-out-of-date is a queue blocker that `prNeedsFollowup`
 * misses — it's exactly the state every sibling PR lands in after one merges to
 * the shared base. Funnel it into the same cloud fix run, which merges the base
 * branch in and brings the branch current.
 */
function needsUpdate(row: PRRow): boolean {
  const s = mergeStateOf(row);
  return s === 'BEHIND' || s === 'BLOCKED';
}

function queueBlocked(row: PRRow, summary: PRMergeableSummary): boolean {
  return prNeedsFollowup(summary) || needsUpdate(row);
}

/**
 * GitHub can't merge a DRAFT PR — the merge API 405s. The queue must never enter
 * the merge path for one (a draft reads as not-queue-blocked, so without this it
 * would attempt a doomed merge every tick and hold the group). Detected from the
 * summary's `draft` flag OR `mergeStateStatus === 'DRAFT'` (belt and suspenders).
 */
function isDraftHead(row: PRRow, summary: PRMergeableSummary): boolean {
  return summary.draft === true || mergeStateOf(row) === 'DRAFT';
}

const DRAFT_BLOCK_REASON =
  'This PR is a draft — mark it ready for review and the merge queue will merge it automatically.';

/**
 * The head commit still has queued / in-progress checks reporting. GitHub
 * surfaces such a PR as `mergeStateStatus = BLOCKED` — the same status it uses
 * for a *failed* required check — so `needsUpdate`/`queueBlocked` can't tell
 * "CI hasn't finished" apart from "CI failed" on their own.
 */
function ciInFlight(summary: PRMergeableSummary): boolean {
  return (summary.checks?.inProgress ?? 0) > 0;
}

/**
 * A *settled* reason the PR can't merge — one a fix run should act on now, even
 * if other checks are still running: conflicts, changes requested, unresolved
 * threads, or a failed REQUIRED check (all caught by `prNeedsFollowup`), or
 * BEHIND the base. Deliberately excludes a bare `BLOCKED` state, which is what
 * GitHub reports while required checks are merely pending — that case must wait
 * for CI, not be treated as blocked.
 */
function hasSettledBlocker(row: PRRow, summary: PRMergeableSummary): boolean {
  return prNeedsFollowup(summary) || mergeStateOf(row) === 'BEHIND';
}

function normalizeMethod(raw: unknown): MergeMethod {
  return raw === 'merge' || raw === 'rebase' ? raw : 'squash';
}

/**
 * Merges the PRs in the FastOwl merge queue one-by-one, serialized per
 * (workspace, repo, base branch). Each tick:
 *
 *   1. Load every queued open PR, FIFO by `merge_queued_at`.
 *   2. Group by (workspace, repo, base) — only same-base merges collide.
 *   3. Walk each group from its HEAD (earliest queued), skipping past PRs that
 *      can't make progress (hard-blocked after MAX_ATTEMPTS, or no longer in
 *      the queue) until one takes an action — so a blocked PR never gates the
 *      PRs queued behind it. The first actionable PR consumes the group's turn:
 *      with the single-threaded `ticking` guard and the merge being a
 *      synchronous awaited REST call, two same-base PRs can never both merge in
 *      a tick — while distinct groups proceed independently.
 *
 * Per PR: refresh stale state, then merge if clean, or fire the shared
 * "take this PR to a clean, mergeable state" cloud run on conflict / behind /
 * blocked, wait for it (active-task guard), retry, and drop the PR off the
 * queue once merged — which promotes the next same-base PR to head.
 */
class MergeQueueProcessor {
  private interval: NodeJS.Timeout | null = null;
  // Wedge watchdog: one stalled await must never freeze the loop forever —
  // see TickGuard for the prod incidents that shaped this.
  private guard = new TickGuard('mergeQueueProcessor');

  init(): void {
    if (this.interval) return;
    debugBus.registerPoller(
      'merge_queue',
      POLL_INTERVAL_MS,
      'Merges queued PRs one-by-one, serialized per (workspace, repo, base branch) — merges the head when clean, fires a cloud fix run on conflict/behind/blocked, and skips past hard-blocked PRs so they never gate the rest of the queue.',
    );
    this.interval = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  shutdown(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test entry point — run a single tick synchronously. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.guard.tryBegin()) {
      // Make the busy state visible: without this the panel's "last tick" just
      // ages while a slow tick holds the guard and the loop looks dead.
      debugBus.pollerTick('merge_queue', {
        durationMs: 0,
        ok: true,
        summary: `merge_queue tick skipped — previous tick still in flight (${Math.round(this.guard.heldMs / 1000)}s)`,
      });
      return;
    }
    const startedAt = Date.now();
    // Hard bound on a tick's group-walking: heads not reached by the deadline
    // wait for the next tick (the queue is FIFO — nothing is lost). Keeps the
    // guard from being held for minutes by a large backlog, which starved the
    // 10s cadence and made per-merge latency look like multi-minute stalls.
    const deadline = startedAt + TICK_DEADLINE_MS;
    let headCount = 0;
    let deferredCount = 0;
    let tickError: string | undefined;
    let skipRecord = false;
    let lockSkipped = false;
    let engineSkipped = false;
    try {
      // Cutover gate: once the engine flag flips to 'v2' (migration 0032),
      // the event-driven pipeline drives the queue and this processor stands
      // down — re-read every tick so a prior deploy stops within ~10s of the
      // flip committing (deploy-overlap safety).
      if ((await getMergeQueueEngine()) === 'v2') {
        engineSkipped = true;
        return;
      }
      // Cross-replica mutex: a deploy overlap runs two instances, and two
      // concurrent ticks can both try to merge the same head PR.
      const lock = await guardCrossReplica('mergeQueue:tick', async () => {
        const db = getDbClient();

        // Self-heal: clear queue bookkeeping on rows that left `open` while
        // still flagged queued (a sweep/refresh path flipped the state without
        // the reset). Such rows are invisible to the open-only select below, so
        // their stale flags would otherwise live forever — and pollute the
        // position math anywhere that doesn't filter on state.
        const healed = await db
          .update(pullRequestsTable)
          .set({ ...QUEUE_RESET_COLUMNS, updatedAt: new Date() })
          .where(
            and(
              eq(pullRequestsTable.mergeQueued, true),
              ne(pullRequestsTable.state, 'open')
            )
          )
          .returning({ workspaceId: pullRequestsTable.workspaceId });
        for (const workspaceId of new Set(healed.map((r) => r.workspaceId))) {
          await broadcastMergeQueuePositions(workspaceId);
        }

        const rows = await db
          .select(QUEUE_COLUMNS)
          .from(pullRequestsTable)
          .where(
            and(
              eq(pullRequestsTable.mergeQueued, true),
              eq(pullRequestsTable.state, 'open')
            )
          )
          .orderBy(pullRequestsTable.mergeQueuedAt);

        // Group by (workspace, repo, base) — `rows` is already FIFO-ordered, so
        // each group's array is its queue order, head first.
        const groups = new Map<string, PRRow[]>();
        for (const row of rows) {
          const key = `${row.workspaceId}|${row.repositoryId}|${baseBranchOf(row)}`;
          const group = groups.get(key);
          if (group) group.push(row);
          else groups.set(key, [row]);
        }

        headCount = groups.size;
        // Distinct groups are independent — a slow GitHub round-trip for one
        // (workspace, repo, base) must not gate the others. Process groups
        // concurrently so the tick's wall-time is the slowest single group, not
        // the sum of all of them: serializing groups held the re-entrancy guard
        // for minutes while a multi-PR backlog drained, so every 10s tick in
        // between no-op'd on the guard and the queue looked frozen. Within a group
        // we stay serial — one same-base merge per tick.
        const outcomes = await Promise.all(
          [...groups.values()].map((group) => this.processGroup(group, deadline))
        );
        deferredCount = outcomes.filter((o) => o !== 'ok').length;
      });
      lockSkipped = !lock.acquired;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DATABASE_URL is not set')) {
        skipRecord = true;
        return;
      }
      tickError = msg;
      console.error('[mergeQueueProcessor] tick error:', err);
    } finally {
      this.guard.end();
      if (!skipRecord) {
        debugBus.pollerTick('merge_queue', {
          durationMs: Date.now() - startedAt,
          ok: !tickError,
          summary: tickError
            ? `merge_queue tick failed: ${tickError}`
            : engineSkipped
              ? 'merge_queue tick skipped — v2 engine active'
            : lockSkipped
              ? 'merge_queue tick skipped — advisory lock held by another instance'
              : `merge_queue tick — ${headCount} head${headCount === 1 ? '' : 's'}` +
              (deferredCount > 0
                ? `, ${deferredCount} group${deferredCount === 1 ? '' : 's'} deferred (rate-limited / deadline)`
                : ''),
          error: tickError,
        });
      }
    }
  }

  /**
   * Act on one queued PR. `position` is its 1-based slot within its queue
   * group (1 = head), echoed on the WS badge. Returns whether the group
   * should keep walking past this PR this tick (see `HeadVerdict`).
   */
  /**
   * Walk one group from its head, skipping past PRs that can't make progress
   * ('advance': hard-blocked, or gone from the queue) so a blocked head never
   * gates the PRs behind it. The first PR that takes an action ('hold': merge,
   * fix run, in-flight run) consumes the group's turn — one same-base merge per
   * tick. Never throws: a single PR's failure is logged and ends the group's turn.
   *
   * Two bounds keep a group's walk from holding the tick guard for minutes
   * (which starved the 10s cadence and read as multi-minute merge stalls):
   *   - Rate gate: while the group's GitHub account is in a secondary-rate-limit
   *     backoff, every API call inside the walk would sleep up to 60s behind
   *     `waitIfBlocked`. Instead of paying that per call, the group defers to a
   *     later tick — checked up front AND between heads, so a 403 mid-walk stops
   *     the group instead of turning each remaining call into a sleep.
   *   - Deadline: heads not reached by the tick's deadline wait for the next
   *     tick. FIFO order means they lose nothing but their turn's timing.
   */
  private async processGroup(group: PRRow[], deadline: number): Promise<'ok' | 'deferred'> {
    const accountKey = githubService.accountKeyFor(group[0].workspaceId);
    for (let i = 0; i < group.length; i++) {
      // The merge itself is a REST call, so defer the group only on a backoff
      // that gates REST (the shared secondary limit). A GraphQL point-budget
      // exhaustion — which the 16-workspace poll fan-out on a shared install
      // hits constantly — must NOT freeze the queue: REST has its own budget.
      if (githubRateGate.isBlocked(accountKey, 'rest')) return 'deferred';
      if (Date.now() > deadline) return 'deferred';
      const row = group[i];
      let verdict: HeadVerdict = 'hold';
      try {
        verdict = await this.processHead(row, i + 1);
      } catch (err) {
        // One PR failing must never abort the tick — retry next time.
        console.warn(
          `[mergeQueueProcessor] failed for PR ${row.owner}/${row.repo}#${row.number}:`,
          err instanceof Error ? err.message : err
        );
      }
      if (verdict === 'hold') break;
    }
    return 'ok';
  }

  private async processHead(initialRow: PRRow, position = 1): Promise<HeadVerdict> {
    const db = getDbClient();

    // 1. Freshness — refetch a stale summary so behind/conflict detection is
    //    current. A stale BEHIND head would otherwise be merge-attempted and
    //    bounce with `merged:false`.
    let row = initialRow;
    const freshnessStale = Date.now() - new Date(row.lastPolledAt).getTime() > FRESHNESS_MS;
    // A head the queue is actively "fixing" is changing under us: the fix run may
    // have ALREADY made it mergeable while our cached mergeStateStatus still reads
    // BEHIND/blocked (webhooks don't refresh mergeStateStatus, only checks). That
    // stale blocker wedges an actually-Ready PR behind a fix run that's done — so
    // refresh it even when the account's GraphQL budget is in the reserve. The
    // queue head is the highest-value point to spend, and it's bounded to once
    // per freshness window. Otherwise keep the opportunistic re-poll budget-gated
    // (a stale BEHIND head bounces with merged:false and self-heals post-reset).
    const beingFixed = readState(initialRow).status === 'fixing';
    if (
      freshnessStale &&
      (beingFixed || !graphqlBudget.shouldDefer(githubService.accountKeyFor(row.workspaceId)))
    ) {
      await prMonitorService
        .refreshPr(row.workspaceId, row.owner, row.repo, row.number)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.warn(
            `[mergeQueueProcessor] freshness refetch failed for ${row.owner}/${row.repo}#${row.number}:`,
            msg
          );
        });
      const reread = await db
        .select(QUEUE_COLUMNS)
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, row.id))
        .limit(1);
      if (reread[0]) row = reread[0];
    }

    // The PR may have merged/closed underneath us. Drop it off the queue so it
    // never blocks the group, and let the next queued PR have this turn.
    if (row.state !== 'open') {
      if (row.mergeQueued) await this.dequeue(row);
      return 'advance';
    }
    if (!row.mergeQueued) return 'advance';

    const summary = row.lastSummary as PRMergeableSummary;
    const state = readState(row);

    // A persisted 'merging' on ENTRY means a previous attempt died between
    // GitHub accepting the merge and our DB write (wedged await, redeploy —
    // exactly the June 2026 incident: the PR merged on GitHub at 19:13 but the
    // row read open/merging for ever and the queue froze). Ask GitHub directly
    // before doing anything else; re-attempting the merge would just 405.
    if (state.status === 'merging' && (await this.verifyMerged(row))) {
      await this.recordMerged(row);
      return 'hold';
    }

    // 1b. Draft head — GitHub refuses to merge a draft (405). A draft reads as
    //     not-queue-blocked, so without this the clean path would attempt a
    //     doomed merge every tick and HOLD the whole group behind it. Surface it
    //     and ADVANCE so the ready PRs behind it keep draining; it self-heals the
    //     moment the PR is marked ready for review (this guard stops firing, and
    //     a now-clean head merges in step 5). No notification — a draft isn't a
    //     queue failure, just work the author hasn't finished.
    if (isDraftHead(row, summary)) {
      if (state.status !== 'blocked' || state.blockReason !== DRAFT_BLOCK_REASON) {
        state.status = 'blocked';
        state.blockReason = DRAFT_BLOCK_REASON;
        // Not an App refusal / retry-exhausted block — clear any stale gate so
        // un-drafting funnels straight back into the merge path.
        state.mergeForbidden = undefined;
        await this.persist(row, state, position);
      }
      return 'advance';
    }

    // 2. Active-run guard — never fire a NEW run while one is already working
    //    this PR. Check the queue's OWN last fix run by id, not just
    //    `row.taskId`: `row.taskId` is shared and gets reassigned by other flows
    //    (a manual task, the auto-keep-mergeable watcher), which would let the
    //    queue fire a duplicate while its own run is still in flight. Also honour
    //    any other run pointed to by `row.taskId` so we don't pile on.
    //
    //    Crucially, an in-flight run only HOLDS BACK a PR that's still blocked.
    //    A fix run can make the PR mergeable before its own status flips terminal
    //    (the commits land + checks go green while the task is still "running"),
    //    and there's no reason to sit on a ready PR waiting for that flip — so a
    //    clean PR falls through to the merge in step 5 regardless of the run.
    const ourFix = state.lastFixTaskId
      ? await linkedTaskStatus(state.lastFixTaskId)
      : null;
    const otherFix =
      row.taskId && row.taskId !== state.lastFixTaskId
        ? await linkedTaskStatus(row.taskId)
        : null;
    const runActive =
      (ourFix !== null && ACTIVE_STATUSES.has(ourFix)) ||
      (otherFix !== null && ACTIVE_STATUSES.has(otherFix));
    if (runActive && queueBlocked(row, summary)) {
      await this.ensureStatus(row, state, 'fixing', position);
      return 'hold';
    }
    // 2a. A fix run is already working this head whose only obstacle is a check
    //     the App won't merge past (not a genuine queue blocker — see the
    //     App-refusal path below). Don't re-attempt the doomed App merge on top
    //     of the run; advance so the ready PRs behind it keep draining while the
    //     run makes it mergeable.
    if (runActive && !queueBlocked(row, summary) && (summary.checks?.failed ?? 0) > 0) {
      await this.ensureStatus(row, state, 'fixing', position);
      return 'advance';
    }

    // 2b. CI still settling — required checks are queued/in-progress on the head
    //     commit, which GitHub reports as mergeStateStatus=BLOCKED. Without this
    //     guard `needsUpdate` treats that BLOCKED exactly like a hard blocker:
    //     the queue fires a fix run and, after MAX_ATTEMPTS of CI-still-not-green,
    //     declares the PR blocked — all while CI had simply not finished. Hold
    //     the slot as 'waiting' and let the checks land, WITHOUT firing a run or
    //     counting an attempt. We only wait when pending CI is the *sole*
    //     obstacle: a settled blocker (conflict, behind, changes requested,
    //     unresolved threads, or a failed required check) still funnels into the
    //     fix path immediately below.
    if (ciInFlight(summary) && !hasSettledBlocker(row, summary)) {
      await this.ensureStatus(row, state, 'waiting', position);
      // Waiting on CI must NOT gate the PRs queued behind this head — a slow or
      // flaky check on the head would otherwise freeze a ready PR behind it for
      // as long as CI churns (the reported stall). Hand the turn to the next
      // queued PR; this head is re-evaluated next tick, FIFO, nothing lost.
      return 'advance';
    }

    // 3. Account the last fix run now that it's terminal. We only ever
    //    INCREMENT `attempts` here — never reset on a momentary non-blocked
    //    reading. The cached summary briefly reads mergeable/UNKNOWN right
    //    after a fix run pushes commits (GitHub recomputes mergeability async),
    //    and resetting on that transient lie is exactly what let the queue blow
    //    past MAX_ATTEMPTS and fire fix runs forever. A genuinely-fixed PR
    //    merges in step 5 and leaves the queue, so it never needs a reset.
    if (state.lastFixTaskId && !state.accounted && !runActive) {
      const wasBlocked = state.status === 'blocked';
      if (queueBlocked(row, summary)) {
        state.attempts += 1;
        if (state.attempts >= MAX_ATTEMPTS) state.status = 'blocked';
      }
      state.accounted = true;
      // Capture the reason at the transition so the badge + notification can
      // explain why the queue gave up.
      const justBlocked = !wasBlocked && state.status === 'blocked';
      if (justBlocked) state.blockReason = blockerReason(row, summary);
      await this.persist(row, state, position);
      // Fire-once notification: the queue exhausted its retries and now needs a
      // human. A dedicated event (not the idempotent pull_request:updated) so
      // the desktop notifies exactly once, never on reconnect/backfill replay.
      if (justBlocked) this.notifyBlocked(row, state);
    }

    // 4. Gave up after MAX_ATTEMPTS — wait for a human. We do NOT auto-reset
    //    `attempts` on a momentary clean reading (same transient-UNKNOWN trap as
    //    step 3). A genuinely-clean blocked PR falls through to the merge in
    //    step 5 and leaves the queue; a still-blocked one waits here until the
    //    user re-toggles the queue (the route resets the state) — and hands its
    //    turn to the next queued PR so it doesn't gate the group meanwhile.
    if (state.status === 'blocked' && queueBlocked(row, summary)) {
      return 'advance';
    }

    // 4b. GitHub refused the App's tokens on the last merge attempt. The PR
    //     reads clean to the queue (a failing OPTIONAL check isn't a queue
    //     blocker), so without this gate the clean path below would re-attempt
    //     the doomed merge every tick, forever.
    if (state.mergeForbidden) {
      const checksFailing = (summary?.checks?.failed ?? 0) > 0;
      // Legacy boolean rows (one deploy's worth) carry no cause — classify
      // them by the live summary, same as the catch below would have.
      const kind =
        state.mergeForbidden === true
          ? checksFailing
            ? 'failing-checks'
            : 'hard'
          : state.mergeForbidden;
      // 'hard' (unknown, unfixable) and 'unsigned-commits' (re-sign budget
      // spent) both stay blocked until a human merges/re-queues — don't re-poll
      // signatures or re-attempt the doomed merge every tick.
      if (kind === 'hard' || kind === 'unsigned-commits') {
        return 'advance';
      }
      if (checksFailing) {
        // Proactively re-run the failing checks from the blocked state too —
        // a row blocked before the rerun budget existed (or before the App
        // had checks:write) would otherwise sit here waiting for a human even
        // though the queue could get itself to green. Same budget as the
        // merge-refusal path; in-flight reruns are held by the CI guard (2b).
        if ((state.rerunAttempts ?? 0) < MAX_ATTEMPTS) {
          try {
            const rerun = await githubService.rerequestFailedCheckRuns(
              row.workspaceId,
              row.owner,
              row.repo,
              row.number
            );
            if (rerun.requested > 0) {
              state.rerunAttempts = (state.rerunAttempts ?? 0) + 1;
              state.status = 'waiting';
              state.lastError =
                `re-ran ${rerun.requested} failing check(s) from the blocked state ` +
                `(attempt ${state.rerunAttempts}/${MAX_ATTEMPTS})`;
              state.lastErrorAt = new Date().toISOString();
              await this.persist(row, state, position);
              await this.refreshAfterFailedMerge(row);
              // Re-running a check is background work — don't gate the ready PRs
              // behind this head on it.
              return 'advance';
            }
            // Nothing could be re-run, and nothing will change on a re-tick
            // (permission / check ownership are static for this head) — spend
            // the budget so we don't hammer GitHub every tick, and put the
            // precise cause on the badge.
            if (rerun.reason && rerun.reason !== 'no-failing-check-runs') {
              state.rerunAttempts = MAX_ATTEMPTS;
              state.blockReason = buildFailingChecksBlockReason(rerun.reason, MAX_ATTEMPTS);
              await this.persist(row, state, position);
            }
          } catch (rerunErr) {
            console.warn(
              `[mergeQueue] blocked-state check rerun for ${row.owner}/${row.repo}#${row.number} errored:`,
              rerunErr instanceof Error ? rerunErr.message : rerunErr
            );
          }
        }
        return 'advance';
      }
      // The failing check that GitHub refused us over has gone green (rerun
      // passed or a new head reset it) — the refusal condition is gone.
      // Clear the gate (and the rerun budget, so a fresh failure on a new
      // head gets its own retries) and fall through to a fresh merge attempt.
      state.mergeForbidden = undefined;
      state.blockReason = undefined;
      state.rerunAttempts = undefined;
      state.status = 'waiting';
      await this.persist(row, state, position);
    }

    // 5. Clean path — mergeable AND up-to-date → merge it.
    if (!queueBlocked(row, summary)) {
      // Last-moment re-check: a force-released wedged tick can resume here
      // minutes later, after the PR merged or the user dequeued it. Never
      // merge off a stale snapshot.
      const current = await db
        .select({
          state: pullRequestsTable.state,
          mergeQueued: pullRequestsTable.mergeQueued,
        })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, row.id))
        .limit(1);
      if (!current[0] || current[0].state !== 'open' || !current[0].mergeQueued) return 'hold';
      // 5a. Signing gate — on a base branch that requires signed commits, a PR
      //     with unsigned commits is refused by GitHub. Re-sign via the fix task
      //     instead of attempting the doomed merge (scoped to signing repos).
      const signingVerdict = await this.handleSigningGate(row, state, summary, position, runActive);
      if (signingVerdict) return signingVerdict;
      state.status = 'merging';
      await this.persist(row, state, position);
      try {
        const result = await githubService.mergePullRequest(
          row.workspaceId,
          row.owner,
          row.repo,
          row.number,
          { merge_method: normalizeMethod(row.mergeMethod) }
        );
        if (!result.merged) {
          // GitHub accepted the request but didn't merge (e.g. it lost a race
          // and is now behind). Our cached summary is stale — refetch now so
          // the BEHIND/conflict state surfaces immediately and the next tick
          // funnels into the fix path, instead of re-attempting the merge
          // against the same stale summary until FRESHNESS_MS elapses.
          if (await this.verifyMerged(row)) {
            await this.recordMerged(row);
            return 'hold';
          }
          state.status = 'waiting';
          state.lastError = result.message || 'GitHub did not merge the pull request';
          state.lastErrorAt = new Date().toISOString();
          await this.persist(row, state, position);
          await this.refreshAfterFailedMerge(row);
          return 'hold';
        }
        await this.recordMerged(row);
      } catch (err) {
        // The merge was rejected. First disambiguate "already merged" (a lost
        // response on a merge that landed, a redeploy mid-merge, or an external
        // merge — GitHub 405s all of them) from a genuine blocker: the former
        // is a SUCCESS, and without this check the queue re-attempts a doomed
        // merge every tick while the row never leaves the head slot.
        if (await this.verifyMerged(row)) {
          await this.recordMerged(row);
          return 'hold';
        }
        // GitHub refused the App's tokens (installation AND user-to-server —
        // both count as the integration). Observed cause: a failing check on
        // the head, even an "optional" one a human can merge past. First
        // response: re-run the failing checks ourselves (bounded by
        // MAX_ATTEMPTS, same budget philosophy as fix runs) — a green rerun
        // makes the clean path merge on a later tick. Block only when the
        // rerun budget is spent, the rerun isn't possible (checks:write not
        // granted), or there's no failing check to blame; the 4b gate still
        // self-heals `failing-checks` blocks the moment the checks go green.
        if (err instanceof MergeNotPermittedForAppError) {
          // Safety net for the signing case the proactive 5a gate missed (a
          // ruleset probe the App couldn't read, or a race). If we can SEE
          // unsigned commits, the refusal is (at least partly) unsigned commits —
          // re-sign via the fix task, and record the requirement so every future
          // PR on this branch is handled proactively (learn-from-403).
          // Skip the signature lookup when GraphQL is in a rate-limit backoff
          // (it would sleep behind waitIfBlocked / burn a scarce point) — fall
          // through to the normal refusal handling; a later tick re-derives it.
          let unsignedNow = 0;
          try {
            if (!githubRateGate.isBlocked(githubService.accountKeyFor(row.workspaceId), 'graphql')) {
              unsignedNow = await fetchUnsignedCommitCount({
                workspaceId: row.workspaceId,
                owner: row.owner,
                repo: row.repo,
                number: row.number,
              });
            }
          } catch {
            // ignore — fall through to the normal refusal handling below
          }
          if (unsignedNow > 0) {
            markSigningRequired(row.workspaceId, row.owner, row.repo, baseBranchOf(row));
            return this.dispatchResign(row, state, summary, position, runActive);
          }
          const checksFailing = (summary?.checks?.failed ?? 0) > 0;
          let rerunReason:
            | 'no-failing-check-runs'
            | 'needs-actions-permission'
            | 'not-rerequestable'
            | undefined;
          if (checksFailing && (state.rerunAttempts ?? 0) < MAX_ATTEMPTS) {
            let rerun: Awaited<ReturnType<typeof githubService.rerequestFailedCheckRuns>> = {
              requested: 0,
              reason: 'no-failing-check-runs',
            };
            try {
              rerun = await githubService.rerequestFailedCheckRuns(
                row.workspaceId,
                row.owner,
                row.repo,
                row.number
              );
            } catch (rerunErr) {
              console.warn(
                `[mergeQueue] failed-check rerun for ${row.owner}/${row.repo}#${row.number} errored:`,
                rerunErr instanceof Error ? rerunErr.message : rerunErr
              );
            }
            if (rerun.requested > 0) {
              state.rerunAttempts = (state.rerunAttempts ?? 0) + 1;
              state.status = 'waiting';
              state.lastError =
                `GitHub refused the App merge over failing check(s); re-ran ` +
                `${rerun.requested} of them (attempt ${state.rerunAttempts}/${MAX_ATTEMPTS})`;
              state.lastErrorAt = new Date().toISOString();
              await this.persist(row, state, position);
              // Refetch so the re-run shows up as in-flight CI. Advance rather
              // than hold: a rerun is background work and must not gate the ready
              // PRs behind this head (step 2b also advances once CI is in flight).
              await this.refreshAfterFailedMerge(row);
              return 'advance';
            }
            rerunReason = rerun.reason;
          }
          // A rerun that produced nothing can never produce anything on a
          // re-tick either (permission / ownership are static per head) —
          // spend the budget so the gate doesn't re-attempt it every tick.
          if (checksFailing && rerunReason && rerunReason !== 'no-failing-check-runs') {
            state.rerunAttempts = MAX_ATTEMPTS;
          }
          // The App can't merge THIS PR — GitHub refused it (a red check it won't
          // merge past, even an "optional" one, or a branch ruleset that excludes
          // the App on this PR). A cloud fix run can't grant merge permission, and
          // dispatching one here left the PR churning in 'fixing' and gating the
          // whole group (the reported stall). So once reruns can't green it, BLOCK
          // this PR with an actionable reason and ADVANCE to the next queued PR —
          // the "block and move on" mechanic. The 4b gate self-heals a
          // 'failing-checks' block the moment the checks go green (a rerun on
          // GitHub, or a new head), so a transient red check still retries without
          // us churning a fix run.
          state.status = 'blocked';
          state.mergeForbidden = checksFailing ? 'failing-checks' : 'hard';
          state.blockReason = !checksFailing
            ? `${err.message} Merge manually on GitHub, or re-queue the PR to retry.`
            : buildFailingChecksBlockReason(rerunReason, state.rerunAttempts ?? 0);
          state.lastError = err.message;
          state.lastErrorAt = new Date().toISOString();
          await this.persist(row, state, position);
          this.notifyBlocked(row, state);
          return 'advance';
        }
        // A real rejection (e.g. 405 "Pull Request has merge conflicts") means
        // our cached mergeability was stale. Record the error, then refetch the
        // PR immediately so the real conflicting/behind state hits the cache +
        // UI now instead of after FRESHNESS_MS — the next tick then funnels the
        // now-blocked PR into the cloud fix run. Don't dequeue.
        state.status = 'waiting';
        state.lastError = err instanceof Error ? err.message : 'Merge failed';
        state.lastErrorAt = new Date().toISOString();
        await this.persist(row, state, position);
        await this.refreshAfterFailedMerge(row);
      }
      return 'hold';
    }

    // 6. Blocked path — conflict / changes / failing CI / unresolved threads /
    //    BEHIND / BLOCKED. Funnel all of these into the SAME cloud fix run (it
    //    merges the base in, curing both conflicts and BEHIND in one run).

    // Hard cap — the absolute guard against firing past the retry budget, even
    // if a transient clean reading + failed merge briefly downgraded `status`
    // to 'waiting'. `attempts` only ever increments in step 3 (which already
    // notified at the cap), so just re-settle the badge to 'blocked' silently —
    // and hand the turn to the next queued PR.
    if (state.attempts >= MAX_ATTEMPTS) {
      await this.ensureStatus(row, state, 'blocked', position);
      return 'advance';
    }

    await this.dispatchFixRun(row, state, summary, position);
    // A genuine blocker (conflict / behind / changes / threads) holds the group
    // while its fix runs — merging a same-base sibling first would just
    // re-conflict it. (The no-provider / task-limit cases handled inside the
    // helper also can't advance: same-workspace siblings can't dispatch either.)
    return 'hold';
  }

  /**
   * Fire the shared "get this PR mergeable" cloud run for the head and record it
   * on the queue state (status → 'fixing'). Returns 'deferred' — badge left as
   * 'waiting', no accountable state changed — when it couldn't dispatch (no
   * connected provider, or the free-plan task limit); neither should burn a
   * retry. Extracted so both the genuine-blocker path (step 6) and the
   * App-refused-over-a-non-required-check path drive the SAME run.
   */
  private async dispatchFixRun(
    row: PRRow,
    state: MergeQueueState,
    summary: PRMergeableSummary,
    position: number,
    opts: { resign?: boolean } = {},
  ): Promise<'fired' | 'deferred'> {
    const resolved = await resolveCloudEnv(row.workspaceId);
    if (!resolved) {
      await this.ensureStatus(row, state, 'waiting', position);
      return 'deferred';
    }
    const { envId, provider } = resolved;
    const ref = `${row.owner}/${row.repo}#${row.number}`;
    const prTitle = (row.lastSummary as { title?: string } | null)?.title ?? '';
    let created;
    try {
      created = await createCloudTask({
        workspaceId: row.workspaceId,
        type: 'pr_response',
        title: `Get ${ref} mergeable (merge queue)`,
        description: opts.resign
          ? `Merge queue: re-sign ${ref} ("${prTitle}") — the base requires signed commits — and take it to a clean, mergeable state.`
          : `Merge queue: take ${ref} ("${prTitle}") to a clean, mergeable, up-to-date state.`,
        prompt: buildMergeablePrompt({
          owner: row.owner,
          repo: row.repo,
          number: row.number,
          summary,
          provider,
          resignCommits: opts.resign ?? false,
          template: await workspacePromptTemplate(row.workspaceId, 'mergeable'),
        }),
        repositoryId: row.repositoryId,
        assignedEnvironmentId: envId,
        pullRequestId: row.id,
      });
    } catch (err) {
      if (err instanceof TaskLimitError) {
        // Free-plan concurrency limit — transient, like "no cloud provider":
        // don't burn an attempt; a slot frees up when a task ends.
        console.log(`[mergeQueue] ${ref}: fix run deferred — ${err.message}`);
        await this.ensureStatus(row, state, 'waiting', position);
        return 'deferred';
      }
      throw err;
    }
    state.lastFixTaskId = created.id;
    state.accounted = false;
    state.status = 'fixing';
    await this.persist(row, state, position);
    return 'fired';
  }

  /**
   * Signing gate for the clean-merge path. On a base branch that REQUIRES signed
   * commits, GitHub refuses the App's merge while any commit is unsigned — so
   * detect it up front and re-sign via the fix task rather than attempting the
   * doomed merge. Returns a {@link HeadVerdict} when it took over (re-sign fired
   * or blocked), or `null` when the PR is safe to merge (repo doesn't require
   * signing, all commits signed, or our own check failed — let the merge/403 net
   * handle it). Scoped by a cached probe, so most PRs skip the signature fetch.
   */
  private async handleSigningGate(
    row: PRRow,
    state: MergeQueueState,
    summary: PRMergeableSummary,
    position: number,
    runActive: boolean
  ): Promise<HeadVerdict | null> {
    const accountKey = githubService.accountKeyFor(row.workspaceId);
    // The gate's first move is a GraphQL signature lookup; if GraphQL is in a
    // backoff (its own point budget, or the shared secondary limit) it would
    // sleep behind `waitIfBlocked` — defer the head to a later tick instead
    // (mirrors processGroup's between-heads rate-gate deferral). REST-only
    // backoffs don't apply here — the merge below rechecks REST itself.
    if (githubRateGate.isBlocked(accountKey, 'graphql')) return 'advance';

    const base = baseBranchOf(row);
    if (!(await requiresSignedCommits(row.workspaceId, row.owner, row.repo, base))) {
      return null; // repo/branch doesn't require signed commits — merge as normal
    }
    // A re-sign run is already in flight — don't re-poll signatures every tick
    // (a needless GraphQL call per tick, on a budget-starved account). Hold the
    // badge at 'fixing' and let the run finish; the next no-run tick re-checks.
    if (runActive) {
      await this.ensureStatus(row, state, 'fixing', position);
      return 'advance';
    }
    // GraphQL budget in reserve — don't spend a scarce point on the signature
    // fetch (or the doomed merge it gates). Defer until the window recovers; this
    // is what keeps the queue's signing checks from tipping the account over.
    if (graphqlBudget.shouldDefer(accountKey)) return 'advance';

    let unsigned: number;
    try {
      unsigned = await fetchUnsignedCommitCount({
        workspaceId: row.workspaceId,
        owner: row.owner,
        repo: row.repo,
        number: row.number,
      });
    } catch (err) {
      // Our own signature check failed — don't block the merge on it; let the
      // attempt proceed (the 403 safety net catches a real refusal).
      console.warn(
        `[mergeQueue] signature check failed for ${row.owner}/${row.repo}#${row.number}:`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
    if (unsigned === 0) return null; // every commit signed — merge as normal
    return this.dispatchResign(row, state, summary, position, runActive);
  }

  /**
   * Fire a bounded re-sign fix run (or block once the budget is spent). Advances
   * the group so ready PRs behind the head keep draining while it re-signs. When
   * a re-sign run is already in flight (`runActive`) it just holds the badge at
   * 'fixing' — never piling a second run on top or burning another attempt.
   */
  private async dispatchResign(
    row: PRRow,
    state: MergeQueueState,
    summary: PRMergeableSummary,
    position: number,
    runActive: boolean
  ): Promise<HeadVerdict> {
    if (runActive) {
      await this.ensureStatus(row, state, 'fixing', position);
      return 'advance';
    }
    if ((state.resignAttempts ?? 0) < MAX_ATTEMPTS) {
      if ((await this.dispatchFixRun(row, state, summary, position, { resign: true })) === 'fired') {
        state.resignAttempts = (state.resignAttempts ?? 0) + 1;
        await this.persist(row, state, position);
      }
      return 'advance';
    }
    // Re-signing couldn't get every commit signed within budget — wait for a human.
    state.status = 'blocked';
    state.mergeForbidden = 'unsigned-commits';
    state.blockReason =
      `The base branch requires signed commits and some commits on this PR are unsigned. ` +
      `Talyn tried to re-sign the branch ${MAX_ATTEMPTS}× and couldn't get every commit signed — ` +
      `sign the branch's commits (or merge manually on GitHub), then re-queue the PR.`;
    state.lastError = 'unsigned commits on a signed-commits-required branch';
    state.lastErrorAt = new Date().toISOString();
    await this.persist(row, state, position);
    this.notifyBlocked(row, state);
    return 'advance';
  }

  /**
   * Ask GitHub (REST — `merged_at` is the canonical signal, and the endpoint
   * works on merged PRs where the open-only GraphQL search can't see them)
   * whether the PR is in fact merged. Best-effort: any failure reads as "not
   * merged" and the caller falls back to its normal error handling.
   */
  private async verifyMerged(row: PRRow): Promise<boolean> {
    try {
      const pr = await githubService.getPullRequest(
        row.workspaceId,
        row.owner,
        row.repo,
        row.number
      );
      return Boolean(pr.merged_at || pr.merged);
    } catch {
      return false;
    }
  }

  /**
   * The single success path: flip the row terminal (the merge route can't
   * GraphQL-refetch a merged PR either), drop it off the queue, and reshuffle
   * the survivors' "#N" badges. The next same-base PR becomes head on the next
   * tick automatically.
   */
  private async recordMerged(row: PRRow): Promise<void> {
    const db = getDbClient();
    await db
      .update(pullRequestsTable)
      .set({
        state: 'merged',
        mergedAt: new Date(),
        ...QUEUE_RESET_COLUMNS,
        updatedAt: new Date(),
      })
      .where(eq(pullRequestsTable.id, row.id));
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: 'merged',
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: false,
      mergeQueueState: null,
    });
    await broadcastMergeQueuePositions(row.workspaceId);
  }

  /**
   * Force-refetch a PR right after a failed merge attempt. The merge API is
   * the freshest possible mergeability signal — if it rejected us, the cached
   * summary that said "mergeable" is stale. Refetching upserts the real state
   * (CONFLICTING/BEHIND) and emits `pull_request:updated`, so the UI updates
   * immediately and the next tick's `queueBlocked` check funnels the PR into
   * the cloud fix run rather than re-attempting a doomed merge for ~90s.
   * Best-effort: a refetch failure just falls back to the freshness timer.
   */
  private async refreshAfterFailedMerge(row: PRRow): Promise<void> {
    await prMonitorService
      .refreshPr(row.workspaceId, row.owner, row.repo, row.number)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn(
          `[mergeQueueProcessor] post-merge-failure refetch failed for ${row.owner}/${row.repo}#${row.number}:`,
          msg
        );
      });
  }

  /**
   * Emit the one-time `merge_queue:blocked` signal the desktop turns into an
   * OS notification + in-app toast. Best-effort: the persisted state + badge
   * already reflect the block, so a missed broadcast just costs the ping.
   */
  private notifyBlocked(row: PRRow, state: MergeQueueState): void {
    const summary = row.lastSummary as { title?: string; url?: string } | null;
    emitMergeQueueBlocked(row.workspaceId, {
      pullRequestId: row.id,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      title: summary?.title ?? '',
      url: summary?.url ?? '',
      reason: state.blockReason ?? 'needs attention',
      attempts: state.attempts,
    });
  }

  /** Persist `status` only if it changed, emitting a WS echo when it does. */
  private async ensureStatus(
    row: PRRow,
    state: MergeQueueState,
    status: QueueStatus,
    position = 1
  ): Promise<void> {
    if (state.status === status) return;
    state.status = status;
    await this.persist(row, state, position);
  }

  /** Drop a no-longer-open PR off the queue. */
  private async dequeue(row: PRRow): Promise<void> {
    const db = getDbClient();
    await db
      .update(pullRequestsTable)
      .set({ ...QUEUE_RESET_COLUMNS, updatedAt: new Date() })
      .where(eq(pullRequestsTable.id, row.id));
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: false,
      mergeQueueState: null,
    });
    // Dropping out of the queue shifts the survivors' positions — rebroadcast.
    await broadcastMergeQueuePositions(row.workspaceId);
  }

  private async persist(row: PRRow, state: MergeQueueState, position = 1): Promise<void> {
    const db = getDbClient();
    await db
      .update(pullRequestsTable)
      .set({ mergeQueueState: state, updatedAt: new Date() })
      .where(eq(pullRequestsTable.id, row.id));
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: row.mergeQueued,
      // The PR's 1-based slot within its queue group — the head is 1, but the
      // processor can act deeper in when blocked PRs are skipped over.
      mergeQueueState: publicState(state, position),
    });
  }
}

export const mergeQueueProcessor = new MergeQueueProcessor();
