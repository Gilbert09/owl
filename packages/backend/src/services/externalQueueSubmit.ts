// Hand a PR to the external merge queue that owns its base branch.
//
// Shared by the merge-queue pipeline (mergeQueue/executor.ts) and the desktop's
// Merge button (routes/pullRequests.ts) so both use the same doors in the same
// order — a PR submitted from the UI is indistinguishable from one the queue
// submitted, which is what makes the queue's tracking work either way.
//
// Two doors, in order:
//
//  1. **GitHub native auto-merge.** trunk.io watches for it and pulls the PR
//     into its queue (~30s later it applies `trunk-not-ready`/`trunk-queued`);
//     GitHub's own merge queue treats it as "merge when ready" directly. Needs
//     no extra App permission, so it goes first.
//  2. **The repo's submit label.** GitHub REFUSES to arm auto-merge on a PR
//     that is already immediately mergeable ("Pull request is in clean status")
//     — exactly the state a gated PR reaches once its checks pass — so without
//     this fallback the readiest PRs would be the ones we couldn't submit.
//     Needs the App's `issues: write`.

import { enableAutoMerge, getAutoMergeCapability } from './githubAutoMerge.js';
import { githubService } from './github.js';
import { getExternalQueueSubmitLabel } from './repoMergeGate.js';
import type { ExternalSubmitVia, MergeMethod } from './mergeQueue/types.js';

export type ExternalSubmitAttempt =
  /** The PR is in the external queue's hands. */
  | { kind: 'submitted'; via: ExternalSubmitVia; armedBy?: 'talyn' | 'user'; label?: string }
  /**
   * GitHub won't arm auto-merge because the PR is immediately mergeable, and the
   * caller asked us not to fall back to the label. Only returned when
   * `labelFallback` is false — the caller wants to try a direct merge first.
   */
  | { kind: 'clean_status' }
  /** Nothing can submit this PR: no auto-merge, no submit label (or no permission). */
  | { kind: 'no_mechanism'; message: string }
  /** Transient — head moved, API error, PR node id not cached yet. */
  | { kind: 'retry'; message: string };

export interface SubmitToExternalQueueInput {
  workspaceId: string;
  owner: string;
  repo: string;
  number: number;
  /** PR GraphQL node id (auto-merge mutations need it); null → retry later. */
  nodeId: string | null;
  /** Head the arm is pinned to, so a concurrent push can't arm the wrong commit. */
  headSha: string;
  mergeMethod: MergeMethod;
  /** Who already has auto-merge armed on the PR, if anyone — that IS a submission. */
  autoMergeArmedBy: 'talyn' | 'user' | null;
  /** Whether to fall back to the submit label when GitHub refuses to arm. */
  labelFallback: boolean;
}

export async function submitToExternalQueue(
  input: SubmitToExternalQueueInput
): Promise<ExternalSubmitAttempt> {
  const { workspaceId, owner, repo, number } = input;

  // Already armed on GitHub's side (the user hit "merge when ready", or our own
  // arm outlived a status drift) — that IS the submission; adopt it.
  if (input.autoMergeArmedBy !== null) {
    return { kind: 'submitted', via: 'auto_merge', armedBy: input.autoMergeArmedBy };
  }

  let cleanStatus = false;
  if (!input.nodeId) {
    return { kind: 'retry', message: 'PR node id not cached yet.' };
  }
  const capability = await getAutoMergeCapability(workspaceId, owner, repo, input.mergeMethod);
  if (capability !== 'unavailable') {
    const result = await enableAutoMerge({
      workspaceId,
      owner,
      repo,
      nodeId: input.nodeId,
      mergeMethod: input.mergeMethod,
      expectedHeadOid: input.headSha,
    });
    if (result.armed) return { kind: 'submitted', via: 'auto_merge', armedBy: 'talyn' };
    switch (result.reason) {
      case 'head_mismatch':
        // A push landed mid-arm; the synchronize event re-evaluates on the new
        // head. Nothing to spend an attempt on.
        return { kind: 'retry', message: 'The head commit moved while submitting.' };
      case 'error':
        return { kind: 'retry', message: result.message };
      case 'clean_status':
        cleanStatus = true;
        break;
      case 'not_allowed':
        break; // recorded sticky by enableAutoMerge; fall through to the label
    }
  }
  if (cleanStatus && !input.labelFallback) return { kind: 'clean_status' };

  const label = await getExternalQueueSubmitLabel(workspaceId, owner, repo);
  if (!label) {
    return {
      kind: 'no_mechanism',
      message:
        'The base branch is behind an external merge queue, but this repo neither allows ' +
        'GitHub auto-merge on this PR nor defines a submit label Talyn recognises ' +
        '(trunk-merge-queue-submit / trunk-merge).',
    };
  }
  try {
    await githubService.addPullRequestLabels(workspaceId, owner, repo, number, [label]);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Applying the submit label failed';
    // A permissions refusal is static per install — surface it as actionable
    // rather than retrying forever.
    if (/not accessible by integration|resource not accessible|403/i.test(message)) {
      return {
        kind: 'no_mechanism',
        message:
          `Talyn couldn't apply the "${label}" submit label — the GitHub App needs the ` +
          `"Issues: Read & write" permission. (${message})`,
      };
    }
    return { kind: 'retry', message };
  }
  return { kind: 'submitted', via: 'label', label };
}
