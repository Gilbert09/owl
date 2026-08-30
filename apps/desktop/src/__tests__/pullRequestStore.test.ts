import type { PRRow } from '../renderer/lib/api';
import {
  usePullRequestStore,
  type PullRequestUpdatePayload,
} from '../renderer/stores/pullRequests';

function makeRow(id: string, over: Partial<PRRow> = {}): PRRow {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'acme',
    repo: 'app',
    number: 1,
    state: 'open',
    reviewRequested: false,
    authored: true,
    watching: false,
    mergedAt: null,
    lastPolledAt: '2026-06-05T00:00:00Z',
    summary: { title: `PR ${id}` } as PRRow['summary'],
    autoKeepMergeable: false,
    autoMergeState: null,
    mergeQueued: false,
    mergeMethod: 'squash',
    mergeQueueState: null,
    createdAt: '2026-06-05T00:00:00Z',
    updatedAt: '2026-06-05T00:00:00Z',
    ...over,
  };
}

function makePayload(
  over: Partial<PullRequestUpdatePayload> & { id: string }
): PullRequestUpdatePayload {
  return {
    taskId: null,
    state: 'open',
    lastSummary: { title: 'updated' } as PullRequestUpdatePayload['lastSummary'],
    ...over,
  };
}

describe('pull request store — applyPullRequestUpdate', () => {
  beforeEach(() => usePullRequestStore.setState({ rows: [] }));

  it('patches an existing open row in place and keeps omitted fields', () => {
    usePullRequestStore.setState({
      rows: [makeRow('p1', { taskId: 't1', authored: true, mergeQueued: true })],
    });
    const needsRefetch = usePullRequestStore
      .getState()
      .applyPullRequestUpdate(makePayload({ id: 'p1', lastSummary: { title: 'new' } as never }));

    expect(needsRefetch).toBe(false);
    const row = usePullRequestStore.getState().rows[0];
    expect(row.summary.title).toBe('new');
    // Echo omitted taskId / flags / queue state → keep what we had.
    expect(row.taskId).toBe('t1');
    expect(row.authored).toBe(true);
    expect(row.mergeQueued).toBe(true);
  });

  it('adopts changed relationship + queue fields when the echo carries them', () => {
    usePullRequestStore.setState({ rows: [makeRow('p1', { reviewRequested: false })] });
    usePullRequestStore.getState().applyPullRequestUpdate(
      makePayload({
        id: 'p1',
        reviewRequested: true,
        mergeQueued: true,
        mergeQueueState: { status: 'merging', attempts: 0, position: 2 },
      })
    );
    const row = usePullRequestStore.getState().rows[0];
    expect(row.reviewRequested).toBe(true);
    expect(row.mergeQueued).toBe(true);
    expect(row.mergeQueueState).toEqual({ status: 'merging', attempts: 0, position: 2 });
  });

  it('drops a row that left the open state (merged/closed upstream)', () => {
    usePullRequestStore.setState({ rows: [makeRow('p1'), makeRow('p2')] });
    const needsRefetch = usePullRequestStore
      .getState()
      .applyPullRequestUpdate(makePayload({ id: 'p1', state: 'merged' }));
    expect(needsRefetch).toBe(false);
    expect(usePullRequestStore.getState().rows.map((r) => r.id)).toEqual(['p2']);
  });

  it('signals a refetch for an unknown OPEN PR, but not an unknown non-open one', () => {
    expect(
      usePullRequestStore.getState().applyPullRequestUpdate(makePayload({ id: 'new', state: 'open' }))
    ).toBe(true);
    expect(
      usePullRequestStore
        .getState()
        .applyPullRequestUpdate(makePayload({ id: 'gone', state: 'closed' }))
    ).toBe(false);
    // Neither inserted a row.
    expect(usePullRequestStore.getState().rows).toHaveLength(0);
  });

  it('patchRow and removeRow mutate the targeted row only', () => {
    usePullRequestStore.setState({ rows: [makeRow('p1'), makeRow('p2')] });
    usePullRequestStore.getState().patchRow('p1', { mergeQueued: true });
    expect(usePullRequestStore.getState().rows.find((r) => r.id === 'p1')?.mergeQueued).toBe(true);
    expect(usePullRequestStore.getState().rows.find((r) => r.id === 'p2')?.mergeQueued).toBe(false);

    usePullRequestStore.getState().removeRow('p1');
    expect(usePullRequestStore.getState().rows.map((r) => r.id)).toEqual(['p2']);
  });
});
