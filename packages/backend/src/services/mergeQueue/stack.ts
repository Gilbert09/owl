// Merge stack: "which PR owns the branch this entry is targeting?"
//
// A stack is a chain of PRs where each one's base branch is the previous one's
// head branch. The queue's group key is (repositoryId, baseBranch), so every
// member of a stack is a group of one and nothing orders them. This resolver
// is what R4b consults to park a child behind its parent and to retarget it
// once the parent lands.
//
// The edge is DERIVED, never persisted. A parent_pull_request_id column would
// be the same class of unmaintained denormalization that let base_branch rot:
// a user retargets a PR, a parent is opened after the child was enqueued, a
// branch is renamed — and the stored edge is silently wrong. Deriving it costs
// one query per group walk, because the group key IS the base branch: every
// entry in a walk shares it.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDbClient, type Database } from '../../db/client.js';
import { pullRequests as pullRequestsTable, mergeQueueEntries } from '../../db/schema.js';
import { TERMINAL_STATUSES } from './store.js';
import type { EntryStatus } from './types.js';

type Db = Database;

/**
 * Hard bound on the climb. A stack this deep is a mistake, not a workflow, and
 * the bound is what stops a base/head cycle the visited-set somehow missed
 * from spinning the walk.
 */
const MAX_STACK_DEPTH = 16;

export interface StackParent {
  pullRequestId: string;
  number: number;
  /** The parent's head branch — equals the child's base branch (the join key). */
  headBranch: string;
  /** The parent's OWN base. This is where the child retargets to once it merges. */
  baseBranch: string;
  state: 'open' | 'closed' | 'merged';
  /** The parent's active queue entry status, or null when it isn't queued. */
  entryStatus: EntryStatus | null;
  /**
   * The branch the whole stack lands on — the base of the bottom-most
   * ancestor. Stable across every retarget (all members converge on it), which
   * is what lets the UI group a draining stack without its key churning.
   */
  targetBase: string;
  /** 1 = immediate parent. Display only. */
  depth: number;
  /** The ancestry revisits a PR — a base/head cycle. Deadlock guard. */
  cycle: boolean;
}

/** Just the fields the climb needs. Never ships the last_summary blob. */
interface PrBranchRow {
  id: string;
  number: number;
  state: string;
  headBranch: string | null;
  baseBranch: string | null;
}

async function prsByHeadBranch(
  db: Db,
  repositoryId: string,
  workspaceId: string,
  branches: string[]
): Promise<PrBranchRow[]> {
  if (branches.length === 0) return [];
  return db
    .select({
      id: pullRequestsTable.id,
      number: pullRequestsTable.number,
      state: pullRequestsTable.state,
      headBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'headBranch'`,
      baseBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'baseBranch'`,
    })
    .from(pullRequestsTable)
    .where(
      and(
        eq(pullRequestsTable.repositoryId, repositoryId),
        // Scoped by workspace as well as repo: the same repo can be tracked by
        // two workspaces, and a branch name must never link across them.
        eq(pullRequestsTable.workspaceId, workspaceId),
        inArray(sql`${pullRequestsTable.lastSummary} ->> 'headBranch'`, branches)
      )
    );
}

/** Active queue-entry status per PR id, for the PRs we resolved as parents. */
async function activeEntryStatuses(
  db: Db,
  prIds: string[]
): Promise<Map<string, EntryStatus>> {
  if (prIds.length === 0) return new Map();
  const rows = await db
    .select({
      pullRequestId: mergeQueueEntries.pullRequestId,
      status: mergeQueueEntries.status,
    })
    .from(mergeQueueEntries)
    .where(inArray(mergeQueueEntries.pullRequestId, prIds));
  const out = new Map<string, EntryStatus>();
  for (const r of rows) {
    if (TERMINAL_STATUSES.includes(r.status as EntryStatus)) continue;
    out.set(r.pullRequestId, r.status as EntryStatus);
  }
  return out;
}

function normalizeState(state: string): StackParent['state'] {
  return state === 'merged' || state === 'closed' ? state : 'open';
}

/**
 * Resolve the stack parent of each given base branch, keyed by that branch.
 * An absent key means no PR owns the branch — the entry is a stack root, or it
 * has already been retargeted onto a real base.
 *
 * The first hop is deliberately STATE-AGNOSTIC: a *merged* parent is exactly
 * what triggers the retarget, so seeding on open PRs only would break the
 * feature outright. Every hop above it follows OPEN parents only, matching
 * `linkStack` in @talyn/shared — a landed ancestor has left the stack.
 */
export async function resolveStackParents(
  repositoryId: string,
  workspaceId: string,
  baseBranches: string[],
  db: Db = getDbClient()
): Promise<Map<string, StackParent>> {
  const seeds = [...new Set(baseBranches.filter((b) => b))];
  if (seeds.length === 0) return new Map();

  const hop1 = await prsByHeadBranch(db, repositoryId, workspaceId, seeds);
  // First writer wins on a duplicate head branch, preferring an open PR — the
  // same tie-break linkStack makes, so the UI and the queue agree.
  const parentByBranch = new Map<string, PrBranchRow>();
  for (const row of hop1) {
    if (!row.headBranch) continue;
    const existing = parentByBranch.get(row.headBranch);
    if (!existing) parentByBranch.set(row.headBranch, row);
    else if (existing.state !== 'open' && row.state === 'open') {
      parentByBranch.set(row.headBranch, row);
    }
  }
  if (parentByBranch.size === 0) return new Map();

  // Climb to the bottom of each chain to learn where the stack actually lands.
  // Cached across seeds: sibling entries in one group share most of the chain.
  const openParentCache = new Map<string, PrBranchRow | null>();
  const lookupOpenParent = async (branch: string): Promise<PrBranchRow | null> => {
    if (openParentCache.has(branch)) return openParentCache.get(branch)!;
    const found = (await prsByHeadBranch(db, repositoryId, workspaceId, [branch])).find(
      (r) => r.state === 'open'
    );
    openParentCache.set(branch, found ?? null);
    return found ?? null;
  };

  const statuses = await activeEntryStatuses(
    db,
    [...parentByBranch.values()].map((p) => p.id)
  );

  const out = new Map<string, StackParent>();
  for (const [branch, parent] of parentByBranch) {
    const seen = new Set<string>([parent.id]);
    let cursor = parent;
    let depth = 1;
    let cycle = false;
    // A merged/closed parent is the bottom as far as this child is concerned:
    // it has left the stack, and its own base is where the child retargets to.
    while (cursor.state === 'open' && depth < MAX_STACK_DEPTH) {
      const next = cursor.baseBranch ? await lookupOpenParent(cursor.baseBranch) : null;
      if (!next) break;
      if (seen.has(next.id)) {
        cycle = true;
        break;
      }
      seen.add(next.id);
      cursor = next;
      depth += 1;
    }
    out.set(branch, {
      pullRequestId: parent.id,
      number: parent.number,
      headBranch: parent.headBranch ?? branch,
      baseBranch: parent.baseBranch ?? '',
      state: normalizeState(parent.state),
      entryStatus: statuses.get(parent.id) ?? null,
      targetBase: cursor.baseBranch ?? '',
      depth,
      cycle,
    });
  }
  return out;
}
