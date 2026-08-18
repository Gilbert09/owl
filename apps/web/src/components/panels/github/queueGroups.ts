import type { PRRow } from '../../../lib/api';
import { linkStack } from '@talyn/shared';
import { toStackNodes } from './stacks';

/**
 * How the Merge Queue page slices its rows.
 *
 * Ordinarily the backend's own serialization unit — one group per
 * (repository, base branch), ordered by queue position — is exactly right, and
 * that is what `kind: 'base'` is.
 *
 * A STACK breaks that, because every member of a stack targets a different
 * base by definition. Grouping naively gives one single-row group per member,
 * each with its own sticky header and each labelled `#1`, which is both ugly
 * and a lie: they are one ordered unit that lands on one branch. So a stack
 * collapses into a single group keyed on the branch it will actually land on.
 */
export type QueueGroup = {
  key: string;
  owner: string;
  repo: string;
  /** The branch this group lands on. For a stack, the bottom member's base. */
  base: string;
  rows: PRRow[];
} & (
  | { kind: 'base' }
  | {
      kind: 'stack';
      /** Members present on this page (a merged one has left the store). */
      size: number;
      /**
       * The first member that is blocked, if any. A stack with a stuck rung is
       * stuck entirely — everything above it is parked on it — and a header
       * that doesn't say so leaves the whole thing looking healthy.
       */
      stalledAt: PRRow | null;
    }
);

const isBlocked = (r: PRRow): boolean =>
  r.mergeQueue?.status === 'blocked' || r.mergeQueue?.status === 'blocked_manual';

/**
 * Group queued rows for the Merge Queue page. Stacks first within a repo, then
 * plain base groups, each set ordered by name so the page is stable between
 * renders.
 *
 * `rows` should be the queued rows only. Stack membership is derived from
 * `linkStack` — the same rule the backend serializes on — so the page and the
 * queue never disagree about what belongs together.
 */
export function buildQueueGroups(rows: PRRow[]): QueueGroup[] {
  const { parentOf } = linkStack(toStackNodes(rows));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Walk down to the bottom-most queued ancestor. That row's base is where the
  // whole stack lands, and it stays the same as the stack drains: each member
  // is retargeted onto exactly that branch as its parent merges.
  const rootOf = (row: PRRow): PRRow => {
    const seen = new Set<string>([row.id]);
    let cursor = row;
    for (;;) {
      const parent = parentOf.get(cursor.id);
      const parentRow = parent ? byId.get(parent.id) : undefined;
      if (!parentRow || seen.has(parentRow.id)) return cursor;
      seen.add(parentRow.id);
      cursor = parentRow;
    }
  };
  /** Rungs below `row` in the queued set — its merge order within the stack. */
  const depthOf = (row: PRRow): number => {
    const seen = new Set<string>([row.id]);
    let depth = 0;
    let cursor = row;
    for (;;) {
      const parent = parentOf.get(cursor.id);
      const parentRow = parent ? byId.get(parent.id) : undefined;
      if (!parentRow || seen.has(parentRow.id)) return depth;
      seen.add(parentRow.id);
      cursor = parentRow;
      depth += 1;
    }
  };

  const buckets = new Map<string, { root: PRRow; rows: PRRow[] }>();
  for (const row of rows) {
    const root = rootOf(row);
    const base = root.summary.baseBranch ?? '';
    const key = `${row.repositoryId}|${base}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.rows.push(row);
    else buckets.set(key, { root, rows: [row] });
  }

  const groups: QueueGroup[] = [];
  for (const [key, { root, rows: members }] of buckets) {
    const base = root.summary.baseBranch ?? '';
    // A bucket is a stack only when its members actually chain together. Two
    // unrelated PRs both targeting `main` share a key but are not a stack.
    const stacked = members.some((r) => parentOf.has(r.id) && byId.has(parentOf.get(r.id)!.id));
    if (stacked) {
      const ordered = [...members].sort((a, b) => depthOf(a) - depthOf(b));
      groups.push({
        kind: 'stack',
        key,
        owner: root.owner,
        repo: root.repo,
        base,
        rows: ordered,
        size: ordered.length,
        stalledAt: ordered.find(isBlocked) ?? null,
      });
    } else {
      groups.push({
        kind: 'base',
        key,
        owner: root.owner,
        repo: root.repo,
        base,
        rows: [...members].sort(
          (a, b) => (a.mergeQueueState?.position ?? 0) - (b.mergeQueueState?.position ?? 0)
        ),
      });
    }
  }

  groups.sort((a, b) => {
    const byName = `${a.owner}/${a.repo}/${a.base}`.localeCompare(
      `${b.owner}/${b.repo}/${b.base}`
    );
    if (byName !== 0) return byName;
    if (a.kind !== b.kind) return a.kind === 'stack' ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  return groups;
}
