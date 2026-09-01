import { describe, it, expect } from 'vitest';
import type { PRRow, PRState } from '../lib/api';
import { buildQueueGroups } from '../components/panels/github/queueGroups';

/**
 * The Merge Queue page groups by where a PR actually LANDS, not by its own base
 * branch. That distinction only matters for stacks — where every member targets
 * a different base by definition — and getting it wrong is very visible: five
 * sticky headers, each holding one row, each labelled #1.
 */
function makeRow(opts: {
  id: string;
  number: number;
  head: string;
  base: string;
  position?: number;
  status?: NonNullable<PRRow['mergeQueue']>['status'];
  repositoryId?: string;
}): PRRow {
  return {
    id: opts.id,
    workspaceId: 'ws1',
    repositoryId: opts.repositoryId ?? 'repo1',
    taskId: null,
    owner: 'a',
    repo: 'b',
    number: opts.number,
    state: 'open' as PRState,
    reviewRequested: false,
    authored: true,
    mergedAt: null,
    lastPolledAt: new Date().toISOString(),
    mergeQueued: true,
    mergeQueue: ({
      status: opts.status ?? 'queued',
      position: opts.position ?? 1,
    } as never),
    summary: {
      url: `https://github.com/a/b/pull/${opts.number}`,
      title: `PR ${opts.number}`,
      headBranch: opts.head,
      baseBranch: opts.base,
      mergeable: 'MERGEABLE',
      blockingReason: 'mergeable',
      reviewDecision: null,
      checks: { total: 1, failed: 0, inProgress: 0, passed: 1 },
      unresolvedReviewThreads: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  } as unknown as PRRow;
}

/** main <- A <- B <- C. */
const stack = () => [
  makeRow({ id: 'a', number: 1, head: 'feat-a', base: 'main' }),
  makeRow({ id: 'b', number: 2, head: 'feat-b', base: 'feat-a' }),
  makeRow({ id: 'c', number: 3, head: 'feat-c', base: 'feat-b' }),
];

describe('buildQueueGroups', () => {
  it('collapses a stack into ONE group, not one per member', () => {
    // The regression this file exists for. Grouping on each row's own base
    // gives three groups here, all showing #1.
    const groups = buildQueueGroups(stack());

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'stack', size: 3, base: 'main' });
  });

  it('orders a stack bottom-first — the order it will actually merge in', () => {
    // Deliberately fed in reverse, and with positions that would sort it wrong:
    // every member is #1 of its own single-member backend group.
    const [a, b, c] = stack();
    const groups = buildQueueGroups([c!, a!, b!]);

    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('groups by the branch the stack lands on, not each member’s base', () => {
    const groups = buildQueueGroups(stack());
    expect(groups[0]!.base).toBe('main');
  });

  it('keeps the group stable as members are retargeted and drain away', () => {
    // Mid-drain: A has merged and left the store, and B has been retargeted
    // onto main. B and C must stay one group, on the same key.
    const before = buildQueueGroups(stack());
    const after = buildQueueGroups([
      makeRow({ id: 'b', number: 2, head: 'feat-b', base: 'main' }),
      makeRow({ id: 'c', number: 3, head: 'feat-c', base: 'feat-b' }),
    ]);

    expect(after).toHaveLength(1);
    expect(after[0]!.key).toBe(before[0]!.key);
    expect(after[0]).toMatchObject({ kind: 'stack', size: 2 });
  });

  it('reports the first blocked rung, because the whole stack is stuck behind it', () => {
    const [a, b, c] = stack();
    const groups = buildQueueGroups([
      a!,
      makeRow({ id: 'b', number: 2, head: 'feat-b', base: 'feat-a', status: 'blocked_manual' }),
      c!,
    ]);

    expect(groups[0]).toMatchObject({ kind: 'stack' });
    expect((groups[0] as { stalledAt: PRRow | null }).stalledAt?.id).toBe('b');
    void b;
  });

  it('has no stalled rung when every member is healthy', () => {
    const groups = buildQueueGroups(stack());
    expect((groups[0] as { stalledAt: PRRow | null }).stalledAt).toBeNull();
  });

  it('does NOT call two unrelated PRs on the same base a stack', () => {
    // They share a group key, but nothing chains them — the header must not
    // claim they merge in sequence.
    const groups = buildQueueGroups([
      makeRow({ id: 'x', number: 1, head: 'feat-x', base: 'main', position: 1 }),
      makeRow({ id: 'y', number: 2, head: 'feat-y', base: 'main', position: 2 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('base');
  });

  it('orders a plain group by the backend-assigned position', () => {
    const groups = buildQueueGroups([
      makeRow({ id: 'y', number: 2, head: 'feat-y', base: 'main', position: 2 }),
      makeRow({ id: 'x', number: 1, head: 'feat-x', base: 'main', position: 1 }),
    ]);

    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['x', 'y']);
  });

  it('keeps a stack and an unrelated group separate, stacks first', () => {
    const groups = buildQueueGroups([
      ...stack(),
      makeRow({ id: 'z', number: 9, head: 'feat-z', base: 'release' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.kind)).toEqual(['stack', 'base']);
  });

  it('never links branches across repositories', () => {
    const groups = buildQueueGroups([
      makeRow({ id: 'a', number: 1, head: 'feat-a', base: 'main' }),
      makeRow({ id: 'b', number: 2, head: 'feat-b', base: 'feat-a', repositoryId: 'repo2' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === 'base')).toBe(true);
  });

  it('survives a base/head cycle instead of hanging', () => {
    const groups = buildQueueGroups([
      makeRow({ id: 'x', number: 1, head: 'feat-x', base: 'feat-y' }),
      makeRow({ id: 'y', number: 2, head: 'feat-y', base: 'feat-x' }),
    ]);

    expect(groups.flatMap((g) => g.rows)).toHaveLength(2);
  });

  it('returns nothing for an empty queue', () => {
    expect(buildQueueGroups([])).toEqual([]);
  });
});
