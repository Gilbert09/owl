import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { prMonitorService, createRestSweepCache } from '../services/prMonitor.js';
import { githubService } from '../services/github.js';
import * as websocketModule from '../services/websocket.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';

/**
 * The reconcile sweep's REST-only closed-PR pass (`sweepClosedViaRest`) — the
 * safety net that still runs when the full GraphQL sweep is deferred on a
 * budget-reserve account. A merged/closed PR whose webhook delivery was
 * dropped must leave the open list without a manual refresh, and the pass
 * must never close a row on missing/ambiguous data.
 */
describe('sweepClosedViaRest', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  const prRow = (over: Partial<typeof pullRequestsTable.$inferInsert> = {}) => ({
    id: `pr-${over.number ?? 1}-${over.workspaceId ?? 'ws1'}`,
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    owner: 'acme',
    repo: 'widgets',
    number: 1,
    state: 'open',
    authored: true,
    reviewRequested: false,
    lastPolledAt: new Date(),
    lastSummary: { title: 'x' },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'm', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo1', workspaceId: 'ws1', name: 'acme/widgets',
      url: 'https://github.com/acme/widgets', defaultBranch: 'main', createdAt: new Date(),
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function rowFor(workspaceId: string, number: number) {
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(and(eq(pullRequestsTable.workspaceId, workspaceId), eq(pullRequestsTable.number, number)));
    return rows[0];
  }

  it('closes a merged row (state, mergedAt, queue reset) and broadcasts the departure', async () => {
    await db.insert(pullRequestsTable).values(prRow({ number: 7, mergeQueued: true, mergeQueuedAt: new Date() }));
    vi.spyOn(githubService, 'listOpenPullRequestNumbers').mockResolvedValue([2, 3]);
    vi.spyOn(githubService, 'getPullRequest').mockResolvedValue({
      number: 7, state: 'closed', merged_at: '2026-07-02T08:51:33Z',
    } as never);
    const emitSpy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');

    const closed = await prMonitorService.sweepClosedViaRest('ws1', createRestSweepCache());

    expect(closed).toBe(1);
    const row = await rowFor('ws1', 7);
    expect(row?.state).toBe('merged');
    expect(row?.mergedAt?.toISOString()).toBe('2026-07-02T08:51:33.000Z');
    expect(row?.mergeQueued).toBe(false); // queue bookkeeping cleared in the same write
    expect(emitSpy).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ number: 7, state: 'merged', mergeQueued: false })
    );
  });

  it('marks a closed-without-merge row as closed with no mergedAt', async () => {
    await db.insert(pullRequestsTable).values(prRow({ number: 8 }));
    vi.spyOn(githubService, 'listOpenPullRequestNumbers').mockResolvedValue([]);
    vi.spyOn(githubService, 'getPullRequest').mockResolvedValue({
      number: 8, state: 'closed', merged_at: null,
    } as never);

    await prMonitorService.sweepClosedViaRest('ws1', createRestSweepCache());

    const row = await rowFor('ws1', 8);
    expect(row?.state).toBe('closed');
    expect(row?.mergedAt).toBeNull();
  });

  it('makes NO per-PR lookups when every tracked row is still on the open list', async () => {
    await db.insert(pullRequestsTable).values([prRow({ number: 1 }), prRow({ number: 2 })]);
    vi.spyOn(githubService, 'listOpenPullRequestNumbers').mockResolvedValue([1, 2, 99]);
    const lookupSpy = vi.spyOn(githubService, 'getPullRequest');

    const closed = await prMonitorService.sweepClosedViaRest('ws1', createRestSweepCache());

    expect(closed).toBe(0);
    expect(lookupSpy).not.toHaveBeenCalled();
    expect((await rowFor('ws1', 1))?.state).toBe('open');
  });

  it('never closes rows when the open-list fetch fails', async () => {
    await db.insert(pullRequestsTable).values(prRow({ number: 9 }));
    vi.spyOn(githubService, 'listOpenPullRequestNumbers').mockRejectedValue(new Error('rate-limited'));
    const lookupSpy = vi.spyOn(githubService, 'getPullRequest');

    const closed = await prMonitorService.sweepClosedViaRest('ws1', createRestSweepCache());

    expect(closed).toBe(0);
    expect(lookupSpy).not.toHaveBeenCalled();
    expect((await rowFor('ws1', 9))?.state).toBe('open');
  });

  it('leaves a row open when the direct lookup says the PR is still open (list pagination race)', async () => {
    await db.insert(pullRequestsTable).values(prRow({ number: 10 }));
    vi.spyOn(githubService, 'listOpenPullRequestNumbers').mockResolvedValue([]);
    vi.spyOn(githubService, 'getPullRequest').mockResolvedValue({
      number: 10, state: 'open', merged_at: null,
    } as never);

    const closed = await prMonitorService.sweepClosedViaRest('ws1', createRestSweepCache());

    expect(closed).toBe(0);
    expect((await rowFor('ws1', 10))?.state).toBe('open');
  });

  it('leaves a row open when the direct lookup fails (retry next tick, never close unconfirmed)', async () => {
    await db.insert(pullRequestsTable).values(prRow({ number: 11 }));
    vi.spyOn(githubService, 'listOpenPullRequestNumbers').mockResolvedValue([]);
    vi.spyOn(githubService, 'getPullRequest').mockRejectedValue(new Error('502'));

    const closed = await prMonitorService.sweepClosedViaRest('ws1', createRestSweepCache());

    expect(closed).toBe(0);
    expect((await rowFor('ws1', 11))?.state).toBe('open');
  });

  it('shares ONE open-list fetch and ONE per-PR lookup across workspaces via the tick cache', async () => {
    await db.insert(workspacesTable).values({ id: 'ws2', ownerId: TEST_USER_ID, name: 'n', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo2', workspaceId: 'ws2', name: 'acme/widgets',
      url: 'https://github.com/acme/widgets', defaultBranch: 'main', createdAt: new Date(),
    });
    await db.insert(pullRequestsTable).values([
      prRow({ number: 7 }),
      prRow({ number: 7, workspaceId: 'ws2', repositoryId: 'repo2' }),
    ]);
    const listSpy = vi
      .spyOn(githubService, 'listOpenPullRequestNumbers')
      .mockResolvedValue([]);
    const lookupSpy = vi.spyOn(githubService, 'getPullRequest').mockResolvedValue({
      number: 7, state: 'closed', merged_at: '2026-07-02T08:51:33Z',
    } as never);

    const cache = createRestSweepCache();
    const closed1 = await prMonitorService.sweepClosedViaRest('ws1', cache);
    const closed2 = await prMonitorService.sweepClosedViaRest('ws2', cache);

    expect(closed1 + closed2).toBe(2); // each workspace's own row closes...
    expect(listSpy).toHaveBeenCalledTimes(1); // ...off ONE shared list fetch
    expect(lookupSpy).toHaveBeenCalledTimes(1); // ...and ONE shared PR lookup
    expect((await rowFor('ws1', 7))?.state).toBe('merged');
    expect((await rowFor('ws2', 7))?.state).toBe('merged');
  });

  it('skips repos with no tracked-open rows without any GitHub call', async () => {
    const listSpy = vi.spyOn(githubService, 'listOpenPullRequestNumbers');

    const closed = await prMonitorService.sweepClosedViaRest('ws1', createRestSweepCache());

    expect(closed).toBe(0);
    expect(listSpy).not.toHaveBeenCalled();
  });
});
