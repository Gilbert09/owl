import { renderHook } from '@testing-library/react';
import type { PRRow } from '../renderer/lib/api';

/**
 * `setMergeQueueStack` — the action behind "Merge stack" and behind a stack
 * member's dequeue. Three things it must get right, none of which the server
 * can protect us from:
 *
 *   - patch EVERY member optimistically, so the whole stack flips at once;
 *   - roll ALL of them back on failure, so a 402 doesn't leave half a stack
 *     looking queued until the next re-list;
 *   - never fabricate a v2 `mergeQueue` payload. The table prefers v2 whenever
 *     it is present, so an invented status/position would render and stick
 *     until the WS echo lands.
 */

const patchRow = jest.fn();
const setMergeQueueStack = jest.fn();
const maybeHandleBillingLimit = jest.fn();
const toastError = jest.fn();
const toastInfo = jest.fn();
const trackEvent = jest.fn();

let storeRows: PRRow[] = [];

jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: () => ({
    currentWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', settings: {} }],
    environments: [],
    cloudProviders: [],
    selectTask: jest.fn(),
    tasks: [],
    addTask: jest.fn(),
    setActivePanel: jest.fn(),
    openSettings: jest.fn(),
    openConnectAgent: jest.fn(),
  }),
}));
jest.mock('../renderer/stores/pullRequests', () => ({
  usePullRequestStore: {
    getState: () => ({ patchRow, removeRow: jest.fn(), rows: storeRows }),
  },
}));
jest.mock('../renderer/hooks/useApi', () => ({ useTaskActions: () => ({ createTask: jest.fn() }) }));
jest.mock('../renderer/hooks/usePullRequestSync', () => ({ refreshPullRequests: jest.fn() }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: (...a: unknown[]) => toastError(...a), info: (...a: unknown[]) => toastInfo(...a) },
}));
jest.mock('../renderer/stores/billing', () => ({
  maybeHandleBillingLimit: (...a: unknown[]) => maybeHandleBillingLimit(...a),
}));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
jest.mock('../renderer/lib/prClipboard', () => ({ copyRich: jest.fn() }));
jest.mock('../renderer/lib/api', () => ({
  api: { tasks: { get: jest.fn() }, pullRequests: { setMergeQueueStack: (...a: unknown[]) => setMergeQueueStack(...a) } },
}));

import { useGitHubActions } from '../renderer/components/panels/github/useGitHubActions';

function makeRow(id: string, number: number, head: string, base: string, queued = false): PRRow {
  return {
    id,
    number,
    owner: 'acme',
    repo: 'w',
    repositoryId: 'r1',
    state: 'open',
    mergeQueued: queued,
    mergeQueueState: queued ? { status: 'waiting', attempts: 0, position: 1 } : null,
    mergeQueue: null,
    summary: {
      title: `PR ${number}`,
      url: `https://github.com/acme/w/pull/${number}`,
      headBranch: head,
      baseBranch: base,
      mergeable: 'MERGEABLE',
      reviewDecision: null,
      blockingReason: 'mergeable',
      checks: { total: 0, failed: 0 },
    },
  } as unknown as PRRow;
}

/** main <- A <- B <- C */
const A = () => makeRow('a', 1, 'feat-a', 'main');
const B = () => makeRow('b', 2, 'feat-b', 'feat-a');
const C = () => makeRow('c', 3, 'feat-c', 'feat-b');

beforeEach(() => {
  jest.clearAllMocks();
  storeRows = [A(), B(), C()];
  setMergeQueueStack.mockResolvedValue({ pullRequestIds: ['a', 'b', 'c'], skipped: [] });
  maybeHandleBillingLimit.mockReturnValue(false);
});

function actions() {
  return renderHook(() => useGitHubActions()).result.current;
}

describe('setMergeQueueStack — enqueue', () => {
  it('optimistically patches every PR the anchor depends on', async () => {
    await actions().setMergeQueueStack(storeRows[2]!, true);

    const patched = patchRow.mock.calls.map((c) => c[0]);
    expect(patched).toEqual(['a', 'b', 'c']);
    for (const call of patchRow.mock.calls) {
      expect(call[1]).toMatchObject({ mergeQueued: true });
    }
  });

  it('NEVER fabricates a v2 mergeQueue payload', async () => {
    // The table prefers v2 whenever present, so an invented status or position
    // would render immediately and stick until the echo corrects it.
    await actions().setMergeQueueStack(storeRows[2]!, true);

    for (const call of patchRow.mock.calls) {
      expect(call[1]).not.toHaveProperty('mergeQueue');
    }
  });

  it('sends the anchor, and lets the server resolve the chain', async () => {
    await actions().setMergeQueueStack(storeRows[2]!, true);
    expect(setMergeQueueStack).toHaveBeenCalledWith('c', true, { includeDescendants: undefined });
  });

  it('does not touch PRs stacked ABOVE the anchor', async () => {
    await actions().setMergeQueueStack(storeRows[1]!, true);
    expect(patchRow.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('takes the WHOLE stack when asked to include descendants', async () => {
    // What the button on a stack root means. Without it the one row where
    // "merge the whole stack" is unambiguous could queue only itself.
    await actions().setMergeQueueStack(storeRows[0]!, true, { includeDescendants: true });

    expect(patchRow.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    expect(setMergeQueueStack).toHaveBeenCalledWith('a', true, { includeDescendants: true });
  });

  it('queues only the root when descendants are NOT requested', async () => {
    await actions().setMergeQueueStack(storeRows[0]!, true);
    expect(patchRow.mock.calls.map((c) => c[0])).toEqual(['a']);
  });

  it('never double-counts the anchor when including descendants', async () => {
    await actions().setMergeQueueStack(storeRows[1]!, true, { includeDescendants: true });
    expect(patchRow.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
  });

  it('reports what the server declined to queue', async () => {
    setMergeQueueStack.mockResolvedValue({
      pullRequestIds: ['a', 'b'],
      skipped: [{ pullRequestId: 'c', reason: 'No longer tracked' }],
    });

    await actions().setMergeQueueStack(storeRows[2]!, true);

    expect(toastInfo).toHaveBeenCalled();
    expect(toastInfo.mock.calls[0]?.[1]).toContain('No longer tracked');
  });

  it('stays quiet when the server took everything', async () => {
    await actions().setMergeQueueStack(storeRows[2]!, true);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('tracks the stack size, so the funnel can tell it from a single PR', async () => {
    await actions().setMergeQueueStack(storeRows[2]!, true);
    expect(trackEvent).toHaveBeenCalledWith(
      'merge_stack_toggled',
      expect.objectContaining({ enabled: true, size: 3 })
    );
  });
});

describe('setMergeQueueStack — dequeue', () => {
  it('takes the anchor and everything stacked on it', async () => {
    storeRows = [A(), B(), C()].map((r) => ({ ...r, mergeQueued: true }));
    await actions().setMergeQueueStack(storeRows[0]!, false);

    expect(patchRow.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    for (const call of patchRow.mock.calls) {
      expect(call[1]).toMatchObject({ mergeQueued: false, mergeQueueState: null });
    }
  });

  it('leaves the ancestors queued', async () => {
    storeRows = [A(), B(), C()].map((r) => ({ ...r, mergeQueued: true }));
    await actions().setMergeQueueStack(storeRows[2]!, false);
    expect(patchRow.mock.calls.map((c) => c[0])).toEqual(['c']);
  });
});

describe('setMergeQueueStack — failure', () => {
  it('rolls EVERY member back, not just the anchor', async () => {
    // Half a stack left looking queued is worse than no change at all.
    setMergeQueueStack.mockRejectedValue(new Error('boom'));

    await actions().setMergeQueueStack(storeRows[2]!, true);

    const rollbacks = patchRow.mock.calls.slice(3);
    expect(rollbacks.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    for (const call of rollbacks) {
      expect(call[1]).toMatchObject({ mergeQueued: false, mergeQueueState: null });
    }
  });

  it('restores the PREVIOUS state, not a blank one', async () => {
    storeRows = [{ ...A(), mergeQueued: true, mergeQueueState: { status: 'waiting', attempts: 0, position: 4 } } as PRRow, B(), C()];
    setMergeQueueStack.mockRejectedValue(new Error('boom'));

    await actions().setMergeQueueStack(storeRows[2]!, true);

    const restoreA = patchRow.mock.calls.slice(3).find((c) => c[0] === 'a');
    expect(restoreA?.[1]).toMatchObject({
      mergeQueued: true,
      mergeQueueState: { position: 4 },
    });
  });

  it('routes a free-plan 402 to the upgrade modal under its own trigger', async () => {
    setMergeQueueStack.mockRejectedValue(new Error('limit'));
    maybeHandleBillingLimit.mockReturnValue(true);

    await actions().setMergeQueueStack(storeRows[2]!, true);

    expect(maybeHandleBillingLimit).toHaveBeenCalledWith(expect.anything(), 'merge_stack');
    // The paywall IS the message — a raw error toast on top would be noise.
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts anything that is not a billing limit', async () => {
    setMergeQueueStack.mockRejectedValue(new Error('boom'));
    await actions().setMergeQueueStack(storeRows[2]!, true);
    expect(toastError).toHaveBeenCalled();
  });
});
