import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { encryptString } from '../services/tokenCrypto.js';
import { prAutoMergeWatcher } from '../services/prAutoMergeWatcher.js';
import { prMonitorService } from '../services/prMonitor.js';
import { graphqlBudget } from '../services/graphqlBudget.js';
import { githubService } from '../services/github.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  integrations as integrationsTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  tasks as tasksTable,
} from '../db/schema.js';
import { registerCloudProvider } from '../services/cloudProviders/registry.js';
import { postHogCodeProvider } from '../services/cloudProviders/posthog/provider.js';

// Seeding the encrypted PostHog credential needs the token-encryption key.
process.env.TALYN_TOKEN_KEY ??= randomBytes(32).toString('base64');

// resolveCloudEnvId checks the provider has stored credentials, so register the
// provider + give the workspace a posthog integration row in seedBase.
registerCloudProvider(postHogCodeProvider);

/**
 * Exercises the auto-keep-mergeable watcher's decision matrix against a real
 * (pglite) DB: it fires the shared "get mergeable" cloud task only when a PR
 * has a blocker, nothing's already running it, and the 3-attempt guard hasn't
 * tripped — and re-arms once the PR is observed mergeable again.
 */

const OWNER = 'user-akm';
const OWNER2 = 'user-noenv';

/** A summary that trips prNeedsFollowup (merge conflicts). */
function blockedSummary() {
  return {
    title: 'PR title',
    author: 'me',
    draft: false,
    headBranch: 'feat',
    baseBranch: 'main',
    headSha: 'abc',
    url: 'https://github.com/a/b/pull/1',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    reviewDecision: null,
    blockingReason: 'merge_conflicts',
    checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0,
  };
}

/** A clean, mergeable summary. */
function cleanSummary() {
  return {
    ...blockedSummary(),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    blockingReason: 'mergeable',
  };
}

async function seedBase(db: Database): Promise<void> {
  await seedUser(db, { id: OWNER });
  await db.insert(workspacesTable).values({
    id: 'ws1',
    ownerId: OWNER,
    name: 'ws',
    settings: {},
  });
  await db.insert(environmentsTable).values({
    id: 'cloud1',
    ownerId: OWNER,
    name: 'PostHog Code',
    type: 'posthog_code',
    status: 'connected',
    config: { type: 'posthog_code' },
  });
  await db.insert(integrationsTable).values({
    id: 'int-ph',
    workspaceId: 'ws1',
    type: 'posthog',
    enabled: true,
    // Encrypted at rest — the legacy plaintext `apiKey` read path was removed.
    config: { apiKeyEnc: encryptString('test-key'), projectId: '1' },
  });
  await db.insert(repositoriesTable).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: 'a/b',
    url: 'https://github.com/a/b',
    defaultBranch: 'main',
  });
}

let prCounter = 0;
async function insertPr(
  db: Database,
  overrides: {
    summary?: Record<string, unknown>;
    autoKeepMergeable?: boolean;
    autoMergeState?: unknown;
    taskId?: string | null;
    state?: string;
    workspaceId?: string;
    repositoryId?: string;
  } = {}
): Promise<string> {
  const id = `pr-${++prCounter}`;
  await db.insert(pullRequestsTable).values({
    id,
    workspaceId: overrides.workspaceId ?? 'ws1',
    repositoryId: overrides.repositoryId ?? 'repo1',
    taskId: overrides.taskId ?? null,
    owner: 'a',
    repo: 'b',
    number: prCounter,
    state: overrides.state ?? 'open',
    autoKeepMergeable: overrides.autoKeepMergeable ?? true,
    autoMergeState: overrides.autoMergeState ?? null,
    // Recent so the watcher's freshness refresh (which would call the live
    // GitHub poller) is skipped.
    lastPolledAt: new Date(),
    lastSummary: overrides.summary ?? blockedSummary(),
  });
  return id;
}

async function insertTask(
  db: Database,
  id: string,
  status: string,
  prId: string
): Promise<void> {
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'pr_response',
    status,
    priority: 'medium',
    title: 't',
    description: 'd',
    repositoryId: 'repo1',
    assignedEnvironmentId: 'cloud1',
    metadata: { pullRequest: { id: prId, number: 1, url: '', createdAt: '' } },
  });
}

async function countTasks(db: Database): Promise<number> {
  const rows = await db.select({ id: tasksTable.id }).from(tasksTable);
  return rows.length;
}

async function getPr(db: Database, id: string) {
  const rows = await db
    .select()
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, id))
    .limit(1);
  return rows[0];
}

describe('prAutoMergeWatcher', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    prCounter = 0;
    await seedBase(db);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    prAutoMergeWatcher._resetLabelRetries();
  });

  describe('watch labels', () => {
    let addLabels: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      addLabels = vi.spyOn(githubService, 'addPullRequestLabels').mockResolvedValue(undefined);
    });

    async function setLabels(labels: string[] | undefined) {
      await db
        .update(workspacesTable)
        .set({ settings: labels === undefined ? {} : { autoKeepMergeableLabels: labels } })
        .where(eq(workspacesTable.id, 'ws1'));
    }

    async function appliedLabels(prId: string): Promise<string[] | undefined> {
      const pr = await getPr(db, prId);
      return (pr.autoMergeState as { appliedLabels?: string[] } | null)?.appliedLabels;
    }

    it.each([
      { name: 'no labels configured', configured: undefined, applied: undefined, expectAdd: null },
      { name: 'an empty list', configured: [], applied: undefined, expectAdd: null },
      {
        name: 'nothing applied yet',
        configured: ['auto-review', 'stamp'],
        applied: undefined,
        expectAdd: ['auto-review', 'stamp'],
      },
      {
        name: 'one of two already applied',
        configured: ['auto-review', 'stamp'],
        applied: ['auto-review'],
        expectAdd: ['stamp'],
      },
      {
        name: 'everything already applied',
        configured: ['auto-review', 'stamp'],
        applied: ['auto-review', 'stamp'],
        expectAdd: null,
      },
      {
        name: 'a label removed from the setting stays applied',
        configured: ['stamp'],
        applied: ['auto-review', 'stamp'],
        expectAdd: null,
      },
      {
        name: 'a casing change is not a new label',
        configured: ['Auto-Review', 'stamp'],
        applied: ['auto-review', 'stamp'],
        expectAdd: null,
      },
    ])('adds only the missing labels: $name', async ({ configured, applied, expectAdd }) => {
      await setLabels(configured);
      const prId = await insertPr(db, {
        summary: cleanSummary(),
        autoMergeState: { attempts: 0, accounted: true, ...(applied ? { appliedLabels: applied } : {}) },
      });

      await prAutoMergeWatcher.runOnce();

      if (expectAdd === null) {
        expect(addLabels).not.toHaveBeenCalled();
        expect(await appliedLabels(prId)).toEqual(applied);
      } else {
        expect(addLabels).toHaveBeenCalledTimes(1);
        expect(addLabels).toHaveBeenCalledWith('ws1', 'a', 'b', 1, expectAdd);
        expect(await appliedLabels(prId)).toEqual([...(applied ?? []), ...expectAdd]);
      }
    });

    it('labels a PR whose fix run is still in flight', async () => {
      await setLabels(['auto-review']);
      const prId = await insertPr(db);
      await insertTask(db, 'running', 'in_progress', prId);
      await db
        .update(pullRequestsTable)
        .set({ taskId: 'running' })
        .where(eq(pullRequestsTable.id, prId));

      await prAutoMergeWatcher.runOnce();

      expect(addLabels).toHaveBeenCalledWith('ws1', 'a', 'b', 1, ['auto-review']);
      expect(await appliedLabels(prId)).toEqual(['auto-review']);
      expect(await countTasks(db)).toBe(1);
    });

    it('still fires the fix run on the same tick it labels', async () => {
      await setLabels(['auto-review']);
      const prId = await insertPr(db, { autoMergeState: { attempts: 0, accounted: true } });

      await prAutoMergeWatcher.runOnce();

      expect(await countTasks(db)).toBe(1);
      const pr = await getPr(db, prId);
      const state = pr.autoMergeState as { appliedLabels?: string[]; lastAutoTaskId?: string };
      expect(state.appliedLabels).toEqual(['auto-review']);
      expect(state.lastAutoTaskId).toBeTruthy();
    });

    it('labels every watched PR in the workspace', async () => {
      await setLabels(['auto-review']);
      await insertPr(db, { summary: cleanSummary() });
      await insertPr(db, { summary: cleanSummary() });
      await insertPr(db, { summary: cleanSummary() });

      await prAutoMergeWatcher.runOnce();

      expect(addLabels).toHaveBeenCalledTimes(3);
    });

    it('records nothing and backs off for the repo when GitHub refuses', async () => {
      await setLabels(['auto-review']);
      addLabels.mockRejectedValue(new Error('Resource not accessible by integration'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const prId = await insertPr(db, { summary: cleanSummary() });
      const otherPrId = await insertPr(db, { summary: cleanSummary() });

      await prAutoMergeWatcher.runOnce();

      expect(addLabels).toHaveBeenCalledTimes(1);
      expect(await appliedLabels(prId)).toBeUndefined();
      expect(await appliedLabels(otherPrId)).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('failed to add labels ["auto-review"]'),
        'Resource not accessible by integration'
      );

      await prAutoMergeWatcher.runOnce();
      expect(addLabels).toHaveBeenCalledTimes(1);

      prAutoMergeWatcher._resetLabelRetries();
      addLabels.mockResolvedValue(undefined);
      await prAutoMergeWatcher.runOnce();
      expect(addLabels).toHaveBeenCalledTimes(3);
      expect(await appliedLabels(prId)).toEqual(['auto-review']);
      expect(await appliedLabels(otherPrId)).toEqual(['auto-review']);
    });

    it('does not label PRs that are merged or not watched', async () => {
      await setLabels(['auto-review']);
      await insertPr(db, { state: 'merged' });
      await insertPr(db, { autoKeepMergeable: false });

      await prAutoMergeWatcher.runOnce();

      expect(addLabels).not.toHaveBeenCalled();
    });

    it('retries after the backoff window has passed', async () => {
      await setLabels(['auto-review']);
      addLabels.mockRejectedValue(new Error('boom'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const prId = await insertPr(db, { summary: cleanSummary() });
      await prAutoMergeWatcher.runOnce();
      expect(addLabels).toHaveBeenCalledTimes(1);

      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + 16 * 60_000);
      await db
        .update(pullRequestsTable)
        .set({ lastPolledAt: new Date(Date.now()) })
        .where(eq(pullRequestsTable.id, prId));
      addLabels.mockResolvedValue(undefined);

      await prAutoMergeWatcher.runOnce();

      expect(addLabels).toHaveBeenCalledTimes(2);
      expect(await appliedLabels(prId)).toEqual(['auto-review']);
    });

    it('applies each workspace its own labels within one tick', async () => {
      await setLabels(['auto-review']);
      await seedUser(db, { id: OWNER2 });
      await db.insert(workspacesTable).values({
        id: 'ws2',
        ownerId: OWNER2,
        name: 'ws2',
        settings: { autoKeepMergeableLabels: ['stamp'] },
      });
      await db.insert(repositoriesTable).values({
        id: 'repo2',
        workspaceId: 'ws2',
        name: 'c/d',
        url: 'https://github.com/c/d',
        defaultBranch: 'main',
      });
      const ws1Pr = await insertPr(db, { summary: cleanSummary() });
      const ws2Pr = await insertPr(db, {
        summary: cleanSummary(),
        workspaceId: 'ws2',
        repositoryId: 'repo2',
      });

      await prAutoMergeWatcher.runOnce();

      expect(addLabels).toHaveBeenCalledWith('ws1', 'a', 'b', 1, ['auto-review']);
      expect(addLabels).toHaveBeenCalledWith('ws2', 'a', 'b', 2, ['stamp']);
      expect(await appliedLabels(ws1Pr)).toEqual(['auto-review']);
      expect(await appliedLabels(ws2Pr)).toEqual(['stamp']);
    });

    it.each([
      { name: 'a string', stored: 'auto-review' },
      { name: 'an object', stored: { auto: true } },
      { name: 'a mixed array', stored: ['auto-review', 42, null] },
    ])('tolerates malformed stored appliedLabels: $name', async ({ stored }) => {
      await setLabels(['auto-review', 'stamp']);
      const prId = await insertPr(db, {
        summary: cleanSummary(),
        autoMergeState: { attempts: 0, accounted: true, appliedLabels: stored },
      });

      await prAutoMergeWatcher.runOnce();

      const expectAdd = Array.isArray(stored) ? ['stamp'] : ['auto-review', 'stamp'];
      expect(addLabels).toHaveBeenCalledWith('ws1', 'a', 'b', 1, expectAdd);
      expect(await appliedLabels(prId)).toEqual(['auto-review', 'stamp']);
    });
  });

  // The top-of-tick freshness refetch is an opportunistic GraphQL poll — it must
  // back off when the account's points budget is in the reserve (like the
  // reconcile sweep) and proceed on the existing row, rather than burning the
  // last points and hard-tripping the rate limit.
  describe('freshness refetch — GraphQL budget deferral', () => {
    let refreshSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      refreshSpy = vi.spyOn(prMonitorService, 'refreshPr').mockResolvedValue(undefined);
    });
    async function staleBlockedPr() {
      const prId = await insertPr(db, { autoMergeState: { attempts: 0, accounted: true } });
      await db
        .update(pullRequestsTable)
        .set({ lastPolledAt: new Date(Date.now() - 10 * 60_000) }) // well past FRESHNESS_MS
        .where(eq(pullRequestsTable.id, prId));
      return prId;
    }

    it('refetches a stale PR when the budget is healthy', async () => {
      vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(false);
      await staleBlockedPr();
      await prAutoMergeWatcher.runOnce();
      expect(refreshSpy).toHaveBeenCalledWith('ws1', 'a', 'b', expect.any(Number));
    });

    it('skips the stale refetch when the budget is in the reserve', async () => {
      vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(true);
      await staleBlockedPr();
      await prAutoMergeWatcher.runOnce();
      expect(refreshSpy).not.toHaveBeenCalled();
    });
  });

  it('fires one cloud task for a blocked PR with no run in flight', async () => {
    const prId = await insertPr(db, { autoMergeState: { attempts: 0, accounted: true } });

    await prAutoMergeWatcher.runOnce();

    const tasks = await db.select().from(tasksTable);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('pr_response');
    expect(tasks[0].repositoryId).toBe('repo1');
    expect(tasks[0].status).toBe('queued');

    const pr = await getPr(db, prId);
    const state = pr.autoMergeState as { lastAutoTaskId?: string; accounted?: boolean };
    expect(state.lastAutoTaskId).toBe(tasks[0].id);
    expect(state.accounted).toBe(false);
    // The PR row is reverse-linked to the run.
    expect(pr.taskId).toBe(tasks[0].id);
  });

  describe('free-plan task limit', () => {
    const savedPolarToken = process.env.POLAR_ACCESS_TOKEN;

    beforeEach(() => {
      // Billing configured → the 3-active-task limit is enforced.
      process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    });

    afterEach(() => {
      if (savedPolarToken === undefined) delete process.env.POLAR_ACCESS_TOKEN;
      else process.env.POLAR_ACCESS_TOKEN = savedPolarToken;
    });

    async function fillOwnerSlots() {
      // Three active tasks NOT linked to any watched PR — they only occupy
      // the owner's free-plan slots.
      await insertTask(db, 'filler-1', 'queued', 'pr-none');
      await insertTask(db, 'filler-2', 'in_progress', 'pr-none');
      await insertTask(db, 'filler-3', 'pending', 'pr-none');
    }

    it('defers the fix run at the limit without burning an attempt', async () => {
      await fillOwnerSlots();
      const prId = await insertPr(db, { autoMergeState: { attempts: 0, accounted: true } });

      await prAutoMergeWatcher.runOnce();

      expect(await countTasks(db)).toBe(3); // no new task
      const pr = await getPr(db, prId);
      const state = pr.autoMergeState as { attempts?: number; lastAutoTaskId?: string } | null;
      expect(state?.lastAutoTaskId).toBeUndefined();
      expect(state?.attempts ?? 0).toBe(0);
    });

    it('fires on a later tick once a slot frees', async () => {
      await fillOwnerSlots();
      const prId = await insertPr(db, { autoMergeState: { attempts: 0, accounted: true } });
      await prAutoMergeWatcher.runOnce();
      expect(await countTasks(db)).toBe(3);

      await db
        .update(tasksTable)
        .set({ status: 'completed' })
        .where(eq(tasksTable.id, 'filler-1'));
      await prAutoMergeWatcher.runOnce();

      expect(await countTasks(db)).toBe(4);
      const pr = await getPr(db, prId);
      const state = pr.autoMergeState as { lastAutoTaskId?: string };
      expect(state.lastAutoTaskId).toBeTruthy();
    });

    it('unlimited owner is never deferred', async () => {
      const { users } = await import('../db/schema.js');
      await db.update(users).set({ planOverride: 'unlimited' }).where(eq(users.id, OWNER));
      await fillOwnerSlots();
      await insertPr(db, { autoMergeState: { attempts: 0, accounted: true } });

      await prAutoMergeWatcher.runOnce();

      expect(await countTasks(db)).toBe(4);
    });
  });

  it('does not fire while a run is already in flight (no double-run)', async () => {
    const prId = await insertPr(db);
    await insertTask(db, 'running', 'in_progress', prId);
    await db
      .update(pullRequestsTable)
      .set({ taskId: 'running' })
      .where(eq(pullRequestsTable.id, prId));

    await prAutoMergeWatcher.runOnce();

    expect(await countTasks(db)).toBe(1); // only the pre-existing running task
  });

  it('increments attempts and pauses after 3 un-mergeable auto-runs', async () => {
    const prId = await insertPr(db, {
      autoMergeState: { attempts: 2, lastAutoTaskId: 'prev', accounted: false },
    });
    await insertTask(db, 'prev', 'completed', prId);
    await db
      .update(pullRequestsTable)
      .set({ taskId: 'prev' })
      .where(eq(pullRequestsTable.id, prId));

    await prAutoMergeWatcher.runOnce();

    const pr = await getPr(db, prId);
    const state = pr.autoMergeState as { attempts: number; pausedAt?: string; accounted?: boolean };
    expect(state.attempts).toBe(3);
    expect(state.pausedAt).toBeTruthy();
    expect(state.accounted).toBe(true);
    // Paused → no new run fired.
    expect(await countTasks(db)).toBe(1); // only 'prev'
  });

  it('resets the attempt counter when the PR is observed mergeable', async () => {
    const prId = await insertPr(db, {
      summary: cleanSummary(),
      autoMergeState: { attempts: 2, lastAutoTaskId: 'prev', accounted: false },
    });
    await insertTask(db, 'prev', 'completed', prId);
    await db
      .update(pullRequestsTable)
      .set({ taskId: 'prev' })
      .where(eq(pullRequestsTable.id, prId));

    await prAutoMergeWatcher.runOnce();

    const pr = await getPr(db, prId);
    const state = pr.autoMergeState as { attempts: number; pausedAt?: string };
    expect(state.attempts).toBe(0);
    expect(state.pausedAt).toBeFalsy();
    // Clean PR → nothing to fix.
    expect(await countTasks(db)).toBe(1);
  });

  it('stays paused on a blocked PR until it is seen mergeable', async () => {
    await insertPr(db, {
      autoMergeState: { attempts: 3, pausedAt: new Date().toISOString(), accounted: true },
    });

    await prAutoMergeWatcher.runOnce();

    expect(await countTasks(db)).toBe(0); // guard holds — no run fired
  });

  it('re-arms and fires again after a paused PR becomes mergeable then breaks', async () => {
    // First: clean observation re-arms (clears pause).
    const prId = await insertPr(db, {
      summary: cleanSummary(),
      autoMergeState: { attempts: 3, pausedAt: new Date().toISOString(), accounted: true },
    });
    await prAutoMergeWatcher.runOnce();
    const pr = await getPr(db, prId);
    expect((pr.autoMergeState as { attempts: number }).attempts).toBe(0);
    expect((pr.autoMergeState as { pausedAt?: string }).pausedAt).toBeFalsy();

    // Then: the PR develops a new blocker → fires a fresh run.
    await db
      .update(pullRequestsTable)
      .set({ lastSummary: blockedSummary() })
      .where(eq(pullRequestsTable.id, prId));
    await prAutoMergeWatcher.runOnce();
    expect(await countTasks(db)).toBe(1);
  });

  it('skips a PR whose workspace has no connected PostHog Code env', async () => {
    await seedUser(db, { id: OWNER2 });
    await db.insert(workspacesTable).values({
      id: 'ws2',
      ownerId: OWNER2,
      name: 'ws2',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo2',
      workspaceId: 'ws2',
      name: 'c/d',
      url: 'https://github.com/c/d',
      defaultBranch: 'main',
    });
    await insertPr(db, { workspaceId: 'ws2', repositoryId: 'repo2' });

    await prAutoMergeWatcher.runOnce();

    expect(await countTasks(db)).toBe(0);
  });

  it('ignores PRs that are not open or not enabled', async () => {
    await insertPr(db, { state: 'merged' });
    await insertPr(db, { autoKeepMergeable: false });

    await prAutoMergeWatcher.runOnce();

    expect(await countTasks(db)).toBe(0);
  });
});
