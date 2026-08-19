// External merge queues (trunk.io, GitHub's native merge queue) — shared vocabulary.
//
// Some base branches are governed by a merge system Talyn can't merge past: a
// ruleset restricts who may UPDATE the ref and exempts only that system's app.
// posthog/posthog's `master` has been one since July 2026 (the "Trunk merge"
// ruleset), so the direct merge 405s with "Cannot update this protected ref".
//
// Talyn's queue still does the valuable half: take the PR to green (fix runs,
// branch updates, re-signs, check re-runs), SUBMIT it to that system, then
// track it there and re-fix if it gets ejected. This module is the shared
// vocabulary the backend pipeline and the desktop badges both read.
//
// TWO channels carry trunk's state, and the authoritative one is the comment:
//
//  - **Its own PR comment.** Trunk posts ONE comment per PR and EDITS IT IN
//    PLACE through the whole lifecycle: the submit instruction becomes "✨
//    Submitted to Merge", then "🧪 Running tests…", then "😎 Merged
//    successfully" (or a 🚫/❌/⚠️ failure). This always exists — it's how trunk
//    talks to humans — so it's the channel to trust.
//  - **Status labels** (`trunk-queued`, `trunk-testing`, …). Configurable, and
//    on posthog/posthog they're applied only sometimes: #74552 went through a
//    full test cycle without ever being labelled, and PRs that merged hours ago
//    still carry a stale `trunk-testing`. Reading state off labels alone made
//    Talyn declare "the queue never picked it up" for seven PRs trunk was
//    actively testing (2026-07-29) — hence the comment channel.

/** Systems whose queue state we can read. */
export type ExternalQueueProvider = 'trunk';

/**
 * Where a submitted PR sits in the external queue.
 *
 * `failed`/`ejected`/`cancelled` are the EJECTED states — the provider gave the
 * PR back, and Talyn's queue takes over again. They differ in what it gave back
 * WITH, which is what decides the response:
 *
 *   `failed`    — it tested the PR and the tests failed. There is failure
 *                 output to start a fix run from.
 *   `ejected`   — it handed the PR back for a reason that is not a test
 *                 failure (a push landed on the branch, it waited too long for
 *                 the PR to become mergeable) and asked for a resubmit. Nothing
 *                 to read; remediate whatever the PR's own blockers are and go
 *                 round again.
 *   `cancelled` — it was removed for a reason this parser doesn't recognise,
 *                 which may be a human pulling it out deliberately. Terminal:
 *                 overriding that is not a repair.
 *
 * `not_submitted` and `rejected` are only ever read off the provider's comment:
 * the first says its submit box is untouched (it does NOT have the PR), the
 * second that it refuses to merge this PR at all — neither is something a fix
 * run or a resubmit can move, so both need a human.
 */
export type ExternalQueueState =
  | 'not_submitted'
  | 'not_ready'
  | 'queued'
  | 'testing'
  | 'passed'
  | 'failed'
  | 'ejected'
  | 'cancelled'
  | 'rejected'
  | 'merged';

export interface ExternalQueueStatus {
  provider: ExternalQueueProvider;
  state: ExternalQueueState;
  /** Which channel the state was read off. */
  source: 'label' | 'comment';
  /** What it was read off — the label name, or the provider's own status
   *  sentence. Shown verbatim in tooltips. */
  evidence: string;
  /**
   * The required checks the provider named as failing, when it named any.
   *
   * Trunk publishes them in two shapes and Talyn used to keep neither, because
   * `evidence` is one SENTENCE and the checks sit either in a markdown table on
   * the following lines or inside a link on the same one. So a run dispatched
   * from a queue failure was told "it failed tests" and had to rediscover which
   * check broke, with the answer already parsed and thrown away.
   *
   * Also what makes a repeat failure distinguishable from a new one: the same
   * check failing twice is a dead end, a different check is progress.
   */
  failedChecks?: string[];
  /**
   * The Actions run/job the provider linked when it reported a FAILURE, when it
   * named one. Deliberately not part of `evidence` (prose for tooltips) or of
   * the queue signature: it is the handle on WHY the queue's run failed, which
   * is what tells an infrastructure death (a runner that never got to the
   * tests) apart from this PR breaking something — see
   * services/externalQueueFailure.ts.
   */
  failureUrl?: string;
}

/**
 * Trunk's status labels, most-decisive first. Trunk churns these through a
 * PR's lifetime (not-ready → queued → testing → tests-passed → merged) and
 * occasionally leaves two on at once mid-transition, so the order here is the
 * tie-break: a terminal state always wins over an in-flight one.
 *
 * `(bisection)` variants exist for both queued and testing — trunk appends the
 * suffix while it bisects a failing batch. Matched by prefix, so they map to
 * the same state.
 */
const TRUNK_STATE_LABELS: Array<{ prefix: string; state: ExternalQueueState }> = [
  { prefix: 'trunk-merged', state: 'merged' },
  { prefix: 'trunk-failed', state: 'failed' },
  { prefix: 'trunk-pending-failure', state: 'failed' },
  { prefix: 'trunk-cancelled', state: 'cancelled' },
  { prefix: 'trunk-canceled', state: 'cancelled' },
  { prefix: 'trunk-tests-passed', state: 'passed' },
  { prefix: 'trunk-testing', state: 'testing' },
  { prefix: 'trunk-queued', state: 'queued' },
  { prefix: 'trunk-not-ready', state: 'not_ready' },
];

/**
 * Labels that SUBMIT a PR to trunk's queue. Only these are ever applied by
 * Talyn — the status labels above belong to trunk and applying one would lie
 * to it. Both are trunk's documented submit labels; which one a repo uses is
 * configured in the Trunk app, so we look for whichever exists on the repo.
 */
export const TRUNK_SUBMIT_LABELS = ['trunk-merge-queue-submit', 'trunk-merge'] as const;

/**
 * Marker trunk puts at the top of the instruction comment it posts on every PR
 * in a repo it manages ("Merging to `master` in this repository is managed by
 * Trunk"). Its presence is the most direct evidence there is that a third-party
 * queue owns the branch — trunk itself said so, on this PR.
 *
 * NOTE: it survives only while the comment is still the instruction. Once trunk
 * takes the PR it rewrites the body to a status line and the marker goes with
 * it, so anything identifying "trunk's comment" must also accept the checkbox
 * markers and the merge-queue link below.
 */
export const TRUNK_COMMENT_MARKER = '<!-- Trunk Merge -->';

/** The command trunk's instruction comment tells you to post. */
export const TRUNK_MERGE_COMMAND = '/trunk merge';

/**
 * Markers wrapping the submit checkbox trunk offers in its comment:
 *
 *     <!-- Start PR Submit Checkbox -->
 *     - [x] <!-- End PR Submit Checkbox -->To merge this pull request, check…
 *
 * The tick IS trunk's answer to "do you have this PR?" — it appears when trunk
 * accepts a submission and is cleared when it hands the PR back. Trunk drops
 * the checkbox entirely while it's actively working the PR (the body is a
 * status line instead), so its absence is not "unsubmitted".
 */
const TRUNK_CHECKBOX_START = '<!-- Start PR Submit Checkbox -->';
const TRUNK_CHECKBOX_END = '<!-- End PR Submit Checkbox -->';

/**
 * Fragments of the per-PR link every trunk merge-queue status line carries
 * (`https://app.trunk.io/<org>/merge-queue/<id>/<pr>`). The path segment is
 * load-bearing: trunk's OTHER comment on the same PR — Test Analytics — links
 * to `/flaky-tests/` and is full of the words "failed"/"failed test", so
 * matching on the host alone would read a flaky-test table as a queue failure.
 */
const TRUNK_QUEUE_LINK_HOST = 'app.trunk.io';
const TRUNK_QUEUE_LINK_PATH = '/merge-queue/';

/** Marker on trunk's unrelated flaky-test comment — never a queue signal. */
const TRUNK_TEST_ANALYTICS_MARKER = '<!-- Trunk Test Analytics -->';

/**
 * Trunk's status sentences, most-decisive first. Verbatim shapes observed on
 * posthog/posthog (2026-07-29); each is matched loosely enough to survive
 * trunk's own interpolations (PR numbers, check names, usernames).
 */
const TRUNK_STATUS_PATTERNS: Array<{ re: RegExp; state: ExternalQueueState }> = [
  // "😎 Merged successfully - [details](…)"
  { re: /merged successfully/i, state: 'merged' },
  // "removed from the merge queue because …" is a PREFIX trunk shares across
  // outcomes that need OPPOSITE handling, so every known reason must be matched
  // before the bare sentence below. Reading the prefix first classified every
  // queue test failure on posthog/posthog as a deliberate cancellation — the
  // one state `decideExternalEjection` refuses to fix or resubmit — which is
  // what left the queue full of permanently blocked PRs (2026-08-18).
  //
  // "❌ This pull request was removed from the merge queue because it failed
  //  tests. PR #x was used for testing. |Failed Required Status|Conclusion|…"
  { re: /removed from the merge queue because it failed tests/i, state: 'failed' },
  // "🚫 … because it was waiting to become mergeable for too long (for example:
  //  missing required approvals or checks, or a merge conflict). Submit it
  //  again once it's ready" — trunk gave up waiting and asks for a resubmit.
  { re: /waiting to become mergeable for too long/i, state: 'ejected' },
  // "🚫 … because it was pushed to by @x. Please re-submit it in order to
  //  merge." — a new commit invalidated what trunk accepted.
  { re: /removed from the merge queue because it was pushed to/i, state: 'ejected' },
  // Any OTHER removal reason. Unrecognised means possibly a human pulling the
  // PR out on purpose, so this stays the conservative terminal state — fixing
  // or resubmitting over a deliberate removal is not a repair.
  { re: /removed from the merge queue/i, state: 'cancelled' },
  // "❌ This pull request could not start testing because there was a merge
  //  conflict." — ejected, and exactly what Talyn's fix runs are for.
  { re: /could not start testing/i, state: 'failed' },
  // "⚠️ The required check `X` (Failure) has failed. Pull request failed tests
  //  and is waiting for other pull requests to finish testing."
  { re: /has failed|failed tests/i, state: 'failed' },
  // "👍 Pull request will be merged soon because tests have passed on #x"
  { re: /will be merged soon/i, state: 'passed' },
  // "🧪 Running tests on this pull request (testing on PR #x)"
  { re: /running tests on this pull request/i, state: 'testing' },
  // "⏳ Waiting to start tests on this pull request[ because …]"
  { re: /waiting to start tests/i, state: 'queued' },
  // "✨ Submitted to Merge by @x. It will be added to the merge queue once all
  //  branch protection rules pass, there are no merge conflicts with the target
  //  branch, and impacted targets … have been uploaded."
  //
  // `not_ready`, not `queued`, and the difference decides whether Talyn may
  // touch the PR. Trunk is saying it holds the SUBMISSION and the PR is NOT in
  // the queue — it will add it once the PR's own branch protection passes. So
  // nothing is being tested, no batch exists to eject the PR from, and the one
  // thing trunk is waiting for is exactly what a fix run produces. Read as
  // `queued` it looked like "trunk is working on it", and Talyn stood down on a
  // PR whose required checks were red — trunk waiting on Talyn, Talyn waiting
  // on trunk (PostHog/posthog#84450, stuck 9½ hours).
  { re: /submitted to merge/i, state: 'not_ready' },
  // "GitHub considers this PR to be a part of a stack — … our merge queue will
  //  be unable to merge this PR." Appended to the instruction body, so it must
  //  be read before the checkbox: the box is ticked and nothing will happen.
  { re: /unable to merge this pr/i, state: 'rejected' },
];

/**
 * Header of the failure table trunk appends when its queue run goes red:
 *
 *     |Failed Required Status|Conclusion|
 *     |-|-|
 *     |Semgrep Checks Pass|[Failure](https://github.com/…/runs/1)|
 */
const TRUNK_FAILURE_TABLE_HEADER = /^\|\s*failed required status\s*\|/i;
/** A markdown table separator row (`|-|-|`) — never a check. */
const TRUNK_TABLE_SEPARATOR = /^\|[\s|:-]*$/;
/** The single-check shape: "The required check `X` (Failure) has failed." */
const TRUNK_INLINE_CHECK = /required check\s+\[?`([^`]+)`/i;

/** Markdown link text, so `[Failure](https://…)` reads as `Failure`. */
function flattenLinks(line: string): string {
  return line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/**
 * Every required check the comment names as failing, deduped and in the order
 * trunk listed them. Empty when it named none — a push ejection has no checks,
 * and neither does a plain "waiting to become mergeable for too long".
 */
function failedChecksFrom(body: string): string[] {
  const checks: string[] = [];
  const inline = TRUNK_INLINE_CHECK.exec(body);
  if (inline) checks.push(inline[1]!.trim());

  const lines = body.split('\n').map((l) => flattenLinks(l).trim());
  let inTable = false;
  for (const line of lines) {
    if (TRUNK_FAILURE_TABLE_HEADER.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    // The table runs until the first line that is not a row of it.
    if (!line.startsWith('|')) break;
    if (TRUNK_TABLE_SEPARATOR.test(line)) continue;
    const name = line.split('|')[1]?.trim();
    if (name) checks.push(name);
  }

  const seen = new Set<string>();
  return checks.filter((c) => {
    const key = c.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One PR comment, as both the REST list and the webhook payload expose it. */
export interface ExternalQueueComment {
  body?: string | null;
  user?: { login?: string | null } | null;
}

/**
 * Is this trunk's merge-queue comment? Requires trunk's own structure — the
 * instruction marker, the submit checkbox, or the per-PR merge-queue link — so
 * a human quoting "running tests on this pull request" can't be mistaken for
 * the provider. When the author is known it must be a trunk bot.
 */
function isTrunkQueueComment(comment: ExternalQueueComment): boolean {
  const body = comment.body;
  if (!body) return false;
  const login = comment.user?.login;
  if (login && !login.toLowerCase().startsWith('trunk')) return false;
  if (body.includes(TRUNK_TEST_ANALYTICS_MARKER)) return false;
  return (
    body.includes(TRUNK_COMMENT_MARKER) ||
    body.includes(TRUNK_CHECKBOX_START) ||
    (body.includes(TRUNK_QUEUE_LINK_HOST) && body.includes(TRUNK_QUEUE_LINK_PATH))
  );
}

/** Is trunk's submit checkbox ticked? Null when the comment has no checkbox. */
function submitCheckboxTicked(body: string): boolean | null {
  const start = body.indexOf(TRUNK_CHECKBOX_START);
  if (start === -1) return null;
  const end = body.indexOf(TRUNK_CHECKBOX_END, start);
  const region = body.slice(start + TRUNK_CHECKBOX_START.length, end === -1 ? undefined : end);
  if (/\[x\]/i.test(region)) return true;
  if (/\[\s*\]/.test(region)) return false;
  return null;
}

/**
 * The sentence that carried the state, for tooltips — trunk's own words, with
 * markdown links flattened to their text so "- [details](https://…)" doesn't
 * paste a URL into a badge. Scoped to the matched sentence rather than the
 * whole line: some of trunk's status lines run to a paragraph.
 */
function statusEvidence(body: string, re: RegExp): string {
  const line = body
    .split('\n')
    .map((l) => l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim())
    .find((l) => re.test(l));
  if (!line) return 'its status comment';
  const sentence = line.split(/(?<=\.)\s+/).find((s) => re.test(s)) ?? line;
  return sentence.replace(/\s*[-–]\s*details\s*\.?$/i, '').trim();
}

/**
 * A GitHub Actions run (or one job inside it) the provider linked. Anchored on
 * `/actions/runs/` so trunk's OWN links (app.trunk.io) and any PR/commit links
 * in the same comment can't be mistaken for the failing run.
 */
const ACTIONS_RUN_URL_RE = /https:\/\/github\.com\/[^\s)]+\/actions\/runs\/\d+(?:\/job\/\d+)?/;

/**
 * The run the provider blamed, off the status line that carried the state.
 * Falls back to the first such link anywhere in the comment: the whole comment
 * is trunk's merge-queue report for THIS PR, so a run it links there is the run
 * it just failed — the table shape ("|Failed Required Status|…") puts the link
 * on a different line from the sentence.
 */
function failureRunUrl(body: string, re: RegExp): string | undefined {
  const line = body
    .split('\n')
    .find((l) => re.test(l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')) && ACTIONS_RUN_URL_RE.test(l));
  const hit = (line ?? body).match(ACTIONS_RUN_URL_RE);
  return hit ? hit[0] : undefined;
}

/**
 * Read the external-queue state off ONE provider comment body. Null when the
 * comment isn't the provider's merge-queue comment, or when trunk has rewritten
 * it into a shape this doesn't recognise — the caller then falls back to labels
 * rather than inventing a state.
 */
export function externalQueueStatusFromComment(
  comment: ExternalQueueComment
): ExternalQueueStatus | null {
  if (!isTrunkQueueComment(comment)) return null;
  const body = comment.body!;
  for (const { re, state } of TRUNK_STATUS_PATTERNS) {
    if (re.test(body)) {
      const failedChecks = failedChecksFrom(body);
      const url = state === 'failed' ? failureRunUrl(body, re) : undefined;
      return {
        provider: 'trunk',
        state,
        source: 'comment',
        evidence: statusEvidence(body, re),
        ...(failedChecks.length > 0 ? { failedChecks } : {}),
        ...(url ? { failureUrl: url } : {}),
      };
    }
  }
  // No status line — the comment is still the instruction, so the checkbox is
  // the whole answer.
  const ticked = submitCheckboxTicked(body);
  if (ticked === true) {
    return {
      provider: 'trunk',
      state: 'queued',
      source: 'comment',
      evidence: 'its submit checkbox is ticked',
    };
  }
  if (ticked === false) {
    return {
      provider: 'trunk',
      state: 'not_submitted',
      source: 'comment',
      evidence: 'its submit checkbox is untouched',
    };
  }
  return null;
}

/**
 * Read the external-queue state off a PR's comments. Trunk keeps ONE
 * merge-queue comment per PR and edits it in place, but a repo can also have
 * its unrelated comments (test analytics), so this scans for the queue one and
 * takes the LAST match — a re-created comment supersedes an older one.
 */
export function externalQueueStatusFromComments(
  comments: ExternalQueueComment[]
): ExternalQueueStatus | null {
  let found: ExternalQueueStatus | null = null;
  for (const comment of comments) {
    const status = externalQueueStatusFromComment(comment);
    if (status) found = status;
  }
  return found;
}

export interface ExternalQueueInstruction {
  provider: ExternalQueueProvider;
  /** Comment body that submits the PR to the queue. */
  command: string;
}

/**
 * Read the provider's own submit instruction off a PR's comments.
 *
 * This is the authoritative door, and it beats guessing: on posthog/posthog
 * trunk posts "To merge this pull request, check the box to the left or comment
 * `/trunk merge` below" — the checkbox lives inside trunk's own comment (only
 * its author should edit it), so the comment command is the one a third party
 * can safely use. Returns null when no provider has claimed the PR, which is
 * the answer for every repo that doesn't use one.
 *
 * Identification deliberately does NOT insist on `<!-- Trunk Merge -->`: trunk
 * drops that marker when it rewrites the comment, and the body it leaves after
 * EJECTING a PR ("🚫 … Please re-submit it in order to merge", checkbox
 * unticked) still offers the command. Requiring the marker made exactly the
 * resubmit path — the one Talyn exists for — unable to find its own door.
 */
export function externalQueueInstructionFromComments(
  comments: ExternalQueueComment[]
): ExternalQueueInstruction | null {
  for (const comment of comments) {
    if (!isTrunkQueueComment(comment)) continue;
    // Only claim the command door if trunk actually offered it in this repo's
    // configuration — some setups are label- or checkbox-only.
    if (!comment.body!.toLowerCase().includes(TRUNK_MERGE_COMMAND)) continue;
    return { provider: 'trunk', command: TRUNK_MERGE_COMMAND };
  }
  return null;
}

/**
 * Has the provider claimed this PR at all? True when any of its merge-queue
 * comments is present, whatever the body currently says.
 *
 * This is the question `externalQueueInstructionFromComments` can NOT answer
 * once trunk takes the PR: trunk keeps one comment and rewrites the body, so
 * the instruction (and with it the command text) disappears the moment the
 * submission lands, and comes back only on some of the eject shapes. The
 * comment itself never goes away — so "trunk manages this PR" stays provable
 * even when "trunk offered a command" no longer is.
 */
export function externalQueueCommentPresent(
  comments: ExternalQueueComment[]
): ExternalQueueProvider | null {
  return comments.some((c) => isTrunkQueueComment(c)) ? 'trunk' : null;
}

/** Is `name` a label Talyn may apply to submit a PR to an external queue? */
export function isExternalQueueSubmitLabel(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (TRUNK_SUBMIT_LABELS as readonly string[]).includes(n);
}

/**
 * Read the external-queue state off a PR's labels. Returns null when no
 * external queue has touched the PR — which is also the answer for every PR in
 * every repo that doesn't use one.
 */
export function externalQueueStatusFromLabels(
  labels: string[] | undefined | null
): ExternalQueueStatus | null {
  if (!labels || labels.length === 0) return null;
  const normalized = labels.map((l) => ({ raw: l, lower: l.trim().toLowerCase() }));
  for (const { prefix, state } of TRUNK_STATE_LABELS) {
    const hit = normalized.find((l) => l.lower === prefix || l.lower.startsWith(`${prefix} `));
    if (hit) return { provider: 'trunk', state, source: 'label', evidence: hit.raw };
  }
  return null;
}

/** The provider handed the PR back — Talyn's queue owns it again. */
export function isExternalQueueEjected(state: ExternalQueueState): boolean {
  return state === 'failed' || state === 'ejected' || state === 'cancelled';
}

/**
 * The provider has the PR — the states that say a submission landed. Positive
 * evidence: seeing one is enough to reopen an entry Talyn had given up on (its
 * submit DID land after all), and to keep the entry in `awaiting_external`.
 *
 * "Has the PR" is NOT the same as "is working the PR" — see
 * {@link externalQueuePushWouldEject}.
 */
export function isExternalQueueHolding(state: ExternalQueueState): boolean {
  return state === 'not_ready' || state === 'queued' || state === 'testing' || state === 'passed';
}

/**
 * A commit pushed to the PR right now costs the provider real work.
 *
 * This is the question "may Talyn remediate?" actually turns on, and it is
 * narrower than {@link isExternalQueueHolding}. Trunk ejects on a push
 * ("removed from the merge queue because it was pushed to by @x"), so from
 * `queued` (accepted, waiting its turn in the batch line) through `testing` and
 * `passed`, a fix run destroys a cycle — ~40 minutes of CI at PostHog — to
 * repair something the provider was already handling.
 *
 * `not_ready` is the opposite case, and collapsing the two deadlocked the
 * queue: trunk holds the submission but has NOT added the PR, and says why —
 * "it will be added to the merge queue once all branch protection rules pass".
 * There is no batch to eject from, and the branch protection it is waiting on
 * is precisely what a fix run exists to satisfy. Standing down there means each
 * side waits for the other forever (PostHog/posthog#84450).
 */
export function externalQueuePushWouldEject(state: ExternalQueueState): boolean {
  return state === 'queued' || state === 'testing' || state === 'passed';
}

/**
 * The ejection REASON, stripped of the parts trunk interpolates per attempt —
 * for asking "has it already sent this head back for exactly this?".
 *
 * Trunk names the actor and the batch in its own sentences: "…because it was
 * pushed to by @dmarchuk", "…it failed tests. PR #74331 was used for testing."
 * Both change every round, so comparing raw sentences answered "a different
 * reason each time" to a queue repeating itself verbatim, and the recurrence
 * guard meant to stop an eject → resubmit → eject loop never once fired. The
 * check NAME in "The required check `X` has failed" is deliberately kept: a
 * different failing check IS a different problem, and deserves its resubmit.
 */
export function externalQueueReason(status: ExternalQueueStatus): string {
  return status.evidence
    .replace(/@[A-Za-z0-9-]+/g, '@actor')
    .replace(/#\d+/g, '#n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Short human label for a badge. */
export function externalQueueStateLabel(state: ExternalQueueState): string {
  switch (state) {
    case 'not_submitted':
      return 'Not submitted';
    case 'rejected':
      return 'Refused by the queue';
    case 'not_ready':
      return 'Not ready';
    case 'queued':
      return 'Queued';
    case 'testing':
      return 'Testing';
    case 'passed':
      return 'Tests passed';
    case 'failed':
      return 'Failed in queue';
    case 'ejected':
      return 'Sent back by the queue';
    case 'cancelled':
      return 'Cancelled in queue';
    case 'merged':
      return 'Merged';
  }
}

/** Display name of the system holding the PR. */
export function externalQueueProviderLabel(provider: ExternalQueueProvider): string {
  return provider === 'trunk' ? 'Trunk' : provider;
}
