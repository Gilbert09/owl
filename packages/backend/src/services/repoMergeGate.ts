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
//   'confirmed' — learned from an observed 405 (markExternalMergeGate). The only
//                 signal that lets the queue skip the direct merge entirely.
//   'suspected' — a branch-rules probe found an `update`/`creation` rule on the
//                 base. Cheap (one REST call) and it makes the evaluator go
//                 eager immediately, but it CANNOT see bypass actors: a repo
//                 where Talyn's App *is* exempt looks identical. So a suspected
//                 gate never skips the direct merge — the queue still tries it
//                 once and lets the 405 (or the merge landing) settle it.
//
// **Every gate decays.** `confirmed` used to be sticky for the life of the
// process, which meant a branch whose ruleset was later relaxed (trunk.io was
// switched off on posthog/posthog in July 2026) kept getting submitted to a
// queue that no longer existed until someone redeployed the backend — the
// clear path (clearExternalMergeGate on a successful merge) was unreachable,
// because a confirmed gate never attempts the merge that would fire it. So a
// gate now expires and must re-earn itself from a fresh probe, one confidence
// level at a time:
//
//   confirmed --probe finds no rule--> suspected --probe finds no rule--> null
//
// and any observed refusal jumps straight back to `confirmed`. The step down to
// `suspected` rather than straight to `null` matters because a false probe does
// NOT prove there's no gate: this endpoint reports *rulesets*, so a classic
// protected branch (or a repo whose rulesets the App can't read) gates merges
// while probing clean. `suspected` is exactly the right landing spot for that —
// it lets the queue try one direct merge and learn the truth, which either
// lands the PR or re-confirms the gate.
//
// Peer of repoSigning.ts: same cache shape, same learn-from-failure discipline.

import { TRUNK_SUBMIT_LABELS } from '@talyn/shared';
import { githubService } from './github.js';

/**
 * How long a probe result is trusted. Short because the cost of being wrong is
 * asymmetric and paid by the user: a stale "gated" reading parks every PR on a
 * queue that may be gone, while a stale "not gated" reading costs one merge
 * call that 405s and immediately corrects itself. One REST call per (repo,
 * base) per window, on an endpoint that costs no GraphQL points.
 */
export const PROBE_TTL_MS = 5 * 60_000;
/** A failed probe is re-asked sooner — it taught us nothing to hold onto. */
const PROBE_FAILURE_TTL_MS = 60_000;
/**
 * How long an observed refusal holds before it must re-earn itself. Same window
 * as a probe: a confirmed gate is better evidence, but it ages the same way.
 */
export const CONFIRMED_TTL_MS = 5 * 60_000;
/** Submit labels are repo config that changes far more rarely than a ruleset. */
const LABEL_CACHE_TTL_MS = 60 * 60_000;

export type MergeGateConfidence = 'suspected' | 'confirmed';

interface CacheEntry {
  gated: boolean;
  /** Wall-clock ms after which this reading must be re-earned from a probe. */
  expiresAt: number;
  /** Learned from an observed protected-ref 405 / App refusal. */
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
 * sure are we? `null` = no gate known. Every reading expires (see the decay
 * ladder up top), so a relaxed ruleset heals itself within a couple of probe
 * windows with no restart. A probe failure never downgrades what we already
 * believe — the merge path's 405 handler is the safety net either way.
 */
export async function getExternalMergeGate(
  workspaceId: string,
  owner: string,
  repo: string,
  baseBranch: string
): Promise<MergeGateConfidence | null> {
  if (!baseBranch) return null;
  const key = cacheKey(workspaceId, owner, repo, baseBranch);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now < cached.expiresAt) {
    if (cached.confirmed) return 'confirmed';
    return cached.gated ? 'suspected' : null;
  }
  try {
    const gated = await probe(workspaceId, owner, repo, baseBranch);
    if (gated) {
      // The rule that justifies the gate is still on the branch. A gate we'd
      // confirmed keeps its confidence — nothing here contradicts it.
      const confirmed = cached?.confirmed === true;
      cache.set(key, { gated: true, expiresAt: now + PROBE_TTL_MS, confirmed });
      return confirmed ? 'confirmed' : 'suspected';
    }
    if (cached?.confirmed) {
      // One level down, not straight to null: the probe only sees rulesets, so
      // "no rule" doesn't disprove a gate we watched GitHub enforce. As
      // `suspected` the queue will try one direct merge, which either lands the
      // PR (clearExternalMergeGate) or re-confirms the gate.
      cache.set(key, { gated: true, expiresAt: now + PROBE_TTL_MS });
      return 'suspected';
    }
    cache.set(key, { gated: false, expiresAt: now + PROBE_TTL_MS });
    return null;
  } catch (err) {
    // Permissions / transient — don't guess a gate into existence, and don't
    // decay one we already hold on the strength of a call that failed. Re-ask
    // in a minute rather than every tick.
    console.warn(
      `[repoMergeGate] probe failed for ${owner}/${repo}@${baseBranch}:`,
      err instanceof Error ? err.message : err
    );
    const held: CacheEntry = cached?.gated
      ? { ...cached, expiresAt: now + PROBE_FAILURE_TTL_MS }
      : { gated: false, expiresAt: now + PROBE_FAILURE_TTL_MS };
    cache.set(key, held);
    return held.gated ? (held.confirmed ? 'confirmed' : 'suspected') : null;
  }
}

/**
 * Record — from an observed "Cannot update this protected ref" 405 — that this
 * base branch is behind an external merge gate. For the next
 * {@link CONFIRMED_TTL_MS} the queue submits to that system instead of burning
 * a doomed merge call per evaluation; after that it re-probes and decays a
 * level at a time, so a gate that goes away doesn't outlive the ruleset.
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
    expiresAt: Date.now() + CONFIRMED_TTL_MS,
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
  if (cached && Date.now() - cached.at < LABEL_CACHE_TTL_MS) return cached.label;
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
    submitLabelCache.set(key, { label: null, at: Date.now() - LABEL_CACHE_TTL_MS + 5 * 60_000 });
    return null;
  }
}

/** Test hook. */
export function _resetSubmitLabelCache(): void {
  submitLabelCache.clear();
}

/**
 * Clear a gate outright — used when a direct merge unexpectedly SUCCEEDS on a
 * branch we'd marked (the ruleset was relaxed, or we were wrong). Proof beats
 * the decay ladder: a merge that landed settles the question in one step.
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
