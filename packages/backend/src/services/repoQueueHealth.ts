// Is the external merge queue on this branch healthy enough to submit into?
//
// Every other guard in the pipeline is PER PR: `MAX_INFRA_SUBMITS_PER_HEAD`
// bounds one commit's resubmits, the recurrence signature bounds one head's
// ejections. None of them can see that the queue itself is the thing that is
// broken, so with a backlog of queued PRs each one rediscovers a dead runner
// independently and spends its own budget doing it.
//
// That is worse than wasted spend, because trunk BATCHES. Every submission into
// a sick queue joins a batch that will fail and then be bisected, so the PRs
// still feeding it are lengthening the outage for the PRs already in it. The
// useful move is the one no single entry can decide alone: stop submitting, and
// wait.
//
// Scope is (repo, base), which is the merge queue's own group key, and it is
// deliberately NOT workspace-scoped — the queue's health is a property of the
// repo, not of who is looking at it, exactly as `externalQueueState` argues for
// the provider's per-PR state. Two workspaces watching posthog/posthog are
// watching one queue.
//
// One-sided on purpose, like `externalQueueFailure`'s classifier: only a
// POSITIVELY identified infrastructure failure counts against the queue. A
// failure Talyn could not classify is treated as the PR's own problem and
// changes nothing here, so the worst this can do on unfamiliar output is
// nothing at all.

import { debugBus } from './debugBus.js';

/**
 * How long an infrastructure failure stays evidence. A queue outage measured in
 * hours is a different thing from three unlucky runs across a morning, and the
 * window is what tells them apart.
 */
export const HEALTH_WINDOW_MS = 30 * 60_000;

/**
 * Distinct PRs that must fail on infrastructure inside the window before Talyn
 * stops feeding the queue. Counted by PR, never by failure: one PR resubmitting
 * three times is one PR having a bad day, while three PRs failing the same way
 * is the queue.
 */
export const DEGRADED_AFTER_DISTINCT_PRS = 3;

interface Observation {
  /** PR number the infrastructure failure was seen on. */
  number: number;
  /** Epoch ms the observation was made. */
  at: number;
}

const observations = new Map<string, Observation[]>();

function keyOf(owner: string, repo: string, baseBranch: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}:${baseBranch}`;
}

function fresh(entries: Observation[], now: number): Observation[] {
  return entries.filter((o) => now - o.at < HEALTH_WINDOW_MS);
}

/**
 * The queue failed a PR on its own CI infrastructure. Recorded per PR, so a
 * single PR resubmitting cannot talk the queue into looking broken.
 */
export function noteInfraFailure(
  owner: string,
  repo: string,
  baseBranch: string,
  number: number
): void {
  const key = keyOf(owner, repo, baseBranch);
  const now = Date.now();
  const entries = fresh(observations.get(key) ?? [], now).filter((o) => o.number !== number);
  entries.push({ number, at: now });
  observations.set(key, entries);
  if (entries.length >= DEGRADED_AFTER_DISTINCT_PRS) {
    debugBus.recordEvent({
      service: 'merge_queue',
      action: 'external_queue_degraded',
      ok: false,
      summary: `${owner}/${repo}@${baseBranch}: ${entries.length} PRs failed on queue infrastructure`,
    });
  }
}

/**
 * The queue merged something, which is the only direct proof it works. Clears
 * the record outright rather than ageing it out: whatever was wrong with the
 * runners, a merge says it is not wrong now.
 */
export function noteMerge(owner: string, repo: string, baseBranch: string): void {
  observations.delete(keyOf(owner, repo, baseBranch));
}

/**
 * Should Talyn stop submitting into this queue? `null` means no reason to
 * think otherwise, which is also the answer for every repo that has never had
 * an infrastructure failure.
 *
 * Recovery needs no restart and no human: the window ages every observation
 * out, and any merge clears them immediately.
 */
export function queueHealth(
  owner: string,
  repo: string,
  baseBranch: string
): { state: 'degraded'; prs: number[] } | null {
  const key = keyOf(owner, repo, baseBranch);
  const entries = observations.get(key);
  if (!entries) return null;
  const now = Date.now();
  const live = fresh(entries, now);
  if (live.length === 0) {
    observations.delete(key);
    return null;
  }
  observations.set(key, live);
  if (live.length < DEGRADED_AFTER_DISTINCT_PRS) return null;
  return { state: 'degraded', prs: live.map((o) => o.number).sort((a, b) => a - b) };
}

/** Test hook — drop every observation. */
export function _resetQueueHealth(): void {
  observations.clear();
}
