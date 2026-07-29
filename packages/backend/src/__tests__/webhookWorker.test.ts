import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  isRefreshEvent,
  isSlowEvent,
  extractPrNumbers,
  processWebhookDelivery,
  _resetCoalesce,
  type WebhookDelivery,
} from '../services/webhookWorker.js';
import { refreshWebhookIndex, _resetWebhookIndex } from '../services/webhookIndex.js';
import { checkCountCoalescer } from '../services/checkCounts.js';
import { prMonitorService } from '../services/prMonitor.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';

function delivery(over: Partial<WebhookDelivery>): WebhookDelivery {
  return {
    deliveryId: 'd1',
    eventType: 'pull_request',
    repoFullName: 'acme/widget',
    enqueuedAtMs: 0,
    payload: {},
    ...over,
  };
}

describe('webhook classification helpers', () => {
  it('flags PR-affecting events as refresh events', () => {
    for (const e of [
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'issue_comment',
      'check_run',
      'check_suite',
    ]) {
      expect(isRefreshEvent(e)).toBe(true);
    }
    for (const e of ['installation', 'status', 'push', 'ping']) {
      expect(isRefreshEvent(e)).toBe(false);
    }
  });

  it('routes refresh events to the slow lane and the check firehose to the fast lane', () => {
    // Slow = makes a ~1-2s refreshPr; must run in the bounded background lane so
    // it never gates the fast check_run/check_suite drain.
    for (const e of ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment']) {
      expect(isSlowEvent(e)).toBe(true);
    }
    for (const e of ['check_run', 'check_suite', 'push', 'installation', 'status']) {
      expect(isSlowEvent(e)).toBe(false);
    }
  });

  it('extracts PR numbers per event shape', () => {
    expect(extractPrNumbers('pull_request', { pull_request: { number: 7 } })).toEqual([7]);
    expect(extractPrNumbers('pull_request', { number: 9 })).toEqual([9]);
    expect(extractPrNumbers('pull_request_review', { pull_request: { number: 3 } })).toEqual([3]);
    expect(
      extractPrNumbers('pull_request_review_comment', { pull_request: { number: 4 } }),
    ).toEqual([4]);
    expect(
      extractPrNumbers('check_run', { check_run: { pull_requests: [{ number: 1 }, { number: 2 }] } }),
    ).toEqual([1, 2]);
    expect(
      extractPrNumbers('check_suite', { check_suite: { pull_requests: [{ number: 5 }] } }),
    ).toEqual([5]);
  });

  it('only treats issue_comment as a PR when issue.pull_request is present', () => {
    expect(extractPrNumbers('issue_comment', { issue: { number: 8, pull_request: {} } })).toEqual([8]);
    expect(extractPrNumbers('issue_comment', { issue: { number: 8 } })).toEqual([]);
  });

  it('returns no numbers for commit-scoped status events', () => {
    expect(extractPrNumbers('status', { sha: 'abc', state: 'success' })).toEqual([]);
  });

  // A faithful subset of the real `pull_request` / action=closed (merged)
  // delivery for PostHog/posthog#64026 (only the fields our pipeline reads,
  // plus a few documenting ones). Guards against a regression in how a merge
  // delivery is classified.
  it('classifies a real merged-PR (action=closed) delivery as a single-PR refresh', () => {
    const payload = {
      action: 'closed',
      number: 64026,
      pull_request: {
        number: 64026,
        state: 'closed',
        merged: true,
        merged_at: '2026-06-16T20:47:18Z',
        user: { login: 'Gilbert09' },
        base: { ref: 'master' },
        html_url: 'https://github.com/PostHog/posthog/pull/64026',
      },
      repository: { full_name: 'PostHog/posthog', name: 'posthog', owner: { login: 'PostHog' } },
      installation: { id: 140694558 },
    };
    expect(isRefreshEvent('pull_request')).toBe(true);
    expect(extractPrNumbers('pull_request', payload)).toEqual([64026]);
  });
});

describe('processWebhookDelivery (fan-out + coalescing)', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let refreshSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    // Two workspaces watching the SAME repo → one event fans to both.
    await db.insert(workspacesTable).values([
      { id: 'wsA', ownerId: TEST_USER_ID, name: 'A', settings: {} },
      { id: 'wsB', ownerId: TEST_USER_ID, name: 'B', settings: {} },
    ]);
    await db.insert(repositoriesTable).values([
      { id: 'rA', workspaceId: 'wsA', name: 'acme/widget', url: 'https://github.com/acme/widget', defaultBranch: 'main', createdAt: new Date() },
      { id: 'rB', workspaceId: 'wsB', name: 'acme/widget', url: 'https://github.com/acme/widget', defaultBranch: 'main', createdAt: new Date() },
    ]);
    _resetWebhookIndex();
    await refreshWebhookIndex();
    _resetCoalesce();
    // Stub the shared cross-workspace refresh so we assert dispatch without
    // hitting GitHub. The webhook fan-out now makes ONE call per PR number with
    // every watching workspace as a target (deduped fetch), not one refreshPr
    // per workspace.
    refreshSpy = vi
      .spyOn(prMonitorService, 'refreshPrAcrossWorkspaces')
      .mockResolvedValue(undefined);
  });

  /** The (workspace, repo) target the fan-out passes for a watched repo row. */
  const target = (workspaceId: string, repositoryId: string) => ({
    workspaceId,
    owner: 'acme',
    repo: 'widget',
    repositoryId,
  });

  // A tracked open PR row (with a known head sha for the incremental check path).
  async function seedTrackedPr(
    repositoryId: string,
    workspaceId: string,
    number: number,
    headSha = 'sha-1',
  ) {
    await db.insert(pullRequestsTable).values({
      id: `pr-${repositoryId}-${number}`,
      workspaceId,
      repositoryId,
      owner: 'acme',
      repo: 'widget',
      number,
      state: 'open',
      lastSummary: { headSha, checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 } },
    });
  }
  afterEach(async () => {
    _resetWebhookIndex();
    _resetCoalesce();
    checkCountCoalescer._reset();
    await cleanup();
    vi.restoreAllMocks();
  });

  it('fans one PR event out to every workspace in a SINGLE shared refresh call', async () => {
    const n = await processWebhookDelivery(
      delivery({ payload: { pull_request: { number: 7 } } }),
      1_000,
    );
    expect(n).toBe(2);
    // The dedup: ONE refreshPrAcrossWorkspaces call carrying both targets (they
    // share an installation → one identical GraphQL fetch), not one per workspace.
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const [targets, number] = refreshSpy.mock.calls[0];
    expect(number).toBe(7);
    expect(targets).toEqual(
      expect.arrayContaining([target('wsA', 'rA'), target('wsB', 'rB')]),
    );
    expect(targets).toHaveLength(2);
  });

  // Read the cached summary of the seeded PR row.
  const summaryOf = async (id = 'pr-rA-7') => {
    const rows = await db
      .select({ ls: pullRequestsTable.lastSummary })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, id));
    return rows[0]?.ls as Record<string, unknown>;
  };

  it('patches title from a pull_request/edited (title) without a refreshPr', async () => {
    await seedTrackedPr('rA', 'wsA', 7, 'sha-1');
    const n = await processWebhookDelivery(
      delivery({
        action: 'edited',
        payload: {
          pull_request: { number: 7, title: 'Renamed PR' },
          changes: { title: { from: 'Old title' } },
        },
      }),
      1_000,
    );
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(n).toBe(1);
    expect((await summaryOf()).title).toBe('Renamed PR');
  });

  it('patches draft on ready_for_review / converted_to_draft without a refreshPr', async () => {
    await seedTrackedPr('rA', 'wsA', 7, 'sha-1');
    await processWebhookDelivery(
      delivery({ action: 'converted_to_draft', payload: { pull_request: { number: 7, draft: true } } }),
      1_000,
    );
    expect((await summaryOf()).draft).toBe(true);
    await processWebhookDelivery(
      delivery({ action: 'ready_for_review', payload: { pull_request: { number: 7, draft: false } } }),
      1_000,
    );
    expect((await summaryOf()).draft).toBe(false);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('patches labels from the payload on labeled/unlabeled — no refreshPr', async () => {
    // Labels carry an external merge queue's per-PR state (trunk.io posts
    // `trunk-queued`/`trunk-testing`/… and nothing else), so they're tracked —
    // but the payload carries the full post-change set, so no fetch is needed.
    await seedTrackedPr('rA', 'wsA', 7, 'sha-1');
    const n = await processWebhookDelivery(
      delivery({
        action: 'labeled',
        payload: {
          pull_request: { number: 7, labels: [{ name: 'trunk-queued' }, { name: 'stamphog' }] },
          label: { name: 'trunk-queued' },
        },
      }),
      1_000,
    );
    expect(n).toBe(1);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect((await summaryOf()).labels).toEqual(['trunk-queued', 'stamphog']);

    await processWebhookDelivery(
      delivery({
        action: 'unlabeled',
        payload: {
          pull_request: { number: 7, labels: [{ name: 'stamphog' }] },
          label: { name: 'trunk-queued' },
        },
      }),
      1_000,
    );
    expect((await summaryOf()).labels).toEqual(['stamphog']);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('falls back to a full refreshPr when a label delivery carries no label set', async () => {
    await seedTrackedPr('rA', 'wsA', 7, 'sha-1');
    await processWebhookDelivery(
      delivery({ action: 'labeled', payload: { pull_request: { number: 7 }, label: { name: 'bug' } } }),
      1_000,
    );
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('still does a full refreshPr when an edited delivery changed the base branch', async () => {
    await seedTrackedPr('rA', 'wsA', 7, 'sha-1');
    const n = await processWebhookDelivery(
      delivery({
        action: 'edited',
        payload: {
          pull_request: { number: 7, title: 'x' },
          changes: { base: { ref: { from: 'main' } } },
        },
      }),
      1_000,
    );
    // base change affects mergeability → must refetch, not patch.
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const [targets, number] = refreshSpy.mock.calls[0];
    expect(number).toBe(7);
    expect(targets).toEqual(expect.arrayContaining([target('wsA', 'rA')]));
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('buffers a check_run into the coalescer, then flushes incremental counts (not refreshPr)', async () => {
    // A tracked PR (7) on head sha-1 + an untracked one (8). check_run is BUFFERED
    // (returns 0 — accounted at flush), then a flush updates counts incrementally
    // (no refreshPr) for the tracked PR on its head.
    await seedTrackedPr('rA', 'wsA', 7, 'sha-1');
    const n = await processWebhookDelivery(
      delivery({
        eventType: 'check_run',
        payload: {
          check_run: {
            id: 1,
            name: 'lint',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'sha-1',
            pull_requests: [{ number: 7 }, { number: 8 }],
          },
          repository: { owner: { login: 'acme' }, name: 'widget' },
        },
      }),
      1_000,
    );
    expect(n).toBe(0); // buffered, not applied per-delivery
    await checkCountCoalescer.flushAllNow();
    expect(refreshSpy).not.toHaveBeenCalled(); // incremental, never a GraphQL refresh
    const rows = await db
      .select({ ls: pullRequestsTable.lastSummary })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, 'pr-rA-7'));
    expect((rows[0].ls as { checks: { total: number; passed: number } }).checks).toMatchObject({
      total: 1,
      passed: 1,
    });
  });

  it('coalesces a burst of check_runs for one sha into a single count update', async () => {
    // Three checks for the same (repo, sha) arrive in one window. They buffer and
    // flush ONCE — the final counts reflect all three (2 passed, 1 in-progress).
    await seedTrackedPr('rA', 'wsA', 7, 'sha-1');
    const mk = (name: string, conclusion: string | null, status: string) =>
      delivery({
        eventType: 'check_run',
        payload: {
          check_run: { id: name, name, status, conclusion, head_sha: 'sha-1', pull_requests: [{ number: 7 }] },
          repository: { owner: { login: 'acme' }, name: 'widget' },
        },
      });
    await processWebhookDelivery(mk('lint', 'success', 'completed'), 1_000);
    await processWebhookDelivery(mk('test', 'success', 'completed'), 1_000);
    await processWebhookDelivery(mk('e2e', null, 'in_progress'), 1_000);
    await checkCountCoalescer.flushAllNow();
    const rows = await db
      .select({ ls: pullRequestsTable.lastSummary })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, 'pr-rA-7'));
    expect(
      (rows[0].ls as { checks: { total: number; passed: number; inProgress: number } }).checks,
    ).toMatchObject({ total: 3, passed: 2, inProgress: 1 });
  });

  it('does NOT refresh or update on a head-sha mismatch (no fallback — keeps the worker fast)', async () => {
    // The check is on sha-NEW but the row's cached head is sha-OLD (e.g. a check
    // that ran on a merge commit, which isn't in the PR head's rollup anyway).
    // Incremental applies to nothing and we must NOT fall back to a ~2s refreshPr.
    await seedTrackedPr('rA', 'wsA', 7, 'sha-OLD');
    const n = await processWebhookDelivery(
      delivery({
        eventType: 'check_run',
        payload: {
          check_run: {
            id: 1,
            name: 'lint',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'sha-NEW',
            pull_requests: [{ number: 7 }],
          },
          repository: { owner: { login: 'acme' }, name: 'widget' },
        },
      }),
      1_000,
    );
    expect(n).toBe(0);
    await checkCountCoalescer.flushAllNow();
    expect(refreshSpy).not.toHaveBeenCalled();
    const rows = await db
      .select({ ls: pullRequestsTable.lastSummary })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, 'pr-rA-7'));
    // Counts untouched — the sha is no tracked PR's head.
    expect((rows[0].ls as { checks: { total: number } }).checks).toMatchObject({ total: 0 });
  });

  it('treats check_suite as a no-op (counts come from check_run)', async () => {
    await seedTrackedPr('rA', 'wsA', 7, 'sha-1');
    const n = await processWebhookDelivery(
      delivery({
        eventType: 'check_suite',
        payload: { check_suite: { pull_requests: [{ number: 7 }] } },
      }),
      1_000,
    );
    expect(n).toBe(0);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('dispatches the real PostHog/posthog#64026 merge delivery to refreshPr', async () => {
    // End-to-end on the actual webhook envelope: a watched repo + the real
    // merged-PR payload must fan out to refreshPr(workspace, owner, repo, 64026).
    // Mirrors the prod path that wasn't firing — proves classification + repo
    // resolution + dispatch are correct for this exact delivery.
    await db.insert(workspacesTable).values({
      id: 'wsPH',
      ownerId: TEST_USER_ID,
      name: 'PostHog',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'rPH',
      workspaceId: 'wsPH',
      name: 'PostHog/posthog',
      url: 'https://github.com/PostHog/posthog',
      defaultBranch: 'master',
      createdAt: new Date(),
    });
    _resetWebhookIndex();
    await refreshWebhookIndex();

    const n = await processWebhookDelivery(
      delivery({
        deliveryId: '0a4c1f00-real',
        eventType: 'pull_request',
        repoFullName: 'PostHog/posthog',
        payload: {
          action: 'closed',
          number: 64026,
          pull_request: {
            number: 64026,
            state: 'closed',
            merged: true,
            user: { login: 'Gilbert09' },
            base: { ref: 'master' },
          },
          repository: { full_name: 'PostHog/posthog', name: 'posthog', owner: { login: 'PostHog' } },
          installation: { id: 140694558 },
        },
      }),
      5_000,
    );

    expect(n).toBe(1);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const [targets, number] = refreshSpy.mock.calls[0];
    expect(number).toBe(64026);
    expect(targets).toEqual([
      { workspaceId: 'wsPH', owner: 'PostHog', repo: 'posthog', repositoryId: 'rPH' },
    ]);
  });

  it('coalesces a burst for the same (workspace, PR) within the window', async () => {
    await processWebhookDelivery(delivery({ payload: { pull_request: { number: 7 } } }), 1_000);
    refreshSpy.mockClear();
    // A different refresh event for the same PR, 100ms later — inside the 750ms
    // window → dropped. (check events take the incremental path, so a review
    // event exercises the coalescing window.)
    const n = await processWebhookDelivery(
      delivery({ eventType: 'pull_request_review', payload: { pull_request: { number: 7 } } }),
      1_100,
    );
    expect(n).toBe(0);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('refreshes again once the coalescing window has elapsed', async () => {
    await processWebhookDelivery(delivery({ payload: { pull_request: { number: 7 } } }), 1_000);
    refreshSpy.mockClear();
    const n = await processWebhookDelivery(
      delivery({ payload: { pull_request: { number: 7 } } }),
      2_000, // > 750ms later
    );
    expect(n).toBe(2);
    // Both workspaces are past the coalescing window → one shared refresh, both targets.
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0][0]).toHaveLength(2);
  });

  it('drops events for a repo nobody watches', async () => {
    const n = await processWebhookDelivery(
      delivery({ repoFullName: 'someone/else', payload: { pull_request: { number: 1 } } }),
      1_000,
    );
    expect(n).toBe(0);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does not refresh on installation events (index maintenance only)', async () => {
    const n = await processWebhookDelivery(
      delivery({ eventType: 'installation', repoFullName: '', payload: { action: 'created' } }),
      1_000,
    );
    expect(n).toBe(0);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('skips a push to a base branch (no per-PR refresh — sweep handles conflicts)', async () => {
    // A push to a busy base would fan out to a refresh per open PR — an expensive
    // backlog source that buries merges and (with resolveMergeable:false) never
    // detected conflicts anyway. It must now be a cheap no-op.
    const baseSpy = vi.spyOn(prMonitorService, 'openPrNumbersForBase');
    const n = await processWebhookDelivery(
      delivery({ eventType: 'push', payload: { ref: 'refs/heads/main' } }),
      1_000,
    );
    expect(n).toBe(0);
    expect(baseSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('ignores a push to a non-branch ref (tags etc.)', async () => {
    const baseSpy = vi.spyOn(prMonitorService, 'openPrNumbersForBase');
    const n = await processWebhookDelivery(
      delivery({ eventType: 'push', payload: { ref: 'refs/tags/v1.0.0' } }),
      1_000,
    );
    expect(n).toBe(0);
    expect(baseSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
