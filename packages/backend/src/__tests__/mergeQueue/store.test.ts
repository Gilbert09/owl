// Store-layer tests for merge queue v2: CAS transition semantics, membership
// helpers, the engine flag, position math, and the 0031 backfill mapping
// (re-run against seeded legacy blobs — the migration is idempotent by
// construction, so executing its INSERT again pins the exact shipped SQL).

import fs from 'fs';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  mergeQueueEntries,
  mergeQueueEvents,
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  settings as settingsTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import {
  casTransition,
  closeActiveEntry,
  computeEntryPositions,
  ensureActiveEntry,
  getActiveEntryForPr,
  getMergeQueueEngine,
  loadActiveGroup,
} from '../../services/mergeQueue/store.js';
import { resolveStackParents } from '../../services/mergeQueue/stack.js';

const MIGRATION_0031 = path.resolve(
  __dirname,
  '../../db/migrations/0031_merge_queue_entries.sql'
);
const MIGRATION_0032 = path.resolve(
  __dirname,
  '../../db/migrations/0032_merge_queue_cutover.sql'
);

describe('mergeQueue store', () => {
  let db: Database;
  let pglite: Awaited<ReturnType<typeof createTestDb>>['pglite'];
  let cleanup: () => Promise<void>;
  let prSeq = 0;

  async function insertPr(opts: {
    queued?: boolean;
    state?: string;
    mergeQueueState?: Record<string, unknown> | null;
    lastSummary?: Record<string, unknown>;
  } = {}): Promise<string> {
    const id = `pr-${++prSeq}`;
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      taskId: null,
      owner: 'a',
      repo: 'b',
      number: prSeq,
      state: opts.state ?? 'open',
      mergeQueued: opts.queued ?? false,
      mergeQueuedAt: opts.queued ? new Date() : null,
      mergeMethod: 'squash',
      mergeQueueState: opts.mergeQueueState ?? null,
      lastPolledAt: new Date(),
      lastSummary: opts.lastSummary ?? { baseBranch: 'main', headSha: 'sha1' },
    });
    return id;
  }

  /** A PR with explicit head/base branches, for the stack-resolver cases. */
  async function insertBranchPr(opts: {
    head: string;
    base: string;
    state?: string;
    repositoryId?: string;
    workspaceId?: string;
  }): Promise<string> {
    const id = `pr-${++prSeq}`;
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: opts.workspaceId ?? 'ws1',
      repositoryId: opts.repositoryId ?? 'repo1',
      taskId: null,
      owner: 'a',
      repo: 'b',
      number: prSeq,
      state: opts.state ?? 'open',
      mergeQueued: false,
      mergeMethod: 'squash',
      lastPolledAt: new Date(),
      lastSummary: { headBranch: opts.head, baseBranch: opts.base, headSha: `sha-${id}` },
    });
    return id;
  }

  function enqueueInput(prId: string) {
    return {
      pullRequestId: prId,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      baseBranch: 'main',
      mergeMethod: 'squash' as const,
      headSha: 'sha1',
      trigger: 'user:enqueue',
    };
  }

  beforeEach(async () => {
    ({ db, pglite, cleanup } = await createTestDb());
    prSeq = 0;
    await seedUser(db);
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws1',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('engine flag', () => {
    it('reads v2 after the cutover migration (0032 flips the 0031 seed)', async () => {
      expect(await getMergeQueueEngine(db)).toBe('v2');
    });

    it('reads v1 when rolled back', async () => {
      await db
        .update(settingsTable)
        .set({ value: 'v1' })
        .where(eq(settingsTable.key, 'merge_queue_engine'));
      expect(await getMergeQueueEngine(db)).toBe('v1');
    });
  });

  describe('membership', () => {
    it('creates a fresh entry with an enqueued audit event', async () => {
      const prId = await insertPr();
      const entryId = await ensureActiveEntry(enqueueInput(prId), db);
      const entry = await getActiveEntryForPr(prId, db);
      expect(entry?.id).toBe(entryId);
      expect(entry?.status).toBe('queued');
      expect(entry?.headSha).toBe('sha1');
      const events = await db
        .select()
        .from(mergeQueueEvents)
        .where(eq(mergeQueueEvents.entryId, entryId));
      expect(events).toHaveLength(1);
      expect(events[0]!.code).toBe('enqueued');
      expect(events[0]!.trigger).toBe('user:enqueue');
    });

    it('re-arms an existing active entry instead of duplicating (budgets reset, place kept)', async () => {
      const prId = await insertPr();
      const entryId = await ensureActiveEntry(enqueueInput(prId), db);
      await db
        .update(mergeQueueEntries)
        .set({
          status: 'blocked',
          blockedCode: 'attempts_exhausted',
          blockedReason: 'x',
          fixAttempts: 3,
          version: 5,
        })
        .where(eq(mergeQueueEntries.id, entryId));

      const again = await ensureActiveEntry(enqueueInput(prId), db);
      expect(again).toBe(entryId);
      const entry = await getActiveEntryForPr(prId, db);
      expect(entry?.status).toBe('queued');
      expect(entry?.blockedCode).toBeNull();
      expect(entry?.fixAttempts).toBe(0);
      expect(entry?.version).toBe(6); // CAS-visible bump
    });

    it('closes the active entry and is idempotent', async () => {
      const prId = await insertPr();
      await ensureActiveEntry(enqueueInput(prId), db);
      const closed = await closeActiveEntry(
        prId,
        'removed',
        { trigger: 'user:dequeue', message: 'gone' },
        db
      );
      expect(closed).not.toBeNull();
      expect(await getActiveEntryForPr(prId, db)).toBeNull();
      // second close is a no-op
      expect(
        await closeActiveEntry(prId, 'removed', { trigger: 'user:dequeue', message: 'gone' }, db)
      ).toBeNull();
    });

    it('a re-queue after close mints a FRESH entry (terminal row retained as history)', async () => {
      const prId = await insertPr();
      const first = await ensureActiveEntry(enqueueInput(prId), db);
      await closeActiveEntry(prId, 'removed', { trigger: 'user:dequeue', message: 'gone' }, db);
      const second = await ensureActiveEntry(enqueueInput(prId), db);
      expect(second).not.toBe(first);
      const all = await db
        .select({ id: mergeQueueEntries.id })
        .from(mergeQueueEntries)
        .where(eq(mergeQueueEntries.pullRequestId, prId));
      expect(all).toHaveLength(2);
    });
  });

  describe('casTransition', () => {
    it('applies the patch, bumps version, and appends the event atomically', async () => {
      const prId = await insertPr();
      const entryId = await ensureActiveEntry(enqueueInput(prId), db);
      const before = (await getActiveEntryForPr(prId, db))!;

      const ok = await casTransition(
        entryId,
        before.version,
        { status: 'fixing', fixTaskId: null, fixTaskAccounted: false },
        {
          trigger: 'webhook:pull_request',
          fromStatus: 'queued',
          toStatus: 'fixing',
          code: 'fix_run_fired',
          message: 'Fix run dispatched.',
        },
        db
      );
      expect(ok).toBe(true);
      const after = (await getActiveEntryForPr(prId, db))!;
      expect(after.status).toBe('fixing');
      expect(after.version).toBe(before.version + 1);
      const events = await db
        .select()
        .from(mergeQueueEvents)
        .where(eq(mergeQueueEvents.entryId, entryId));
      expect(events.map((e) => e.code)).toContain('fix_run_fired');
    });

    it('a stale version loses: no write, no event', async () => {
      const prId = await insertPr();
      const entryId = await ensureActiveEntry(enqueueInput(prId), db);
      const before = (await getActiveEntryForPr(prId, db))!;

      const ok = await casTransition(
        entryId,
        before.version + 41, // stale/wrong
        { status: 'merging' },
        {
          trigger: 'reconcile',
          fromStatus: 'queued',
          toStatus: 'merging',
          code: 'x',
          message: 'x',
        },
        db
      );
      expect(ok).toBe(false);
      const after = (await getActiveEntryForPr(prId, db))!;
      expect(after.status).toBe('queued');
      expect(after.version).toBe(before.version);
      const events = await db
        .select()
        .from(mergeQueueEvents)
        .where(eq(mergeQueueEvents.entryId, entryId));
      expect(events.map((e) => e.code)).not.toContain('x');
    });
  });

  describe('groups and positions', () => {
    it('loads a group FIFO and numbers positions per (repo, base) group', async () => {
      const a = await insertPr();
      const b = await insertPr();
      const c = await insertPr();
      await ensureActiveEntry(enqueueInput(a), db);
      await ensureActiveEntry(enqueueInput(b), db);
      await ensureActiveEntry({ ...enqueueInput(c), baseBranch: 'develop' }, db);

      const group = await loadActiveGroup('repo1', 'main', db);
      expect(group.map((e) => e.pullRequestId)).toEqual([a, b]);

      const positions = computeEntryPositions([
        ...group,
        ...(await loadActiveGroup('repo1', 'develop', db)),
      ]);
      expect([...positions.values()]).toEqual([1, 2, 1]);
    });
  });

  describe('0031 backfill (re-run against seeded legacy blobs)', () => {
    async function runBackfill(): Promise<void> {
      const sqlText = fs.readFileSync(MIGRATION_0031, 'utf-8');
      const backfill = sqlText
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .find((s) => s.includes('INSERT INTO "merge_queue_entries"'));
      expect(backfill).toBeTruthy();
      await pglite.exec(backfill!);
    }

    it('maps every legacy status × mergeForbidden variant', async () => {
      const waiting = await insertPr({
        queued: true,
        mergeQueueState: { status: 'waiting', attempts: 1, accounted: true },
      });
      const fixing = await insertPr({
        queued: true,
        mergeQueueState: { status: 'fixing', attempts: 2, accounted: false },
      });
      const merging = await insertPr({
        queued: true,
        mergeQueueState: { status: 'merging', attempts: 0, accounted: true },
      });
      const blockedPlain = await insertPr({
        queued: true,
        mergeQueueState: { status: 'blocked', attempts: 3, blockReason: 'merge conflicts' },
      });
      const blockedHard = await insertPr({
        queued: true,
        mergeQueueState: { status: 'blocked', mergeForbidden: 'hard', blockReason: 'refused' },
      });
      const blockedChecks = await insertPr({
        queued: true,
        mergeQueueState: {
          status: 'blocked',
          mergeForbidden: 'failing-checks',
          rerunAttempts: 3,
          blockReason: 'checks',
        },
      });
      const blockedUnsigned = await insertPr({
        queued: true,
        mergeQueueState: { status: 'blocked', mergeForbidden: 'unsigned-commits', resignAttempts: 3 },
      });
      const blockedDraft = await insertPr({
        queued: true,
        mergeQueueState: {
          status: 'blocked',
          blockReason: 'This PR is a draft — mark it ready for review and the merge queue will merge it automatically.',
        },
      });
      // Not eligible: unqueued, and queued-but-closed.
      await insertPr({ queued: false });
      await insertPr({ queued: true, state: 'merged' });

      await runBackfill();

      const byPr = new Map(
        (await db.select().from(mergeQueueEntries)).map((e) => [e.pullRequestId, e])
      );
      expect(byPr.size).toBe(8);
      expect(byPr.get(waiting)).toMatchObject({ status: 'queued', fixAttempts: 1, headSha: 'sha1', baseBranch: 'main' });
      expect(byPr.get(fixing)).toMatchObject({ status: 'fixing', fixAttempts: 2, fixTaskAccounted: false });
      expect(byPr.get(merging)).toMatchObject({ status: 'merging' });
      expect(byPr.get(blockedPlain)).toMatchObject({
        status: 'blocked',
        blockedCode: 'attempts_exhausted',
        blockedReason: 'merge conflicts',
        fixAttempts: 3,
      });
      expect(byPr.get(blockedHard)).toMatchObject({ status: 'blocked_manual', blockedCode: 'app_refused_hard' });
      expect(byPr.get(blockedChecks)).toMatchObject({
        status: 'blocked',
        blockedCode: 'app_refused_checks',
        rerunAttempts: 3,
      });
      expect(byPr.get(blockedUnsigned)).toMatchObject({
        status: 'blocked',
        blockedCode: 'unsigned_commits',
        resignAttempts: 3,
      });
      expect(byPr.get(blockedDraft)).toMatchObject({ status: 'blocked', blockedCode: 'draft' });
    });

    it('is idempotent — a re-run adds nothing on top of existing active entries', async () => {
      const prId = await insertPr({
        queued: true,
        mergeQueueState: { status: 'waiting', attempts: 0, accounted: true },
      });
      await runBackfill();
      await runBackfill();
      const rows = await db
        .select({ id: mergeQueueEntries.id })
        .from(mergeQueueEntries)
        .where(eq(mergeQueueEntries.pullRequestId, prId));
      expect(rows).toHaveLength(1);
    });
  });

  describe('0032 cutover re-sync (re-run against seeded dual-write drift)', () => {
    async function runCutover(): Promise<void> {
      const sqlText = fs.readFileSync(MIGRATION_0032, 'utf-8');
      for (const stmt of sqlText.split('--> statement-breakpoint')) {
        const trimmed = stmt.trim();
        if (trimmed) await pglite.exec(trimmed);
      }
    }

    it('converges every drift direction, then flips the flag', async () => {
      // Simulate the pre-cutover state the boot migrator sees.
      await db
        .update(settingsTable)
        .set({ value: 'v1' })
        .where(eq(settingsTable.key, 'merge_queue_engine'));

      // Drift 1: entry active but v1 merged the PR (mirror cleared).
      const mergedPr = await insertPr({ queued: false, state: 'merged' });
      await ensureActiveEntry(enqueueInput(mergedPr), db);
      // Drift 2: entry active but the user dequeued through a v1-only path.
      const dequeuedPr = await insertPr({ queued: false });
      await ensureActiveEntry(enqueueInput(dequeuedPr), db);
      // Drift 3: entry stale vs the authoritative v1 blob (blocked hard).
      const stalePr = await insertPr({
        queued: true,
        mergeQueueState: {
          status: 'blocked',
          mergeForbidden: 'hard',
          attempts: 3,
          blockReason: 'refused',
        },
      });
      await ensureActiveEntry(enqueueInput(stalePr), db);
      // Drift 4: queued PR with no entry at all (missed dual-write).
      const missingPr = await insertPr({
        queued: true,
        mergeQueueState: { status: 'fixing', attempts: 1, accounted: false },
      });

      await runCutover();

      const byPr = new Map(
        (await db.select().from(mergeQueueEntries)).map((e) => [e.pullRequestId, e])
      );
      expect(byPr.get(mergedPr)?.status).toBe('merged');
      expect(byPr.get(dequeuedPr)?.status).toBe('removed');
      expect(byPr.get(stalePr)).toMatchObject({
        status: 'blocked_manual',
        blockedCode: 'app_refused_hard',
        blockedReason: 'refused',
        fixAttempts: 3,
      });
      expect(byPr.get(missingPr)).toMatchObject({ status: 'fixing', fixAttempts: 1 });
      expect(await getMergeQueueEngine(db)).toBe('v2');
    });

    it('is idempotent — a second run converges to the same state', async () => {
      const prId = await insertPr({
        queued: true,
        mergeQueueState: { status: 'waiting', attempts: 2, accounted: true },
      });
      await ensureActiveEntry(enqueueInput(prId), db);
      await runCutover();
      await runCutover();
      const rows = await db
        .select()
        .from(mergeQueueEntries)
        .where(eq(mergeQueueEntries.pullRequestId, prId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'queued', fixAttempts: 2 });
    });
  });

  // The stack parent edge is derived per walk, never persisted — a stored edge
  // would rot the way base_branch did. These pin the derivation.
  describe('resolveStackParents', () => {
    it('resolves the open PR whose head is the queried base branch', async () => {
      const parent = await insertBranchPr({ head: 'feat-a', base: 'main' });
      await insertBranchPr({ head: 'feat-b', base: 'feat-a' });

      const got = await resolveStackParents('repo1', 'ws1', ['feat-a'], db);

      expect(got.get('feat-a')).toMatchObject({
        pullRequestId: parent,
        baseBranch: 'main',
        state: 'open',
        targetBase: 'main',
        depth: 1,
        cycle: false,
      });
    });

    it('resolves a MERGED parent — that is what triggers the retarget', async () => {
      // Seeding on open PRs only would break the feature outright: the child
      // is retargeted precisely because its parent has landed.
      await insertBranchPr({ head: 'feat-a', base: 'main', state: 'merged' });

      const got = await resolveStackParents('repo1', 'ws1', ['feat-a'], db);

      expect(got.get('feat-a')).toMatchObject({ state: 'merged', baseBranch: 'main' });
    });

    it('resolves a CLOSED parent, so an abandoned stack can be reported', async () => {
      await insertBranchPr({ head: 'feat-a', base: 'main', state: 'closed' });

      const got = await resolveStackParents('repo1', 'ws1', ['feat-a'], db);

      expect(got.get('feat-a')?.state).toBe('closed');
    });

    it('climbs to the bottom of the chain for targetBase', async () => {
      // main <- A <- B <- C. Asking about C's base must report main, not feat-a:
      // targetBase is where the whole stack lands, and it is the group identity
      // the UI needs to stay stable while the stack drains.
      await insertBranchPr({ head: 'feat-a', base: 'main' });
      await insertBranchPr({ head: 'feat-b', base: 'feat-a' });
      await insertBranchPr({ head: 'feat-c', base: 'feat-b' });

      const got = await resolveStackParents('repo1', 'ws1', ['feat-c'], db);

      expect(got.get('feat-c')).toMatchObject({ targetBase: 'main', depth: 3 });
    });

    it('stops climbing at a landed ancestor — it has left the stack', async () => {
      await insertBranchPr({ head: 'feat-a', base: 'main', state: 'merged' });
      await insertBranchPr({ head: 'feat-b', base: 'feat-a' });

      const got = await resolveStackParents('repo1', 'ws1', ['feat-b'], db);

      expect(got.get('feat-b')).toMatchObject({ targetBase: 'feat-a', depth: 1 });
    });

    it('reports a base/head cycle instead of climbing forever', async () => {
      await insertBranchPr({ head: 'feat-x', base: 'feat-y' });
      await insertBranchPr({ head: 'feat-y', base: 'feat-x' });

      const got = await resolveStackParents('repo1', 'ws1', ['feat-x'], db);

      expect(got.get('feat-x')?.cycle).toBe(true);
    });

    it('returns no entry for a branch no PR owns (a stack root)', async () => {
      await insertBranchPr({ head: 'feat-a', base: 'main' });

      const got = await resolveStackParents('repo1', 'ws1', ['main'], db);

      expect(got.has('main')).toBe(false);
    });

    it('never links across repositories with the same branch name', async () => {
      await db.insert(repositoriesTable).values({
        id: 'repo2',
        workspaceId: 'ws1',
        name: 'c',
        url: 'https://github.com/a/c',
        defaultBranch: 'main',
      });
      await insertBranchPr({ head: 'feat-a', base: 'main', repositoryId: 'repo2' });

      expect((await resolveStackParents('repo1', 'ws1', ['feat-a'], db)).size).toBe(0);
    });

    it('never links across workspaces tracking the same repo', async () => {
      await db.insert(workspacesTable).values({
        id: 'ws2',
        ownerId: TEST_USER_ID,
        name: 'ws2',
        settings: {},
      });
      await insertBranchPr({ head: 'feat-a', base: 'main', workspaceId: 'ws2' });

      expect((await resolveStackParents('repo1', 'ws1', ['feat-a'], db)).size).toBe(0);
    });

    it('prefers the open PR when two share a head branch', async () => {
      await insertBranchPr({ head: 'feat-a', base: 'old-base', state: 'closed' });
      const open = await insertBranchPr({ head: 'feat-a', base: 'main' });

      const got = await resolveStackParents('repo1', 'ws1', ['feat-a'], db);

      expect(got.get('feat-a')?.pullRequestId).toBe(open);
    });

    it('carries the parent active queue-entry status, and drops terminal ones', async () => {
      const parent = await insertBranchPr({ head: 'feat-a', base: 'main' });
      await ensureActiveEntry({ ...enqueueInput(parent), baseBranch: 'main' }, db);

      const queued = await resolveStackParents('repo1', 'ws1', ['feat-a'], db);
      expect(queued.get('feat-a')?.entryStatus).toBe('queued');

      await closeActiveEntry(parent, 'merged', { trigger: 't', message: 'm' }, db);
      const done = await resolveStackParents('repo1', 'ws1', ['feat-a'], db);
      expect(done.get('feat-a')?.entryStatus).toBeNull();
    });

    it('ignores empty seed branches rather than matching every blank summary', async () => {
      await insertBranchPr({ head: '', base: 'main' });

      expect((await resolveStackParents('repo1', 'ws1', [''], db)).size).toBe(0);
    });
  });
});
