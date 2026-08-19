// External merge queues: the shared label vocabulary, the gate probe, and the
// submit primitive the queue + the desktop Merge button both go through.
//
// The label mapping is pinned against the real vocabulary observed on
// posthog/posthog after trunk.io went live (July 2026) — trunk-not-ready →
// trunk-queued → trunk-testing → trunk-tests-passed → merged, with
// `(bisection)` variants and a trunk-merged tombstone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  externalQueueInstructionFromComments,
  externalQueueReason,
  externalQueueStatusFromComment,
  externalQueueStatusFromComments,
  externalQueueStatusFromLabels,
  isExternalQueueEjected,
  isExternalQueueHolding,
  isExternalQueueSubmitLabel,
  TRUNK_SUBMIT_LABELS,
} from '@talyn/shared';
import { githubService } from '../services/github.js';
import {
  _resetMergeGateCache,
  _resetSubmitLabelCache,
  clearExternalMergeGate,
  CONFIRMED_TTL_MS,
  getExternalMergeGate,
  getExternalQueueSubmitLabel,
  markExternalMergeGate,
  PROBE_TTL_MS,
} from '../services/repoMergeGate.js';
import { submitToExternalQueue } from '../services/externalQueueSubmit.js';
import * as autoMerge from '../services/githubAutoMerge.js';

describe('externalQueueStatusFromLabels', () => {
  it.each([
    ['trunk-not-ready', 'not_ready'],
    ['trunk-queued', 'queued'],
    ['trunk-queued (bisection)', 'queued'],
    ['trunk-testing', 'testing'],
    ['trunk-testing (bisection)', 'testing'],
    ['trunk-tests-passed', 'passed'],
    ['trunk-failed', 'failed'],
    ['trunk-pending-failure', 'failed'],
    ['trunk-cancelled', 'cancelled'],
    ['trunk-merged', 'merged'],
  ])('maps %s → %s', (label, state) => {
    expect(externalQueueStatusFromLabels([label, 'stamphog'])).toEqual({
      provider: 'trunk',
      state,
      source: 'label',
      evidence: label,
    });
  });

  it('is null for a PR with no queue labels (every repo that uses no queue)', () => {
    expect(externalQueueStatusFromLabels(['stamphog', 'automerge'])).toBeNull();
    expect(externalQueueStatusFromLabels([])).toBeNull();
    expect(externalQueueStatusFromLabels(undefined)).toBeNull();
  });

  it('is case- and whitespace-insensitive but keeps the raw label for display', () => {
    expect(externalQueueStatusFromLabels([' Trunk-Testing '])).toEqual({
      provider: 'trunk',
      state: 'testing',
      source: 'label',
      evidence: ' Trunk-Testing ',
    });
  });

  it('lets the terminal state win when trunk leaves two labels on mid-transition', () => {
    expect(externalQueueStatusFromLabels(['trunk-testing', 'trunk-merged'])?.state).toBe('merged');
    expect(externalQueueStatusFromLabels(['trunk-queued', 'trunk-failed'])?.state).toBe('failed');
  });

  it('never treats a submit label as a state', () => {
    for (const label of TRUNK_SUBMIT_LABELS) {
      expect(externalQueueStatusFromLabels([label])).toBeNull();
      expect(isExternalQueueSubmitLabel(label)).toBe(true);
    }
    // …and never treats a state label as submittable (applying one would lie to
    // trunk about its own state machine).
    for (const label of ['trunk-queued', 'trunk-testing', 'trunk-merged']) {
      expect(isExternalQueueSubmitLabel(label)).toBe(false);
    }
  });

  it.each([
    ['failed', true],
    ['ejected', true],
    ['cancelled', true],
    ['queued', false],
    ['testing', false],
    ['passed', false],
    ['not_ready', false],
    ['merged', false],
    ['not_submitted', false],
    ['rejected', false],
  ] as const)('isExternalQueueEjected(%s) === %s', (state, ejected) => {
    expect(isExternalQueueEjected(state)).toBe(ejected);
  });

  it.each([
    ['queued', true],
    ['testing', true],
    ['passed', true],
    ['not_ready', true],
    ['failed', false],
    ['ejected', false],
    ['cancelled', false],
    ['merged', false],
    ['not_submitted', false],
    ['rejected', false],
  ] as const)('isExternalQueueHolding(%s) === %s', (state, holding) => {
    expect(isExternalQueueHolding(state)).toBe(holding);
  });
});

// ── The comment channel ──
//
// Trunk keeps ONE merge-queue comment per PR and rewrites its body in place as
// the PR moves. Every body below is a VERBATIM capture from posthog/posthog on
// 2026-07-29 — this is the corpus the parser was written against, and the
// reason the queue no longer needs trunk's optional status labels.

/** trunk's instruction body, submit box untouched (#74552 before submitting). */
const TRUNK_UNSUBMITTED =
  '<!-- Trunk Merge -->\nMerging to `master` in this repository is managed by Trunk.\n\n' +
  '<!-- Start PR Submit Checkbox -->\n- [ ] <!-- End PR Submit Checkbox -->To merge this pull ' +
  'request, check the box to the left or comment `/trunk merge` below.\n\nAfter your PR is ' +
  'submitted to the merge queue, this comment will be automatically updated with its status. ' +
  'If the PR fails, failure details will also be posted here';
/** The same comment after trunk accepted the submission (#74595). */
const TRUNK_TICKED = TRUNK_UNSUBMITTED.replace('- [ ]', '- [x]');
const LINK = '(https://app.trunk.io/posthog-inc/merge-queue/3921a8a3/74552)';

const trunk = (body: string) => ({ body, user: { login: 'trunk-io[bot]' } });

describe('externalQueueStatusFromComment — trunk states, as trunk writes them', () => {
  it.each([
    ['testing', 'testing',
      `\u{1F9EA} Running tests on this pull request (testing on PR [#74678](https://www.github.com/PostHog/posthog/pull/74678)) - [details]${LINK}.`],
    ['waiting to start', 'queued',
      `\u{23F3} Waiting to start tests on this pull request - [details]${LINK}.`],
    ['waiting after a restart', 'queued',
      `\u{23F3} Waiting to start tests on this pull request because its tests were restarted by Tom\u00E1s (a GitHub user) - [details]${LINK}.`],
    ['submitted', 'queued',
      `\u{2728} Submitted to Merge by @tatoalo. It will be added to the merge queue once all branch protection rules pass and there are no merge conflicts with the target branch. See more details [here]${LINK}.`],
    ['tests passed', 'passed',
      `\u{1F44D} Pull request will be merged soon because tests have passed on [#74640](https://www.github.com/PostHog/posthog/pull/74640) - [details]${LINK}.`],
    ['merged', 'merged',
      `\u{1F60E} Merged successfully - [details]${LINK}.`],
    ['required check failed', 'failed',
      `\u{26A0}\u{FE0F} The required check [\`LLM Services Tests Pass\`](https://github.com/PostHog/posthog/actions/runs/1) (Failure) has failed. Pull request failed tests and is waiting for other pull requests to finish testing. See more details [here]${LINK}.`],
    ['merge conflict', 'failed',
      `\u{274C} This pull request could not start testing because there was a merge conflict. See more details [here]${LINK}.\n<!-- Start PR Submit Checkbox -->\n- [ ] <!-- End PR Submit Checkbox -->To merge this pull request, check the box to the left or comment \`/trunk merge\` below.`],
    ['ejected by a push', 'ejected',
      `\u{1F6AB} This pull request was removed from the merge queue because it was pushed to by @dmarchuk. Please re-submit it in order to merge. See more details [here]${LINK}.\n<!-- Start PR Submit Checkbox -->\n- [ ] <!-- End PR Submit Checkbox -->To merge this pull request, check the box to the left or comment \`/trunk merge\` below.`],
    // Verbatim off PostHog/posthog#77129, #78858, #73765, #73758, #77141 and
    // #73763 (2026-08-18) — every one of them was sitting permanently blocked
    // because this body matched the bare "removed from the merge queue" rule
    // and read as `cancelled`, the one state Talyn will neither fix nor
    // resubmit. It is a TEST FAILURE, and the failure table is what a
    // queue_failure fix run is started from.
    ['removed for failing tests', 'failed',
      `\u{274C} This pull request was removed from the merge queue because it failed tests. PR [#84396](https://www.github.com/PostHog/posthog/pull/84396) was used for testing. See more details [here]${LINK}.\n|Failed Required Status|Conclusion|\n|-|-|\n|Semgrep Checks Pass|[Failure](https://github.com/PostHog/posthog/actions/runs/1)|\n<!-- Start PR Submit Checkbox -->\n- [ ] <!-- End PR Submit Checkbox -->To merge this pull request, check the box to the left or comment \`/trunk merge\` below.`],
    // Verbatim off PostHog/posthog#82677 and #82676 (2026-08-18). Trunk gave
    // up waiting and asks for a resubmit — an eject, not a cancellation.
    ['removed for waiting too long to become mergeable', 'ejected',
      `\u{1F6AB} This pull request was removed from the merge queue because it was waiting to become mergeable for too long (for example: missing required approvals or checks, or a merge conflict). Submit it again once it's ready. See more details [here]${LINK}.`],
    // Any OTHER removal reason stays terminal — it may be a human.
    ['removed for an unrecognised reason', 'cancelled',
      `\u{1F6AB} This pull request was removed from the merge queue by @someone. See more details [here]${LINK}.`],
  ])('reads %s as %s', (_name, state, body) => {
    expect(externalQueueStatusFromComment(trunk(body))).toMatchObject({
      provider: 'trunk',
      state,
      source: 'comment',
    });
  });

  // Trunk names the pusher and the batch PR in exactly the two reasons that
  // repeat, so the raw sentence made every ejection look like a new one and
  // the recurrence guard that bounds eject → resubmit → eject never fired.
  // Pinned to the verbatim bodies above, so a change in trunk's wording that
  // reintroduces an interpolation shows up here.
  describe('the ejection reason, minus what trunk interpolates per attempt', () => {
    const reasonOf = (body: string) => externalQueueReason(externalQueueStatusFromComment(trunk(body))!);

    it('reads two push-ejections by different people as the same reason', () => {
      const pushedBy = (who: string) =>
        reasonOf(
          `\u{1F6AB} This pull request was removed from the merge queue because it was pushed to by @${who}. Please re-submit it in order to merge. See more details [here]${LINK}.`
        );
      expect(pushedBy('dmarchuk')).toBe(pushedBy('tatoalo'));
    });

    it('reads two test-failure ejections tested on different PRs as the same reason', () => {
      const failedOn = (n: number) =>
        reasonOf(
          `\u{274C} This pull request was removed from the merge queue because it failed tests. PR [#${n}](https://www.github.com/PostHog/posthog/pull/${n}) was used for testing. See more details [here]${LINK}.`
        );
      expect(failedOn(84396)).toBe(failedOn(84400));
    });

    it('still tells two DIFFERENT failing checks apart — that is a new problem', () => {
      const checkFailed = (name: string) =>
        reasonOf(
          `\u{26A0}\u{FE0F} The required check [\`${name}\`](https://github.com/PostHog/posthog/actions/runs/1) (Failure) has failed. See more details [here]${LINK}.`
        );
      expect(checkFailed('Semgrep Checks Pass')).not.toBe(checkFailed('Backend Tests Pass'));
    });
  });

  // The queue-failure fix run is dispatched from this. Before it was captured,
  // the run was told "it failed tests" and had to rediscover which check broke,
  // with the answer already parsed and thrown away.
  describe('the required checks the provider named as failing', () => {
    const checksOf = (body: string) => externalQueueStatusFromComment(trunk(body))?.failedChecks;

    it('reads them out of the failure table, which sits below the status sentence', () => {
      expect(
        checksOf(
          `\u{274C} This pull request was removed from the merge queue because it failed tests. PR [#84396](https://www.github.com/PostHog/posthog/pull/84396) was used for testing. See more details [here]${LINK}.\n|Failed Required Status|Conclusion|\n|-|-|\n|Semgrep Checks Pass|[Failure](https://github.com/PostHog/posthog/actions/runs/1)|\n|Backend Tests Pass|[Failure](https://github.com/PostHog/posthog/actions/runs/2)|\n<!-- Start PR Submit Checkbox -->\n- [ ] <!-- End PR Submit Checkbox -->To merge this pull request, check the box to the left or comment \`/trunk merge\` below.`
        )
      ).toEqual(['Semgrep Checks Pass', 'Backend Tests Pass']);
    });

    it('reads the single-check shape, where the name sits inside a link', () => {
      expect(
        checksOf(
          `\u{26A0}\u{FE0F} The required check [\`LLM Services Tests Pass\`](https://github.com/PostHog/posthog/actions/runs/1) (Failure) has failed. Pull request failed tests and is waiting for other pull requests to finish testing. See more details [here]${LINK}.`
        )
      ).toEqual(['LLM Services Tests Pass']);
    });

    it('names none when the queue never tested the PR', () => {
      expect(
        checksOf(
          `\u{1F6AB} This pull request was removed from the merge queue because it was pushed to by @dmarchuk. Please re-submit it in order to merge. See more details [here]${LINK}.`
        )
      ).toBeUndefined();
    });
  });

  it('quotes the provider sentence that carried the state, without the link URL', () => {
    const status = externalQueueStatusFromComment(
      trunk(`\u{1F60E} Merged successfully - [details]${LINK}.`)
    );
    expect(status!.evidence).toBe('\u{1F60E} Merged successfully');
  });

  it("reads an untouched submit box as 'the provider does NOT have this PR'", () => {
    // THE bug this channel exists for: on #74552 Talyn read only labels, saw
    // none, and declared its `/trunk merge` ignored while trunk was testing.
    expect(externalQueueStatusFromComment(trunk(TRUNK_UNSUBMITTED))?.state).toBe('not_submitted');
  });

  it('reads a ticked submit box as submitted, even before trunk writes a status', () => {
    expect(externalQueueStatusFromComment(trunk(TRUNK_TICKED))?.state).toBe('queued');
  });

  it("reads trunk's refusal of a stacked PR as rejected, not as 'submitted'", () => {
    // The box is TICKED here — reading the checkbox alone would park the PR
    // forever on a queue that has already said it will never merge it.
    const body =
      TRUNK_TICKED +
      '\nGitHub considers this PR to be a part of a stack - GitHub has not rolled out support ' +
      'for Trunk to work with these stacks yet, so our merge queue will be unable to merge this ' +
      'PR. Until GitHub does, you must tear down a PR\u2019s stack before submitting it.';
    const status = externalQueueStatusFromComment(trunk(body));
    expect(status?.state).toBe('rejected');
    expect(status?.evidence).toContain('unable to merge this PR');
  });

  it("never reads trunk's flaky-test comment as a queue state", () => {
    // Same author, same host, and full of the word "failed" — the only thing
    // telling them apart is the marker and the /merge-queue/ link path.
    const body =
      '<!-- Trunk Test Analytics -->\n\n[![Static Badge](https://raster.shields.io/badge/4-failed-crimson)]' +
      '(https://app.trunk.io/posthog-inc/flaky-tests/pr/70824)\n\n| Failed Test | Failure Summary |\n' +
      '| --- | --- |\n| `Funnel insights` | The test failed because the tooltip was not found. |';
    expect(externalQueueStatusFromComment(trunk(body))).toBeNull();
  });

  it('ignores a human quoting trunk, and any non-trunk bot', () => {
    const body = `\u{1F9EA} Running tests on this pull request - [details]${LINK}.`;
    expect(externalQueueStatusFromComment({ body, user: { login: 'Gilbert09' } })).toBeNull();
    expect(externalQueueStatusFromComment({ body, user: { login: 'github-actions[bot]' } })).toBeNull();
    expect(externalQueueStatusFromComment({ body: null })).toBeNull();
    expect(externalQueueStatusFromComment({ body: 'lgtm!' })).toBeNull();
  });

  it('picks the queue comment out of a PR full of other comments', () => {
    expect(
      externalQueueStatusFromComments([
        { body: 'lgtm', user: { login: 'Gilbert09' } },
        trunk('<!-- Trunk Test Analytics -->\n\n| Failed Test |\n| --- |'),
        trunk(`\u{1F9EA} Running tests on this pull request - [details]${LINK}.`),
        { body: '/trunk merge', user: { login: 'talyn-app[bot]' } },
      ])?.state
    ).toBe('testing');
    expect(externalQueueStatusFromComments([])).toBeNull();
  });
});

describe('externalQueueInstructionFromComments', () => {
  it('finds the command door in the instruction body', () => {
    expect(externalQueueInstructionFromComments([trunk(TRUNK_UNSUBMITTED)])).toEqual({
      provider: 'trunk',
      command: '/trunk merge',
    });
  });

  it('still finds it after an ejection, when trunk has dropped its own marker', () => {
    // Trunk's post-ejection body re-offers the command but carries no
    // `<!-- Trunk Merge -->` marker — insisting on the marker made exactly the
    // RESUBMIT path unable to find its own door.
    const ejected =
      `\u{1F6AB} This pull request was removed from the merge queue because it was pushed to by ` +
      `@dmarchuk. Please re-submit it in order to merge. See more details [here]${LINK}.\n` +
      '<!-- Start PR Submit Checkbox -->\n- [ ] <!-- End PR Submit Checkbox -->To merge this pull ' +
      'request, check the box to the left or comment `/trunk merge` below.';
    expect(externalQueueInstructionFromComments([trunk(ejected)])?.command).toBe('/trunk merge');
  });

  it('claims no door when trunk offers none, and none for an ordinary PR', () => {
    expect(
      externalQueueInstructionFromComments([
        trunk('<!-- Trunk Merge -->\nMerging is managed by Trunk. Check the box above.'),
      ])
    ).toBeNull();
    expect(externalQueueInstructionFromComments([{ body: 'ship it' }])).toBeNull();
  });
});

describe('repoMergeGate', () => {
  let rules: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetMergeGateCache();
    _resetSubmitLabelCache();
    rules = vi.spyOn(githubService, 'getBranchRules');
  });
  afterEach(() => vi.restoreAllMocks());

  it('suspects a gate when the base carries an `update` rule (the trunk.io ruleset shape)', async () => {
    rules.mockResolvedValue([
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'creation' },
      { type: 'update' },
      { type: 'required_status_checks' },
    ]);
    expect(await getExternalMergeGate('ws', 'PostHog', 'posthog', 'master')).toBe('suspected');
  });

  it('is null for ordinary protection (reviews + status checks, no ref-update rule)', async () => {
    rules.mockResolvedValue([
      { type: 'pull_request' },
      { type: 'required_status_checks' },
      { type: 'required_signatures' },
      // non_fast_forward alone doesn't stop an ordinary merge
      { type: 'non_fast_forward' },
    ]);
    expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBeNull();
  });

  it('caches the probe and never guesses a gate from a failed one', async () => {
    rules.mockResolvedValue([{ type: 'update' }]);
    expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('suspected');
    expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('suspected');
    expect(rules).toHaveBeenCalledTimes(1);

    _resetMergeGateCache();
    rules.mockRejectedValue(new Error('Resource not accessible by integration'));
    expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBeNull();
  });

  it('markExternalMergeGate confirms a gate without any probe, and holds it for its TTL', async () => {
    markExternalMergeGate('ws', 'o', 'r', 'main');
    expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('confirmed');
    expect(rules).not.toHaveBeenCalled();
  });

  it('a confirmed gate outranks a probe that says otherwise, within its TTL', async () => {
    markExternalMergeGate('ws', 'o', 'r', 'main');
    rules.mockResolvedValue([]); // ruleset relaxed / probe can't see it
    expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('confirmed');
    clearExternalMergeGate('ws', 'o', 'r', 'main');
    expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBeNull();
  });

  // The decay ladder. Before this, `confirmed` was sticky for the life of the
  // process: when trunk.io was switched off on posthog/posthog the queue kept
  // submitting PRs to a queue that no longer existed, and the only cure was a
  // backend redeploy (a confirmed gate never attempts the merge whose success
  // would clear it).
  describe('gate decay — no restart required', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const past = (ms: number) => vi.advanceTimersByTime(ms);

    it('decays confirmed → suspected → null across probe windows once the rule is gone', async () => {
      markExternalMergeGate('ws', 'o', 'r', 'main');
      rules.mockResolvedValue([{ type: 'pull_request' }]); // ruleset relaxed

      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('confirmed');
      past(CONFIRMED_TTL_MS + 1);
      // One level down, not straight to null — a false probe doesn't disprove a
      // gate we watched GitHub enforce, but `suspected` still tries the merge.
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('suspected');
      past(PROBE_TTL_MS + 1);
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBeNull();
      // Settled: no further probes needed within the window.
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBeNull();
    });

    it('keeps confirming while the rule is still on the branch', async () => {
      markExternalMergeGate('ws', 'o', 'r', 'main');
      rules.mockResolvedValue([{ type: 'update' }]);
      past(CONFIRMED_TTL_MS + 1);
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('confirmed');
      past(PROBE_TTL_MS + 1);
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('confirmed');
    });

    it('re-confirms immediately when a refusal is observed again mid-decay', async () => {
      markExternalMergeGate('ws', 'o', 'r', 'main');
      rules.mockResolvedValue([]);
      past(CONFIRMED_TTL_MS + 1);
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('suspected');
      markExternalMergeGate('ws', 'o', 'r', 'main'); // the direct merge 405'd
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('confirmed');
    });

    it('a suspected gate decays to null on its own once the rule goes away', async () => {
      rules.mockResolvedValue([{ type: 'update' }]);
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('suspected');
      rules.mockResolvedValue([]);
      past(PROBE_TTL_MS + 1);
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBeNull();
    });

    it('a failed probe never decays a gate we already hold, and is re-asked sooner', async () => {
      markExternalMergeGate('ws', 'o', 'r', 'main');
      rules.mockRejectedValue(new Error('Resource not accessible by integration'));
      past(CONFIRMED_TTL_MS + 1);
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('confirmed');
      // Held on the shorter failure TTL, so the next real answer lands quickly.
      past(60_000 + 1);
      rules.mockResolvedValue([]);
      expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('suspected');
    });
  });

  it('finds only known submit labels the repo actually defines, preferring the specific one', async () => {
    const labels = vi.spyOn(githubService, 'listRepoLabelNames');
    labels.mockResolvedValue(['stamphog', 'trunk-merge', 'trunk-merge-queue-submit', 'trunk-queued']);
    expect(await getExternalQueueSubmitLabel('ws', 'o', 'r')).toBe('trunk-merge-queue-submit');

    _resetSubmitLabelCache();
    labels.mockResolvedValue(['stamphog', 'automerge']);
    expect(await getExternalQueueSubmitLabel('ws', 'o', 'r')).toBeNull();
  });
});

describe('submitToExternalQueue', () => {
  const base = {
    workspaceId: 'ws',
    owner: 'PostHog',
    repo: 'posthog',
    number: 74353,
    nodeId: 'PR_node',
    headSha: 'abc123',
    mergeMethod: 'squash' as const,
    autoMergeArmedBy: null,
    labelFallback: true,
  };

  /** The instruction comment trunk posts on every PR in a repo it manages. */
  const TRUNK_INSTRUCTION =
    '<!-- Trunk Merge -->\nMerging to `master` in this repository is managed by Trunk.\n' +
    '<!-- Start PR Submit Checkbox -->\n- [ ] <!-- End PR Submit Checkbox -->To merge this ' +
    'pull request, check the box to the left or comment `/trunk merge` below.';

  let enable: ReturnType<typeof vi.spyOn>;
  let capability: ReturnType<typeof vi.spyOn>;
  let labels: ReturnType<typeof vi.spyOn>;
  let addLabels: ReturnType<typeof vi.spyOn>;
  let listComments: ReturnType<typeof vi.spyOn>;
  let comment: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetSubmitLabelCache();
    capability = vi.spyOn(autoMerge, 'getAutoMergeCapability').mockResolvedValue('available');
    enable = vi.spyOn(autoMerge, 'enableAutoMerge').mockResolvedValue({ armed: true });
    // Defaults: no provider instruction, no submit label — i.e. the plain repo.
    listComments = vi.spyOn(githubService, 'listIssueComments').mockResolvedValue([]);
    comment = vi.spyOn(githubService, 'createIssueComment').mockResolvedValue(undefined);
    labels = vi.spyOn(githubService, 'listRepoLabelNames').mockResolvedValue([]);
    addLabels = vi.spyOn(githubService, 'addPullRequestLabels').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('door 1 — the provider says how, on the PR itself', () => {
    it("posts trunk's own submit command and uses no other door", async () => {
      listComments.mockResolvedValue([{ body: TRUNK_INSTRUCTION }]);
      expect(await submitToExternalQueue(base)).toEqual({
        kind: 'submitted',
        via: 'comment',
        command: '/trunk merge',
      });
      expect(comment).toHaveBeenCalledWith('ws', 'PostHog', 'posthog', 74353, '/trunk merge');
      // Auto-merge does NOT submit to trunk (verified on #74354: armed, ignored),
      // so the command door must not fall back to it.
      expect(enable).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('takes the command door even when auto-merge is armable and the PR is clean', async () => {
      listComments.mockResolvedValue([{ body: TRUNK_INSTRUCTION }]);
      labels.mockResolvedValue(['trunk-merge-queue-submit']);
      expect((await submitToExternalQueue(base)).via).toBe('comment');
      expect(enable).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('ignores unrelated bot comments, and a trunk comment that offers no command', async () => {
      listComments.mockResolvedValue([
        { body: '<!-- greptile_other_comments_section --> Reviews (1)' },
        { body: '<!-- Trunk Merge -->\nMerging is managed by Trunk. Check the box above.' },
      ]);
      expect((await submitToExternalQueue(base)).via).toBe('auto_merge');
      expect(comment).not.toHaveBeenCalled();
    });

    it('explains the missing App permission when the comment is refused', async () => {
      listComments.mockResolvedValue([{ body: TRUNK_INSTRUCTION }]);
      comment.mockRejectedValue(new Error('Resource not accessible by integration'));
      const result = await submitToExternalQueue(base);
      expect(result.kind).toBe('no_mechanism');
      expect(result).toMatchObject({ message: expect.stringContaining('Issues: Read & write') });
    });

    it('retries a transient comment failure without falling through to another door', async () => {
      listComments.mockResolvedValue([{ body: TRUNK_INSTRUCTION }]);
      comment.mockRejectedValue(new Error('502 Bad Gateway'));
      expect((await submitToExternalQueue(base)).kind).toBe('retry');
      expect(enable).not.toHaveBeenCalled();
    });

    it('falls through to the other doors when the comments cannot be read', async () => {
      listComments.mockRejectedValue(new Error('403'));
      expect((await submitToExternalQueue(base)).via).toBe('auto_merge');
    });
  });

  describe('door 2 — a submit label the repo defines', () => {
    it('applies the label when no provider instruction exists', async () => {
      labels.mockResolvedValue(['stamphog', 'trunk-merge-queue-submit']);
      expect(await submitToExternalQueue(base)).toEqual({
        kind: 'submitted',
        via: 'label',
        label: 'trunk-merge-queue-submit',
      });
      expect(addLabels).toHaveBeenCalledWith('ws', 'PostHog', 'posthog', 74353, [
        'trunk-merge-queue-submit',
      ]);
      expect(enable).not.toHaveBeenCalled();
    });

    it('explains the missing App permission when labelling is refused', async () => {
      labels.mockResolvedValue(['trunk-merge-queue-submit']);
      addLabels.mockRejectedValue(new Error('Resource not accessible by integration'));
      const result = await submitToExternalQueue(base);
      expect(result.kind).toBe('no_mechanism');
      expect(result).toMatchObject({ message: expect.stringContaining('Issues: Read & write') });
    });
  });

  describe("door 3 — GitHub auto-merge (GitHub's own merge queue)", () => {
    it('arms auto-merge, pinned to the head we decided on', async () => {
      expect(await submitToExternalQueue(base)).toEqual({
        kind: 'submitted',
        via: 'auto_merge',
        armedBy: 'talyn',
      });
      expect(enable.mock.calls[0]![0]).toMatchObject({ expectedHeadOid: 'abc123' });
    });

    it('adopts an existing arm (user or ours) as the submission without re-arming', async () => {
      expect(await submitToExternalQueue({ ...base, autoMergeArmedBy: 'user' })).toEqual({
        kind: 'submitted',
        via: 'auto_merge',
        armedBy: 'user',
      });
      expect(enable).not.toHaveBeenCalled();
    });

    it('reports clean_status when the caller wants to try a direct merge instead', async () => {
      enable.mockResolvedValue({ armed: false, reason: 'clean_status' });
      expect(await submitToExternalQueue({ ...base, labelFallback: false })).toEqual({
        kind: 'clean_status',
      });
    });

    it.each([
      ['a head that moved mid-arm', { armed: false, reason: 'head_mismatch' as const }],
      ['a transient API error', { armed: false, reason: 'error' as const, message: 'boom' }],
    ])('retries (spending nothing) on %s', async (_label, armResult) => {
      enable.mockResolvedValue(armResult);
      expect((await submitToExternalQueue(base)).kind).toBe('retry');
    });

    it('retries when the PR node id has not been cached yet', async () => {
      expect((await submitToExternalQueue({ ...base, nodeId: null })).kind).toBe('retry');
      expect(enable).not.toHaveBeenCalled();
    });
  });

  it('reports no_mechanism when no door exists at all — the one case a human must handle', async () => {
    capability.mockResolvedValue('unavailable');
    labels.mockResolvedValue(['stamphog']);
    const result = await submitToExternalQueue(base);
    expect(result.kind).toBe('no_mechanism');
    expect(result).toMatchObject({ message: expect.stringContaining('instruction comment') });
  });
});
