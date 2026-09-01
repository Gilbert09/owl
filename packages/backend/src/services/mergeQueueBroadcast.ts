import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { emitPullRequestUpdated } from './websocket.js';
import { toPublicMergeQueue } from './mergeQueue/legacy.js';
import {
  computeEntryPositions,
  loadActiveEntriesForWorkspace,
  rowToEntrySnapshot,
} from './mergeQueue/store.js';

/**
 * Drop a PR out of the merge queue — spread into any `.set()` that flips a
 * row terminal (merged/closed). Single definition shared by the processor,
 * the monitor's closed-sweep, and the routes' terminal reconcile, so no path
 * can flip `state` while leaking stale queue bookkeeping (which once left a
 * merged PR holding the head slot's "#1" badge forever).
 */
export const QUEUE_RESET_COLUMNS = {
  mergeQueued: false,
  mergeQueuedAt: null,
  mergeQueueState: null,
} as const;

/** The minimal row shape the position math needs — satisfied by both the
 *  drizzle select row and the routes' local PullRequestRow interface. */
interface QueueableRow {
  id: string;
  mergeQueued: boolean;
  mergeQueuedAt: Date | null;
  repositoryId: string;
  lastSummary: unknown;
}

function baseBranchOf(row: QueueableRow): string {
  return (row.lastSummary as { baseBranch?: string } | null)?.baseBranch ?? '';
}

/**
 * 1-based merge-queue position per (repo, base branch) group, FIFO ordered by
 * `mergeQueuedAt`. Mirrors the processor's grouping so the badge's "#N" matches
 * the order the PRs will actually merge. Single source of truth shared by the
 * REST list endpoint and the live position broadcast.
 */
export function computeQueuePositions<T extends QueueableRow>(rows: T[]): Map<string, number> {
  const byGroup = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.mergeQueued) continue;
    const key = `${r.repositoryId}|${baseBranchOf(r)}`;
    let arr = byGroup.get(key);
    if (!arr) {
      arr = [];
      byGroup.set(key, arr);
    }
    arr.push(r);
  }
  const positions = new Map<string, number>();
  for (const group of byGroup.values()) {
    group.sort(
      (a, b) => (a.mergeQueuedAt?.getTime() ?? 0) - (b.mergeQueuedAt?.getTime() ?? 0)
    );
    group.forEach((r, i) => positions.set(r.id, i + 1));
  }
  return positions;
}

/**
 * Recompute and broadcast queue positions for every PR currently in the
 * workspace's merge queue. Call after any membership change (enqueue, dequeue,
 * merge) so the "Queued #N" badges on sibling PRs update live — otherwise a
 * single PR's `pull_request:updated` event can't move its neighbours, and the
 * counts only correct themselves on a manual list refresh.
 */
/**
 * Exactly the columns the position math + emit need. Projected so we don't
 * ship cursor columns or the `autoMergeState` blob on every queue change.
 * The `Pick` type makes `tsc` fail if this function reads a column not listed.
 */
const BROADCAST_COLUMNS = {
  id: pullRequestsTable.id,
  taskId: pullRequestsTable.taskId,
  repositoryId: pullRequestsTable.repositoryId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  mergeQueued: pullRequestsTable.mergeQueued,
  mergeQueuedAt: pullRequestsTable.mergeQueuedAt,
  lastSummary: pullRequestsTable.lastSummary,
} as const;

export async function broadcastMergeQueuePositions(workspaceId: string): Promise<void> {
  const db = getDbClient();
  const rows = await db
    .select(BROADCAST_COLUMNS)
    .from(pullRequestsTable)
    .where(
      and(
        eq(pullRequestsTable.workspaceId, workspaceId),
        eq(pullRequestsTable.mergeQueued, true),
        eq(pullRequestsTable.state, 'open')
      )
    );
  // Positions come from the ENTRIES, not from the pull_requests rows: the entry
  // table is the source of queue state, and its position is per (repo, base)
  // group — which is what the desktop renders. The rows are still needed for
  // the emit's identity fields.
  const entries = await loadActiveEntriesForWorkspace(workspaceId, db);
  // Rank only over entries whose PR is still open AND still flagged queued.
  //
  // This sweep is usually triggered the instant a PR leaves the queue — the
  // monitor sets state='merged' and calls straight into here. The entry for
  // that PR is still active at this point: it is `decide` that terminates it,
  // on the group evaluation the snapshot event triggers a moment later. Ranking
  // over the raw entry list would leave the merged PR occupying #1 and every
  // survivor one place too low, until that evaluation landed.
  const liveIds = new Set(rows.map((r) => r.id));
  const ranked = entries.filter((e) => liveIds.has(e.pullRequestId));
  const positions = computeEntryPositions(ranked);
  const entryByPr = new Map(ranked.map((e) => [e.pullRequestId, e]));

  for (const row of rows) {
    const entry = entryByPr.get(row.id);
    // A row still flagged mergeQueued with no active entry is mid-transition —
    // the entry closed and the flag has not been cleared yet. Emitting a
    // position for it would put a phantom back on the queue page.
    if (!entry) continue;
    emitPullRequestUpdated(workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: true,
      mergeQueue: toPublicMergeQueue(rowToEntrySnapshot(entry), positions.get(entry.id) ?? 0),
    });
  }
}
