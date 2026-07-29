// External merge queues: the shared label vocabulary, the gate probe, and the
// submit primitive the queue + the desktop Merge button both go through.
//
// The label mapping is pinned against the real vocabulary observed on
// posthog/posthog after trunk.io went live (July 2026) — trunk-not-ready →
// trunk-queued → trunk-testing → trunk-tests-passed → merged, with
// `(bisection)` variants and a trunk-merged tombstone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  externalQueueStatusFromLabels,
  isExternalQueueEjected,
  isExternalQueueSubmitLabel,
  TRUNK_SUBMIT_LABELS,
} from '@talyn/shared';
import { githubService } from '../services/github.js';
import {
  _resetMergeGateCache,
  _resetSubmitLabelCache,
  clearExternalMergeGate,
  getExternalMergeGate,
  getExternalQueueSubmitLabel,
  markExternalMergeGate,
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
      label,
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
      label: ' Trunk-Testing ',
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
    ['cancelled', true],
    ['queued', false],
    ['testing', false],
    ['passed', false],
    ['not_ready', false],
    ['merged', false],
  ] as const)('isExternalQueueEjected(%s) === %s', (state, ejected) => {
    expect(isExternalQueueEjected(state)).toBe(ejected);
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

  it('markExternalMergeGate confirms a gate stickily, without any probe', async () => {
    markExternalMergeGate('ws', 'o', 'r', 'main');
    expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('confirmed');
    expect(rules).not.toHaveBeenCalled();
  });

  it('a confirmed gate outranks a probe that says otherwise, until explicitly cleared', async () => {
    markExternalMergeGate('ws', 'o', 'r', 'main');
    rules.mockResolvedValue([]); // ruleset relaxed / probe can't see it
    expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBe('confirmed');
    clearExternalMergeGate('ws', 'o', 'r', 'main');
    expect(await getExternalMergeGate('ws', 'o', 'r', 'main')).toBeNull();
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
