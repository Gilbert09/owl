// Is a base branch governed by an EXTERNAL merge gate Talyn can't merge past?
//
// posthog/posthog's `master` has been since July 2026: a "Trunk merge" ruleset
// adds an `update` rule to the default branch and exempts only trunk.io's App,
// so every other actor's merge — including ours — 405s with "Cannot update this
// protected ref". GitHub's own native merge queue and any restrictive
// protected-ref ruleset produce the same refusal.
//
// The merge queue reacts by SUBMITTING to that system instead of merging (see
// mergeQueue/decide.ts). This module answers "is there a gate?" with two
// signals, deliberately ranked:
//
//   'confirmed' — learned from an observed 405 (markExternalMergeGate). Sticky
//                 for the process: unambiguous, and the only signal that lets
//                 the queue skip the direct merge entirely.
//   'suspected' — a branch-rules probe found an `update`/`creation` rule on the
//                 base. Cheap (one REST call, cached 1h) and it makes the
//                 evaluator go eager immediately, but it CANNOT see bypass
//                 actors: a repo where Talyn's App *is* exempt looks identical.
//                 So a suspected gate never skips the direct merge — the queue
//                 still tries it once and lets the 405 (or the merge landing)
//                 settle the question.
//
// Peer of repoSigning.ts: same cache shape, same learn-from-failure discipline.

import { TRUNK_SUBMIT_LABELS } from '@talyn/shared';
import { githubService } from './github.js';

const CACHE_TTL_MS = 60 * 60_000; // 1h — ruleset config changes rarely.

export type MergeGateConfidence = 'suspected' | 'confirmed';

interface CacheEntry {
  gated: boolean;
  at: number;
  /** Learned from an observed protected-ref 405 — never re-probed back to false. */
  confirmed?: boolean;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(workspaceId: string, owner: string, repo: string, baseBranch: string): string {
  return `${workspaceId}:${owner.toLowerCase()}/${repo.toLowerCase()}:${baseBranch}`;
}

/** Test hook. */
export function _resetMergeGateCache(): void {
  cache.clear();
}

/**
 * Rule types that stop a non-exempt actor from advancing the ref — which is
 * exactly what a merge does. `update` is what both GitHub's native merge queue
 * and trunk.io install; `non_fast_forward` alone doesn't block an ordinary
 * merge, so it isn't listed.
 */
const BLOCKING_RULE_TYPES = new Set(['update', 'creation']);

async function probe(
  workspaceId: string,
  owner: string,
  repo: string,
  baseBranch: string
): Promise<boolean> {
  // REST, not GraphQL: this endpoint returns the rules that apply to ONE branch
  // for the calling token, needs no admin scope, and costs no GraphQL points
  // (the merge queue's scarcest budget).
  const rules = await githubService.getBranchRules(workspaceId, owner, repo, baseBranch);
  return rules.some((r) => typeof r.type === 'string' && BLOCKING_RULE_TYPES.has(r.type));
}

/**
 * Is `baseBranch` on `owner/repo` governed by an external merge gate, and how
 * sure are we? `null` = no gate known. Cached ~1h; a probe failure reads as
 * "no gate" (the merge path's 405 handler still catches a real one).
 */
export async function getExternalMergeGate(
  workspaceId: string,
  owner: string,
  repo: string,
  baseBranch: string
): Promise<MergeGateConfidence | null> {
  if (!baseBranch) return null;
  const key = cacheKey(workspaceId, owner, repo, baseBranch);
  const cached = cache.get(key);
  if (cached?.confirmed) return 'confirmed';
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.gated ? 'suspected' : null;
  }
  try {
    const gated = await probe(workspaceId, owner, repo, baseBranch);
    cache.set(key, { gated, at: Date.now() });
    return gated ? 'suspected' : null;
  } catch (err) {
    // Permissions / transient — don't guess a gate into existence. Cache a
    // short-lived negative so we retry in 5 minutes rather than every tick.
    console.warn(
      `[repoMergeGate] probe failed for ${owner}/${repo}@${baseBranch}:`,
      err instanceof Error ? err.message : err
    );
    cache.set(key, { gated: false, at: Date.now() - CACHE_TTL_MS + 5 * 60_000 });
    return null;
  }
}

/**
 * Record — from an observed "Cannot update this protected ref" 405 — that this
 * base branch is behind an external merge gate. Sticky: from here on the queue
 * submits to that system instead of burning a doomed merge call per evaluation.
 */
export function markExternalMergeGate(
  workspaceId: string,
  owner: string,
  repo: string,
  baseBranch: string
): void {
  if (!baseBranch) return;
  cache.set(cacheKey(workspaceId, owner, repo, baseBranch), {
    gated: true,
    at: Date.now(),
    confirmed: true,
  });
}

// ── Submit label ──
//
// The second submit mechanism. GitHub refuses to arm auto-merge on a PR that is
// already immediately mergeable ("Pull request is in clean status"), which is
// precisely the state a gated PR ends up in once its checks go green — so
// auto-merge alone cannot submit every PR. trunk.io's other documented entry
// point is a label, which works in every state.
//
// We only ever apply a label that (a) is on the known-submit list and (b)
// already EXISTS on the repo — never one we invent, and never one of trunk's
// own status labels (applying `trunk-queued` would lie to trunk about its own
// state machine).

interface LabelCacheEntry {
  label: string | null;
  at: number;
}

const submitLabelCache = new Map<string, LabelCacheEntry>();

/**
 * The label that submits a PR to this repo's external queue, or null when the
 * repo defines none. Cached ~1h per repo; a probe failure caches null briefly.
 */
export async function getExternalQueueSubmitLabel(
  workspaceId: string,
  owner: string,
  repo: string
): Promise<string | null> {
  const key = `${workspaceId}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = submitLabelCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.label;
  try {
    const names = await githubService.listRepoLabelNames(workspaceId, owner, repo);
    const lower = new Map(names.map((n) => [n.trim().toLowerCase(), n]));
    // Ordered by TRUNK_SUBMIT_LABELS: the more specific name wins when a repo
    // somehow defines both.
    const match = TRUNK_SUBMIT_LABELS.map((l) => lower.get(l)).find(
      (n): n is string => n !== undefined
    );
    const label = match ?? null;
    submitLabelCache.set(key, { label, at: Date.now() });
    return label;
  } catch (err) {
    console.warn(
      `[repoMergeGate] submit-label probe failed for ${owner}/${repo}:`,
      err instanceof Error ? err.message : err
    );
    submitLabelCache.set(key, { label: null, at: Date.now() - CACHE_TTL_MS + 5 * 60_000 });
    return null;
  }
}

/** Test hook. */
export function _resetSubmitLabelCache(): void {
  submitLabelCache.clear();
}

/**
 * Clear a confirmed gate — used when a direct merge unexpectedly SUCCEEDS on a
 * branch we'd marked (the ruleset was relaxed, or we were wrong). Keeps the
 * sticky flag from outliving the config that justified it.
 */
export function clearExternalMergeGate(
  workspaceId: string,
  owner: string,
  repo: string,
  baseBranch: string
): void {
  if (!baseBranch) return;
  cache.delete(cacheKey(workspaceId, owner, repo, baseBranch));
}
