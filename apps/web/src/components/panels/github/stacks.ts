import { ancestorsOf, descendantsOf, linkStack, type StackNode } from '@talyn/shared';
import type { PRRow } from '../../../lib/api';
import { escapeHtml } from '../../../lib/prClipboard';
import { compareByCreated, type SortDir } from './filters';

/**
 * Per-row placement within a stacked-PR group, consumed by the table to render
 * indentation + the shared accent bar. A "stack" is a chain of PRs where one
 * PR's base branch is another PR's head branch (PR B is stacked on PR A when
 * `B.baseBranch === A.headBranch` in the same repo).
 */
/** Adapt the client's PR shape to the structural node @talyn/shared links on. */
export function toStackNodes(rows: PRRow[]): StackNode[] {
  return rows.map((r) => ({
    id: r.id,
    repositoryId: r.repositoryId,
    state: r.state,
    headBranch: r.summary.headBranch,
    baseBranch: r.summary.baseBranch,
  }));
}

/**
 * The PRs that must land before `id` can, root-first — which is also the order
 * the queue will merge them in. Includes `id` itself. Empty when `id` isn't in
 * `rows`, and truncated at any gap in the chain (Talyn only tracks PRs you
 * authored or were asked to review, so a stack can legitimately have a middle
 * PR it cannot see). A base/head cycle yields just `[id]` rather than throwing:
 * the server refuses that case with a message, and it should say so, not the
 * button.
 */
export function stackAncestors(rows: PRRow[], id: string): PRRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  try {
    return ancestorsOf(toStackNodes(rows), id)
      .map((n) => byId.get(n.id))
      .filter((r): r is PRRow => !!r);
  } catch {
    const self = byId.get(id);
    return self ? [self] : [];
  }
}

/**
 * `id` plus every PR stacked on top of it, transitively. This is the set a
 * DEQUEUE has to take: each descendant is parked on `id` and would wait forever
 * if only `id` came out.
 */
export function stackWithDescendants(rows: PRRow[], id: string): PRRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const self = byId.get(id);
  if (!self) return [];
  return [
    self,
    ...descendantsOf(toStackNodes(rows), id)
      .map((n) => byId.get(n.id))
      .filter((r): r is PRRow => !!r),
  ];
}

export interface StackSelection {
  /** The PRs a "Merge stack" on this row queues, root-first (= merge order). */
  targets: PRRow[];
  /** This row is the bottom of a stack, so the button reaches upward. */
  isRoot: boolean;
  /**
   * The branch the stack LANDS on — the bottom member's base. Never the row's
   * own base: for any member but the root that is its parent's head branch,
   * i.e. a feature branch the stack passes through on the way.
   */
  base: string | undefined;
}

/**
 * What "Merge stack" on a given row should queue, and where that stack lands.
 *
 * The reach depends on where the row sits. On a row with PRs beneath it the
 * button means "land everything this PR needs" and stops there — the PRs
 * stacked ABOVE are work the user hasn't asked for, and merging is not
 * reversible. On the stack ROOT there is nothing beneath it, so that reading
 * would leave the one row where "merge the whole stack" is unambiguous with no
 * button at all; there it reaches upward instead.
 *
 * `targets.length <= 1` means there is no stack worth offering.
 *
 * Shared by the row action and the detail sheet deliberately: they had two
 * copies of this, and the copies disagreed about which branch to name — which
 * is exactly how the button came to promise merging a stack into one of its own
 * feature branches.
 */
export function stackSelection(rows: PRRow[], id: string): StackSelection {
  const below = stackAncestors(rows, id);
  const above = stackWithDescendants(rows, id).slice(1);
  const isRoot = below.length === 1 && above.length > 0;
  return {
    targets: isRoot ? [...below, ...above] : below,
    isRoot,
    base: below[0]?.summary.baseBranch,
  };
}

export interface StackMeta {
  /** 0 = stack root, 1 = first dependent, … (used for indentation). */
  depth: number;
  /** True when the row belongs to a stack of more than one PR. */
  stacked: boolean;
}

/**
 * Re-order a list of PRs so stacked PRs are grouped together, root-first, with
 * dependents in dependency order beneath their parent. Returns the new ordering
 * plus per-row {@link StackMeta} keyed by row id.
 *
 * Only **open** PRs participate in linking — a merged/closed parent shouldn't
 * indent its child (in practice the child gets retargeted to `main` once the
 * parent merges). Linking is scoped per repository, so the same branch name in
 * two repos never connects.
 *
 * Roots and sibling dependents are ordered by {@link compareByCreated} so the
 * result respects the active sort direction; within a stack, a parent always
 * precedes its children regardless of sort.
 */
export function buildStackedRows(
  rows: PRRow[],
  sortDir: SortDir
): { ordered: PRRow[]; meta: Map<string, StackMeta> } {
  // Linking itself lives in @talyn/shared — the backend's merge-stack drain
  // resolves parents by the same rule, and two copies of it would diverge into
  // "the UI says these are stacked but the queue doesn't". Ordering and depth
  // stay here: they're presentation.
  const links = linkStack(toStackNodes(rows));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rowOf = (node: { id: string } | undefined): PRRow | undefined =>
    node ? byId.get(node.id) : undefined;

  const parentOf = (r: PRRow): PRRow | undefined => {
    // A closed/merged child keeps no parent link in the display: nothing should
    // indent under a row that has left the stack.
    if (r.state !== 'open') return undefined;
    return rowOf(links.parentOf.get(r.id));
  };

  // children[parentId] → its dependent rows, sorted by the active direction.
  const children = new Map<string, PRRow[]>();
  for (const r of rows) {
    const parent = parentOf(r);
    if (!parent) continue;
    const list = children.get(parent.id);
    if (list) list.push(r);
    else children.set(parent.id, [r]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => compareByCreated(a, b, sortDir));
  }

  // Roots = rows with no parent in the displayed set, ordered by the active sort.
  const roots = rows
    .filter((r) => !parentOf(r))
    .sort((a, b) => compareByCreated(a, b, sortDir));

  const ordered: PRRow[] = [];
  const meta = new Map<string, StackMeta>();
  const visited = new Set<string>();

  const walk = (row: PRRow, depth: number, stacked: boolean) => {
    if (visited.has(row.id)) return; // cycle / diamond guard
    visited.add(row.id);
    ordered.push(row);
    meta.set(row.id, { depth, stacked });
    for (const child of children.get(row.id) ?? []) {
      walk(child, depth + 1, stacked);
    }
  };

  for (const root of roots) {
    if (visited.has(root.id)) continue;
    // A root only opens a stack when it has dependents.
    const isStack = (children.get(root.id)?.length ?? 0) > 0;
    walk(root, 0, isStack);
  }

  // Fallback: any row not reachable from a root (only possible via a base/head
  // cycle) is emitted as its own root so PRs never silently vanish. Re-sort by
  // the active direction.
  if (visited.size < rows.length) {
    const leftovers = rows
      .filter((r) => !visited.has(r.id))
      .sort((a, b) => compareByCreated(a, b, sortDir));
    for (const r of leftovers) {
      if (visited.has(r.id)) continue;
      walk(r, 0, false);
    }
  }

  return { ordered, meta };
}

/**
 * Build the "Copy list" clipboard payload from the displayed rows: a markdown
 * bullet list (plain-text flavour) plus an HTML list (rich flavour, what Slack
 * pastes). Stacked PRs are indented under their parent — two spaces per level
 * in markdown, nested `<ul>`s in HTML — using the same {@link StackMeta} that
 * drives the table's indentation. Filtering can hide a parent while showing
 * its child, so each item's depth is clamped to one deeper than the item above
 * it, keeping both flavours well-formed. Returns null when nothing has a URL.
 */
export function buildCopyListPayload(
  rows: PRRow[],
  meta?: Map<string, StackMeta>
): { markdown: string; html: string; count: number } | null {
  const items: Array<{ title: string; url: string; depth: number }> = [];
  for (const r of rows) {
    if (!r.summary.url) continue;
    const raw = meta?.get(r.id)?.depth ?? 0;
    const prev = items.length > 0 ? items[items.length - 1].depth : -1;
    items.push({
      title: r.summary.title || '(no title)',
      url: r.summary.url,
      depth: Math.min(raw, prev + 1),
    });
  }
  if (items.length === 0) return null;

  const markdown = items
    .map((i) => `${'  '.repeat(i.depth)}- [${i.title}](${i.url})`)
    .join('\n');

  let html = '<ul>';
  let depth = 0;
  let liOpen = false;
  for (const it of items) {
    if (liOpen && it.depth > depth) {
      // Clamped depths only ever step down or go one deeper, so a deeper item
      // opens exactly one nested list inside the still-open parent <li>.
      html += '<ul>';
      depth++;
    } else {
      while (depth > it.depth) {
        html += '</li></ul>';
        depth--;
      }
      if (liOpen) html += '</li>';
    }
    html += `<li><a href="${escapeHtml(it.url)}">${escapeHtml(it.title)}</a>`;
    liOpen = true;
  }
  while (depth > 0) {
    html += '</li></ul>';
    depth--;
  }
  if (liOpen) html += '</li>';
  html += '</ul>';

  return { markdown, html, count: items.length };
}
