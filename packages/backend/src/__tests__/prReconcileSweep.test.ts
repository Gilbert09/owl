import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prReconcileSweep } from '../services/prReconcileSweep.js';
import { prMonitorService } from '../services/prMonitor.js';
import { githubService } from '../services/github.js';
import { graphqlBudget } from '../services/graphqlBudget.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

/**
 * The reconcile sweep is the webhook pipeline's safety net, and its own net is
 * `sweepClosedViaRest` — the close-out that spends zero GraphQL points.
 *
 * That fallback used to run in exactly ONE case: an account whose GraphQL point
 * budget had fallen into the reserve. A poll that FAILED (a 502, or a secondary
 * rate-limit backoff) got no fallback at all, even though it leaves the same
 * hole: the poll never reaches its close-out, so a merged PR keeps its last
 * open summary on the list. That was the bigger case in practice — on
 * 2026-08-24 a merged posthog PR sat on the list for about an hour through nine
 * 300s backoffs, showing "Ready" with a live merge button.
 */
describe('prReconcileSweep — REST close-out fallback', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let restSpy: ReturnType<typeof vi.spyOn>;
  let refreshSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });

    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue(['ws1']);
    vi.spyOn(githubService, 'accountKeyFor').mockReturnValue('inst:1');
    vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(false);
    restSpy = vi.spyOn(prMonitorService, 'sweepClosedViaRest').mockResolvedValue(0);
    refreshSpy = vi
      .spyOn(prMonitorService, 'refreshWorkspaceNow')
      .mockResolvedValue({ failedRepos: 0 });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('does not spend REST budget when every repo polled cleanly', async () => {
    await prReconcileSweep.runOnce();
    expect(refreshSpy).toHaveBeenCalledWith('ws1');
    expect(restSpy).not.toHaveBeenCalled();
  });

  it('runs the REST close-out when a repo poll failed', async () => {
    refreshSpy.mockResolvedValue({ failedRepos: 1 });
    await prReconcileSweep.runOnce();
    expect(restSpy).toHaveBeenCalledTimes(1);
  });

  it('runs the REST close-out when the whole workspace refresh throws', async () => {
    refreshSpy.mockRejectedValue(new Error('GitHub rate-limited; retry in 298s'));
    await prReconcileSweep.runOnce();
    expect(restSpy).toHaveBeenCalledTimes(1);
  });

  it('still defers the GraphQL poll on a budget-reserve account, REST close-out only', async () => {
    vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(true);
    await prReconcileSweep.runOnce();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(restSpy).toHaveBeenCalledTimes(1);
  });

  it('survives a REST close-out that throws (never takes the tick down)', async () => {
    refreshSpy.mockResolvedValue({ failedRepos: 2 });
    restSpy.mockRejectedValue(new Error('GitHub rate-limited; retry in 298s'));
    await expect(prReconcileSweep.runOnce()).resolves.toBeUndefined();
  });
});
