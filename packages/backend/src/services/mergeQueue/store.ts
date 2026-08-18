// Merge queue v2 — entry store: projections, CAS transitions, membership.
//
// All reads use the explicit ENTRY_COLUMNS projection (egress rules), every
// status write is a compare-and-swap on `version` (so an abandoned evaluation,
// a deploy-overlap replica, or a double-delivered webhook can never clobber a
// newer state), and every transition appends its audit event in the same
// transaction — the timeline can't lie about what happened.

import { and, asc, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDbClient } from '../../db/client.js';
import {
  mergeQueueEntries,
  mergeQueueEvents,
  pullRequests as pullRequestsTable,
  settings as settingsTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import type { ExternalQueueState, MergeQueueMode } from '@talyn/shared';
import type {
  BlockedCode,
  EntrySnapshot,
  EntryStatus,
  EventDraft,
  ExternalSubmitVia,
  FixKind,
  MergeMethod,
} from './types.js';

type Db = ReturnType<typeof getDbClient>;

export const TERMINAL_STATUSES: EntryStatus[] = ['merged', 'removed'];

// Every column the pipeline touches. The `Pick` makes the compiler enforce
// completeness: read a column not listed here and tsc fails, so the
// projection can't silently drift (same pattern as v1's QUEUE_COLUMNS).
export const ENTRY_COLUMNS = {
  id: mergeQueueEntries.id,
  pullRequestId: mergeQueueEntries.pullRequestId,
  workspaceId: mergeQueueEntries.workspaceId,
  repositoryId: mergeQueueEntries.repositoryId,
  baseBranch: mergeQueueEntries.baseBranch,
  mergeMethod: mergeQueueEntries.mergeMethod,
  status: mergeQueueEntries.status,
  blockedCode: mergeQueueEntries.blockedCode,
  blockedReason: mergeQueueEntries.blockedReason,
  enqueuedAt: mergeQueueEntries.enqueuedAt,
  headSha: mergeQueueEntries.headSha,
  fixAttempts: mergeQueueEntries.fixAttempts,
  rerunAttempts: mergeQueueEntries.rerunAttempts,
  resignAttempts: mergeQueueEntries.resignAttempts,
  submitAttempts: mergeQueueEntries.submitAttempts,
  externalSubmitVia: mergeQueueEntries.externalSubmitVia,
  externalSubmittedAt: mergeQueueEntries.externalSubmittedAt,
  externalState: mergeQueueEntries.externalState,
  fixTaskId: mergeQueueEntries.fixTaskId,
  fixTaskAccounted: mergeQueueEntries.fixTaskAccounted,
  fixKind: mergeQueueEntries.fixKind,
  stackParentNumber: mergeQueueEntries.stackParentNumber,
  retargetAttempts: mergeQueueEntries.retargetAttempts,
  signingCheckedSha: mergeQueueEntries.signingCheckedSha,
  unsignedCount: mergeQueueEntries.unsignedCount,
  automergeArmedAt: mergeQueueEntries.automergeArmedAt,
  automergeArmedBy: mergeQueueEntries.automergeArmedBy,
  pendingDisarm: mergeQueueEntries.pendingDisarm,
  mergeStartedAt: mergeQueueEntries.mergeStartedAt,
  lastError: mergeQueueEntries.lastError,
  lastErrorAt: mergeQueueEntries.lastErrorAt,
  lastEvaluatedAt: mergeQueueEntries.lastEvaluatedAt,
  version: mergeQueueEntries.version,
} as const;

export type EntryRow = Pick<
  typeof mergeQueueEntries.$inferSelect,
  keyof typeof ENTRY_COLUMNS
>;

export function rowToEntrySnapshot(row: EntryRow): EntrySnapshot {
  return {
    id: row.id,
    status: row.status as EntryStatus,
    blockedCode: (row.blockedCode as BlockedCode | null) ?? null,
    blockedReason: row.blockedReason,
    headSha: row.headSha,
    fixAttempts: row.fixAttempts,
    rerunAttempts: row.rerunAttempts,
    resignAttempts: row.resignAttempts,
    submitAttempts: row.submitAttempts,
    externalSubmitVia: (row.externalSubmitVia as ExternalSubmitVia | null) ?? null,
    externalSubmittedAt: row.externalSubmittedAt ? row.externalSubmittedAt.toISOString() : null,
    externalState: (row.externalState as ExternalQueueState | null) ?? null,
    fixTaskId: row.fixTaskId,
    fixTaskAccounted: row.fixTaskAccounted,
    fixKind: (row.fixKind as FixKind | null) ?? null,
    signingCheckedSha: row.signingCheckedSha,
    unsignedCount: row.unsignedCount,
    automergeArmedBy: (row.automergeArmedBy as 'talyn' | 'user' | null) ?? null,
    mergeMethod: (row.mergeMethod as MergeMethod) ?? 'squash',
    baseBranch: row.baseBranch,
    stackParentNumber: row.stackParentNumber,
    retargetAttempts: row.retargetAttempts,
  };
}

// ── Engine flag ──

export type MergeQueueEngine = 'v1' | 'v2';

/**
 * Which engine drives the queue. 'v1' = the poll processor; 'v2' = the
 * event-driven pipeline. Seeded by migration 0031, flipped by 0032. Read
 * per-tick / per-trigger (a single-row PK lookup) so the old deploy stops
 * driving within one tick of the cutover migration committing.
 */
export async function getMergeQueueEngine(db: Db = getDbClient()): Promise<MergeQueueEngine> {
  const rows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, 'merge_queue_engine'))
    .limit(1);
  return rows[0]?.value === 'v2' ? 'v2' : 'v1';
}

/**
 * The workspace's queue-drain mode (see WorkspaceSettings.mergeQueueMode):
 * 'ordered' (default) = FIFO, one merge in flight per (repo, base) group;
 * 'eager' = every entry is its own head, merge/fix the moment it's possible.
 * Extracts the one scalar — never ships the settings jsonb (egress rules).
 */
export async function getMergeQueueMode(
  workspaceId: string,
  db: Db = getDbClient()
): Promise<MergeQueueMode> {
  const rows = await db
    .select({
      mode: sql<string | null>`${workspacesTable.settings} ->> 'mergeQueueMode'`,
    })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return rows[0]?.mode === 'eager' ? 'eager' : 'ordered';
}

// ── Membership (route dual-write + pipeline) ──

export async function getActiveEntryForPr(
  prId: string,
  db: Db = getDbClient()
): Promise<EntryRow | null> {
  const rows = await db
    .select(ENTRY_COLUMNS)
    .from(mergeQueueEntries)
    .where(
      and(
        eq(mergeQueueEntries.pullRequestId, prId),
        notInArray(mergeQueueEntries.status, TERMINAL_STATUSES)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface EnsureEntryInput {
  pullRequestId: string;
  workspaceId: string;
  repositoryId: string;
  baseBranch: string;
  mergeMethod: MergeMethod;
  headSha: string;
  trigger: string;
}

/**
 * Enqueue: create an active entry, or RE-ARM the existing one (a re-enable of
 * an already-queued/blocked PR resets budgets and clears blocks — the v1
 * requeue semantics; the queue place is preserved via enqueuedAt). Returns
 * the active entry id.
 */
export async function ensureActiveEntry(
  input: EnsureEntryInput,
  db: Db = getDbClient()
): Promise<string> {
  const existing = await getActiveEntryForPr(input.pullRequestId, db);
  if (existing) {
    await db.transaction(async (tx) => {
      await tx
        .update(mergeQueueEntries)
        .set({
          status: 'queued',
          blockedCode: null,
          blockedReason: null,
          mergeMethod: input.mergeMethod,
          // A re-arm must re-read the base: the PR may have been retargeted
          // (by GitHub, by the user, or by the stack retarget) while the entry
          // sat blocked, and a stale group key strands it in a phantom group.
          // Only when we actually know it — a summary-less caller passing ''
          // would blank a good key, which is worse than leaving it stale.
          ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
          fixAttempts: 0,
          rerunAttempts: 0,
          resignAttempts: 0,
          submitAttempts: 0,
          externalSubmitVia: null,
          externalSubmittedAt: null,
          externalState: null,
          signingCheckedSha: null,
          unsignedCount: null,
          fixTaskAccounted: true,
          lastError: null,
          lastErrorAt: null,
          version: sql`${mergeQueueEntries.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(mergeQueueEntries.id, existing.id));
      await tx.insert(mergeQueueEvents).values({
        entryId: existing.id,
        fromStatus: existing.status,
        toStatus: 'queued',
        trigger: input.trigger,
        code: 'requeued',
        message: 'Re-armed by the user — budgets reset.',
      });
    });
    return existing.id;
  }
  const id = uuid();
  await db.transaction(async (tx) => {
    await tx.insert(mergeQueueEntries).values({
      id,
      pullRequestId: input.pullRequestId,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      baseBranch: input.baseBranch,
      mergeMethod: input.mergeMethod,
      status: 'queued',
      headSha: input.headSha,
    });
    await tx.insert(mergeQueueEvents).values({
      entryId: id,
      fromStatus: null,
      toStatus: 'queued',
      trigger: input.trigger,
      code: 'enqueued',
      message: 'Added to the merge queue.',
    });
  });
  return id;
}

/**
 * Close out the PR's active entry (dequeue, PR closed, merged externally).
 * Idempotent — a missing active entry is a no-op.
 */
export async function closeActiveEntry(
  prId: string,
  outcome: 'merged' | 'removed',
  opts: { trigger: string; message: string; code?: string },
  db: Db = getDbClient()
): Promise<EntryRow | null> {
  const existing = await getActiveEntryForPr(prId, db);
  if (!existing) return null;
  await db.transaction(async (tx) => {
    await tx
      .update(mergeQueueEntries)
      .set({
        status: outcome,
        version: sql`${mergeQueueEntries.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(mergeQueueEntries.id, existing.id));
    await tx.insert(mergeQueueEvents).values({
      entryId: existing.id,
      fromStatus: existing.status,
      toStatus: outcome,
      trigger: opts.trigger,
      code: opts.code ?? outcome,
      message: opts.message,
    });
  });
  return existing;
}

// ── CAS transitions (the pipeline's only status writer) ──

export interface CasPatch {
  status?: EntryStatus;
  /** The group key. Kept current against the PR's live base — see the
   *  reconcile-and-bail at the top of `evaluateEntry`. */
  baseBranch?: string;
  blockedCode?: BlockedCode | null;
  blockedReason?: string | null;
  headSha?: string;
  fixAttempts?: number;
  rerunAttempts?: number;
  resignAttempts?: number;
  submitAttempts?: number;
  externalSubmitVia?: ExternalSubmitVia | null;
  externalSubmittedAt?: Date | null;
  externalState?: ExternalQueueState | null;
  externalStateAt?: Date | null;
  fixTaskId?: string | null;
  fixTaskAccounted?: boolean;
  fixKind?: FixKind | null;
  signingCheckedSha?: string | null;
  unsignedCount?: number | null;
  stackParentNumber?: number | null;
  retargetAttempts?: number;
  automergeArmedAt?: Date | null;
  automergeArmedBy?: 'talyn' | 'user' | null;
  pendingDisarm?: boolean;
  mergeStartedAt?: Date | null;
  lastError?: string | null;
  lastErrorAt?: Date | null;
  lastEvaluatedAt?: Date;
}

export interface CasEvent extends EventDraft {
  trigger: string;
  fromStatus: string | null;
  toStatus: string;
}

/**
 * Compare-and-swap update: applies `patch` and appends `event` atomically,
 * but ONLY if the entry's `version` still matches. Returns false when someone
 * else transitioned first — the caller must drop its remaining actions and
 * re-schedule (this is what makes an abandoned timed-out evaluation, the
 * deploy-overlap replica, and a double-delivered webhook all harmless).
 */
export async function casTransition(
  entryId: string,
  expectedVersion: number,
  patch: CasPatch,
  event: CasEvent | null,
  db: Db = getDbClient()
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(mergeQueueEntries)
      .set({
        ...patch,
        version: sql`${mergeQueueEntries.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(mergeQueueEntries.id, entryId), eq(mergeQueueEntries.version, expectedVersion))
      )
      .returning({ id: mergeQueueEntries.id });
    if (updated.length === 0) return false;
    if (event) {
      await tx.insert(mergeQueueEvents).values({
        entryId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        trigger: event.trigger,
        code: event.code,
        message: event.message,
        detail: event.detail ?? null,
      });
    }
    return true;
  });
}

/** Append a non-transition audit event (probe results, deferrals, …). */
export async function appendEntryEvent(
  entryId: string,
  status: string,
  event: EventDraft & { trigger: string },
  db: Db = getDbClient()
): Promise<void> {
  await db.insert(mergeQueueEvents).values({
    entryId,
    fromStatus: status,
    toStatus: status,
    trigger: event.trigger,
    code: event.code,
    message: event.message,
    detail: event.detail ?? null,
  });
}

/**
 * The PR's head branch, straight off the summary jsonb. Projection-only — the
 * blob never ships. The fallback for the stack-advance trigger when the domain
 * event didn't carry it.
 */
export async function headBranchOfPr(prId: string, db: Db = getDbClient()): Promise<string | null> {
  const rows = await db
    .select({
      headBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'headBranch'`,
    })
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, prId))
    .limit(1);
  return rows[0]?.headBranch ?? null;
}

// ── Group loading + positions ──

/** Active entries of one (repo, base) group, FIFO — head first. */
export async function loadActiveGroup(
  repositoryId: string,
  baseBranch: string,
  db: Db = getDbClient()
): Promise<EntryRow[]> {
  return db
    .select(ENTRY_COLUMNS)
    .from(mergeQueueEntries)
    .where(
      and(
        eq(mergeQueueEntries.repositoryId, repositoryId),
        eq(mergeQueueEntries.baseBranch, baseBranch),
        notInArray(mergeQueueEntries.status, TERMINAL_STATUSES)
      )
    )
    .orderBy(asc(mergeQueueEntries.enqueuedAt));
}

/** All active entries in a workspace, FIFO — for position broadcasts. */
export async function loadActiveEntriesForWorkspace(
  workspaceId: string,
  db: Db = getDbClient()
): Promise<EntryRow[]> {
  return db
    .select(ENTRY_COLUMNS)
    .from(mergeQueueEntries)
    .where(
      and(
        eq(mergeQueueEntries.workspaceId, workspaceId),
        notInArray(mergeQueueEntries.status, TERMINAL_STATUSES)
      )
    )
    .orderBy(asc(mergeQueueEntries.enqueuedAt));
}

/** Cheap indexed existence probe — does this (repo, base) group have entries? */
export async function hasActiveEntries(
  repositoryId: string,
  baseBranch: string,
  db: Db = getDbClient()
): Promise<boolean> {
  const rows = await db
    .select({ id: mergeQueueEntries.id })
    .from(mergeQueueEntries)
    .where(
      and(
        eq(mergeQueueEntries.repositoryId, repositoryId),
        eq(mergeQueueEntries.baseBranch, baseBranch),
        notInArray(mergeQueueEntries.status, TERMINAL_STATUSES)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** Active entries for a batch of PR ids (the pr:checks trigger fan-in). */
export async function getActiveEntriesForPrs(
  prIds: string[],
  db: Db = getDbClient()
): Promise<EntryRow[]> {
  if (prIds.length === 0) return [];
  return db
    .select(ENTRY_COLUMNS)
    .from(mergeQueueEntries)
    .where(
      and(
        inArray(mergeQueueEntries.pullRequestId, prIds),
        notInArray(mergeQueueEntries.status, TERMINAL_STATUSES)
      )
    );
}

/** Active entries whose queue-owned fix run is this task (task:status trigger). */
export async function getActiveEntriesByFixTask(
  taskId: string,
  db: Db = getDbClient()
): Promise<EntryRow[]> {
  return db
    .select(ENTRY_COLUMNS)
    .from(mergeQueueEntries)
    .where(
      and(
        eq(mergeQueueEntries.fixTaskId, taskId),
        notInArray(mergeQueueEntries.status, TERMINAL_STATUSES)
      )
    );
}

/** Stamp last_evaluated_at on a walked group (the reconciler's staleness cue). */
export async function touchEvaluated(entryIds: string[], db: Db = getDbClient()): Promise<void> {
  if (entryIds.length === 0) return;
  await db
    .update(mergeQueueEntries)
    .set({ lastEvaluatedAt: new Date() })
    .where(inArray(mergeQueueEntries.id, entryIds));
}

/**
 * Reconciler scans: active entries that need attention — a `merging` marker
 * older than `mergingStaleMs` (crashed mid-merge), or anything not evaluated
 * within `evaluatedStaleMs` (dropped webhook / gated deferral / crash).
 * Returns the distinct group keys to re-evaluate.
 */
export async function loadStaleGroups(
  opts: { mergingStaleMs: number; evaluatedStaleMs: number },
  db: Db = getDbClient()
): Promise<Array<{ repositoryId: string; baseBranch: string }>> {
  const now = Date.now();
  const rows = await db
    .select({
      repositoryId: mergeQueueEntries.repositoryId,
      baseBranch: mergeQueueEntries.baseBranch,
    })
    .from(mergeQueueEntries)
    .where(
      and(
        notInArray(mergeQueueEntries.status, TERMINAL_STATUSES),
        or(
          and(
            eq(mergeQueueEntries.status, 'merging'),
            lt(mergeQueueEntries.mergeStartedAt, new Date(now - opts.mergingStaleMs))
          ),
          isNull(mergeQueueEntries.lastEvaluatedAt),
          lt(mergeQueueEntries.lastEvaluatedAt, new Date(now - opts.evaluatedStaleMs))
        )
      )
    );
  const seen = new Set<string>();
  const groups: Array<{ repositoryId: string; baseBranch: string }> = [];
  for (const row of rows) {
    const key = `${row.repositoryId}|${row.baseBranch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(row);
  }
  return groups;
}

/** Delete terminal entries older than `days` (their events cascade). */
export async function pruneTerminalEntries(days: number, db: Db = getDbClient()): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(mergeQueueEntries)
    .where(
      and(
        inArray(mergeQueueEntries.status, TERMINAL_STATUSES),
        lt(mergeQueueEntries.updatedAt, cutoff)
      )
    )
    .returning({ id: mergeQueueEntries.id });
  return deleted.length;
}

/**
 * 1-based position per entry within its (repo, base) group. Input must be
 * FIFO-ordered (the loaders above are). Keyed by entry id.
 */
export function computeEntryPositions(
  entries: Array<Pick<EntryRow, 'id' | 'repositoryId' | 'baseBranch'>>
): Map<string, number> {
  const counters = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.repositoryId}|${entry.baseBranch}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    positions.set(entry.id, next);
  }
  return positions;
}
