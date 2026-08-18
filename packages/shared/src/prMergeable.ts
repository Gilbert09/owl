// Shared "take this PR to a clean, mergeable state" helpers.
//
// Used in two places that must stay in lock-step:
//   - the desktop "Get PR mergeable" button (one-shot, manual)
//   - the backend auto-keep-mergeable watcher (repeated, unattended)
// so the watcher fires the *identical* cloud task the button does.
//
// The prompt's git/publishing mechanics differ per cloud provider (PostHog Code
// publishes through signed-git MCP tools; Claude Code publishes through the
// `github` MCP server, with no `gh` CLI and no raw `git push`), so the builder
// is provider-aware while keeping the same goals, leak-guard, and loop.

import type { CloudProviderType } from './index.js';
import { DEFAULT_MERGEABLE_TEMPLATE, renderPromptTemplate } from './promptTemplates.js';

export type PRBlockingReason =
  | 'mergeable'
  | 'merge_conflicts'
  | 'changes_requested'
  | 'checks_failed'
  | 'checks_failed_optional'
  | 'blocked'
  | 'unknown';

export type PRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export type PRReviewDecisionState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'REVIEW_REQUIRED'
  | null;

/**
 * The subset of a PR's cached summary the mergeable helpers read. Both the
 * desktop `PRSummaryShape` and the backend `PRSummary` are structural
 * supersets of this, so either can be passed directly.
 */
export interface PRMergeableSummary {
  url: string;
  title?: string;
  headBranch: string;
  baseBranch: string;
  mergeable: PRMergeableState;
  reviewDecision: PRReviewDecisionState;
  blockingReason: PRBlockingReason;
  checks: { total: number; failed: number; inProgress?: number };
  unresolvedReviewThreads?: number;
  /** GitHub can't merge a draft PR — the merge queue must never enter the merge
   *  path for one (it 405s). Persisted in the summary; also reflected as
   *  `mergeStateStatus === 'DRAFT'`. */
  draft?: boolean;
  /**
   * The PR's GitHub labels. Tracked because an external merge queue (trunk.io)
   * publishes its per-PR state as labels and that is the ONLY signal we get —
   * see `externalQueueStatusFromLabels`. Absent on rows cached before labels
   * shipped in the summary.
   */
  labels?: string[];
  /**
   * Stable identity of the SET of currently-failing checks — the sorted check
   * names, hashed. The merge queue compares it across remediation attempts to
   * tell "the run fixed nothing" from "the run fixed one thing and uncovered
   * another": `checks.failed` alone reads 4 → 4 for both, and treating a
   * different four as no progress is what a retry budget gets wrong.
   *
   * Hashed rather than listed because posthog/posthog runs ~280 checks per PR
   * and this rides in `last_summary`, which every poll loop ships (see the
   * DB-egress rules). Equality is the only thing asked of it.
   *
   * Absent on rows cached before it shipped, and on the by-branch fetch path;
   * callers must treat `undefined` as "unknown", never as "no failures".
   */
  failingChecksDigest?: string;
}

/**
 * A PR has something a cloud follow-up run could fix: merge conflicts,
 * requested changes, failing required CI, or unresolved review threads.
 * This is the AUTO-fire predicate (the keep-mergeable watcher and merge
 * queue); the manual fix button uses the broader {@link prHasFixableIssues}.
 */
export function prNeedsFollowup(s: PRMergeableSummary): boolean {
  return (
    s.blockingReason === 'merge_conflicts' ||
    s.blockingReason === 'changes_requested' ||
    // 'checks_failed' already means a *required* check is red (the backend
    // resolves required-ness authoritatively, falling back to a heuristic).
    // We deliberately don't AUTO-fire on raw `checks.failed > 0`: a
    // non-required failing check is not worth an unattended paid run.
    s.blockingReason === 'checks_failed' ||
    s.mergeable === 'CONFLICTING' ||
    s.reviewDecision === 'CHANGES_REQUESTED' ||
    (s.unresolvedReviewThreads ?? 0) > 0
  );
}

/**
 * Whether the MANUAL "get PR mergeable" fix button has something to point an
 * agent at. Broader than {@link prNeedsFollowup}: also true when only
 * NON-required checks are failing. Those never auto-fire (a human merge
 * doesn't need them, so an unattended run isn't worth paying for), but they
 * do block Talyn's own App-token merge and are often a real signal the user
 * wants investigated — so the button stays live and the choice is theirs.
 */
export function prHasFixableIssues(s: PRMergeableSummary): boolean {
  return prNeedsFollowup(s) || s.checks.failed > 0;
}

/**
 * A short, human one-liner for *why* a PR can't merge — for blocked-state
 * notifications and badge tooltips. Most-specific blocker first.
 *
 * Note: it does NOT cover "behind the base branch" (that lives on
 * `mergeStateStatus`, which isn't part of this summary subset). Callers that
 * track it — e.g. the merge queue — should special-case that reason before
 * falling back here.
 */
export function mergeBlockerReason(s: PRMergeableSummary): string {
  if (s.blockingReason === 'merge_conflicts' || s.mergeable === 'CONFLICTING') {
    return 'merge conflicts with the base branch';
  }
  if (s.reviewDecision === 'CHANGES_REQUESTED' || s.blockingReason === 'changes_requested') {
    return 'a reviewer requested changes';
  }
  if ((s.unresolvedReviewThreads ?? 0) > 0) {
    return 'unresolved review threads';
  }
  if (s.blockingReason === 'checks_failed') {
    return 'failing CI checks';
  }
  return 'needs attention';
}

/** Bulleted list of the issues we detected, for the agent prompt. */
export function buildIssuesSummary(s: PRMergeableSummary): string {
  const lines: string[] = [];
  if (s.blockingReason === 'merge_conflicts' || s.mergeable === 'CONFLICTING') {
    lines.push('- Merge conflicts with the base branch');
  }
  if ((s.unresolvedReviewThreads ?? 0) > 0) {
    lines.push(`- Unresolved review threads: ${s.unresolvedReviewThreads}`);
  }
  if (s.reviewDecision === 'CHANGES_REQUESTED') {
    lines.push('- A reviewer has requested changes');
  }
  if (s.checks.failed > 0) {
    const optional = s.blockingReason === 'checks_failed_optional';
    lines.push(
      `- Failing CI checks: ${s.checks.failed}/${s.checks.total}` +
        (optional ? ' (none required — not blocking the merge)' : '')
    );
  }
  return lines.length > 0
    ? lines.join('\n')
    : '- (Re-fetch the PR to confirm the current issues.)';
}

/**
 * The PostHog Code sandbox's non-negotiable git/publishing rules (signed-git
 * MCP tools; raw push blocked). Shared verbatim by the mergeable prompt and
 * the skill-run prompt so the two can never drift.
 */
export function postHogCodeGitRules(baseBranch: string): string {
  return `NON-NEGOTIABLE GIT RULES — read these first, they apply to EVERYTHING below:
  - This environment publishes through SIGNED GIT TOOLS. Raw \`git commit\`, \`git push\`, and any force-push are blocked. Changes reach the remote ONLY through:
      - \`git_signed_commit\` — publishes your staged changes (\`git add\` first) as a new commit on the PR branch. Use this for all ordinary work: review fixes, CI fixes, etc.
      - \`git_signed_merge\` — brings the base branch (${baseBranch}) into the PR branch SERVER-SIDE, as a true two-parent Verified merge commit (the same machinery as GitHub's "Update branch" button). No local merge, no history rewriting.
      - \`git_signed_rewrite\` — republishes the branch after a LOCAL rebase. This is the only sanctioned force-update, and the rebase-for-conflicts flow below is its only sanctioned use here.
  - To incorporate changes from ${baseBranch}, ALWAYS call \`git_signed_merge\` first. NEVER run a local \`git merge origin/${baseBranch}\` and then \`git_signed_commit\`: the commit tool refuses while a merge is in progress, because publishing through it would LINEARIZE the merge into a single-parent commit — the base never becomes an ancestor, so the PR diff attributes EVERY file the base changed to your branch (hundreds of unrelated files leaking into the PR). This has actually happened.
  - Rebase is ONLY for conflicts, and only after \`git_signed_merge\` has reported one: \`git fetch origin ${baseBranch}\`, \`git rebase origin/${baseBranch}\`, resolve each conflict, \`git add\` the resolutions, \`git rebase --continue\` (NOT \`git commit\`), then publish with \`git_signed_rewrite\`. Never rebase for any other reason, and never try to publish a rebase any other way.
  - NEVER bring the base's changes in as a single-parent imitation of a merge: no \`git merge --squash\`, \`git read-tree\`, \`git checkout ${baseBranch} -- .\`, \`git diff base | git apply\`, etc. The base must become an ANCESTOR of your branch — via \`git_signed_merge\`'s two-parent merge commit, or via a rebase ONTO it. Naming a single-parent commit "Merge branch '${baseBranch}'" does not make it a merge.
  - A signed git tool's REFUSAL is authoritative ("merge in progress", "base leak", merge commits in a rewrite range, …). Read its error and follow the recovery path it describes — do not retry the same call and do not work around it. If you're stuck mid-operation, \`git merge --abort\` / \`git rebase --abort\` returns you to a clean state to start over from.`;
}

/**
 * The Claude Code (Managed Agents) sandbox's non-negotiable publishing rules
 * (`github` MCP server only; no `gh` CLI, no raw push). Shared verbatim by the
 * mergeable prompt and the skill-run prompt so the two can never drift.
 */
export function claudeCodeGitRules(baseBranch: string): string {
  return `NON-NEGOTIABLE PUBLISHING RULES — read these first, they apply to EVERYTHING below:
  - The repository is mounted in your sandbox, but you have NO \`gh\` CLI and NO outbound \`git push\`. Every change that must reach GitHub — commits to the PR branch, updating the branch from its base, PR comments, resolving review threads — goes through the connected \`github\` MCP server's tools. Use those tools to publish.
  - Local git is available for READ-ONLY inspection and for preparing changes: \`git fetch\`, \`git status\`, \`git diff\`, \`git log\`, \`git merge-base\`, \`git rev-list\`, and a LOCAL \`git rebase\` to resolve conflicts. None of that reaches GitHub on its own — only the \`github\` MCP tools publish.
  - To incorporate changes from ${baseBranch}, bring the base in as a TRUE MERGE so it becomes an ANCESTOR of the PR branch — prefer GitHub's "update branch" / merge-base-into-head operation via the \`github\` MCP server (the same machinery as GitHub's "Update branch" button). Do NOT fabricate a single-parent imitation of a merge (no \`git merge --squash\`, no \`git checkout ${baseBranch} -- .\`, no \`git read-tree\`, no "apply the base's diff"): that makes the base look like your work and leaks every file the base changed into the PR's diff (hundreds of unrelated files). Naming a single-parent commit "Merge branch '${baseBranch}'" does not make it a merge.
  - If GitHub can't auto-update the branch because of CONFLICTS, resolve them LOCALLY (\`git fetch origin ${baseBranch}\` then \`git rebase origin/${baseBranch}\`, resolving each conflict), then publish the resolved branch by pushing it through the \`github\` MCP server. Rebase is ONLY for conflict resolution onto the PR's own base — never rebase for any other reason or onto any other branch.
  - If a \`github\` MCP tool rejects an operation, its error is authoritative — read it and follow the recovery path it describes rather than retrying the same call or working around it.`;
}

/**
 * The small footnote tagline appended to every GitHub comment/reply/review a
 * cloud run posts on our behalf — a subtle "made with Talyn" credit, rendered
 * small via GitHub's `<sub>` and linked to the site. Single source of truth so
 * every prompt family emits the identical line; tweak the wording/link here and
 * it changes everywhere.
 */
export const TALYN_COMMENT_TAGLINE = '<sub>🦉 via [talyn.dev](https://talyn.dev)</sub>';

/**
 * Instruction block telling a cloud agent to end every comment, reply, or review
 * it posts to GitHub with {@link TALYN_COMMENT_TAGLINE}. Shared verbatim by the
 * mergeable and skill prompts so the credit line can't drift, and deliberately
 * scoped to comments only — never commit messages or the PR description.
 */
export function talynTaglineRule(): string {
  return `COMMENT FOOTER — applies to EVERY comment, reply, or review body you post to GitHub (inline review-thread replies, top-level PR comments, and review summaries alike):
  - End the comment with this exact line, on its own final line, verbatim (a blank line before it is fine):
      ${TALYN_COMMENT_TAGLINE}
  - It renders as a small footnote crediting the tool. Add it once per comment, as the LAST line after your actual message. Never omit it and never alter the text or link.
  - Scope: comments/replies/reviews ONLY. Do NOT add it to commit messages, the PR title, or the PR description.`;
}

/** Inputs shared by every provider variant of the "make this PR mergeable" prompt. */
export interface MergeablePromptInput {
  owner: string;
  repo: string;
  number: number;
  summary: PRMergeableSummary;
  /**
   * The PR's base branch enforces "require signed commits" AND the branch
   * currently has unsigned commits — so the merge will be refused until every
   * commit is signed. When set, the prompt gains a re-sign section. Set by the
   * merge queue's signing gate; unset (false) leaves the prompt unchanged.
   */
  resignCommits?: boolean;
  /**
   * The PR was ejected by an external merge queue that FAILED it, while the PR
   * itself looks clean locally.
   *
   * That combination is the whole reason this field exists: there is no local
   * blocker to work from, because the thing that broke is the PR MERGED WITH
   * TRUNK — a state that exists only inside the queue. A run started from the
   * PR's own state would re-read green checks and conclude there is nothing to
   * do, which is exactly what made these PRs sit blocked.
   *
   * `evidence` is the provider's own status sentence, verbatim.
   */
  queueFailure?: { provider: string; evidence: string };
  /**
   * The PR was just retargeted onto its real base by the merge stack, because
   * the PR it was stacked on merged.
   *
   * This matters because the default merge method is SQUASH: when the parent
   * squash-lands, the base gets one new commit and the parent's original
   * commits are NOT in it — but this PR's branch still contains them. A plain
   * "merge the base in" therefore conflicts, or worse succeeds and re-shows the
   * parent's changes in this PR's diff. The correct move is a rebase that drops
   * what the base already has, and only an agent with a checkout can do it.
   */
  retargetedOnto?: { base: string; parentNumber: number };
}

/**
 * What to tell a run whose PR passed on its own branch and failed in the queue.
 *
 * Deliberately starts by sending the agent to the QUEUE's output rather than
 * the PR's checks: the checks are green, and treating them as the source of
 * truth is how a run concludes "nothing to fix" on a PR that is demonstrably
 * unmergeable. The queue tested a merge commit that does not exist on the
 * branch, so reproducing it means merging trunk in locally.
 */
export function queueFailureRule(input: { provider: string; evidence: string; baseBranch: string }): string {
  return `WHY THIS RUN EXISTS — THE MERGE QUEUE FAILED THIS PR, NOT ITS BRANCH:
  - ${input.provider} took this PR into its merge queue, tested it MERGED WITH ${input.baseBranch}, and that merged result failed. The PR's own checks are green — do not take that as "nothing to fix", because the failure is not on the branch as it stands.
  - What ${input.provider} reported: "${input.evidence}"
  - START THERE, not with the PR's check list. Find the queue's failure output — the provider's comments on the PR, its check runs, and any linked CI job it names — and read what actually broke.
  - REPRODUCE IT the way the queue did: merge the latest ${input.baseBranch} into this branch (or rebase onto it) and run the failing tests against that combination. A failure that only appears merged is usually a semantic conflict — two changes that are each fine alone and contradict together.
  - If you genuinely cannot find any failure after merging ${input.baseBranch} and running the relevant tests, say so plainly in your summary rather than pushing a speculative change. A no-op run that explains itself is worth more than a guess.`;
}

/**
 * Re-sign instructions for the PostHog Code sandbox: the signed-git tools sign
 * what they publish, so re-publishing the whole branch via `git_signed_rewrite`
 * makes every commit Verified. Only injected when the base branch requires
 * signatures and the branch has unsigned commits.
 */
export function postHogCodeResignRule(baseBranch: string): string {
  return `COMMIT SIGNING — REQUIRED FOR THIS MERGE (do this before anything else can land):
  - The base branch (${baseBranch}) enforces "require signed commits": GitHub REFUSES the merge while ANY commit on this PR branch is unsigned, and some commits here currently ARE unsigned. A signed merge/squash result is not enough — every commit on the branch must be Verified.
  - The signed-git tools sign what they publish, so re-publish the WHOLE branch through them: replay the branch's commits with a rebase (\`git fetch origin ${baseBranch}\` then \`git rebase origin/${baseBranch}\`; if the branch is already up to date, use \`git rebase -i --root\` — or rebase onto the merge-base — so the commits are actually rewritten), resolving any conflicts per the git rules above, then publish with \`git_signed_rewrite\`. That re-signs every commit in the range.
  - VERIFY before you finish: \`git fetch origin ${baseBranch}\` then \`git log --show-signature origin/${baseBranch}..HEAD\` must show a valid signature on EVERY commit (no "gpg: no signature" / unsigned commit). Do not stop until all of them are signed.`;
}

/**
 * Re-sign instructions for the Claude Code sandbox: commits published through
 * the `github` MCP server are signed by GitHub automatically, so re-creating the
 * branch's commits through it makes them Verified.
 */
export function claudeCodeResignRule(baseBranch: string): string {
  return `COMMIT SIGNING — REQUIRED FOR THIS MERGE (do this before anything else can land):
  - The base branch (${baseBranch}) enforces "require signed commits": GitHub REFUSES the merge while ANY commit on this PR branch is unsigned, and some commits here currently ARE unsigned. A signed merge/squash result is not enough — every commit on the branch must be Verified.
  - Commits you publish through the \`github\` MCP server are signed by GitHub automatically. Re-create the branch's commits through it: rebase locally to linearize/prepare if needed (\`git fetch origin ${baseBranch}\`, \`git rebase origin/${baseBranch}\`), then publish the branch through the \`github\` MCP tools so every commit becomes a Verified GitHub commit.
  - VERIFY before you finish: every commit in \`origin/${baseBranch}..HEAD\` must show as Verified on GitHub. Do not stop until all of them are signed.`;
}

export function githubToolsHint(provider: CloudProviderType): string {
  return provider === 'claude_code'
    ? "the `github` MCP server's tools (there is no `gh` CLI here)"
    : '`gh` (or the GitHub API)';
}

export function postHogCodeBaseUpdateFlow(baseBranch: string, number: number): string {
  return `   - Check mergeability via \`gh pr view ${number} --json mergeable,mergeStateStatus\`.
   - BEFORE updating anything, record the exact set of files this PR owns:
       git fetch origin ${baseBranch}
       git diff --name-only origin/${baseBranch}...HEAD   # save this "before" list
   - If the branch is BEHIND or CONFLICTING / DIRTY, first call \`git_signed_merge\` (per the git rules above). If it succeeds, the base is now merged in server-side as a true two-parent merge commit and your local checkout is synced — skip to the verification step.
   - ONLY if \`git_signed_merge\` reports a CONFLICT, resolve it with the rebase flow:
       git fetch origin ${baseBranch}
       git rebase origin/${baseBranch}
     For each conflicted file, resolve ONLY the genuine conflict: preserve the intent of BOTH sides; never blindly discard the PR's changes or the base's. Then \`git add\` the resolutions and \`git rebase --continue\` (NOT \`git commit\`), repeating until the rebase completes. Publish the rebased branch with \`git_signed_rewrite\`. Only ever rebase onto the PR's own base branch (\`origin/${baseBranch}\`) — never any other branch. If the rebase goes sideways, \`git rebase --abort\` and start it over — never leave it half-finished, and never try to publish it with \`git_signed_commit\`.
   - VERIFY THE UPDATE ACTUALLY JOINED THE BASE, whichever path ran (this is the #1 cause of mass file leaks — the base never truly becomes an ancestor). Both of these must hold:
       git fetch origin ${baseBranch}
       git merge-base --is-ancestor origin/${baseBranch} HEAD   # must exit 0 — the base tip is now an ancestor of your branch
       git rev-list --count HEAD..origin/${baseBranch}          # must print 0 — your branch is NOT behind the base anymore
     If either fails, the update did not take — re-read the tool output (a refusal explains its recovery path) and redo the update; do not proceed.
   - GUARD AGAINST BASE-BRANCH FILES LEAKING INTO THE PR. This is a real, recurring failure: a botched conflict resolution drags files that only changed on ${baseBranch} into the PR's diff. Catch it explicitly:
       a. AFTER the update (signed merge or completed rebase), record the file set again:
            git diff --name-only origin/${baseBranch}...HEAD   # the "after" list
       b. Compare with the "before" list you saved. The two MUST be identical. A clean base update adds NOTHING to the PR's own diff — files that already live on ${baseBranch} must never appear as PR changes. Any file in "after" that wasn't in "before" is a leak (usually a conflict resolved by re-adding base-only content, or a file deleted on one side wrongly kept).
       c. For every file still in the diff, eyeball it: \`git diff origin/${baseBranch}...HEAD -- <file>\`. Each hunk must be either this PR's intended work or a genuine conflict resolution. A hunk that just restates what's already on ${baseBranch} is a leak.
   - If you find ANY leaked file or hunk after a rebase, do not publish. \`git rebase --abort\` (or restart from the remote branch state — the remote is untouched until \`git_signed_rewrite\`) and redo the rebase, taking the base side for files this PR never meant to touch.
   - Do not publish until the "before" and "after" file sets match and every remaining hunk is intentional. Then re-run the build/tests locally where feasible and publish (\`git_signed_rewrite\` for a rebase; a server-side \`git_signed_merge\` needs no publish step). Updating the branch re-triggers CI and can reopen review threads, so re-check conditions (1) and (2) afterwards.`;
}

export function claudeCodeBaseUpdateFlow(baseBranch: string): string {
  return `   - Check mergeability via the \`github\` MCP server's pull-request tools (mergeable / mergeStateStatus).
   - BEFORE updating anything, record the exact set of files this PR owns (local read, safe):
       git fetch origin ${baseBranch}
       git diff --name-only origin/${baseBranch}...HEAD   # save this "before" list
   - If the branch is BEHIND or CONFLICTING, first try to update it from ${baseBranch} through the \`github\` MCP server (a real merge of the base into the head branch). If that succeeds, the base is now an ancestor of your branch — \`git fetch\` and continue to the verification step.
   - ONLY if GitHub reports the update can't be done automatically because of a CONFLICT, resolve it with a local rebase:
       git fetch origin ${baseBranch}
       git rebase origin/${baseBranch}
     For each conflicted file, resolve ONLY the genuine conflict: preserve the intent of BOTH sides; never blindly discard the PR's changes or the base's. Then \`git add\` the resolutions and \`git rebase --continue\`, repeating until the rebase completes. Publish the rebased branch by pushing it through the \`github\` MCP server. Only ever rebase onto the PR's own base branch (\`origin/${baseBranch}\`). If the rebase goes sideways, \`git rebase --abort\` and start over — never leave it half-finished.
   - VERIFY THE UPDATE ACTUALLY JOINED THE BASE, whichever path ran (this is the #1 cause of mass file leaks — the base never truly becomes an ancestor). Both of these must hold (local reads):
       git fetch origin ${baseBranch}
       git merge-base --is-ancestor origin/${baseBranch} HEAD   # must exit 0 — the base tip is now an ancestor of your branch
       git rev-list --count HEAD..origin/${baseBranch}          # must print 0 — your branch is NOT behind the base anymore
     If either fails, the update did not take — redo it; do not proceed.
   - GUARD AGAINST BASE-BRANCH FILES LEAKING INTO THE PR. This is a real, recurring failure: a botched base update or conflict resolution drags files that only changed on ${baseBranch} into the PR's diff. Catch it explicitly:
       a. AFTER the update, record the file set again:
            git diff --name-only origin/${baseBranch}...HEAD   # the "after" list
       b. Compare with the "before" list you saved. The two MUST be identical. A clean base update adds NOTHING to the PR's own diff — files that already live on ${baseBranch} must never appear as PR changes. Any file in "after" that wasn't in "before" is a leak.
       c. For every file still in the diff, eyeball it: \`git diff origin/${baseBranch}...HEAD -- <file>\`. Each hunk must be either this PR's intended work or a genuine conflict resolution. A hunk that just restates what's already on ${baseBranch} is a leak.
   - If you find ANY leaked file or hunk, do not publish. Reset to the remote branch state (the remote is untouched until you push through the \`github\` MCP server) and redo the update, taking the base side for files this PR never meant to touch.
   - Do not publish until the "before" and "after" file sets match and every remaining hunk is intentional. Updating the branch re-triggers CI and can reopen review threads, so re-check conditions (1) and (2) afterwards.`;
}

export function postHogCodeLoopRules(ref: string): string {
  return `Loop discipline:
  - After every publish, wait for CI to finish, then re-check all of: (1) review comments, (2) check status, and (3) mergeability.
  - Do not stop, do not declare victory, and do not hand control back until ALL conditions are simultaneously true on the latest commit.
  - If you genuinely get stuck (e.g. you need credentials you don't have, or a reviewer's request is impossible without product-level decisions), leave a clear PR comment describing exactly what you need and why, then stop. Otherwise keep going.

Start by checking out the PR branch (${ref}), fetching the current state of review threads and CI, and then work the loop until done.`;
}

export function claudeCodeLoopRules(ref: string): string {
  return `Efficiency — this run is metered, so be decisive and do not idle:
  - Investigate ONCE, then batch. Gather every unresolved review thread, the failing required checks, and the mergeability state up front, then make all the fixes you can determine and publish them TOGETHER. Each push re-triggers CI and can reopen threads, so don't publish a separate commit per comment.
  - Don't babysit CI. After publishing, check the required checks once; if they're still queued/running, do at most ONE short re-check — never sit polling a slow pipeline. Talyn re-checks this PR continuously and starts a fresh run if CI later regresses, so you do NOT need to wait out a full CI cycle.
  - Bound your effort to about TWO fix → publish → verify cycles. If required checks are still failing for reasons you can't fix, or you're blocked (missing credentials/secrets, a product decision, or domain knowledge you don't have), post ONE concise PR comment listing exactly what remains and why, then stop — do not keep looping.
  - Make the smallest change that resolves each item — no refactors or edits to unrelated code. If a condition already holds when you fetch state, leave it alone.

Stop as soon as the PR is clean, or after your bounded attempts with a short summary comment. Start by checking out the PR branch (${ref}) and fetching review threads + CI in a single pass.`;
}

export type MergeablePromptVariables = Record<string, string>;

export function mergeablePromptVariables(
  input: MergeablePromptInput & { provider: CloudProviderType }
): MergeablePromptVariables {
  const { owner, repo, number, summary: s, provider } = input;
  const ref = `${owner}/${repo}#${number}`;
  const claude = provider === 'claude_code';
  const issues =
    buildIssuesSummary(s) +
    (input.resignCommits
      ? '\n- Some commits on the branch are UNSIGNED and the base requires signed commits — re-sign the whole branch (see the COMMIT SIGNING section above).'
      : '') +
    (input.retargetedOnto
      ? `\n- This PR was part of a stack. #${input.retargetedOnto.parentNumber} (the PR it was based on) has merged, and this PR has just been retargeted onto \`${input.retargetedOnto.base}\`. ` +
        `That parent was very likely SQUASH-merged, so \`${input.retargetedOnto.base}\` contains its changes as ONE new commit while this branch still carries the parent's original commits. ` +
        `Prefer rebasing this branch onto \`${input.retargetedOnto.base}\` and dropping every commit whose changes are already there, rather than merging the base in — a merge here either conflicts or leaves the parent's changes showing in this PR's diff. ` +
        `When you are done, this PR's diff must contain ONLY its own changes.`
      : '');
  return {
    'pr.url': s.url,
    'pr.number': String(number),
    'pr.ref': ref,
    'pr.title': s.title ?? '',
    'pr.headBranch': s.headBranch,
    'pr.baseBranch': s.baseBranch,
    repo: `${owner}/${repo}`,
    issues,
    gitRules: claude ? claudeCodeGitRules(s.baseBranch) : postHogCodeGitRules(s.baseBranch),
    githubTools: githubToolsHint(provider),
    taglineRule: talynTaglineRule(),
    baseUpdateFlow: claude
      ? claudeCodeBaseUpdateFlow(s.baseBranch)
      : postHogCodeBaseUpdateFlow(s.baseBranch, number),
    resignRule: input.resignCommits
      ? claude
        ? claudeCodeResignRule(s.baseBranch)
        : postHogCodeResignRule(s.baseBranch)
      : '',
    queueFailureRule: input.queueFailure
      ? queueFailureRule({ ...input.queueFailure, baseBranch: s.baseBranch })
      : '',
    loopRules: claude ? claudeCodeLoopRules(ref) : postHogCodeLoopRules(ref),
  };
}

// Same goals for every provider; only the variables change. `template` is a
// workspace override (Settings → Instructions), else the shipped default.
export function buildMergeablePrompt(
  input: MergeablePromptInput & { provider: CloudProviderType; template?: string }
): string {
  return renderPromptTemplate(
    input.template ?? DEFAULT_MERGEABLE_TEMPLATE,
    mergeablePromptVariables(input)
  );
}

export function buildPostHogPrompt(input: MergeablePromptInput & { template?: string }): string {
  return buildMergeablePrompt({ ...input, provider: 'posthog_code' });
}

/** Trimmed, empties dropped, deduped ignoring case because GitHub label names are. */
export function normalizeLabelNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of values) {
    const label = raw.trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

export function parseAutoKeepMergeableLabels(input: string): string[] {
  return normalizeLabelNames(input.split(','));
}
