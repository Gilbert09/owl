// Stacked-PR linking — the one definition of "PR B is stacked on PR A".
//
// A stack is a chain of PRs where each one's base branch is the previous one's
// head branch. The rule, in full, because three consumers depend on it agreeing:
//
//   parent(B) = the OPEN PR in the same repository whose headBranch equals
//               B's baseBranch. First writer wins on a duplicate head branch.
//               A PR is never its own parent. Cycles are cut by a visited set.
//
// Only open PRs can be parents: a merged or closed parent shouldn't indent its
// child, and in practice the child is retargeted onto the real base once the
// parent lands. Linking is scoped per repository, so the same branch name in
// two repos never connects.
//
// The backend uses this for the merge queue's stack-aware enqueue; both front
// ends use it to indent My PRs and to build the "Merge stack" affordance. It
// is deliberately structural (`StackNode`, not a `PRRow`) so `packages/shared`
// stays free of any client or renderer type.

export interface StackNode {
  id: string;
  repositoryId: string;
  state: 'open' | 'closed' | 'merged' | string;
  headBranch: string;
  baseBranch: string;
}

/** Thrown when a walk revisits a PR — a base/head cycle in the input. */
export class StackCycleError extends Error {
  constructor(public readonly atId: string) {
    super(`Stacked PRs form a cycle at ${atId}`);
    this.name = 'StackCycleError';
  }
}

export interface StackLinks<T extends StackNode> {
  /** child id → its parent node. Absent for stack roots. */
  parentOf: Map<string, T>;
  /** parent id → its dependent nodes, in input order. */
  childrenOf: Map<string, T[]>;
}

/**
 * Index the rows into parent/child maps. O(n); safe on rows of mixed state —
 * a closed row can still be a child, it just can't be a parent.
 */
export function linkStack<T extends StackNode>(rows: T[]): StackLinks<T> {
  // Only open rows can be parents, keyed by repo + head branch so a child can
  // find its parent by its own base branch.
  const byHead = new Map<string, T>();
  for (const r of rows) {
    if (r.state !== 'open') continue;
    if (!r.headBranch) continue;
    const key = `${r.repositoryId}|${r.headBranch}`;
    if (!byHead.has(key)) byHead.set(key, r);
  }

  const parentOf = new Map<string, T>();
  const childrenOf = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.baseBranch) continue;
    const parent = byHead.get(`${r.repositoryId}|${r.baseBranch}`);
    if (!parent || parent.id === r.id) continue;
    parentOf.set(r.id, parent);
    const siblings = childrenOf.get(parent.id);
    if (siblings) siblings.push(r);
    else childrenOf.set(parent.id, [r]);
  }
  return { parentOf, childrenOf };
}

/**
 * The chain from the stack root down to `id`, **root-first**, including `id`
 * itself. This is merge order: you cannot land `id` before everything it is
 * based on. Returns `[]` when `id` isn't in `rows`.
 *
 * @throws {StackCycleError} when the ancestry revisits a PR.
 */
export function ancestorsOf<T extends StackNode>(
  rows: T[],
  id: string,
  links?: StackLinks<T>
): T[] {
  const self = rows.find((r) => r.id === id);
  if (!self) return [];
  const { parentOf } = links ?? linkStack(rows);

  const chain: T[] = [self];
  const seen = new Set<string>([self.id]);
  let cursor: T | undefined = parentOf.get(self.id);
  while (cursor) {
    if (seen.has(cursor.id)) throw new StackCycleError(cursor.id);
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = parentOf.get(cursor.id);
  }
  return chain.reverse();
}

/**
 * Every PR stacked on top of `id`, transitively, in breadth-first order
 * (nearest dependents first). Excludes `id`. Returns `[]` when `id` isn't in
 * `rows`. A cycle is cut by the visited set rather than thrown: a descendant
 * walk is used to widen a selection, and silently dropping the repeat is the
 * safer failure than refusing the whole operation.
 */
export function descendantsOf<T extends StackNode>(
  rows: T[],
  id: string,
  links?: StackLinks<T>
): T[] {
  if (!rows.some((r) => r.id === id)) return [];
  const { childrenOf } = links ?? linkStack(rows);

  const out: T[] = [];
  const seen = new Set<string>([id]);
  const queue = [...(childrenOf.get(id) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
    queue.push(...(childrenOf.get(node.id) ?? []));
  }
  return out;
}
