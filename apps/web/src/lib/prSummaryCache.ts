import { api, type PRState, type PRSummaryShape } from './api';

/**
 * Process-lifetime stale-while-revalidate cache for PR status summaries,
 * keyed by pull-request id.
 *
 * The status pill in the task header (and anywhere else that needs a PR's
 * status at a glance) reads this synchronously on mount so it can paint the
 * last-known state instantly instead of a blank pill + network round-trip on
 * every task switch. Entries are written from two sources:
 *
 *   - `prime()` — whenever a `GET /pull-requests/:id` resolves.
 *   - the global `pull_request:updated` WS event — keeps the cache warm for
 *     every PR as the backend monitor refetches, even for ones not on screen.
 *
 * It is intentionally unbounded: a session watches a bounded set of PRs and
 * each entry is tiny. Cleared implicitly when the renderer reloads.
 */

export interface PRStatus {
  summary: PRSummaryShape;
  state: PRState;
}

const cache = new Map<string, PRStatus>();
const listeners = new Map<string, Set<(status: PRStatus) => void>>();

/** Last-known status for a PR, or undefined if never seen this session. */
export function getCachedPRStatus(id: string): PRStatus | undefined {
  return cache.get(id);
}

/** Write a status and notify any live subscribers for that id. */
export function prime(id: string, status: PRStatus): void {
  cache.set(id, status);
  const subs = listeners.get(id);
  if (subs) for (const fn of subs) fn(status);
}

/**
 * Subscribe to cache updates for a single PR id. Returns an unsubscribe fn.
 * Fires on every `prime()` for that id (own fetch or WS update).
 */
export function subscribePRStatus(id: string, fn: (status: PRStatus) => void): () => void {
  let subs = listeners.get(id);
  if (!subs) {
    subs = new Set();
    listeners.set(id, subs);
  }
  subs.add(fn);
  return () => {
    subs!.delete(fn);
    if (subs!.size === 0) listeners.delete(id);
  };
}

// Keep the cache warm from the firehose of monitor refetches. Registered once
// at module load; the WS client retains handlers across reconnects.
api.ws.on('pull_request:updated', (payload) => {
  const p = payload as { id: string; state?: PRState; lastSummary?: unknown };
  if (!p?.id || p.lastSummary == null) return;
  const prev = cache.get(p.id);
  prime(p.id, {
    summary: p.lastSummary as PRSummaryShape,
    state: p.state ?? prev?.state ?? 'open',
  });
});
