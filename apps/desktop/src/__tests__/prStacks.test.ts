import type { PRRow, PRState } from '../renderer/lib/api';
import {
  buildStackedRows,
  buildCopyListPayload,
  stackAncestors,
  stackSelection,
  stackWithDescendants,
} from '../renderer/components/panels/github/stacks';

/**
 * Minimal PRRow factory — the stack helper only reads `id`, `repositoryId`,
 * `state`, `summary.headBranch`, `summary.baseBranch`, and the created-at used
 * by the sort. Everything else is filler.
 */
function makeRow(opts: {
  id: string;
  head: string;
  base: string;
  repo?: string;
  state?: PRState;
  createdAt?: string;
}): PRRow {
  const createdAt = opts.createdAt ?? '2026-06-05T00:00:00Z';
  return {
    id: opts.id,
    workspaceId: 'ws1',
    repositoryId: opts.repo ?? 'repo1',
    taskId: null,
    owner: 'acme',
    repo: 'app',
    number: 1,
    state: opts.state ?? 'open',
    reviewRequested: false,
    authored: true,
    mergedAt: null,
    lastPolledAt: createdAt,
    summary: {
      title: opts.id,
      draft: false,
      headBranch: opts.head,
      baseBranch: opts.base,
      createdAt,
    } as PRRow['summary'],
    autoKeepMergeable: false,
    autoMergeState: null,
    mergeQueued: false,
    mergeMethod: 'squash',
    mergeQueueState: null,
    createdAt,
    updatedAt: createdAt,
  };
}

/** Convenience: ordered ids out of buildStackedRows. */
function order(rows: PRRow[], dir: 'asc' | 'desc' = 'desc'): string[] {
  return buildStackedRows(rows, dir).ordered.map((r) => r.id);
}

describe('buildStackedRows', () => {
  it('orders a simple chain root-first with increasing depth, all stacked', () => {
    const a = makeRow({ id: 'A', head: 'a', base: 'main' });
    const b = makeRow({ id: 'B', head: 'b', base: 'a' });
    const c = makeRow({ id: 'C', head: 'c', base: 'b' });
    // Deliberately shuffled input.
    const { ordered, meta } = buildStackedRows([c, a, b], 'desc');

    expect(ordered.map((r) => r.id)).toEqual(['A', 'B', 'C']);
    expect(meta.get('A')).toEqual({ depth: 0, stacked: true });
    expect(meta.get('B')).toEqual({ depth: 1, stacked: true });
    expect(meta.get('C')).toEqual({ depth: 2, stacked: true });
  });

  it('handles a branching stack: two dependents share the parent depth', () => {
    const a = makeRow({ id: 'A', head: 'a', base: 'main' });
    const b = makeRow({ id: 'B', head: 'b', base: 'a', createdAt: '2026-06-05T01:00:00Z' });
    const c = makeRow({ id: 'C', head: 'c', base: 'a', createdAt: '2026-06-05T02:00:00Z' });
    const { ordered, meta } = buildStackedRows([a, b, c], 'desc');

    expect(ordered[0].id).toBe('A');
    // desc → newer sibling (C) first.
    expect(ordered.map((r) => r.id)).toEqual(['A', 'C', 'B']);
    expect(meta.get('B')).toEqual({ depth: 1, stacked: true });
    expect(meta.get('C')).toEqual({ depth: 1, stacked: true });

    // asc flips the sibling order.
    expect(order([a, b, c], 'asc')).toEqual(['A', 'B', 'C']);
  });

  it('keeps independent stacks contiguous, newer root first under desc', () => {
    const a = makeRow({ id: 'A', head: 'a', base: 'main', createdAt: '2026-06-05T00:00:00Z' });
    const a2 = makeRow({ id: 'A2', head: 'a2', base: 'a' });
    const x = makeRow({ id: 'X', head: 'x', base: 'main', createdAt: '2026-06-06T00:00:00Z' });
    const x2 = makeRow({ id: 'X2', head: 'x2', base: 'x' });
    const { ordered } = buildStackedRows([a, a2, x, x2], 'desc');

    expect(ordered.map((r) => r.id)).toEqual(['X', 'X2', 'A', 'A2']);
  });

  it('leaves standalone PRs unstacked and interleaved by sort', () => {
    const a = makeRow({ id: 'A', head: 'a', base: 'main', createdAt: '2026-06-05T00:00:00Z' });
    const b = makeRow({ id: 'B', head: 'b', base: 'main', createdAt: '2026-06-06T00:00:00Z' });
    const { ordered, meta } = buildStackedRows([a, b], 'desc');

    expect(ordered.map((r) => r.id)).toEqual(['B', 'A']);
    expect(meta.get('A')).toEqual({ depth: 0, stacked: false });
    expect(meta.get('B')).toEqual({ depth: 0, stacked: false });
  });

  it('does not link matching branch names across different repositories', () => {
    const a = makeRow({ id: 'A', head: 'shared', base: 'main', repo: 'repo1' });
    const b = makeRow({ id: 'B', head: 'b', base: 'shared', repo: 'repo2' });
    const { meta } = buildStackedRows([a, b], 'desc');

    expect(meta.get('A')).toMatchObject({ stacked: false });
    expect(meta.get('B')).toMatchObject({ depth: 0, stacked: false });
  });

  it.each<PRState>(['merged', 'closed'])(
    'treats a %s parent as absent so the child is a root',
    (parentState) => {
      const a = makeRow({ id: 'A', head: 'a', base: 'main', state: parentState });
      const b = makeRow({ id: 'B', head: 'b', base: 'a' });
      const { meta } = buildStackedRows([a, b], 'desc');

      expect(meta.get('B')).toMatchObject({ depth: 0, stacked: false });
    }
  );

  it('terminates on a base/head cycle without infinite recursion', () => {
    const a = makeRow({ id: 'A', head: 'a', base: 'b' });
    const b = makeRow({ id: 'B', head: 'b', base: 'a' });
    const { ordered } = buildStackedRows([a, b], 'desc');

    // Both rows are emitted exactly once regardless of the cycle.
    expect(ordered.map((r) => r.id).sort()).toEqual(['A', 'B']);
    expect(new Set(ordered.map((r) => r.id)).size).toBe(2);
  });
});

/** makeRow + a URL so the row participates in Copy list. */
function makeLinkedRow(opts: Parameters<typeof makeRow>[0]): PRRow {
  const row = makeRow(opts);
  row.summary = { ...row.summary, url: `https://github.com/acme/app/pull/${opts.id}` };
  return row;
}

describe('buildCopyListPayload', () => {
  it('renders a flat list when no stack meta is given', () => {
    const rows = [makeLinkedRow({ id: 'A', head: 'a', base: 'main' })];
    const payload = buildCopyListPayload(rows);

    expect(payload?.count).toBe(1);
    expect(payload?.markdown).toBe('- [A](https://github.com/acme/app/pull/A)');
    expect(payload?.html).toBe(
      '<ul><li><a href="https://github.com/acme/app/pull/A">A</a></li></ul>'
    );
  });

  it('indents stacked PRs under their parent in both flavours', () => {
    // A ← B ← C is a stack; D is an older independent root (so desc keeps
    // the A stack first).
    const a = makeLinkedRow({ id: 'A', head: 'a', base: 'main', createdAt: '2026-06-06T00:00:00Z' });
    const b = makeLinkedRow({ id: 'B', head: 'b', base: 'a' });
    const c = makeLinkedRow({ id: 'C', head: 'c', base: 'b' });
    const d = makeLinkedRow({ id: 'D', head: 'd', base: 'main', createdAt: '2026-06-05T00:00:00Z' });
    const { ordered, meta } = buildStackedRows([d, c, b, a], 'desc');
    const payload = buildCopyListPayload(ordered, meta);

    expect(payload?.markdown.split('\n')).toEqual([
      '- [A](https://github.com/acme/app/pull/A)',
      '  - [B](https://github.com/acme/app/pull/B)',
      '    - [C](https://github.com/acme/app/pull/C)',
      '- [D](https://github.com/acme/app/pull/D)',
    ]);
    expect(payload?.html).toBe(
      '<ul>' +
        '<li><a href="https://github.com/acme/app/pull/A">A</a>' +
        '<ul><li><a href="https://github.com/acme/app/pull/B">B</a>' +
        '<ul><li><a href="https://github.com/acme/app/pull/C">C</a></li></ul>' +
        '</li></ul>' +
        '</li>' +
        '<li><a href="https://github.com/acme/app/pull/D">D</a></li>' +
        '</ul>'
    );
  });

  it('clamps depth when filtering hid a parent, keeping the output well-formed', () => {
    // Meta says B sits at depth 2, but its ancestors were filtered out of the
    // displayed rows — it must render as a root, and E (depth 3 in meta) as
    // its direct child, never skipping list levels.
    const b = makeLinkedRow({ id: 'B', head: 'b', base: 'a' });
    const e = makeLinkedRow({ id: 'E', head: 'e', base: 'b' });
    const meta = new Map([
      ['B', { depth: 2, stacked: true }],
      ['E', { depth: 3, stacked: true }],
    ]);
    const payload = buildCopyListPayload([b, e], meta);

    expect(payload?.markdown.split('\n')).toEqual([
      '- [B](https://github.com/acme/app/pull/B)',
      '  - [E](https://github.com/acme/app/pull/E)',
    ]);
    expect(payload?.html).toBe(
      '<ul><li><a href="https://github.com/acme/app/pull/B">B</a>' +
        '<ul><li><a href="https://github.com/acme/app/pull/E">E</a></li></ul>' +
        '</li></ul>'
    );
  });

  it('skips rows without a URL and returns null when nothing is copyable', () => {
    const noUrl = makeRow({ id: 'X', head: 'x', base: 'main' }); // no url
    const linked = makeLinkedRow({ id: 'A', head: 'a', base: 'main' });

    expect(buildCopyListPayload([noUrl, linked])?.count).toBe(1);
    expect(buildCopyListPayload([noUrl])).toBeNull();
    expect(buildCopyListPayload([])).toBeNull();
  });
});


/**
 * The two selections the merge-stack actions make. They are asymmetric on
 * purpose: queuing takes what a PR DEPENDS ON, dequeuing takes what depends
 * on IT — dropping one member of a live stack would strand everything above it.
 */
describe('stackAncestors / stackWithDescendants', () => {
  // main <- A <- B <- C
  const chain = () => [
    makeRow({ id: 'A', head: 'a', base: 'main' }),
    makeRow({ id: 'B', head: 'b', base: 'a' }),
    makeRow({ id: 'C', head: 'c', base: 'b' }),
  ];

  it('resolves ancestors root-first — the order the queue merges them in', () => {
    expect(stackAncestors(chain(), 'C').map((r) => r.id)).toEqual(['A', 'B', 'C']);
  });

  it('resolves from the middle of a stack', () => {
    expect(stackAncestors(chain(), 'B').map((r) => r.id)).toEqual(['A', 'B']);
  });

  it('returns a lone PR as a one-member chain', () => {
    expect(stackAncestors([makeRow({ id: 'A', head: 'a', base: 'main' })], 'A').map((r) => r.id)).toEqual(['A']);
  });

  it('returns nothing for a row that is not on the page', () => {
    expect(stackAncestors(chain(), 'zzz')).toEqual([]);
  });

  it('stops at a gap rather than inventing a parent', () => {
    // Talyn only tracks PRs you authored or were asked to review, so the middle
    // of a stack can legitimately be invisible.
    const rows = [makeRow({ id: 'B', head: 'b', base: 'a' }), makeRow({ id: 'C', head: 'c', base: 'b' })];
    expect(stackAncestors(rows, 'C').map((r) => r.id)).toEqual(['B', 'C']);
  });

  it('does not treat a merged parent as part of the stack', () => {
    const rows = [
      makeRow({ id: 'A', head: 'a', base: 'main', state: 'merged' }),
      makeRow({ id: 'B', head: 'b', base: 'a' }),
    ];
    expect(stackAncestors(rows, 'B').map((r) => r.id)).toEqual(['B']);
  });

  it('degrades to just the row on a cycle — the server owns that refusal', () => {
    const rows = [makeRow({ id: 'X', head: 'x', base: 'y' }), makeRow({ id: 'Y', head: 'y', base: 'x' })];
    expect(stackAncestors(rows, 'X').map((r) => r.id)).toEqual(['X']);
  });

  it('takes the row and everything stacked on it, for a dequeue', () => {
    expect(stackWithDescendants(chain(), 'A').map((r) => r.id)).toEqual(['A', 'B', 'C']);
  });

  it('leaves the ancestors alone on a dequeue', () => {
    expect(stackWithDescendants(chain(), 'C').map((r) => r.id)).toEqual(['C']);
  });

  it('covers a branching stack, not just a linear one', () => {
    const rows = [...chain(), makeRow({ id: 'D', head: 'd', base: 'a' })];
    expect(stackWithDescendants(rows, 'A').map((r) => r.id).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('never links branches across repositories', () => {
    const rows = [
      makeRow({ id: 'A', head: 'a', base: 'main' }),
      makeRow({ id: 'B', head: 'b', base: 'a', repo: 'repo2' }),
    ];
    expect(stackAncestors(rows, 'B').map((r) => r.id)).toEqual(['B']);
    expect(stackWithDescendants(rows, 'A').map((r) => r.id)).toEqual(['A']);
  });
});


/**
 * What the "Merge stack" button offers on a given row. Both cases below were
 * live bugs: the button was absent on the stack ROOT (the one row where "merge
 * the whole stack" is unambiguous), and it named the row's OWN base as the
 * landing branch — which for every member but the root is its parent's head
 * branch, so it promised to merge a stack into one of that stack's own feature
 * branches.
 */
describe('stackSelection', () => {
  // master <- A <- B <- C
  const chain = () => [
    makeRow({ id: 'A', head: 'a', base: 'master' }),
    makeRow({ id: 'B', head: 'b', base: 'a' }),
    makeRow({ id: 'C', head: 'c', base: 'b' }),
  ];

  it('offers the WHOLE stack on the root, reaching upward', () => {
    const sel = stackSelection(chain(), 'A');
    expect(sel.isRoot).toBe(true);
    expect(sel.targets.map((r) => r.id)).toEqual(['A', 'B', 'C']);
  });

  it('names the branch the stack LANDS on, never the row\'s own base', () => {
    for (const id of ['A', 'B', 'C']) {
      expect(stackSelection(chain(), id).base).toBe('master');
    }
  });

  it('stops at the anchor on a non-root row — merging is not reversible', () => {
    const sel = stackSelection(chain(), 'B');
    expect(sel.isRoot).toBe(false);
    expect(sel.targets.map((r) => r.id)).toEqual(['A', 'B']);
  });

  it('offers the whole chain from the top, which is the same set', () => {
    expect(stackSelection(chain(), 'C').targets.map((r) => r.id)).toEqual(['A', 'B', 'C']);
  });

  it('offers nothing for a PR that is not in a stack', () => {
    const rows = [makeRow({ id: 'A', head: 'a', base: 'master' })];
    expect(stackSelection(rows, 'A').targets).toHaveLength(1);
    expect(stackSelection(rows, 'A').isRoot).toBe(false);
  });

  it('offers nothing for a row that is not on the page', () => {
    expect(stackSelection(chain(), 'zzz').targets).toEqual([]);
  });

  it('reaches every branch of a forked stack from the root', () => {
    const rows = [...chain(), makeRow({ id: 'D', head: 'd', base: 'a' })];
    expect(stackSelection(rows, 'A').targets.map((r) => r.id).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('treats a stack whose root has merged as landing on the retargeted base', () => {
    // Mid-drain: A is gone from the open set and B has been retargeted onto
    // master. B is now the root, and master is still the answer.
    const rows = [
      makeRow({ id: 'B', head: 'b', base: 'master' }),
      makeRow({ id: 'C', head: 'c', base: 'b' }),
    ];
    const sel = stackSelection(rows, 'B');
    expect(sel.isRoot).toBe(true);
    expect(sel.base).toBe('master');
    expect(sel.targets.map((r) => r.id)).toEqual(['B', 'C']);
  });
});
