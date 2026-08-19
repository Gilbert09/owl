import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// The required-ness recheck fires the authoritative by-number refresh
// (prCache.forceFetchAndUpsert). Mock it so we can assert it's invoked without
// a real GraphQL fetch.
const { mockForceFetch } = vi.hoisted(() => ({ mockForceFetch: vi.fn() }));
vi.mock('../services/prCache.js', () => ({ forceFetchAndUpsert: mockForceFetch }));

import {
  ingestCheckRun,
  pruneChecksForSha,
  parseCheckRunPayload,
  _resetRequirednessRecheck,
  _flushRequirednessRecheckTrailing,
  type CheckEventInput,
} from '../services/checkCounts.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  prCheckStates,
} from '../db/schema.js';

describe('checkCounts', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    mockForceFetch.mockReset();
    mockForceFetch.mockResolvedValue({
      summary: { blockingReason: 'checks_failed', checks: {} },
      delta: null,
      cacheMiss: true,
      rowId: 'pr-7',
    });
    _resetRequirednessRecheck();
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'A', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'r1',
      workspaceId: 'ws1',
      name: 'acme/widget',
      url: 'https://github.com/acme/widget',
      defaultBranch: 'main',
      createdAt: new Date(),
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  const ZERO = { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 };

  async function seedPr(
    number: number,
    headSha: string,
    summaryExtra: Record<string, unknown> = {},
  ) {
    await db.insert(pullRequestsTable).values({
      id: `pr-${number}`,
      workspaceId: 'ws1',
      repositoryId: 'r1',
      owner: 'acme',
      repo: 'widget',
      number,
      state: 'open',
      lastSummary: { headSha, checks: { ...ZERO }, ...summaryExtra },
    });
  }
  async function summaryOf(number: number) {
    const rows = await db
      .select({ ls: pullRequestsTable.lastSummary })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, `pr-${number}`));
    return rows[0].ls as { checks: Record<string, number>; blockingReason?: string };
  }
  const targets = [{ workspaceId: 'ws1', repositoryId: 'r1' }];
  const tracked = (nums: number[]) => new Map([['r1', new Set(nums)]]);
  const ev = (over: Partial<CheckEventInput> = {}): CheckEventInput => ({
    repoFullName: 'acme/widget',
    owner: 'acme',
    repo: 'widget',
    headSha: 'sha-A',
    name: 'lint',
    source: 'check_run',
    externalId: '1',
    state: 'success',
    ts: new Date('2026-06-16T10:00:00Z'),
    ...over,
  });
  async function checksOf(number: number) {
    const rows = await db
      .select({ ls: pullRequestsTable.lastSummary })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, `pr-${number}`));
    return (rows[0].ls as { checks: Record<string, number> }).checks;
  }

  describe('parseCheckRunPayload', () => {
    it('extracts + normalizes a completed check_run', () => {
      const parsed = parseCheckRunPayload(
        {
          check_run: {
            id: 42,
            name: 'Build',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc',
            completed_at: '2026-06-16T10:00:00Z',
          },
          repository: { owner: { login: 'Acme' }, name: 'Widget' },
        },
        'Acme/Widget',
      );
      expect(parsed).toMatchObject({
        repoFullName: 'acme/widget',
        name: 'Build',
        headSha: 'abc',
        state: 'success',
        externalId: '42',
      });
    });

    it('returns null without a name or head sha', () => {
      expect(parseCheckRunPayload({ check_run: { status: 'queued' } }, 'a/b')).toBeNull();
    });

    it.each([
      [{ status: 'in_progress' }, 'in_progress'],
      [{ status: 'queued' }, 'pending'],
      [{ status: 'completed', conclusion: 'failure' }, 'failure'],
      [{ status: 'completed', conclusion: 'skipped' }, 'skipped'],
      [{ status: 'completed', conclusion: 'success' }, 'success'],
    ])('maps %o → %s', (cr, want) => {
      const parsed = parseCheckRunPayload(
        { check_run: { name: 'x', head_sha: 's', ...cr } },
        'a/b',
      );
      expect(parsed?.state).toBe(want);
    });
  });

  describe('ingestCheckRun', () => {
    it('builds counts from check_run events for a tracked PR on the head commit', async () => {
      await seedPr(7, 'sha-A');
      const n = await ingestCheckRun(ev({ name: 'lint', state: 'success' }), targets, [7], tracked([7]));
      expect(n).toBe(1);
      expect(await checksOf(7)).toEqual({ total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 });
      await ingestCheckRun(ev({ name: 'test', state: 'success' }), targets, [7], tracked([7]));
      expect(await checksOf(7)).toEqual({ total: 2, passed: 2, failed: 0, inProgress: 0, skipped: 0 });
      await ingestCheckRun(ev({ name: 'e2e', state: 'in_progress' }), targets, [7], tracked([7]));
      expect(await checksOf(7)).toEqual({ total: 3, passed: 2, failed: 0, inProgress: 1, skipped: 0 });
    });

    it('dedupes a re-run by name (latest state wins, total unchanged)', async () => {
      await seedPr(7, 'sha-A');
      await ingestCheckRun(
        ev({ name: 'lint', state: 'success', ts: new Date('2026-06-16T10:00:00Z') }),
        targets,
        [7],
        tracked([7]),
      );
      await ingestCheckRun(
        ev({ name: 'lint', state: 'failure', ts: new Date('2026-06-16T10:05:00Z') }),
        targets,
        [7],
        tracked([7]),
      );
      expect(await checksOf(7)).toEqual({ total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 });
      expect(await db.select().from(prCheckStates)).toHaveLength(1); // one row per name
    });

    it('ignores an out-of-order older event (does not regress a check)', async () => {
      await seedPr(7, 'sha-A');
      await ingestCheckRun(
        ev({ name: 'lint', state: 'failure', ts: new Date('2026-06-16T10:05:00Z') }),
        targets,
        [7],
        tracked([7]),
      );
      // A stale 'queued' event for the same check arrives late — must not overwrite.
      await ingestCheckRun(
        ev({ name: 'lint', state: 'pending', ts: new Date('2026-06-16T10:00:00Z') }),
        targets,
        [7],
        tracked([7]),
      );
      expect(await checksOf(7)).toEqual({ total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 });
    });

    it('does not count — or store — checks on a superseded commit', async () => {
      await seedPr(7, 'sha-A'); // PR head is sha-A
      const n = await ingestCheckRun(ev({ headSha: 'sha-OLD' }), targets, [7], tracked([7]));
      expect(n).toBe(0);
      expect(await checksOf(7)).toEqual(ZERO); // unchanged
      expect(await db.select().from(prCheckStates)).toHaveLength(0); // not stored
    });

    it('ignores — and does not store — a check for an untracked PR', async () => {
      const n = await ingestCheckRun(ev(), targets, [8], tracked([])); // nothing tracked
      expect(n).toBe(0);
      expect(await db.select().from(prCheckStates)).toHaveLength(0);
    });

    it('counts a CANCELLED check as failing, not as an uncounted extra (posthog#84477)', async () => {
      // CANCELLED used to normalize to a state of its own that no bucket read,
      // so a cancelled REQUIRED check left `failed: 0` and the PR read green.
      // Driven through the payload parser so the whole chain is covered.
      await seedPr(7, 'sha-A');
      await ingestCheckRun(ev({ name: 'a', state: 'success' }), targets, [7], tracked([7]));
      const cancelled = parseCheckRunPayload(
        {
          check_run: { id: 9, name: 'shellcheck', status: 'completed', conclusion: 'cancelled', head_sha: 'sha-A' },
          repository: { owner: { login: 'acme' }, name: 'widget' },
        },
        'acme/widget',
      );
      expect(cancelled?.state).toBe('failure');
      await ingestCheckRun(cancelled!, targets, [7], tracked([7]));
      const counts = await checksOf(7);
      expect(counts).toEqual({ total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 });
      // Every check lands in exactly one bucket — the invariant whose absence
      // is what made the blocking check invisible.
      expect(counts.passed + counts.failed + counts.inProgress + counts.skipped).toBe(counts.total);
    });
  });

  describe('verdict reconciliation', () => {
    // Guards the "green Ready pill next to N failing checks" bug: the incremental
    // path patches `checks` only, so a stale verdict must be reconciled here.
    it('corrects a stale mergeable verdict to non-required failing (UNSTABLE)', async () => {
      await seedPr(7, 'sha-A', { blockingReason: 'mergeable', mergeStateStatus: 'UNSTABLE' });
      await ingestCheckRun(ev({ name: 'optional', state: 'failure' }), targets, [7], tracked([7]));
      const ls = await summaryOf(7);
      expect(ls.checks.failed).toBe(1);
      expect(ls.blockingReason).toBe('checks_failed_optional');
    });

    it('corrects a stale mergeable verdict to checks_failed when not UNSTABLE', async () => {
      await seedPr(7, 'sha-A', { blockingReason: 'mergeable', mergeStateStatus: 'BLOCKED' });
      await ingestCheckRun(ev({ name: 'gate', state: 'failure' }), targets, [7], tracked([7]));
      expect((await summaryOf(7)).blockingReason).toBe('checks_failed');
    });

    it('flips a stale checks_failed back to mergeable once the failure clears', async () => {
      await seedPr(7, 'sha-A', { blockingReason: 'checks_failed', mergeStateStatus: 'BLOCKED' });
      await ingestCheckRun(ev({ name: 'gate', state: 'success' }), targets, [7], tracked([7]));
      const ls = await summaryOf(7);
      expect(ls.checks.failed).toBe(0);
      expect(ls.blockingReason).toBe('mergeable');
    });

    it('leaves a consistent verdict (checks_failed + a live failure) untouched', async () => {
      await seedPr(7, 'sha-A', { blockingReason: 'checks_failed', mergeStateStatus: 'BLOCKED' });
      await ingestCheckRun(ev({ name: 'gate', state: 'failure' }), targets, [7], tracked([7]));
      expect((await summaryOf(7)).blockingReason).toBe('checks_failed');
    });
  });

  // The incremental path is blind to per-check `isRequired`, so a
  // `checks_failed_optional` verdict can hide a newly-failing REQUIRED check
  // (the "N non-required" bug). When the failing set changes under that verdict
  // we kick an authoritative by-number refresh to re-derive required-ness.
  describe('required-ness recheck', () => {
    it('rechecks authoritatively when a check fails under a non-required verdict', async () => {
      await seedPr(7, 'sha-A', {
        blockingReason: 'checks_failed_optional',
        mergeStateStatus: 'UNSTABLE',
      });
      await ingestCheckRun(
        ev({ name: 'Visual regression tests pass', state: 'failure' }),
        targets,
        [7],
        tracked([7]),
      );
      // Incrementally it stays "non-required"; the recheck is what corrects it.
      expect((await summaryOf(7)).blockingReason).toBe('checks_failed_optional');
      expect(mockForceFetch).toHaveBeenCalledTimes(1);
      expect(mockForceFetch).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'acme', repo: 'widget', number: 7 }),
      );
    });

    it('does not recheck when the verdict is not the non-required one', async () => {
      await seedPr(7, 'sha-A', { blockingReason: 'checks_failed', mergeStateStatus: 'BLOCKED' });
      await ingestCheckRun(ev({ name: 'gate', state: 'failure' }), targets, [7], tracked([7]));
      expect(mockForceFetch).not.toHaveBeenCalled();
    });

    it('does not recheck a clean (mergeable) PR', async () => {
      await seedPr(7, 'sha-A', { blockingReason: 'mergeable', mergeStateStatus: 'CLEAN' });
      await ingestCheckRun(ev({ name: 'lint', state: 'success' }), targets, [7], tracked([7]));
      expect(mockForceFetch).not.toHaveBeenCalled();
    });

    it('debounces repeat rechecks for the same PR within the cooldown', async () => {
      await seedPr(7, 'sha-A', {
        blockingReason: 'checks_failed_optional',
        mergeStateStatus: 'UNSTABLE',
      });
      await ingestCheckRun(ev({ name: 'a', state: 'failure' }), targets, [7], tracked([7]));
      await ingestCheckRun(ev({ name: 'b', state: 'failure' }), targets, [7], tracked([7]));
      // Only the leading recheck fires synchronously; the trailing one is parked.
      expect(mockForceFetch).toHaveBeenCalledTimes(1);
    });

    it('still rechecks the final failing set when a failure lands mid-cooldown and the suite settles', async () => {
      // The "N non-required" bug: 'a' (non-required) fails → leading recheck sees
      // only 'a'. 'b' (a REQUIRED check) fails inside the cooldown, then no more
      // events arrive. A leading-only cooldown would drop 'b' entirely; the
      // trailing fire must recheck the settled set so the required failure surfaces.
      // Both ingests land well inside the 15s cooldown, so 'b' parks a trailing
      // recheck; flush it synchronously rather than racing the real timer.
      await seedPr(7, 'sha-A', {
        blockingReason: 'checks_failed_optional',
        mergeStateStatus: 'UNSTABLE',
      });
      await ingestCheckRun(ev({ name: 'a', state: 'failure' }), targets, [7], tracked([7]));
      await ingestCheckRun(ev({ name: 'b', state: 'failure' }), targets, [7], tracked([7]));
      expect(mockForceFetch).toHaveBeenCalledTimes(1); // leading only; trailing parked
      _flushRequirednessRecheckTrailing();
      expect(mockForceFetch).toHaveBeenCalledTimes(2); // trailing recheck of settled set
    });
  });

  describe('pruneChecksForSha', () => {
    it('deletes all check state for a commit', async () => {
      await seedPr(7, 'sha-A');
      await ingestCheckRun(ev({ name: 'lint' }), targets, [7], tracked([7]));
      await ingestCheckRun(ev({ name: 'test' }), targets, [7], tracked([7]));
      expect(await db.select().from(prCheckStates)).toHaveLength(2);
      await pruneChecksForSha('acme/widget', 'sha-A');
      expect(await db.select().from(prCheckStates)).toHaveLength(0);
    });
  });
});
