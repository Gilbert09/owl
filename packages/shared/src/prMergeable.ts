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
  /**
   * The {@link unresolvedReviewThreads} split by who OPENED each thread. Both
   * optional: a summary cached before the split shipped has neither, and every
   * reader must treat absence as "we don't know", never as zero.
   */
  unresolvedHumanReviewThreads?: number;
  unresolvedBotReviewThreads?: number;
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
  // Unresolved BOT threads only, and only when we actually know the split —
  // see the note below. Everything else is in the merge-queue variant.
  return prBlocksMerge(s) || (s.unresolvedBotReviewThreads ?? 0) > 0;
}

/**
 * {@link prNeedsFollowup} without the unresolved-thread clause — what the MERGE
 * QUEUE asks, and the reason it is a separate function.
 *
 * Queueing a PR is a request to MERGE it. It is not a request to have an agent
 * go and answer the comments on it first, and a user who queues three PRs the
 * list calls "Ready" and watches three cloud runs start has been surprised by
 * their own tool (PostHog/hogland#442/#444/#445). A thread is also not a thing
 * GitHub refuses a merge over unless the repo requires conversation
 * resolution — in which case the merge attempt itself says so, which is a
 * better signal than guessing beforehand and paying for a run.
 *
 * The auto-keep-mergeable watcher deliberately keeps the broader
 * {@link prNeedsFollowup}: "keep this PR green" IS a standing request to do the
 * work, and a linter's nits are exactly what nobody wants to triage by hand.
 */
export function prBlocksMerge(s: PRMergeableSummary): boolean {
  return (
    s.blockingReason === 'merge_conflicts' ||
    s.blockingReason === 'changes_requested' ||
    // 'checks_failed' already means a *required* check is red (the backend
    // resolves required-ness authoritatively, falling back to a heuristic).
    // We deliberately don't AUTO-fire on raw `checks.failed > 0`: a
    // non-required failing check is not worth an unattended paid run.
    s.blockingReason === 'checks_failed' ||
    s.mergeable === 'CONFLICTING' ||
    s.reviewDecision === 'CHANGES_REQUESTED'
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
  return (
    prNeedsFollowup(s) ||
    s.checks.failed > 0 ||
    // Every unresolved thread, human included. Starting a run for a human's
    // comments is a choice the user is entitled to make deliberately — it is
    // only doing it UNATTENDED that is wrong (see prNeedsFollowup).
    (s.unresolvedReviewThreads ?? 0) > 0
  );
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

/**
 * The checks GitHub reports as failing, read live at dispatch rather than off
 * the cached summary.
 *
 * `last_summary` carries only a COUNT and a hash of the failing set — the names
 * are deliberately not persisted, because that row ships on every poll tick (see
 * the DB-egress rules). So a run that needs to be pointed at a specific red job
 * has to be told at dispatch time, which is rare enough to afford one call.
 *
 * `headSha` is part of the fact, not decoration: it is what lets the agent tell
 * this reading from an older one it may find quoted in a PR comment.
 */
export interface FailingChecksReading {
  headSha: string;
  names: string[];
}

/** Bulleted list of the issues we detected, for the agent prompt. */
export function buildIssuesSummary(
  s: PRMergeableSummary,
  failingChecks?: FailingChecksReading
): string {
  const lines: string[] = [];
  if (s.blockingReason === 'merge_conflicts' || s.mergeable === 'CONFLICTING') {
    lines.push('- Merge conflicts with the base branch');
  }
  if ((s.unresolvedReviewThreads ?? 0) > 0) {
    // Name the split when we have it. "3 unresolved threads" tells the agent
    // nothing about which ones are its business; "2 from bots, 1 from a human"
    // does — and it stops the agent inferring the breakdown from author names
    // it has to go and fetch first.
    const bots = s.unresolvedBotReviewThreads;
    const humans = s.unresolvedHumanReviewThreads;
    const split =
      bots === undefined || humans === undefined
        ? ''
        : ` (${bots} from bots, ${humans} from humans)`;
    lines.push(`- Unresolved review threads: ${s.unresolvedReviewThreads}${split}`);
  }
  if (s.reviewDecision === 'CHANGES_REQUESTED') {
    lines.push('- A reviewer has requested changes');
  }
  if (s.checks.failed > 0) {
    const optional = s.blockingReason === 'checks_failed_optional';
    // Name them when we have them. "Failing CI checks: 2/199" sends the agent
    // to look for itself, and what it finds first is the PR's own comment
    // history — which is how a stale verdict gets re-affirmed instead of
    // re-derived. The head SHA pins the reading to a commit so a quoted
    // conclusion from an earlier head is recognisable as the older fact.
    const named = failingChecks?.names.length
      ? ` — ${failingChecks.names.map((n) => `\`${n}\``).join(', ')} (as of head ${failingChecks.headSha.slice(0, 7)})`
      : '';
    lines.push(
      `- Failing CI checks: ${s.checks.failed}/${s.checks.total}` +
        (optional ? ' (none required — not blocking the merge)' : '') +
        named
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
 * The Talyn Fleet microVM's non-negotiable publishing rules.
 *
 * The guest holds no credential of any kind — the host-side credential proxy
 * injects them — and it holds no signing key either, so a raw `git push` is
 * refused by any base that requires verified signatures. `fleet-publish` is the
 * way through: it asks the proxy to create the commit through GitHub's API,
 * which signs it server-side.
 *
 * Shared verbatim by the mergeable prompt and the skill-run prompt so the two
 * can never drift, and deliberately consistent with the executor's own
 * SYSTEM_PROMPT — an agent told two different mechanisms treats the first
 * refusal it meets as something to route around.
 */
export function fleetGitRules(baseBranch: string): string {
  return `NON-NEGOTIABLE PUBLISHING RULES — read these first, they apply to EVERYTHING below:
  - This environment has NO signing key and NO outbound \`git push\`. A push is REJECTED on any repository that requires verified signatures, and that is by design — do not try to work around it. Changes reach the remote ONLY through:
      - \`fleet-publish --branch <branch> --message "<headline>" [--body "<longer text>"]\` — publishes your working tree as ONE commit that GitHub signs server-side. Use this for all ordinary work: review fixes, CI fixes, etc. It diffs against the merge-base with the default branch, so commit locally or not as you prefer — only the final file contents matter.
      - \`fleet-publish --move-branch <branch> --oid <sha>\` — repoints a branch at a commit you already published. This is the only sanctioned force-update, and the conflict flow below is its only sanctioned use here. It REWRITES the branch and discards its previous commits, so never reach for it while a server-side update would have worked.
  - Local git is fully available for inspection and for preparing changes: \`git fetch\`, \`git status\`, \`git diff\`, \`git log\`, \`git merge-base\`, \`git rev-list\`, and a LOCAL \`git rebase\` to resolve conflicts. None of it reaches the remote on its own — only \`fleet-publish\` and the GitHub API publish.
  - To incorporate changes from ${baseBranch}, make GITHUB perform the merge so the result is signed and the base becomes a true ANCESTOR of the PR branch — see the base-update flow below. NEVER fabricate a single-parent imitation of a merge (no \`git merge --squash\`, no \`git checkout ${baseBranch} -- .\`, no \`git read-tree\`, no "apply the base's diff"): that makes the base look like your work and leaks every file the base changed into the PR's diff (hundreds of unrelated files). Naming a single-parent commit "Merge branch '${baseBranch}'" does not make it a merge.
  - Never move the repository's default branch. The fleet will refuse it.
  - git and the GitHub API are ALREADY authenticated — there are no credentials here and you do not need any. Some API endpoints are deliberately unreachable; a refusal is a policy decision, not an obstacle to route around. Do not probe for alternatives, and never use a request that creates state (a review, a comment, a ref) to test whether something is permitted.`;
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
   * The names of the checks currently failing on the PR's head. Optional
   * everywhere: the front ends build this prompt from the cached summary alone
   * and simply omit it, and a backend dispatch that cannot read them must still
   * dispatch. Absent means "we didn't look", never "nothing is failing".
   */
  failingChecks?: FailingChecksReading;
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
  queueFailure?: { provider: string; evidence: string; failedChecks?: string[] };
  /**
   * The workspace's "reply to human review comments" setting. Absent means
   * unset, i.e. today's behaviour; only an explicit `false` makes the agent
   * leave human threads alone. See {@link humanCommentRule}.
   */
  respondToHumanComments?: boolean;
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
/**
 * The rule injected when a workspace turns OFF replying to human review
 * comments.
 *
 * Requested by reviewers on PostHog/posthog: an agent replying on their review
 * threads is noise on a conversation between people, and resolving one closes a
 * thread its author had not finished with. Bot threads are unaffected — they are
 * the ones nobody wants to triage by hand.
 *
 * Deliberately "leave alone" rather than "act but stay silent". Pushing a change
 * for a human's comment while never replying and leaving the thread open reads,
 * to the reviewer, as an unexplained edit — worse than either doing the whole
 * job or none of it. So human threads become read-only context: the agent may
 * use them to understand the PR, and does nothing else with them.
 */
export function humanCommentRule(): string {
  return `   - THIS WORKSPACE HAS TURNED OFF REPLYING TO HUMAN REVIEW COMMENTS. For any
     thread opened by a human reviewer: do NOT reply to it, do NOT resolve it,
     and do NOT push code for it. Read it for context if it helps you understand
     the PR, then leave it exactly as you found it — it is a conversation between
     people and the PR author will handle it.
     This overrides the human-reviewer guidance above wherever the two conflict.
     Bot and automated-reviewer threads are UNAFFECTED: keep handling those
     exactly as described. If human threads are the only thing left unresolved,
     that is a finished run — say so and stop, rather than treating the PR as
     still blocked.`;
}

export function queueFailureRule(input: {
  provider: string;
  evidence: string;
  baseBranch: string;
  failedChecks?: string[];
}): string {
  const named = input.failedChecks?.length
    ? `\n  - The checks ${input.provider} named as failing: ${input.failedChecks.map((c) => `\`${c}\``).join(', ')}. Start with those specific ones.`
    : '';
  return `WHY THIS RUN EXISTS — THE MERGE QUEUE FAILED THIS PR, NOT ITS BRANCH:
  - ${input.provider} took this PR into its merge queue, tested it MERGED WITH ${input.baseBranch}, and that merged result failed. The PR's own checks are green — do not take that as "nothing to fix", because the failure is not on the branch as it stands.
  - What ${input.provider} reported: "${input.evidence}"${named}
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
 * Re-sign instructions for the Talyn Fleet microVM: `fleet-publish` commits are
 * created through GitHub's API and signed server-side, so republishing the
 * branch's contents through it makes the branch Verified.
 *
 * Publishing collapses the working tree into ONE commit, which is what makes
 * this simple: there is no per-commit re-signing to do, because the branch ends
 * up carrying a single signed commit.
 */
export function fleetResignRule(baseBranch: string): string {
  return `COMMIT SIGNING — REQUIRED FOR THIS MERGE (do this before anything else can land):
  - The base branch (${baseBranch}) enforces "require signed commits": GitHub REFUSES the merge while ANY commit on this PR branch is unsigned, and some commits here currently ARE unsigned. A signed merge/squash result is not enough — every commit on the branch must be Verified.
  - \`fleet-publish\` creates its commit through GitHub's API, which signs it. Republish the branch's whole contents through it: bring the branch up to date with ${baseBranch} per the base-update flow, make sure the working tree holds exactly the final file contents you want, then publish to a NEW scratch branch and repoint the PR branch at it with \`fleet-publish --move-branch <the PR head branch> --oid <the sha you just published>\`. The branch then carries one Verified commit.
  - VERIFY before you finish: every commit in \`origin/${baseBranch}..HEAD\` must show as Verified on GitHub. Do not stop until all of them are.`;
}

/**
 * How this provider's sandbox reaches GitHub's API.
 *
 * One answer for every provider now that Claude Code (whose sandbox had no `gh`
 * and reached GitHub only through the `github` MCP server) is gone: PostHog Code
 * ships `gh`, and the fleet golden ships a `gh` shim that names the way through
 * the host credential proxy. Kept as a function rather than inlined because the
 * next provider may well answer differently again.
 */
export function githubToolsHint(_provider: CloudProviderType): string {
  return '`gh` (or the GitHub API)';
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

/**
 * The fleet's base-update ladder — three rungs, stop at the first that works.
 *
 * Rungs 1 and 2 make GITHUB perform the merge, so the result is signed and the
 * base genuinely becomes an ancestor; both refuse a merge that is not clean, and
 * a refusal means a real conflict rather than a misuse. Rung 3 rewrites the PR
 * branch and discards its previous commits, which is why it is last and why the
 * wording says so out loud.
 */
export function fleetBaseUpdateFlow(baseBranch: string, number: number): string {
  return `   - Check mergeability via \`gh pr view ${number} --json mergeable,mergeStateStatus\` (or the equivalent GitHub API read).
   - BEFORE updating anything, record the exact set of files this PR owns (local read, safe):
       git fetch origin ${baseBranch}
       git diff --name-only origin/${baseBranch}...HEAD   # save this "before" list
   - If the branch is BEHIND or CONFLICTING, try these IN ORDER and stop at the first that works:
       1. \`PUT /repos/{owner}/{repo}/pulls/${number}/update-branch\`
       2. \`POST /repos/{owner}/{repo}/merges\`, merging ${baseBranch} into the head branch
     Both make GitHub perform the merge server-side, so the result is signed, and both REFUSE when the merge is not clean. A refusal means there is a real conflict — not that you used them wrongly. If one succeeds, \`git fetch\` and continue to the verification step.
   - ONLY if both refuse, resolve the conflict locally:
       git fetch origin ${baseBranch}
       git rebase origin/${baseBranch}
     For each conflicted file, resolve ONLY the genuine conflict: preserve the intent of BOTH sides; never blindly discard the PR's changes or the base's. Then \`git add\` the resolutions and \`git rebase --continue\` (NOT \`git commit\`), repeating until the rebase completes. Publish the resolved tree to a NEW scratch branch with \`fleet-publish --branch <scratch>\`, then repoint the PR branch with \`fleet-publish --move-branch <the PR head branch> --oid <the sha you just published>\`. Only ever rebase onto the PR's own base branch (\`origin/${baseBranch}\`) — never any other branch. If the rebase goes sideways, \`git rebase --abort\` and start over; never leave it half-finished.
   - VERIFY THE UPDATE ACTUALLY JOINED THE BASE, whichever rung ran (this is the #1 cause of mass file leaks — the base never truly becomes an ancestor). Both of these must hold (local reads):
       git fetch origin ${baseBranch}
       git merge-base --is-ancestor origin/${baseBranch} HEAD   # must exit 0 — the base tip is now an ancestor of your branch
       git rev-list --count HEAD..origin/${baseBranch}          # must print 0 — your branch is NOT behind the base anymore
     If either fails, the update did not take — re-read the refusal (it explains its recovery path) and redo it; do not proceed.
   - GUARD AGAINST BASE-BRANCH FILES LEAKING INTO THE PR. This is a real, recurring failure: a botched base update or conflict resolution drags files that only changed on ${baseBranch} into the PR's diff. Catch it explicitly:
       a. AFTER the update, record the file set again:
            git diff --name-only origin/${baseBranch}...HEAD   # the "after" list
       b. Compare with the "before" list you saved. The two MUST be identical. A clean base update adds NOTHING to the PR's own diff — files that already live on ${baseBranch} must never appear as PR changes. Any file in "after" that wasn't in "before" is a leak.
       c. For every file still in the diff, eyeball it: \`git diff origin/${baseBranch}...HEAD -- <file>\`. Each hunk must be either this PR's intended work or a genuine conflict resolution. A hunk that just restates what's already on ${baseBranch} is a leak.
   - If you find ANY leaked file or hunk, do not publish. \`git rebase --abort\` (or reset to the remote branch state — the remote is untouched until you publish) and redo the update, taking the base side for files this PR never meant to touch.
   - Do not publish until the "before" and "after" file sets match and every remaining hunk is intentional. Then re-run the build/tests locally where feasible and publish. A server-side update (rung 1 or 2) needs no publish step. Updating the branch re-triggers CI and can reopen review threads, so re-check conditions (1) and (2) afterwards.`;
}

export function postHogCodeLoopRules(ref: string): string {
  return `Loop discipline:
  - After every publish, wait for CI to finish, then re-check all of: (1) review comments, (2) check status, and (3) mergeability.
  - Do not stop, do not declare victory, and do not hand control back until ALL conditions are simultaneously true on the latest commit.
  - If you genuinely get stuck (e.g. you need credentials you don't have, or a reviewer's request is impossible without product-level decisions), leave a clear PR comment describing exactly what you need and why, then stop. Otherwise keep going.

Start by checking out the PR branch (${ref}), fetching the current state of review threads and CI, and then work the loop until done.`;
}

export type MergeablePromptVariables = Record<string, string>;

export function mergeablePromptVariables(
  input: MergeablePromptInput & { provider: CloudProviderType }
): MergeablePromptVariables {
  const { owner, repo, number, summary: s, provider } = input;
  const ref = `${owner}/${repo}#${number}`;
  // Which PUBLISHING DIALECT this provider's sandbox speaks. It is not a label:
  // each variant names the concrete tools the agent must reach for, and an
  // agent handed the wrong ones spends its run discovering they do not exist.
  // The fleet used to fall into the PostHog branch and was told to call
  // `git_signed_commit` / `git_signed_merge` / `git_signed_rewrite`, which are
  // PostHog sandbox tools — its own mechanism is `fleet-publish`.
  const fleet = provider === 'selfhosted';
  const issues =
    buildIssuesSummary(s, input.failingChecks) +
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
    gitRules: fleet ? fleetGitRules(s.baseBranch) : postHogCodeGitRules(s.baseBranch),
    githubTools: githubToolsHint(provider),
    taglineRule: talynTaglineRule(),
    baseUpdateFlow: fleet
      ? fleetBaseUpdateFlow(s.baseBranch, number)
      : postHogCodeBaseUpdateFlow(s.baseBranch, number),
    resignRule: input.resignCommits
      ? fleet
        ? fleetResignRule(s.baseBranch)
        : postHogCodeResignRule(s.baseBranch)
      : '',
    queueFailureRule: input.queueFailure
      ? queueFailureRule({ ...input.queueFailure, baseBranch: s.baseBranch })
      : '',
    // Absent (undefined) means the workspace has never set it — today's
    // behaviour, where human feedback takes priority. Only an explicit `false`
    // injects the rule.
    humanCommentRule: input.respondToHumanComments === false ? humanCommentRule() : '',
    loopRules: postHogCodeLoopRules(ref),
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
