// The one definition of "PR B is stacked on PR A" (@talyn/shared/stacks).
// Three consumers depend on it agreeing — the merge queue's stack drain and
// both front ends' indented PR lists — so the edge cases are pinned here
// rather than in any one of them. (packages/shared has no test dir of its own;
// its modules are tested from the backend, cf. externalMergeQueue.test.ts.)

import { describe, it, expect } from 'vitest';
import {
  ancestorsOf,
  descendantsOf,
  linkStack,
  StackCycleError,
  type StackNode,
} from '@talyn/shared';

function node(
  id: string,
  headBranch: string,
  baseBranch: string,
  overrides: Partial<StackNode> = {}
): StackNode {
  return { id, repositoryId: 'repo1', state: 'open', headBranch, baseBranch, ...overrides };
}

/** A ← B ← C: the plain three-deep chain every other case is measured against. */
const A = node('a', 'feat-a', 'main');
const B = node('b', 'feat-b', 'feat-a');
const C = node('c', 'feat-c', 'feat-b');

describe('linkStack', () => {
  it('links a child to the open PR whose head is its base', () => {
    const { parentOf, childrenOf } = linkStack([A, B, C]);
    expect(parentOf.get('b')?.id).toBe('a');
    expect(parentOf.get('c')?.id).toBe('b');
    expect(parentOf.has('a')).toBe(false);
    expect(childrenOf.get('a')?.map((n) => n.id)).toEqual(['b']);
  });

  it('never makes a PR its own parent', () => {
    // A self-targeting row can't exist on GitHub, but a half-written summary
    // can produce one, and a self-edge would hang every walk below.
    const self = node('s', 'same', 'same');
    expect(linkStack([self]).parentOf.has('s')).toBe(false);
  });

  it('refuses a merged or closed PR as a parent', () => {
    // Once the parent lands, the child is retargeted onto the real base — it
    // should stop reading as stacked rather than indent under a dead row.
    const merged = { ...A, state: 'merged' };
    expect(linkStack([merged, B]).parentOf.has('b')).toBe(false);
    const closed = { ...A, state: 'closed' };
    expect(linkStack([closed, B]).parentOf.has('b')).toBe(false);
  });

  it('still links a closed CHILD — only parenthood needs an open row', () => {
    const closedChild = { ...B, state: 'closed' };
    expect(linkStack([A, closedChild]).parentOf.get('b')?.id).toBe('a');
  });

  it('never links across repositories with the same branch name', () => {
    const other = node('x', 'feat-b', 'feat-a', { repositoryId: 'repo2' });
    const { parentOf } = linkStack([A, other]);
    expect(parentOf.has('x')).toBe(false);
  });

  it('takes the first writer on a duplicate head branch', () => {
    const dupe = node('a2', 'feat-a', 'main');
    expect(linkStack([A, dupe, B]).parentOf.get('b')?.id).toBe('a');
  });

  it('ignores rows with an empty head or base branch', () => {
    // A summary that predates the branch fields reads as '' — it must not
    // become the parent of every other '' row in the repo.
    const blankHead = node('p', '', 'main');
    const blankBase = node('q', 'feat-q', '');
    const { parentOf } = linkStack([blankHead, blankBase]);
    expect(parentOf.size).toBe(0);
  });
});

describe('ancestorsOf', () => {
  it('returns the chain root-first, including the anchor — merge order', () => {
    expect(ancestorsOf([A, B, C], 'c').map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('resolves from the middle of a stack', () => {
    expect(ancestorsOf([A, B, C], 'b').map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('returns just the root when the anchor is the root', () => {
    expect(ancestorsOf([A, B, C], 'a').map((n) => n.id)).toEqual(['a']);
  });

  it('returns a lone PR as a one-member chain', () => {
    expect(ancestorsOf([A], 'a').map((n) => n.id)).toEqual(['a']);
  });

  it('returns nothing for an id that is not in the rows', () => {
    expect(ancestorsOf([A, B], 'zzz')).toEqual([]);
  });

  it('stops at a parent missing from the input rather than inventing one', () => {
    // The client only sees PRs Talyn tracks, so a stack can have a gap.
    expect(ancestorsOf([B, C], 'c').map((n) => n.id)).toEqual(['b', 'c']);
  });

  it('throws on a cycle instead of looping forever', () => {
    const x = node('x', 'feat-x', 'feat-y');
    const y = node('y', 'feat-y', 'feat-x');
    expect(() => ancestorsOf([x, y], 'x')).toThrow(StackCycleError);
  });
});

describe('descendantsOf', () => {
  it('returns every dependent transitively, nearest first', () => {
    expect(descendantsOf([A, B, C], 'a').map((n) => n.id)).toEqual(['b', 'c']);
  });

  it('excludes the anchor itself', () => {
    expect(descendantsOf([A, B, C], 'c')).toEqual([]);
  });

  it('covers a branching stack, not just a linear one', () => {
    const d = node('d', 'feat-d', 'feat-a');
    const ids = descendantsOf([A, B, C, d], 'a').map((n) => n.id);
    expect(ids.sort()).toEqual(['b', 'c', 'd']);
  });

  it('cuts a cycle rather than throwing — it only widens a selection', () => {
    const x = node('x', 'feat-x', 'feat-y');
    const y = node('y', 'feat-y', 'feat-x');
    expect(descendantsOf([x, y], 'x').map((n) => n.id)).toEqual(['y']);
  });

  it('returns nothing for an id that is not in the rows', () => {
    expect(descendantsOf([A, B], 'zzz')).toEqual([]);
  });
});
