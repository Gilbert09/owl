import type { Redis } from 'ioredis';
import { createRedisConnection, isRedisEnabled } from './redis.js';
import { REPLICA_ID } from './wsBus.js';
import { targetsForRepo, refreshWebhookIndex, type WatchTarget } from './webhookIndex.js';
import { prMonitorService } from './prMonitor.js';
import { githubService } from './github.js';
import { GitHubRateLimitError } from './githubRateGate.js';
import { debugBus } from './debugBus.js';
import {
  checkCountCoalescer,
  parseCheckRunPayload,
  pruneChecksForSha,
} from './checkCounts.js';

/**
 * Drains the GitHub webhook ingest stream and turns each delivery into the
 * realtime work it implies.
 *
 * The receiver (routes/webhooks.ts) XADDs verified deliveries to a Redis Stream;
 * a consumer group lets every replica pull competitively so each delivery is
 * processed exactly once across the fleet. For a PR-affecting event we resolve
 * EVERY workspace watching the repo and `refreshPr` each — that one call
 * re-fetches the PR (state, checks, reviews, comments, mergeability) and upserts
 * it, which broadcasts `pull_request:updated`. A short coalescing window
 * collapses bursts (e.g. 20 check_runs for one suite) into a single refresh per
 * (workspace, PR).
 *
 * Inert when REDIS_URL is unset.
 */

export const WEBHOOK_STREAM = 'gh:webhooks';
const GROUP = 'fastowl';
const COALESCE_WINDOW_MS = 750;
// How many stream deliveries to read per loop iteration.
const WORKER_BATCH = 32;

// Max concurrent SLOW deliveries (pull_request/review/comment → a ~1-2s
// `refreshPr` GraphQL call). These run in a background lane so they never gate
// the fast `check_run`/`check_suite` firehose (which only buffers into the
// coalescer, ~1ms). Before this split, one slow refresh in a Promise.all batch
// dragged the whole batch to ~1.5s and capped drain below the ingest rate, so a
// CI burst built a multi-minute backlog the worker could never claw back. The
// cap also bounds simultaneous GitHub GraphQL + DB-pool load.
const SLOW_LANE_MAX = 6;

/** Events whose processing makes a ~1-2s `refreshPr` GraphQL call (the slow lane). */
export function isSlowEvent(eventType: string): boolean {
  return [
    'pull_request',
    'pull_request_review',
    'pull_request_review_comment',
    'issue_comment',
  ].includes(eventType);
}

/** Minimal counting semaphore with fair slot hand-off, for the slow lane. */
class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot directly to a waiter (active unchanged)
    else this.active--;
  }
}

// Opt-in deep trace of the webhook pipeline (set WEBHOOK_TRACE=1). Logs every
// step a delivery takes — received → fanout → dispatch/coalesce → refresh →
// resolved state — so a "why didn't my merge update?" can be followed end to
// end in stdout. Off by default: with org-wide ("All repositories") install
// access this is a firehose, so it's a deliberate, temporary debug switch.
export const WEBHOOK_TRACE =
  process.env.WEBHOOK_TRACE === '1' || process.env.WEBHOOK_TRACE === 'true';
export function whTrace(msg: string): void {
  if (WEBHOOK_TRACE) console.log(`[wh-trace] ${msg}`);
}

/** The decoded envelope the receiver enqueues. */
export interface WebhookDelivery {
  deliveryId: string;
  eventType: string;
  action?: string;
  repoFullName: string;
  installationId?: string;
  enqueuedAtMs: number;
  payload: Record<string, unknown>;
}

// ---- Pure classification helpers (unit-tested) ---------------------------

/**
 * Whether an event should trigger a PR data refresh. installation* events are
 * handled separately (index/allowlist maintenance), not here.
 */
export function isRefreshEvent(eventType: string): boolean {
  return [
    'pull_request',
    'pull_request_review',
    'pull_request_review_comment',
    'issue_comment',
    'check_run',
    'check_suite',
  ].includes(eventType);
}

/**
 * The PR number(s) a delivery touches. Most events carry one; check_run /
 * check_suite reference an array (a commit can belong to several PRs).
 * `issue_comment` only counts when the issue is actually a PR. `status` carries
 * no PR number (commit-scoped) — returns [] (the reconcile sweep covers it).
 */
export function extractPrNumbers(eventType: string, payload: Record<string, unknown>): number[] {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) ? v : null;
  const fromArray = (arr: unknown): number[] =>
    Array.isArray(arr)
      ? arr.map((p) => num((p as { number?: unknown })?.number)).filter((n): n is number => n !== null)
      : [];

  switch (eventType) {
    case 'pull_request': {
      const n = num((payload.pull_request as { number?: unknown })?.number) ?? num(payload.number);
      return n !== null ? [n] : [];
    }
    case 'pull_request_review':
    case 'pull_request_review_comment': {
      const n = num((payload.pull_request as { number?: unknown })?.number);
      return n !== null ? [n] : [];
    }
    case 'issue_comment': {
      const issue = payload.issue as { number?: unknown; pull_request?: unknown } | undefined;
      if (!issue?.pull_request) return []; // a plain issue, not a PR
      const n = num(issue.number);
      return n !== null ? [n] : [];
    }
    case 'check_run':
      return fromArray((payload.check_run as { pull_requests?: unknown })?.pull_requests);
    case 'check_suite':
      return fromArray((payload.check_suite as { pull_requests?: unknown })?.pull_requests);
    default:
      return [];
  }
}

// ---- Coalescing ----------------------------------------------------------

const recentRefresh = new Map<string, number>();

function shouldRefresh(key: string, nowMs: number): boolean {
  const last = recentRefresh.get(key);
  if (last !== undefined && nowMs - last < COALESCE_WINDOW_MS) return false;
  recentRefresh.set(key, nowMs);
  // Opportunistic prune so the map can't grow unbounded.
  if (recentRefresh.size > 5_000) {
    for (const [k, t] of recentRefresh) {
      if (nowMs - t > COALESCE_WINDOW_MS) recentRefresh.delete(k);
    }
  }
  return true;
}

// ---- Delivery processing --------------------------------------------------

/**
 * Fan one delivery out to every watching workspace. Returns the number of
 * (workspace, PR) refreshes actually dispatched (post-coalescing). Exported for
 * tests. `nowMs` is injectable for deterministic coalescing assertions.
 */
export async function processWebhookDelivery(
  delivery: WebhookDelivery,
  nowMs: number = Date.now(),
): Promise<number> {
  whTrace(
    `recv ${delivery.eventType}/${delivery.action ?? '-'} ` +
      `${delivery.repoFullName || '(no repo)'} delivery=${delivery.deliveryId}`,
  );

  // installation lifecycle: keep the repo watch index + the account→installation
  // index current (the latter so data-plane reads resolve a newly-(un)installed
  // account immediately, across replicas).
  if (delivery.eventType === 'installation' || delivery.eventType === 'installation_repositories') {
    await refreshWebhookIndex().catch(() => undefined);
    await githubService.refreshInstallationIndex().catch(() => undefined);
    return 0;
  }

  const targets = await targetsForRepo(delivery.repoFullName);
  if (targets.length === 0) {
    whTrace(`  └ ${delivery.repoFullName}: no watching workspace — dropped`);
    return 0;
  }

  // A push to a busy base branch (posthog merges to `master` constantly) would
  // fan out to a full refreshPr for EVERY open PR on that base — dozens of ~1-2s
  // GraphQL calls per push — which starves the worker and buries low-volume,
  // high-value events (a PR merge) behind the backlog. And it couldn't do its
  // job anyway: the refresh runs with resolveMergeable:false, so it only ever
  // saw `mergeable: UNKNOWN` (GitHub recomputes lazily) and never detected the
  // conflict it existed to catch. The 5-min reconcile sweep (resolveMergeable:
  // true) is the authoritative base-advance conflict check; a PR's *own* push
  // still fires `pull_request synchronize`. So skip push entirely.
  if (delivery.eventType === 'push') {
    whTrace(`  push ${delivery.repoFullName}: skipped (sweep handles base-advance conflicts)`);
    return 0;
  }

  if (!isRefreshEvent(delivery.eventType)) {
    whTrace(`  └ ${delivery.eventType}: not a refresh event — ignored`);
    return 0;
  }
  const numbers = extractPrNumbers(delivery.eventType, delivery.payload);
  if (numbers.length === 0) {
    whTrace(
      `  └ ${delivery.eventType}/${delivery.action ?? '-'} ${delivery.repoFullName}: ` +
        `no PR number on payload — ignored`,
    );
    return 0;
  }
  whTrace(
    `  ${delivery.eventType}/${delivery.action ?? '-'} ${delivery.repoFullName} ` +
      `PRs=[${numbers.join(',')}] → ${targets.length} workspace(s)`,
  );

  // check_suite carries no per-check data — the individual check_run events do —
  // so it's a no-op for the incremental count path. Skipping it removes a big
  // slice of the firehose; the per-check_run updates + the sweep keep counts live.
  if (delivery.eventType === 'check_suite') {
    whTrace(`  check_suite ${delivery.repoFullName}: no-op (counts come from check_run)`);
    return 0;
  }

  // check_run: update the pill counts INCREMENTALLY — no GraphQL refresh. We
  // BUFFER the event into the coalescer keyed by (repo, sha) and return
  // immediately; a short window collapses a CI suite's burst of check_runs for
  // one commit into a single DB flush (one multi-row upsert + one recompute +
  // one broadcast per PR) instead of paying that per event. The receiver has
  // already dropped check_runs whose sha is no PR head (webhookHeadIndex), so
  // anything reaching here is a live, tracked head worth buffering.
  //
  // NB: NO full-refresh fallback. A check_run whose head_sha ≠ the PR's head
  // (very common — GitHub runs many checks on a *merge commit*) isn't in the PR
  // head's statusCheckRollup anyway; a genuinely stale head is corrected by the
  // PR's own pull_request/synchronize event and the reconcile sweep.
  if (delivery.eventType === 'check_run') {
    const ev = parseCheckRunPayload(delivery.payload, delivery.repoFullName);
    if (!ev) return 0;
    checkCountCoalescer.enqueue(ev);
    whTrace(`  check_run ${delivery.repoFullName} ${ev.name}=${ev.state} → buffered (coalesced)`);
    return 0; // the count update is accounted at flush time, not per delivery
  }

  // A PR closing/merging or force-pushing makes its per-check state irrelevant —
  // prune it (the count fast-path stays bounded to open, tracked PRs). Done
  // alongside the normal refresh below, which still materialises the PR row.
  if (delivery.eventType === 'pull_request') {
    await pruneOnPullRequest(delivery).catch(() => undefined);
    // Metadata-only actions (label/title/draft) change a field we persist
    // verbatim, or nothing at all — patch it from the payload and skip the
    // ~1-2s refreshPr. `null` = "needs the full refresh" (falls through below).
    const handled = await tryIncrementalPrMetadata(delivery, targets, numbers);
    if (handled !== null) return handled;
  }

  // Everything else (pull_request actions, reviews, comments): a full refresh
  // that materialises/updates the row (mergeable, reviews, authoritative counts).
  // ONE shared GitHub fetch per PR number across all watching workspaces — the
  // old per-(workspace, PR) fan-out made N identical GraphQL calls against the
  // installation's single shared point budget and drained it (the prod
  // rate-limit storm). See prMonitor.refreshPrAcrossWorkspaces.
  let dispatched = 0;
  for (const number of numbers) {
    dispatched += await refreshNumberAcrossTargets(
      targets,
      number,
      delivery.repoFullName,
      nowMs,
      delivery.eventType,
    );
  }
  return dispatched;
}

/**
 * Drop per-check state a `pull_request` event has made stale: the head commit on
 * close/merge (the PR is done), and the *previous* head on a force-push
 * (`synchronize` carries `before`/`after`; checks on `before` no longer count).
 */
async function pruneOnPullRequest(delivery: WebhookDelivery): Promise<void> {
  const pr = delivery.payload.pull_request as { head?: { sha?: string } } | undefined;
  if (delivery.action === 'closed') {
    const sha = pr?.head?.sha;
    if (typeof sha === 'string') await pruneChecksForSha(delivery.repoFullName, sha);
  } else if (delivery.action === 'synchronize') {
    const before = delivery.payload.before;
    if (typeof before === 'string') await pruneChecksForSha(delivery.repoFullName, before);
  }
}

/**
 * Handle `pull_request` actions whose effect is fully contained in the payload —
 * a persisted field we copy verbatim (title, draft, labels) — without a GitHub
 * fetch. Returns the rows-updated count when handled, or `null` to signal "this
 * action needs the full `refreshPr`".
 *
 * Deliberately NOT shortcut (→ refreshPr): `opened`/`reopened`/`synchronize`
 * (new/changed head → checks + mergeability), `closed`/merged (flows through the
 * cursor/delta + merge-queue path), `review_requested*` (recomputes the
 * viewer-relative `reviewRequestVia`), and `edited` that changed the base branch
 * (mergeability). Validated against `summaryToJsonb`: `draft`/`title`/`labels`
 * feed no derived field (mergeable/reviewDecision/blockingReason) — labels are
 * read only by the external-merge-queue logic, which wants exactly this verbatim
 * copy.
 */
async function tryIncrementalPrMetadata(
  delivery: WebhookDelivery,
  targets: Array<{ repositoryId: string }>,
  numbers: number[],
): Promise<number | null> {
  const action = delivery.action;
  const pr = delivery.payload.pull_request as
    | { title?: string; draft?: boolean; labels?: Array<{ name?: string }> }
    | undefined;
  const changes = delivery.payload.changes as Record<string, unknown> | undefined;

  const patchAll = async (patch: {
    title?: string;
    draft?: boolean;
    labels?: string[];
  }): Promise<number> => {
    let n = 0;
    for (const number of numbers) n += await prMonitorService.patchOpenPrSummary(targets, number, patch);
    return n;
  };

  switch (action) {
    case 'labeled':
    case 'unlabeled': {
      // Labels ARE tracked now: an external merge queue (trunk.io) reports a
      // submitted PR's state only as labels, and the merge queue re-evaluates on
      // each change (patchOpenPrSummary emits pr:snapshot). The payload carries
      // the PR's full post-change label set, so no GitHub fetch is needed.
      const labels = pr?.labels
        ?.map((l) => l?.name)
        .filter((n): n is string => typeof n === 'string');
      if (!labels) return null; // malformed payload — fall back to a real refresh
      const n = await patchAll({ labels });
      whTrace(
        `  pull_request/${action} ${delivery.repoFullName}: labels patched → ${n} row(s) (no refresh)`,
      );
      return n;
    }
    case 'edited': {
      // A base-branch edit changes mergeability → needs the full refresh.
      if (changes?.base !== undefined) return null;
      // Only a title change touches a persisted field; a body-only edit is a no-op.
      if (changes?.title === undefined) {
        whTrace(`  pull_request/edited ${delivery.repoFullName}: no title/base change — no refresh`);
        return 0;
      }
      if (typeof pr?.title !== 'string') return null;
      const n = await patchAll({ title: pr.title });
      whTrace(`  pull_request/edited ${delivery.repoFullName}: title patched → ${n} row(s) (no refresh)`);
      return n;
    }
    case 'ready_for_review':
    case 'converted_to_draft': {
      if (typeof pr?.draft !== 'boolean') return null;
      const n = await patchAll({ draft: pr.draft });
      whTrace(
        `  pull_request/${action} ${delivery.repoFullName}: draft=${pr.draft} patched → ${n} row(s) (no refresh)`,
      );
      return n;
    }
    default:
      return null; // opened / reopened / synchronize / closed / review_requested / …
  }
}

/**
 * Refresh one PR number across every watching workspace with a SINGLE shared
 * GitHub fetch. Per-workspace coalescing still applies (a workspace refreshed
 * <COALESCE_WINDOW_MS ago is skipped); the fetch runs once for the workspaces
 * that survive it. Returns how many (workspace) refreshes were dispatched
 * post-coalescing. A fetch failure is logged ONCE here — not once per workspace,
 * as the old per-target fan-out did.
 *
 * The index-resolved repositoryId flows through so the refresh skips its
 * getWatchedRepos DB round-trip; refreshPrAcrossWorkspaces never blocks on
 * `mergeable: UNKNOWN` (the sweep / a follow-up event settles it).
 */
async function refreshNumberAcrossTargets(
  targets: WatchTarget[],
  number: number,
  repoFullName: string,
  nowMs: number,
  eventType: string,
): Promise<number> {
  const fresh = targets.filter((t) =>
    shouldRefresh(`${t.workspaceId}:${repoFullName.toLowerCase()}:${number}`, nowMs),
  );
  if (fresh.length === 0) {
    whTrace(
      `    coalesced ${repoFullName}#${number} (${eventType}) — all workspaces refreshed <${COALESCE_WINDOW_MS}ms ago`,
    );
    return 0;
  }
  whTrace(
    `    dispatch ${repoFullName}#${number} (${eventType}) → refreshPrAcrossWorkspaces ×${fresh.length}`,
  );
  try {
    await prMonitorService.refreshPrAcrossWorkspaces(fresh, number);
    whTrace(`    done ${repoFullName}#${number} (${eventType})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Benign on busy repos: the number is an ISSUE (issues + PRs share a
    // numbering space, and a check_run/check_suite/comment can reference one)
    // or a transferred/deleted PR. Not an error — record where it came from on
    // the Debug bus (not stdout) so the source is traceable without spam.
    if (/Could not resolve to a PullRequest/i.test(msg)) {
      debugBus.recordWebhook({
        action: 'processed',
        eventType,
        repo: repoFullName,
        prNumbers: [number],
        ok: true,
        fanout: 0,
        dropReason: 'not_a_pr',
      });
      return fresh.length;
    }
    // The account's GraphQL budget is gated (githubRateGate) — an expected,
    // self-clearing condition the gate already logged ONCE when it engaged.
    // Don't re-log per delivery (that was part of the storm); record it on the
    // Debug bus and move on. The reconcile sweep catches up once the window resets.
    if (err instanceof GitHubRateLimitError) {
      debugBus.recordWebhook({
        action: 'processed',
        eventType,
        repo: repoFullName,
        prNumbers: [number],
        ok: false,
        fanout: 0,
        error: 'rate-limited (gated)',
      });
      return fresh.length;
    }
    // One concise line, no stack — operational, not a crash.
    console.warn(`[webhookWorker] refreshPr (${eventType}) ${repoFullName}#${number}: ${msg}`);
  }
  return fresh.length;
}

// ---- Stream consumer ------------------------------------------------------

function fieldsToObject(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  return obj;
}

/** Decode a stream entry's fields into a delivery, or null if unparseable. */
function parseDelivery(fields: string[]): WebhookDelivery | null {
  try {
    return JSON.parse(fieldsToObject(fields).data) as WebhookDelivery;
  } catch {
    return null;
  }
}

class WebhookWorker {
  private conn: Redis | null = null;
  private running = false;
  private slowGate = new Semaphore(SLOW_LANE_MAX);

  async init(): Promise<void> {
    if (!isRedisEnabled()) {
      console.log('[webhookWorker] REDIS_URL unset — webhook worker disabled');
      return;
    }
    this.conn = createRedisConnection('webhook-worker');
    if (!this.conn) return;
    debugBus.registerPoller(
      'webhook_worker',
      0,
      'Drains the GitHub webhook Redis Stream and fans deliveries out to PR refreshes.',
    );
    try {
      await this.conn.xgroup('CREATE', WEBHOOK_STREAM, GROUP, '$', 'MKSTREAM');
    } catch (err) {
      // BUSYGROUP = group already exists; anything else is unexpected.
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) {
        console.error('[webhookWorker] xgroup create failed:', err);
      }
    }
    this.running = true;
    void this.loop();
    console.log(`[webhookWorker] consuming ${WEBHOOK_STREAM} as ${REPLICA_ID}`);
  }

  private async loop(): Promise<void> {
    while (this.running && this.conn) {
      try {
        const res = (await this.conn.xreadgroup(
          'GROUP',
          GROUP,
          REPLICA_ID,
          'COUNT',
          WORKER_BATCH,
          'BLOCK',
          5_000,
          'STREAMS',
          WEBHOOK_STREAM,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;
        if (!res) continue;
        // Process the batch CONCURRENTLY rather than one-at-a-time. Each
        // delivery's expensive step (refreshPr → GitHub GraphQL, ~1-2s for a big
        // PR) is independent, so serial processing capped throughput at
        // 1/latency and let the firehose back up. handleEntry is self-contained
        // (its own try/catch + xack), so a failure in one never rejects the
        // batch. Concurrency is bounded by WORKER_BATCH (the read COUNT), which
        // keeps simultaneous GraphQL/DB load in check.
        const batch = res
          .flatMap(([, entries]) => entries)
          .map(([id, fields]) => ({ id, delivery: parseDelivery(fields) }));

        // FAST lane: check_run/check_suite (buffer into the coalescer, ~1ms) and
        // anything unparseable/no-op. Drained inline at memory speed so the
        // firehose never waits on a refresh. SLOW lane: refresh events run in a
        // bounded background pool (slowGate) and are NOT awaited here, so one
        // slow refreshPr can't gate the batch. Backpressure: we only block
        // reading more when the slow lane is saturated.
        const fast = batch.filter((b) => !b.delivery || !isSlowEvent(b.delivery.eventType));
        const slow = batch.filter((b) => b.delivery && isSlowEvent(b.delivery.eventType));
        await Promise.all(fast.map((b) => this.handleEntry(b.id, b.delivery, 'fast')));
        for (const b of slow) {
          await this.slowGate.acquire();
          void this.handleEntry(b.id, b.delivery, 'slow').finally(() => this.slowGate.release());
        }
      } catch (err) {
        if (this.running) {
          console.error('[webhookWorker] read loop error:', err);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }
  }

  private async handleEntry(
    id: string,
    delivery: WebhookDelivery | null,
    lane: 'fast' | 'slow',
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      if (!delivery) throw new Error('unparseable delivery payload');
      const fanout = await processWebhookDelivery(delivery);
      // Definitive consumer-lag readout: how long this delivery sat between the
      // receiver enqueuing it and the worker starting it. Reading this directly
      // beats inferring lag from UUID gaps in a noisy log buffer.
      const lagMs = delivery.enqueuedAtMs ? startedAt - delivery.enqueuedAtMs : -1;
      whTrace(
        `entry ${delivery.eventType}/${delivery.action ?? '-'} ${delivery.repoFullName} ` +
          `lag=${(lagMs / 1000).toFixed(1)}s fanout=${fanout} took=${Date.now() - startedAt}ms`,
      );
      debugBus.recordWebhook({
        action: 'processed',
        eventType: delivery.eventType,
        ghAction: delivery.action,
        repo: delivery.repoFullName,
        prNumbers: extractPrNumbers(delivery.eventType, delivery.payload),
        delivery: delivery.deliveryId,
        ok: true,
        fanout,
        latencyMs: delivery.enqueuedAtMs ? startedAt - delivery.enqueuedAtMs : undefined,
        lane,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      debugBus.recordWebhook({
        action: 'processed',
        eventType: delivery?.eventType ?? 'unknown',
        ghAction: delivery?.action,
        repo: delivery?.repoFullName,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Ack regardless: a delivery that throws is logged; the reconcile sweep is
      // the safety net for missed work. Leaving it un-acked would wedge the PEL.
      await this.conn?.xack(WEBHOOK_STREAM, GROUP, id).catch(() => undefined);
      debugBus.pollerTick('webhook_worker', {
        durationMs: Date.now() - startedAt,
        ok: true,
        summary: `webhook_worker processed ${delivery?.eventType ?? '?'} `,
      });
    }
  }

  shutdown(): void {
    this.running = false;
    void this.conn?.quit().catch(() => undefined);
    this.conn = null;
  }
}

export const webhookWorker = new WebhookWorker();

/** Test helper — clear the coalescing window. */
export function _resetCoalesce(): void {
  recentRefresh.clear();
}
