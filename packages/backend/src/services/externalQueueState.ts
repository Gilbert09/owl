// Where an external merge queue (trunk.io) says a PR currently is.
//
// The signal is the provider's own PR comment, which trunk EDITS IN PLACE
// through the lifecycle (instruction → "Submitted to Merge" → "Running tests"
// → "Merged successfully" / a failure). Two things follow:
//
//  1. **Every edit is a webhook.** `issue_comment/edited` is already a refresh
//     event, so the worker hands the fresh body here and the cache is warm
//     before the merge-queue evaluation it triggers even runs. That makes the
//     common path free — no extra GitHub call for a state we were told about.
//  2. **A cold cache still needs an answer** (a restart, a missed delivery, a
//     PR submitted before this shipped), so there's a REST fallback, gated on a
//     caller-chosen max age. The caller picks that age by how much the answer
//     can change: see `externalStateMaxAge` in mergeQueue/executor.ts.
//
// Deliberately NOT read off labels here — `externalQueueStatusFromLabels` still
// does that, as the fallback channel, in `decide`. Trunk's labels are optional
// in its config and were entirely absent on the PRs this module was written
// for (see externalMergeQueue.ts).

import {
  externalQueueInstructionFromComments,
  externalQueueStatusFromComment,
  externalQueueStatusFromComments,
  type ExternalQueueComment,
  type ExternalQueueStatus,
} from '@talyn/shared';
import { githubService } from './github.js';
import { noteExternalQueueSubmitRoute } from './externalQueueSubmitRoute.js';
import { debugBus } from './debugBus.js';

/**
 * Every comment that passes through here is also a chance to learn the repo's
 * submit command, which trunk offers only while a PR is unsubmitted. Recording
 * it repo-wide is what lets a LATER evaluation resubmit a PR whose own comment
 * has since been rewritten into a status line — see externalQueueSubmitRoute.ts.
 */
function learnSubmitRoute(owner: string, repo: string, comments: ExternalQueueComment[]): void {
  const instruction = externalQueueInstructionFromComments(comments);
  if (instruction) noteExternalQueueSubmitRoute(owner, repo, instruction);
}

interface Observation {
  status: ExternalQueueStatus | null;
  /** Epoch ms the observation was made (NOT when the comment was written). */
  at: number;
}

/**
 * Repo-scoped, so every workspace watching the same repo shares one entry —
 * the provider's state is a property of the PR, not of who's looking at it.
 */
const observations = new Map<string, Observation>();

/**
 * How long an observation is kept once nothing refreshes it. Well past any
 * caller's max age (the longest is 10 minutes), so this only ever evicts PRs
 * that have stopped being evaluated — it bounds memory, it doesn't bound
 * freshness.
 */
const RETENTION_MS = 60 * 60_000;

function keyOf(owner: string, repo: string, number: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

function prune(now: number): void {
  for (const [key, obs] of observations) {
    if (now - obs.at > RETENTION_MS) observations.delete(key);
  }
}

/**
 * Record what a single PR comment says, straight off a webhook payload. A
 * comment that isn't the provider's merge-queue comment is ignored — it must
 * not overwrite a real observation with "no state" (a PR gets plenty of other
 * comments, including trunk's own flaky-test one).
 */
export function noteIssueComment(
  owner: string,
  repo: string,
  number: number,
  comment: ExternalQueueComment
): void {
  learnSubmitRoute(owner, repo, [comment]);
  const status = externalQueueStatusFromComment(comment);
  if (!status) return;
  const now = Date.now();
  observations.set(keyOf(owner, repo, number), { status, at: now });
  prune(now);
  debugBus.recordEvent({
    service: 'merge_queue',
    action: 'external_queue_observed',
    summary: `${owner}/${repo}#${number}: ${status.provider} → ${status.state} (comment)`,
  });
}

/** Seed the cache from a comment list we already fetched for another reason. */
export function noteIssueComments(
  owner: string,
  repo: string,
  number: number,
  comments: ExternalQueueComment[]
): void {
  learnSubmitRoute(owner, repo, comments);
  const status = externalQueueStatusFromComments(comments);
  if (!status) return;
  observations.set(keyOf(owner, repo, number), { status, at: Date.now() });
}

/**
 * The provider's state for a PR, no older than `maxAgeMs`. Falls back to one
 * REST call (the same comment list the submit path reads) when the cached
 * observation is missing or older than that. A failed fetch returns null —
 * "nothing observed" — never a fabricated state: the caller's other evidence
 * (labels, the submission grace window) then decides.
 */
export async function readExternalQueueState(
  workspaceId: string,
  owner: string,
  repo: string,
  number: number,
  maxAgeMs: number
): Promise<ExternalQueueStatus | null> {
  const key = keyOf(owner, repo, number);
  const cached = observations.get(key);
  const now = Date.now();
  // Strict `<` so a maxAge of 0 means "always re-read", rather than depending
  // on whether the observation landed in this same millisecond.
  if (cached && now - cached.at < maxAgeMs) return cached.status;

  let comments: ExternalQueueComment[];
  try {
    comments = await githubService.listIssueComments(workspaceId, owner, repo, number);
  } catch (err) {
    console.warn(
      `[externalQueueState] couldn't read ${owner}/${repo}#${number} comments:`,
      err instanceof Error ? err.message : err
    );
    // Keep a stale observation rather than forgetting it: an old reading of
    // "trunk is testing this" beats no reading at all while GitHub is unhappy.
    return cached?.status ?? null;
  }
  learnSubmitRoute(owner, repo, comments);
  const status = externalQueueStatusFromComments(comments);
  observations.set(key, { status, at: Date.now() });
  prune(now);
  return status;
}

/** Test hook — drop every observation. */
export function _resetExternalQueueState(): void {
  observations.clear();
}
