import type { DebugMergeableSettle } from '@talyn/shared';

import { githubService } from './github.js';
import { graphqlBudget } from './graphqlBudget.js';

/**
 * GitHub computes `mergeable` LAZILY. The first fetch after anything that
 * invalidates it — a push to the head, or a push to the BASE — answers
 * `UNKNOWN` and kicks off a background job; the answer is usually ready a
 * second or two later.
 *
 * The webhook refresh path deliberately does not wait for it (`resolveMergeable:
 * false`): resolving inline is a blocking retry loop, and putting it on the hot
 * path is a webhook-worker backlog source. So the hot path writes `UNKNOWN` over
 * whatever the row knew before.
 *
 * Nothing then asked again. The only caller that resolves `UNKNOWN` is the 5-6
 * minute reconcile sweep, so a row could sit on `blockingReason: 'unknown'` for
 * minutes — and `'unknown'` is in NO list bucket: `isNeedsAttention` matches
 * `changes_requested`/`checks_failed`/`merge_conflicts`, and the merge button
 * needs `mergeable`/`checks_failed_optional`. The PR quietly left both "Needs
 * attention" and "Ready to merge" and lost its merge button, while opening the
 * detail sheet — which fetches live and writes the result back — showed the
 * truth. That disagreement is what this module removes.
 *
 * It does NOT put the wait back on the hot path. The PR is queued, coalesced per
 * PR, and re-asked by a timer a moment later. Everything it gives up on (a gated
 * account, a fetch that fails, a PR GitHub is still computing after the retries)
 * falls through to the sweep exactly as before.
 */

/**
 * How long to wait before re-asking, and how many times the resolver retries
 * inside one settle.
 *
 * Owned here so the deferred settle and prMonitor's inline `resolveUnknownMergeable`
 * cannot drift: they are answering the same question — "how long does GitHub take
 * to compute mergeability" — and the answer must not depend on which one asked.
 */
export const UNKNOWN_MERGEABLE_BACKOFF_MS = 1_500;
export const UNKNOWN_MERGEABLE_RETRIES = 3;

export type MergeableSettleStats = DebugMergeableSettle;

export interface MergeableSettleTarget {
  workspaceId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  number: number;
}

/**
 * Re-fetch one PR WITH `UNKNOWN` resolution and re-apply it. Registered by
 * prMonitor at init so this module never imports it back.
 */
export type MergeableResolver = (target: MergeableSettleTarget) => Promise<void>;

let resolver: MergeableResolver | null = null;
const pending = new Map<string, MergeableSettleTarget>();
let timer: NodeJS.Timeout | null = null;
let draining = false;

const stats = {
  observed: 0,
  settled: 0,
  deferred: 0,
  failed: 0,
  totalSettleMs: 0,
};

/**
 * Counters since boot, for the Debug panel and for tests.
 *
 * Kept debug-bus-INDEPENDENT, the same way `graphqlBudget` is: the bus reads
 * this on snapshot rather than this pushing events into the bus. That keeps the
 * import one-directional, and an aggregate is the better measurement anyway —
 * a per-occurrence event stream on a busy workspace buries the number you
 * actually want under its own noise.
 */
export function mergeableSettleStats(): MergeableSettleStats {
  return {
    observed: stats.observed,
    settled: stats.settled,
    deferred: stats.deferred,
    failed: stats.failed,
    pending: pending.size,
    avgSettleMs: stats.settled > 0 ? Math.round(stats.totalSettleMs / stats.settled) : 0,
  };
}

export function initMergeableSettler(fn: MergeableResolver): void {
  resolver = fn;
}

function key(t: MergeableSettleTarget): string {
  return `${t.workspaceId}:${t.repositoryId}:${t.number}`;
}

/**
 * Queue a PR whose freshly-written summary says `mergeable: UNKNOWN`.
 *
 * Coalesced per PR: a burst of webhook deliveries for one PR settles once.
 * Idempotent, non-blocking, and never throws — the caller is a hot path that
 * has already done its real work.
 */
export function scheduleMergeableSettle(target: MergeableSettleTarget): void {
  if (!resolver) return; // not wired (tests, or before init) — the sweep covers it
  stats.observed++;
  const k = key(target);
  if (pending.has(k)) return;
  pending.set(k, target);
  if (!timer) timer = setTimeout(() => void drain(), UNKNOWN_MERGEABLE_BACKOFF_MS);
}

/**
 * Drain everything queued, one PR at a time.
 *
 * Sequential on purpose: every settle is a GraphQL call against the same
 * per-account point budget that the poll loops, the merge queue, and manual
 * refresh share, and this is the least urgent of them. Anything queued while a
 * drain is running is picked up by the next timer.
 */
async function drain(): Promise<void> {
  timer = null;
  if (draining) return;
  draining = true;
  try {
    const batch = [...pending.values()];
    pending.clear();
    for (const target of batch) {
      // The settle is a nice-to-have; it must never be the call that tips an
      // account into a hard rate limit. Same reserve check the reconcile sweep
      // makes, for the same reason.
      if (graphqlBudget.shouldDefer(githubService.accountKeyFor(target.workspaceId))) {
        stats.deferred++;
        continue;
      }
      const startedAt = Date.now();
      try {
        await resolver!(target);
        stats.settled++;
        stats.totalSettleMs += Date.now() - startedAt;
      } catch (err) {
        // Gated account, revoked token, network. Logged rather than retried:
        // the reconcile sweep is still the backstop it always was.
        stats.failed++;
        console.warn(
          `[mergeableSettle] ${target.owner}/${target.repo}#${target.number} failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  } finally {
    draining = false;
    // Re-arm if anything arrived mid-drain.
    if (pending.size > 0 && !timer) {
      timer = setTimeout(() => void drain(), UNKNOWN_MERGEABLE_BACKOFF_MS);
    }
  }
}

/** Test/shutdown helper — drops the queue and the timer, keeps the resolver. */
export function _resetMergeableSettler(): void {
  pending.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  draining = false;
  stats.observed = 0;
  stats.settled = 0;
  stats.deferred = 0;
  stats.failed = 0;
  stats.totalSettleMs = 0;
}

/** Test helper — run a drain now instead of waiting for the timer. */
export async function _drainMergeableSettlerNow(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  await drain();
}
