// Hand a PR to the external merge queue that owns its base branch.
//
// Shared by the merge-queue pipeline (mergeQueue/executor.ts) and the desktop's
// Merge button (routes/pullRequests.ts) so both use the same doors in the same
// order — a PR submitted from the UI is indistinguishable from one the queue
// submitted, which is what makes the queue's tracking work either way.
//
// Before any of them: if the provider's comment says it ALREADY has the PR
// (queued/testing/passed), that is the answer — no door is opened at all.
// Trunk rewrites its one comment in place, so a PR it is actively working shows
// neither the instruction nor the checkbox, and a ladder that walked past that
// reported "nothing can submit this PR" about a PR sitting happily in the queue.
//
// Three doors, most authoritative first:
//
//  1. **The provider's own submit command.** trunk.io posts an instruction
//     comment on every PR in a repo it manages: "To merge this pull request,
//     check the box to the left or comment `/trunk merge` below." That comment
//     IS the contract — it names the door and proves the queue owns the branch.
//     The checkbox lives inside trunk's own comment (only its author should edit
//     it), so Talyn posts the command instead. Needs `issues: write`.
//     The instruction survives only until trunk takes the PR, so the command is
//     also remembered per repo (externalQueueSubmitRoute.ts) and reused on any PR whose
//     comment proves trunk owns it — that is what makes a RESUBMIT possible.
//  2. **The repo's submit label**, for configurations that use one. Applied as
//     the connected GitHub USER, not as the App. Trunk checks this channel more
//     strictly than the comment channel above: it takes `/trunk merge` from
//     talyn-app[bot] (verified on #85100, #84450), but answers the same App's
//     LABEL with "Only users that are a part of this repo's Trunk organization
//     or have write permissions to the repo can submit a PR to the queue", and
//     deletes the label. The connected user has that write access.
//
//     Unverified: no human has applied the label on a gated repo to confirm
//     trunk then accepts it. A refusal costs no more than today — trunk deletes
//     the label either way, and R5b bounds the retries.
//  3. **GitHub native auto-merge** — the door for GitHub's OWN merge queue
//     ("merge when ready"), and the only one needing no extra permission. It is
//     last because a third-party queue does not necessarily watch it: on
//     posthog/posthog, arming auto-merge does nothing at all (verified on
//     #74354 — trunk ignored it and the PR sat untouched).

import { enableAutoMerge, getAutoMergeCapability } from './githubAutoMerge.js';
import {
  externalQueueCommentPresent,
  externalQueueInstructionFromComments,
  externalQueueStatusFromComments,
  isExternalQueueHolding,
  type ExternalQueueComment,
  type ExternalQueueInstruction,
  type ExternalQueueState,
} from '@talyn/shared';
import { noteIssueComments } from './externalQueueState.js';
import { githubService } from './github.js';
import { getExternalQueueSubmitLabel } from './repoMergeGate.js';
import { rememberedExternalQueueSubmitRoute } from './externalQueueSubmitRoute.js';
import type { ExternalSubmitVia, MergeMethod } from './mergeQueue/types.js';

export type ExternalSubmitAttempt =
  /** The PR is in the external queue's hands. */
  | {
      kind: 'submitted';
      via: ExternalSubmitVia;
      armedBy?: 'talyn' | 'user';
      label?: string;
      command?: string;
    }
  /**
   * GitHub won't arm auto-merge because the PR is immediately mergeable, and the
   * caller asked us not to fall back to the label. Only returned when
   * `labelFallback` is false — the caller wants to try a direct merge first.
   */
  | { kind: 'clean_status' }
  /** Nothing can submit this PR: no auto-merge, no submit label (or no permission). */
  | { kind: 'no_mechanism'; message: string }
  /**
   * The provider ALREADY has this PR — its own comment says it is queued,
   * testing, waiting or passed. Not a submission we made, and not a failure:
   * submitting again would post a duplicate command (or, once every door is
   * closed, report a healthy PR as unmergeable).
   */
  | { kind: 'already_submitted'; state: ExternalQueueState; evidence: string }
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
  /**
   * Whether the auto-merge door (3) may be used. Callers acting on a merely
   * SUSPECTED gate pass false: doors 1 and 2 rest on explicit provider evidence
   * (its own instruction comment, a submit label the repo defines), whereas
   * arming auto-merge on a repo where Talyn can actually merge would replace a
   * merge with a wait. Default true.
   */
  allowAutoMerge?: boolean;
}

/**
 * A submit failure that will not fix itself, so it must not go back as `retry`.
 *
 * `apiRequest` throws this string when neither an installation token nor a user
 * token resolves — the workspace's GitHub connection is gone, or its token
 * cannot be refreshed. That is not transient, and `retry` used to mean "try
 * again on the very next evaluation, forever". The budget in `decide` now bounds
 * that anyway; classifying it here means the PR stops with the right answer
 * instead of after three pointless calls.
 */
function disconnectedFailure(message: string): boolean {
  return /GitHub not connected/i.test(message);
}

function disconnectedMessage(owner: string, repo: string, message: string): string {
  return (
    `Talyn has no usable GitHub credential for this workspace, so it can't submit ` +
    `${owner}/${repo} to the external merge queue. Reconnect GitHub in Settings. (${message})`
  );
}

export async function submitToExternalQueue(
  input: SubmitToExternalQueueInput
): Promise<ExternalSubmitAttempt> {
  const { workspaceId, owner, repo, number } = input;

  const comments = await readProviderComments(workspaceId, owner, repo, number);

  // Does the provider already HAVE the PR? Its comment is the authoritative
  // answer, and every door below is pointless while it holds it: door 1 would
  // post a second `/trunk merge`, and doors 2-3 would be reached only because
  // trunk has REPLACED its instruction body with a status line — which is how a
  // queued PR ended up blocked as "no way to submit" (2026-08-19).
  const observed = externalQueueStatusFromComments(comments);
  if (observed && isExternalQueueHolding(observed.state)) {
    return { kind: 'already_submitted', state: observed.state, evidence: observed.evidence };
  }

  // Door 1 — the provider's own submit command.
  const instruction = resolveSubmitInstruction(owner, repo, comments);
  if (instruction) {
    try {
      await githubService.createIssueComment(
        workspaceId,
        owner,
        repo,
        number,
        instruction.command
      );
      return { kind: 'submitted', via: 'comment', command: instruction.command };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Posting the submit command failed';
      if (disconnectedFailure(message)) {
        return { kind: 'no_mechanism', message: disconnectedMessage(owner, repo, message) };
      }
      if (/not accessible by integration|resource not accessible|403/i.test(message)) {
        return {
          kind: 'no_mechanism',
          message:
            `Talyn couldn't post "${instruction.command}" — the GitHub App needs the ` +
            `"Issues: Read & write" permission. (${message})`,
        };
      }
      return { kind: 'retry', message };
    }
  }

  // Already armed on GitHub's side (the user hit "merge when ready", or our own
  // arm outlived a status drift) — that IS the submission for a native queue.
  if (input.autoMergeArmedBy !== null) {
    return { kind: 'submitted', via: 'auto_merge', armedBy: input.autoMergeArmedBy };
  }

  // Door 2 — a submit label the repo defines.
  const label = await getExternalQueueSubmitLabel(workspaceId, owner, repo);
  if (label) {
    try {
      await githubService.addPullRequestLabels(workspaceId, owner, repo, number, [label], 'user');
      return { kind: 'submitted', via: 'label', label };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Applying the submit label failed';
      if (disconnectedFailure(message)) {
        return { kind: 'no_mechanism', message: disconnectedMessage(owner, repo, message) };
      }
      if (/not accessible by integration|resource not accessible|403/i.test(message)) {
        return {
          kind: 'no_mechanism',
          message:
            `Talyn couldn't apply the "${label}" submit label as the connected GitHub user — ` +
            `that account needs write access to ${owner}/${repo}, and Talyn's GitHub App needs ` +
            `the "Issues: Read & write" permission. (${message})`,
        };
      }
      return { kind: 'retry', message };
    }
  }

  if (input.allowAutoMerge === false) {
    return {
      kind: 'no_mechanism',
      message:
        'No external merge queue has claimed this PR: no provider instruction comment, ' +
        'and no submit label the repo defines.',
    };
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
  // Doors 1 and 2 are already exhausted by here, so a clean-status refusal has
  // nowhere left to go — unless the caller still wants to try a direct merge.
  if (cleanStatus && !input.labelFallback) return { kind: 'clean_status' };

  return {
    kind: 'no_mechanism',
    message:
      'The base branch is behind an external merge queue, but nothing on this PR says ' +
      'how to submit it: no provider instruction comment, no submit label the repo ' +
      'defines (trunk-merge-queue-submit / trunk-merge), and GitHub auto-merge is ' +
      'unavailable here. Submit it in that system, or remove it from the queue.',
  };
}

/**
 * The PR's comments, or an empty list. One REST call, made only at submit time.
 * A failure reads as "no comments" — the remaining doors still apply, and the
 * caller's block reason stays honest either way.
 */
async function readProviderComments(
  workspaceId: string,
  owner: string,
  repo: string,
  number: number
): Promise<ExternalQueueComment[]> {
  try {
    const comments = await githubService.listIssueComments(workspaceId, owner, repo, number);
    // The same fetch answers "where is this PR in the queue?" and "how does this
    // repo submit?" — seed both caches so the post-submit evaluation doesn't pay
    // for the list twice.
    noteIssueComments(owner, repo, number, comments);
    return comments;
  } catch (err) {
    console.warn(
      `[externalQueueSubmit] couldn't read comments for ${owner}/${repo}#${number}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * The command that submits THIS PR, from the provider's instruction when the
 * comment still carries it, and otherwise from what this repo taught us on an
 * earlier PR.
 *
 * The memo is only consulted when the provider has claimed this PR (its comment
 * is present), so a repo that uses no queue can never acquire a command, and a
 * PR no queue manages can never be sent one. That pairing is what makes the
 * fallback safe: the evidence for "trunk owns this PR" and the evidence for
 * "trunk takes this command here" are both real, they just live on different
 * PRs once trunk has rewritten this one's comment.
 */
function resolveSubmitInstruction(
  owner: string,
  repo: string,
  comments: ExternalQueueComment[]
): ExternalQueueInstruction | null {
  const instruction = externalQueueInstructionFromComments(comments);
  if (instruction) return instruction;
  if (!externalQueueCommentPresent(comments)) return null;
  return rememberedExternalQueueSubmitRoute(owner, repo);
}
