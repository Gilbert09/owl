import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { encryptString } from '../services/tokenCrypto.js';
import { mergeQueueProcessor } from '../services/mergeQueueProcessor.js';
import { githubService, MergeNotPermittedForAppError } from '../services/github.js';
import { githubRateGate } from '../services/githubRateGate.js';
import { debugBus } from '../services/debugBus.js';
import { graphqlBudget } from '../services/graphqlBudget.js';
import { prMonitorService } from '../services/prMonitor.js';
import * as websocketModule from '../services/websocket.js';
import {
  broadcastMergeQueuePositions,
  computeQueuePositions,
} from '../services/mergeQueueBroadcast.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  integrations as integrationsTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  tasks as tasksTable,
  settings as settingsTable,
} from '../db/schema.js';
import { registerCloudProvider } from '../services/cloudProviders/registry.js';
import { postHogCodeProvider } from '../services/cloudProviders/posthog/provider.js';

// The signing gate reads two module functions; mock them so we can drive the
// "does this repo require signed commits?" + "how many commits are unsigned?"
// answers without a live GitHub. Defaults (set in beforeEach) are "no signing
// required / 0 unsigned", so every existing test behaves exactly as before.
const { mockRequiresSigning, mockUnsignedCount, mockMarkSigning } = vi.hoisted(() => ({
  mockRequiresSigning: vi.fn(),
  mockUnsignedCount: vi.fn(),
  mockMarkSigning: vi.fn(),
}));
vi.mock('../services/repoSigning.js', () => ({
  requiresSignedCommits: mockRequiresSigning,
  markSigningRequired: mockMarkSigning,
  _resetRepoSigningCache: vi.fn(),
}));
vi.mock('../services/githubGraphql.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/githubGraphql.js')>()),
  fetchUnsignedCommitCount: mockUnsignedCount,
}));

// Seeding the encrypted PostHog credential needs the token-encryption key.
process.env.TALYN_TOKEN_KEY ??= randomBytes(32).toString('base64');

// resolveCloudEnvId checks the provider has stored credentials, so register the
// provider + give the workspace a posthog integration row in seedBase.
registerCloudProvider(postHogCodeProvider);

/**
 * Exercises the merge-queue processor against a real (pglite) DB: it merges a
 * group's head when it's clean, fires the shared "get mergeable" cloud run on
 * conflict / behind / blocked, serializes same-base PRs one-at-a-time, and
 * drops merged PRs off the queue.
 */

const OWNER = 'user-mq';
const OWNER2 = 'user-mq-noenv';

/** Conflicting summary — trips prNeedsFollowup. */
function conflictSummary(base = 'main') {
  return {
    title: 'PR title',
    author: 'me',
    draft: false,
    headBranch: 'feat',
    baseBranch: base,
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

/** Clean, mergeable, up-to-date. */
function cleanSummary(base = 'main') {
  return {
    ...conflictSummary(base),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    blockingReason: 'mergeable',
  };
}

/**
 * Mergeable but behind the base — the post-merge race state. Passes
 * prNeedsFollowup (nothing to "fix") but must still funnel into the fix path
 * via `needsUpdate`.
 */
function behindSummary(base = 'main') {
  return {
    ...cleanSummary(base),
    mergeStateStatus: 'BEHIND',
  };
}

/**
 * Mergeable on GitHub's side but required checks are still queued/in-progress,
 * so GitHub reports mergeStateStatus=BLOCKED with no *failed* check. The queue
 * must wait for CI to settle here rather than treat it as a hard blocker.
 */
function pendingChecksSummary(base = 'main') {
  return {
    ...cleanSummary(base),
    mergeStateStatus: 'BLOCKED',
    blockingReason: 'blocked',
    checks: { total: 2, passed: 1, failed: 0, inProgress: 1, skipped: 0 },
  };
}

/** A draft PR — GitHub refuses to merge it (reports mergeStateStatus 'DRAFT'). */
function draftSummary(base = 'main') {
  return { ...cleanSummary(base), draft: true, mergeStateStatus: 'DRAFT' };
}

async function seedBase(db: Database): Promise<void> {
  await seedUser(db, { id: OWNER });
  await db.insert(workspacesTable).values({ id: 'ws1', ownerId: OWNER, name: 'ws', settings: {} });
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
    mergeQueued?: boolean;
    mergeQueuedAt?: Date;
    mergeQueueState?: unknown;
    mergeMethod?: string;
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
    mergeQueued: overrides.mergeQueued ?? true,
    mergeQueuedAt: overrides.mergeQueuedAt ?? new Date(),
    mergeMethod: overrides.mergeMethod ?? 'squash',
    mergeQueueState: overrides.mergeQueueState ?? { status: 'waiting', attempts: 0, accounted: true },
    // Recent so the processor's freshness refresh (a live GitHub poll) is skipped.
    lastPolledAt: new Date(),
    lastSummary: overrides.summary ?? cleanSummary(),
  });
  return id;
}

async function insertTask(db: Database, id: string, status: string, prId: string): Promise<void> {
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

type QueueState = {
  status: string;
  attempts: number;
  lastFixTaskId?: string;
  accounted?: boolean;
  lastError?: string;
};

describe('mergeQueueProcessor', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let mergeSpy: ReturnType<typeof vi.spyOn>;
  let refreshSpy: ReturnType<typeof vi.spyOn>;
  let blockedSpy: ReturnType<typeof vi.spyOn>;
  let getPrSpy: ReturnType<typeof vi.spyOn>;
  let rerunSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    prCounter = 0;
    await seedBase(db);
    // The cutover migration (0032) flips the engine to v2 in every fresh test
    // DB. This suite exercises the LEGACY v1 processor (kept until the cleanup
    // push), so pin the flag back or every tick would stand down.
    await db
      .update(settingsTable)
      .set({ value: 'v1' })
      .where(eq(settingsTable.key, 'merge_queue_engine'));
    mergeSpy = vi
      .spyOn(githubService, 'mergePullRequest')
      .mockResolvedValue({ sha: 'merged-sha', merged: true, message: 'ok' });
    // The failure-path "is it actually merged?" REST verify. Default: still
    // open — failure paths behave as genuine failures unless a test says
    // otherwise.
    getPrSpy = vi
      .spyOn(githubService, 'getPullRequest')
      .mockResolvedValue({ state: 'open', merged: false, merged_at: null } as never);
    // Failed-check rerun after an App-refused merge. Default: nothing could
    // be re-run, so refusal paths land in `blocked` unless a test grants it.
    rerunSpy = vi
      .spyOn(githubService, 'rerequestFailedCheckRuns')
      .mockResolvedValue({ requested: 0, reason: 'no-failing-check-runs' });
    // Stub the post-failure refetch so it doesn't hit GitHub; tests assert it
    // fires. The top-of-tick freshness refresh is skipped (fresh lastPolledAt).
    refreshSpy = vi.spyOn(prMonitorService, 'refreshPr').mockResolvedValue(undefined);
    // The one-time "PR blocked" broadcast — tests assert it fires once on the
    // transition and never on a re-tick while already blocked.
    blockedSpy = vi.spyOn(websocketModule, 'emitMergeQueueBlocked').mockImplementation(() => {});
    // Signing gate defaults: no repo requires signed commits, nothing unsigned —
    // so the gate is a no-op and every non-signing test is unaffected.
    mockRequiresSigning.mockReset().mockResolvedValue(false);
    mockUnsignedCount.mockReset().mockResolvedValue(0);
    mockMarkSigning.mockReset();
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    githubRateGate._reset();
  });

  it('merges a clean queued PR and drops it off the queue', async () => {
    const prId = await insertPr(db, { summary: cleanSummary() });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(await countTasks(db)).toBe(0); // no cloud fix run needed
    const pr = await getPr(db, prId);
    expect(pr.state).toBe('merged');
    expect(pr.mergeQueued).toBe(false);
    expect(pr.mergeQueueState).toBeNull();
    expect(pr.mergedAt).toBeTruthy();
  });

  it('processes independent groups concurrently — a slow group never gates another', async () => {
    // Two distinct (workspace, repo, base) groups. They must drain in parallel
    // so one slow GitHub round-trip can't hold the re-entrancy guard while the
    // other waits (the "stuck queue" symptom). Barrier proof: each merge blocks
    // until BOTH have started — serial processing would await a second call that
    // never starts and deadlock (test times out); parallel lets both proceed.
    await db.insert(repositoriesTable).values({
      id: 'repo2',
      workspaceId: 'ws1',
      name: 'a/c',
      url: 'https://github.com/a/c',
      defaultBranch: 'main',
    });
    const a = await insertPr(db, { summary: cleanSummary(), repositoryId: 'repo1' });
    const b = await insertPr(db, { summary: cleanSummary(), repositoryId: 'repo2' });

    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    mergeSpy.mockImplementation((async () => {
      started += 1;
      if (started === 2) release();
      await bothStarted;
      return { sha: 'merged-sha', merged: true, message: 'ok' };
    }) as never);

    await mergeQueueProcessor.runOnce();

    expect(started).toBe(2); // both groups were in-flight at once
    expect((await getPr(db, a)).mergeQueued).toBe(false);
    expect((await getPr(db, b)).mergeQueued).toBe(false);
  });

  it('merges with the configured merge method', async () => {
    await insertPr(db, { summary: cleanSummary(), mergeMethod: 'merge' });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledWith('ws1', 'a', 'b', expect.any(Number), {
      merge_method: 'merge',
    });
  });

  it('fires a cloud fix run for a conflicting PR instead of merging', async () => {
    const createdSpy = vi.spyOn(websocketModule, 'emitTaskCreated');
    const prId = await insertPr(db, { summary: conflictSummary() });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).not.toHaveBeenCalled();
    const tasks = await db.select().from(tasksTable);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('pr_response');
    const pr = await getPr(db, prId);
    const state = pr.mergeQueueState as QueueState;
    expect(state.status).toBe('fixing');
    expect(state.lastFixTaskId).toBe(tasks[0].id);
    expect(state.accounted).toBe(false);
    expect(pr.taskId).toBe(tasks[0].id); // reverse-linked

    // Broadcast task:created so the desktop adds this backend-made fix run to
    // the Tasks list live (and the PR's task badge resolves to it).
    expect(createdSpy).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ id: tasks[0].id, type: 'pr_response' })
    );
  });

  it('renders the workspace mergeable prompt override into the fix run', async () => {
    await db
      .update(workspacesTable)
      .set({
        settings: {
          prompts: {
            mergeable: {
              template: 'Custom for {{pr.ref}} on {{pr.headBranch}}\n{{gitRules}}',
              basedOnHash: '00000000',
              updatedAt: 'then',
            },
          },
        },
      })
      .where(eq(workspacesTable.id, 'ws1'));
    await insertPr(db, { summary: conflictSummary() });

    await mergeQueueProcessor.runOnce();

    const tasks = await db.select({ prompt: tasksTable.prompt }).from(tasksTable);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt?.startsWith('Custom for a/b#')).toBe(true);
    expect(tasks[0].prompt).toContain(' on feat');
    expect(tasks[0].prompt).toContain('git_signed_commit');
    expect(tasks[0].prompt).not.toContain('Every reviewer comment');
  });

  describe('free-plan task limit', () => {
    const savedPolarToken = process.env.POLAR_ACCESS_TOKEN;

    beforeEach(async () => {
      // Billing configured → the 3-active-task limit is enforced. Fill the
      // owner's slots with tasks unrelated to any queued PR.
      process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
      await insertTask(db, 'filler-1', 'queued', 'pr-none');
      await insertTask(db, 'filler-2', 'in_progress', 'pr-none');
      await insertTask(db, 'filler-3', 'pending', 'pr-none');
    });

    afterEach(() => {
      if (savedPolarToken === undefined) delete process.env.POLAR_ACCESS_TOKEN;
      else process.env.POLAR_ACCESS_TOKEN = savedPolarToken;
    });

    it('holds a conflicting PR as waiting at the limit — no task, no attempt, no blocked badge', async () => {
      const prId = await insertPr(db, { summary: conflictSummary() });

      await mergeQueueProcessor.runOnce();

      expect(mergeSpy).not.toHaveBeenCalled();
      expect(await countTasks(db)).toBe(3); // no fix run created
      const pr = await getPr(db, prId);
      const state = pr.mergeQueueState as QueueState;
      expect(state.status).toBe('waiting');
      expect(state.attempts ?? 0).toBe(0);
      expect(state.lastFixTaskId).toBeUndefined();
      expect(blockedSpy).not.toHaveBeenCalled();
    });

    it('fires the fix run on a later tick once a slot frees', async () => {
      const prId = await insertPr(db, { summary: conflictSummary() });
      await mergeQueueProcessor.runOnce();
      expect(await countTasks(db)).toBe(3);

      await db
        .update(tasksTable)
        .set({ status: 'completed' })
        .where(eq(tasksTable.id, 'filler-1'));
      await mergeQueueProcessor.runOnce();

      expect(await countTasks(db)).toBe(4);
      const pr = await getPr(db, prId);
      expect((pr.mergeQueueState as QueueState).status).toBe('fixing');
    });

    it('comped owner is never held', async () => {
      const { users } = await import('../db/schema.js');
      await db.update(users).set({ planOverride: 'unlimited' }).where(eq(users.id, OWNER));
      const prId = await insertPr(db, { summary: conflictSummary() });

      await mergeQueueProcessor.runOnce();

      expect(await countTasks(db)).toBe(4);
      const pr = await getPr(db, prId);
      expect((pr.mergeQueueState as QueueState).status).toBe('fixing');
    });
  });

  it('funnels a BEHIND PR into the same fix path (the post-merge race)', async () => {
    await insertPr(db, { summary: behindSummary() });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).not.toHaveBeenCalled(); // would bounce with merged:false
    expect(await countTasks(db)).toBe(1);
  });

  it('waits (does not fire, merge, or block) while the head\'s CI is still in flight', async () => {
    // GitHub reports a PR with queued/in-progress required checks as
    // mergeStateStatus=BLOCKED — the queue must let CI settle, not treat the
    // pending checks as a hard blocker and fire a doomed fix run.
    const prId = await insertPr(db, { summary: pendingChecksSummary() });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(await countTasks(db)).toBe(0); // no fix run
    const pr = await getPr(db, prId);
    const state = pr.mergeQueueState as QueueState;
    expect(state.status).toBe('waiting');
    expect(state.attempts).toBe(0); // no attempt counted against pending CI
    expect(blockedSpy).not.toHaveBeenCalled();
  });

  it('does not count an attempt or block a PR that is still running CI after a fix run', async () => {
    // A fix run pushed commits and went terminal; CI re-triggered and is still
    // in flight. The PR reads BLOCKED (pending checks), but that must NOT be
    // accounted as another failed attempt or it would march toward `blocked`.
    await insertTask(db, 'task-ci', 'completed', 'pr-x');
    const prId = await insertPr(db, {
      summary: pendingChecksSummary(),
      mergeQueueState: {
        status: 'fixing',
        attempts: 2,
        lastFixTaskId: 'task-ci',
        accounted: false,
      },
    });

    await mergeQueueProcessor.runOnce();

    expect(await countTasks(db)).toBe(1); // only the pre-seeded task; none fired
    const pr = await getPr(db, prId);
    const state = pr.mergeQueueState as QueueState;
    expect(state.status).toBe('waiting');
    expect(state.attempts).toBe(2); // held, not incremented to the cap
    expect(blockedSpy).not.toHaveBeenCalled();
  });

  it('still fires the fix path for a BEHIND PR even while its CI is in flight', async () => {
    // Pending checks alone → wait; but a settled blocker (BEHIND) means a fix
    // run should merge the base in now, regardless of in-flight checks.
    await insertPr(db, {
      summary: {
        ...pendingChecksSummary(),
        mergeStateStatus: 'BEHIND',
      },
    });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(await countTasks(db)).toBe(1); // BEHIND wins — fix run fires
  });

  it('does not fire or merge while a fix run is in flight', async () => {
    const prId = await insertPr(db, { summary: conflictSummary() });
    await insertTask(db, 'running', 'in_progress', prId);
    await db.update(pullRequestsTable).set({ taskId: 'running' }).where(eq(pullRequestsTable.id, prId));

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(await countTasks(db)).toBe(1); // only the pre-existing run
    const pr = await getPr(db, prId);
    expect((pr.mergeQueueState as QueueState).status).toBe('fixing');
  });

  it('merges a now-clean PR even while its fix run is still in flight', async () => {
    // The fix run landed its commits + checks went green, but its task status
    // hasn't flipped terminal yet. A ready PR shouldn't wait on that flip.
    const prId = await insertPr(db, {
      summary: cleanSummary(),
      mergeQueueState: { status: 'fixing', attempts: 0, lastFixTaskId: 'running', accounted: false },
    });
    await insertTask(db, 'running', 'in_progress', prId);
    await db.update(pullRequestsTable).set({ taskId: 'running' }).where(eq(pullRequestsTable.id, prId));

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    const pr = await getPr(db, prId);
    expect(pr.state).toBe('merged');
    expect(pr.mergeQueued).toBe(false);
    expect(pr.mergeQueueState).toBeNull();
  });

  it('serializes two same-base PRs — only the head merges per tick', async () => {
    const first = await insertPr(db, {
      summary: cleanSummary('main'),
      mergeQueuedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const second = await insertPr(db, {
      summary: cleanSummary('main'),
      mergeQueuedAt: new Date('2026-06-01T00:01:00Z'),
    });

    await mergeQueueProcessor.runOnce();

    // Exactly one merge — the earlier-queued head.
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect((await getPr(db, first)).state).toBe('merged');
    const secondRow = await getPr(db, second);
    expect(secondRow.state).toBe('open');
    expect(secondRow.mergeQueued).toBe(true);

    // Next tick: the second is now the head and merges.
    await mergeQueueProcessor.runOnce();
    expect(mergeSpy).toHaveBeenCalledTimes(2);
    expect((await getPr(db, second)).state).toBe('merged');
  });

  it('merges different-base PRs in parallel within one tick', async () => {
    const a = await insertPr(db, { summary: cleanSummary('main') });
    const b = await insertPr(db, { summary: cleanSummary('develop') });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledTimes(2);
    expect((await getPr(db, a)).state).toBe('merged');
    expect((await getPr(db, b)).state).toBe('merged');
  });

  it('blocks after MAX_ATTEMPTS consecutive failed fix runs and notifies once with the reason', async () => {
    const prId = await insertPr(db, {
      summary: conflictSummary(),
      mergeQueueState: { status: 'fixing', attempts: 2, lastFixTaskId: 'prev', accounted: false },
    });
    await insertTask(db, 'prev', 'completed', prId);
    await db.update(pullRequestsTable).set({ taskId: 'prev' }).where(eq(pullRequestsTable.id, prId));

    await mergeQueueProcessor.runOnce();

    const pr = await getPr(db, prId);
    const state = pr.mergeQueueState as QueueState;
    expect(state.attempts).toBe(3);
    expect(state.status).toBe('blocked');
    expect(mergeSpy).not.toHaveBeenCalled();
    expect(await countTasks(db)).toBe(1); // only 'prev' — no new run

    // Fired the one-time blocked notification with the human reason.
    expect(blockedSpy).toHaveBeenCalledTimes(1);
    expect(blockedSpy).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({
        pullRequestId: prId,
        number: expect.any(Number),
        reason: 'merge conflicts with the base branch',
        attempts: 3,
      })
    );
  });

  it('does not re-notify on a re-tick while already blocked', async () => {
    // Already blocked (the transition happened on a prior tick), still conflicting.
    const prId = await insertPr(db, {
      summary: conflictSummary(),
      mergeQueueState: {
        status: 'blocked',
        attempts: 3,
        accounted: true,
        blockReason: 'merge conflicts with the base branch',
      },
    });

    await mergeQueueProcessor.runOnce();

    expect((await getPr(db, prId)).mergeQueueState).toMatchObject({ status: 'blocked' });
    expect(blockedSpy).not.toHaveBeenCalled(); // no fresh transition → no ping
  });

  it('surfaces the blocked reason on the persisted state (for the badge tooltip)', async () => {
    const prId = await insertPr(db, {
      summary: conflictSummary(),
      mergeQueueState: { status: 'fixing', attempts: 2, lastFixTaskId: 'prev', accounted: false },
    });
    await insertTask(db, 'prev', 'completed', prId);
    await db.update(pullRequestsTable).set({ taskId: 'prev' }).where(eq(pullRequestsTable.id, prId));

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState & { blockReason?: string };
    expect(state.blockReason).toBe('merge conflicts with the base branch');
  });

  it('blocks an App-unmergeable failing-check PR and advances, without churning a fix run', async () => {
    // GitHub refuses the App a merge past a failing (non-required) check that
    // can't be re-run here. A cloud fix run can't grant the App merge permission,
    // and dispatching one left the PR stuck in 'fixing' gating the whole group —
    // so the queue BLOCKS this PR (with an actionable reason) and moves on to the
    // next queued PR. The 4b gate self-heals if the check later goes green.
    mergeSpy.mockRejectedValueOnce(
      new MergeNotPermittedForAppError('PostHog', 'posthog', new Error('403'))
    );
    const prId = await insertPr(db, {
      summary: { ...cleanSummary(), checks: { total: 5, failed: 1, inProgress: 0 } },
    });

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
      mergeForbidden?: string;
    };
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('blocked'); // blocked + advance, NOT a fix-run churn
    expect(state.mergeForbidden).toBe('failing-checks');
    expect(await countTasks(db)).toBe(0); // no fix run dispatched
    expect(blockedSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes a "fixing" head and merges it once the fix run has made it mergeable, even while that run is still active and the GraphQL budget is deferring', async () => {
    // The stale-cache stall: a fix run updated the branch (GitHub now CLEAN) but
    // the cached mergeStateStatus still reads BEHIND (queueBlocked), and the
    // opportunistic refresh is deferred for a big account — so the queue held
    // 'fixing' on a PR that was actually mergeable.
    vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(true); // budget in reserve
    await insertTask(db, 'fix-1', 'in_progress', 'pr-1'); // fix run still running
    const prId = await insertPr(db, {
      summary: { ...cleanSummary(), mergeStateStatus: 'BEHIND' }, // stale blocker
      mergeQueueState: { status: 'fixing', attempts: 1, lastFixTaskId: 'fix-1', accounted: false },
    });
    // Old enough that the freshness re-poll applies.
    await db
      .update(pullRequestsTable)
      .set({ lastPolledAt: new Date(Date.now() - 120_000) })
      .where(eq(pullRequestsTable.id, prId));
    // The refresh reflects the fix run's result: the branch is now up to date.
    refreshSpy.mockImplementation(async () => {
      await db
        .update(pullRequestsTable)
        .set({ lastSummary: cleanSummary(), lastPolledAt: new Date() })
        .where(eq(pullRequestsTable.id, prId));
    });

    await mergeQueueProcessor.runOnce();

    expect(refreshSpy).toHaveBeenCalled(); // refreshed despite the budget deferring
    expect((await getPr(db, prId)).state).toBe('merged'); // and merged, run still active
  });

  it('a ready PR still merges behind a head that only fails a non-required check (no head-of-line stall)', async () => {
    // Repro of the July 2026 stall: the head is mergeable but its only red check
    // is non-required, so the App won't merge it and re-runs it. That background
    // work must NOT gate the CLEAN PR queued behind it — it should merge this tick.
    mergeSpy.mockImplementation(async (_ws: unknown, _o: unknown, _r: unknown, num: unknown) => {
      if (num === 1) throw new MergeNotPermittedForAppError('PostHog', 'posthog', new Error('403'));
      return { sha: 'merged-sha', merged: true, message: 'ok' };
    });
    rerunSpy.mockResolvedValue({ requested: 1 }); // the head's failing check can be re-run
    const head = await insertPr(db, {
      summary: { ...cleanSummary(), checks: { total: 5, failed: 1, inProgress: 0 } },
      mergeQueuedAt: new Date(Date.now() - 1000),
    });
    const ready = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date() });

    await mergeQueueProcessor.runOnce();

    // The ready PR queued behind the stuck head merged this tick.
    expect((await getPr(db, ready)).state).toBe('merged');
    // The head did not merge (its check is still red) but re-ran it, not gating.
    expect((await getPr(db, head)).state).toBe('open');
    expect(rerunSpy).toHaveBeenCalled();
  });

  it('re-runs the failing checks on an App-refused merge instead of blocking, then merges when green', async () => {
    // The user-preferred path: GitHub refuses the App over a failing optional
    // check → re-run that check (bounded), wait for it, merge when green.
    mergeSpy.mockRejectedValueOnce(
      new MergeNotPermittedForAppError('PostHog', 'posthog', new Error('403'))
    );
    rerunSpy.mockResolvedValueOnce({ requested: 1 });
    const failingOptional = {
      ...cleanSummary(),
      checks: { total: 5, failed: 1, inProgress: 0 },
    };
    const prId = await insertPr(db, { summary: failingOptional });

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
      rerunAttempts?: number;
    };
    expect(rerunSpy).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('waiting'); // NOT blocked — the rerun is in flight
    expect(state.rerunAttempts).toBe(1);
    expect(blockedSpy).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalled(); // refetched so the rerun reads as in-flight CI

    // The re-run passes (summary refreshes green) — next tick merges.
    await db
      .update(pullRequestsTable)
      .set({ lastSummary: cleanSummary(), lastPolledAt: new Date() })
      .where(eq(pullRequestsTable.id, prId));
    await mergeQueueProcessor.runOnce();

    expect((await getPr(db, prId)).state).toBe('merged');
  });

  it('blocks with the ownership explanation when the failing check cannot be re-run via API', async () => {
    // The Depot case: rerequest only works for checks the calling app created,
    // so a third-party CI check is simply not re-runnable by Talyn. The budget
    // must be spent immediately — retrying an ownership refusal every tick
    // hammers GitHub for nothing.
    mergeSpy.mockRejectedValueOnce(
      new MergeNotPermittedForAppError('PostHog', 'posthog', new Error('403'))
    );
    rerunSpy.mockResolvedValue({ requested: 0, reason: 'not-rerequestable' });
    const prId = await insertPr(db, {
      summary: { ...cleanSummary(), checks: { total: 5, failed: 1, inProgress: 0 } },
      // Fix attempts already spent → exercises the terminal human-block path.
      mergeQueueState: { status: 'waiting', attempts: 3, accounted: true },
    });

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
      blockReason?: string;
      mergeForbidden?: string;
      rerunAttempts?: number;
    };
    expect(state.status).toBe('blocked');
    expect(state.mergeForbidden).toBe('failing-checks');
    expect(state.blockReason).toContain('only lets the app that created');
    expect(state.rerunAttempts).toBe(3); // budget spent — no per-tick hammering
    expect(blockedSpy).toHaveBeenCalledTimes(1);

    // Re-ticks: no further rerun sweeps, no merge attempts, no re-notify.
    rerunSpy.mockClear();
    await mergeQueueProcessor.runOnce();
    expect(rerunSpy).not.toHaveBeenCalled();
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(blockedSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks with the actions-permission hint when a failing Actions check cannot be re-run', async () => {
    mergeSpy.mockRejectedValueOnce(
      new MergeNotPermittedForAppError('PostHog', 'posthog', new Error('403'))
    );
    rerunSpy.mockResolvedValueOnce({ requested: 0, reason: 'needs-actions-permission' });
    const prId = await insertPr(db, {
      summary: { ...cleanSummary(), checks: { total: 5, failed: 1, inProgress: 0 } },
      // Fix attempts already spent → exercises the terminal human-block path.
      mergeQueueState: { status: 'waiting', attempts: 3, accounted: true },
    });

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
      blockReason?: string;
    };
    expect(state.status).toBe('blocked');
    expect(state.blockReason).toContain('Actions: Read & write');
  });

  it('blocks a failing-check PR once its rerun budget is spent, without churning a fix run', async () => {
    // Rerun budget already spent (a genuinely-broken, not just flaky, check).
    // The App still can't merge past it and a fix run can't grant permission — so
    // the queue blocks for a human and moves on, rather than dispatching a doomed
    // fix run that would leave the PR stuck in 'fixing'.
    mergeSpy.mockRejectedValue(
      new MergeNotPermittedForAppError('PostHog', 'posthog', new Error('403'))
    );
    const prId = await insertPr(db, {
      summary: { ...cleanSummary(), checks: { total: 5, failed: 1, inProgress: 0 } },
      mergeQueueState: { status: 'waiting', attempts: 0, rerunAttempts: 3 },
    });

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
      blockReason?: string;
    };
    expect(rerunSpy).not.toHaveBeenCalled(); // rerun budget spent
    expect(state.status).toBe('blocked'); // blocked, not a fix-run churn
    expect(await countTasks(db)).toBe(0); // no fix run dispatched
    expect(state.blockReason).toContain('kept failing');
    expect(blockedSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks with the exhausted reason once the rerun budget is spent', async () => {
    mergeSpy.mockRejectedValue(
      new MergeNotPermittedForAppError('PostHog', 'posthog', new Error('403'))
    );
    const prId = await insertPr(db, {
      summary: { ...cleanSummary(), checks: { total: 5, failed: 1, inProgress: 0 } },
      // Rerun budget spent: the failing check kept failing across reruns, and the
      // App still won't merge past it — so it waits for a human.
      mergeQueueState: { status: 'waiting', attempts: 3, rerunAttempts: 3 },
    });

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
      blockReason?: string;
      rerunAttempts?: number;
    };
    expect(rerunSpy).not.toHaveBeenCalled(); // budget spent — no more reruns
    expect(state.status).toBe('blocked');
    expect(state.rerunAttempts).toBe(3);
    expect(state.blockReason).toContain('kept failing');
  });

  it('re-runs failing checks from an already-blocked row (pre-permission-grant rows self-drive)', async () => {
    // A row blocked by an earlier deploy (or before checks:write was granted)
    // never attempts merges, so the merge-refusal rerun can't fire. The gate
    // itself must spend the rerun budget.
    rerunSpy.mockResolvedValueOnce({ requested: 1 });
    const prId = await insertPr(db, {
      summary: { ...cleanSummary(), checks: { total: 5, failed: 1, inProgress: 0 } },
      mergeQueueState: {
        status: 'blocked',
        attempts: 0,
        mergeForbidden: 'failing-checks',
        blockReason: 'previously blocked',
      },
    });

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
      rerunAttempts?: number;
      mergeForbidden?: string;
    };
    expect(rerunSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy).not.toHaveBeenCalled(); // still gated — no doomed merge attempt
    expect(state.status).toBe('waiting');
    expect(state.rerunAttempts).toBe(1);
    expect(blockedSpy).not.toHaveBeenCalled(); // no re-notify

    // Rerun passes → summary green → gate self-clears and the PR merges.
    await db
      .update(pullRequestsTable)
      .set({ lastSummary: cleanSummary(), lastPolledAt: new Date() })
      .where(eq(pullRequestsTable.id, prId));
    await mergeQueueProcessor.runOnce();
    expect((await getPr(db, prId)).state).toBe('merged');
  });

  it('stays blocked until requeue when the App is refused with no failing check to blame', async () => {
    // Unknown-cause refusal (nothing red on the head): retrying every tick
    // can't help, so the gate is sticky — a human merges or requeues.
    mergeSpy.mockRejectedValue(
      new MergeNotPermittedForAppError('PostHog', 'posthog', new Error('403'))
    );
    const prId = await insertPr(db, { summary: cleanSummary() });

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
      blockReason?: string;
      mergeForbidden?: string;
    };
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('blocked');
    expect(state.mergeForbidden).toBe('hard');
    expect(state.blockReason).toContain('Merge manually');
    expect(blockedSpy).toHaveBeenCalledTimes(1);

    await mergeQueueProcessor.runOnce();
    await mergeQueueProcessor.runOnce();
    expect(mergeSpy).toHaveBeenCalledTimes(1); // never re-attempted
    expect(blockedSpy).toHaveBeenCalledTimes(1); // never re-notified
    expect((await getPr(db, prId)).mergeQueued).toBe(true); // stays queued for the badge
  });

  describe('draft head', () => {
    it('does NOT attempt a merge, blocks with a draft reason, and advances so a ready sibling merges', async () => {
      const draft = await insertPr(db, {
        summary: draftSummary(),
        mergeQueuedAt: new Date(Date.now() - 1000),
      });
      const ready = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date() });

      await mergeQueueProcessor.runOnce();

      const draftState = (await getPr(db, draft)).mergeQueueState as QueueState & {
        blockReason?: string;
      };
      expect((await getPr(db, draft)).state).toBe('open'); // never merged
      expect(draftState.status).toBe('blocked');
      expect(draftState.blockReason).toMatch(/draft/i);
      // The ready PR queued behind the draft merged this tick — not gated.
      expect((await getPr(db, ready)).state).toBe('merged');
      // Only the ready PR was merge-attempted; the draft never hit the API.
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(await countTasks(db)).toBe(0); // and no fix run dispatched
    });

    it('detects a draft via mergeStateStatus even without the draft flag', async () => {
      const prId = await insertPr(db, { summary: { ...cleanSummary(), mergeStateStatus: 'DRAFT' } });

      await mergeQueueProcessor.runOnce();

      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await getPr(db, prId)).mergeQueueState).toMatchObject({ status: 'blocked' });
    });

    it('does not send a blocked notification for a draft, and does not churn writes on re-ticks', async () => {
      const prId = await insertPr(db, { summary: draftSummary() });

      await mergeQueueProcessor.runOnce();
      expect(blockedSpy).not.toHaveBeenCalled(); // a draft isn't a queue failure
      expect(mergeSpy).not.toHaveBeenCalled();

      await mergeQueueProcessor.runOnce();
      await mergeQueueProcessor.runOnce();
      expect(blockedSpy).not.toHaveBeenCalled();
      expect((await getPr(db, prId)).mergeQueueState).toMatchObject({ status: 'blocked' });
    });

    it('merges once the PR is marked ready for review (self-heals from the draft block)', async () => {
      const prId = await insertPr(db, {
        summary: cleanSummary(), // no longer a draft
        mergeQueueState: { status: 'blocked', attempts: 0, blockReason: 'This PR is a draft — mark it ready…' },
      });

      await mergeQueueProcessor.runOnce();

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect((await getPr(db, prId)).state).toBe('merged');
    });
  });

  describe('signed-commits gate', () => {
    it('does NOT fetch signatures on a repo that does not require signed commits', async () => {
      mockRequiresSigning.mockResolvedValue(false);
      const prId = await insertPr(db, { summary: cleanSummary() });

      await mergeQueueProcessor.runOnce();

      expect(mockUnsignedCount).not.toHaveBeenCalled(); // egress guard — no signature query
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect((await getPr(db, prId)).state).toBe('merged');
    });

    it('merges normally when the base requires signing and every commit is signed', async () => {
      mockRequiresSigning.mockResolvedValue(true);
      mockUnsignedCount.mockResolvedValue(0);
      const prId = await insertPr(db, { summary: cleanSummary() });

      await mergeQueueProcessor.runOnce();

      expect(mockUnsignedCount).toHaveBeenCalledTimes(1);
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect((await getPr(db, prId)).state).toBe('merged');
    });

    it('re-signs (fix run) instead of attempting a doomed merge when commits are unsigned', async () => {
      mockRequiresSigning.mockResolvedValue(true);
      mockUnsignedCount.mockResolvedValue(2);
      const prId = await insertPr(db, { summary: cleanSummary() });

      await mergeQueueProcessor.runOnce();

      const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
        resignAttempts?: number;
      };
      expect(mergeSpy).not.toHaveBeenCalled(); // never attempted the doomed merge
      expect(state.status).toBe('fixing');
      expect(state.resignAttempts).toBe(1);
      expect(await countTasks(db)).toBe(1); // a re-sign fix run was dispatched
      expect(blockedSpy).not.toHaveBeenCalled();
    });

    it('does not fire a second re-sign run while one is already in flight', async () => {
      mockRequiresSigning.mockResolvedValue(true);
      mockUnsignedCount.mockResolvedValue(2);
      const prId = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueueState: {
          status: 'fixing',
          attempts: 0,
          resignAttempts: 1,
          lastFixTaskId: 'resign-1',
          accounted: false,
        },
      });
      await insertTask(db, 'resign-1', 'in_progress', prId);

      await mergeQueueProcessor.runOnce();

      const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
        resignAttempts?: number;
      };
      expect(state.status).toBe('fixing');
      expect(state.resignAttempts).toBe(1); // not bumped — didn't pile on a second run
      expect(await countTasks(db)).toBe(1); // still just the in-flight one
      expect(mergeSpy).not.toHaveBeenCalled();
      expect(mockUnsignedCount).not.toHaveBeenCalled(); // no per-tick signature poll while a run is in flight
    });

    it('defers the signing check (no signature fetch, no merge) when the GraphQL budget is in reserve', async () => {
      mockRequiresSigning.mockResolvedValue(true);
      mockUnsignedCount.mockResolvedValue(2);
      vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(true); // budget in reserve
      const prId = await insertPr(db, { summary: cleanSummary() });

      await mergeQueueProcessor.runOnce();

      expect(mockUnsignedCount).not.toHaveBeenCalled(); // didn't spend a scarce point on signatures
      expect(mergeSpy).not.toHaveBeenCalled(); // and didn't attempt the doomed merge
      expect((await getPr(db, prId)).state).toBe('open'); // deferred to a later tick
    });

    it('blocks with the signing reason once the re-sign budget is spent', async () => {
      mockRequiresSigning.mockResolvedValue(true);
      mockUnsignedCount.mockResolvedValue(1);
      const prId = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueueState: { status: 'fixing', attempts: 0, resignAttempts: 3 },
      });

      await mergeQueueProcessor.runOnce();

      const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
        mergeForbidden?: string;
        blockReason?: string;
      };
      expect(mergeSpy).not.toHaveBeenCalled();
      expect(state.status).toBe('blocked');
      expect(state.mergeForbidden).toBe('unsigned-commits');
      expect(state.blockReason).toContain('signed commits');
      expect(await countTasks(db)).toBe(0); // no new fix run past the budget
      expect(blockedSpy).toHaveBeenCalledTimes(1);

      // Re-tick: stays blocked, never re-polls signatures or re-attempts.
      mockUnsignedCount.mockClear();
      await mergeQueueProcessor.runOnce();
      expect(mockUnsignedCount).not.toHaveBeenCalled();
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('learns from a 403: re-signs (not hard-blocks) when unsigned commits are visible after a refusal', async () => {
      // Proactive probe missed it (returns false — e.g. the App can't read the
      // ruleset), so 5a is a no-op and the merge is attempted → 403. The 403 net
      // then SEES unsigned commits, records the requirement, and re-signs.
      mockRequiresSigning.mockResolvedValue(false);
      mockUnsignedCount.mockResolvedValue(3);
      mergeSpy.mockRejectedValueOnce(
        new MergeNotPermittedForAppError('PostHog', 'posthog', new Error('403'))
      );
      const prId = await insertPr(db, { summary: cleanSummary() });

      await mergeQueueProcessor.runOnce();

      const state = (await getPr(db, prId)).mergeQueueState as QueueState & {
        resignAttempts?: number;
      };
      expect(mergeSpy).toHaveBeenCalledTimes(1); // attempted, got the 403
      expect(mockMarkSigning).toHaveBeenCalled(); // recorded so future PRs are proactive
      expect(state.status).toBe('fixing'); // re-sign, NOT a hard block
      expect(state.resignAttempts).toBe(1);
      expect(await countTasks(db)).toBe(1);
    });
  });

  it('does not reset the attempt counter on a transient clean reading (cap-evasion)', async () => {
    // Mid-loop: 2 runs already spent, the last one terminal. The cached summary
    // momentarily reads CLEAN (the post-push UNKNOWN window) but the merge then
    // bounces — the PR isn't really fixed. The counter must NOT reset to 0, or
    // the 3-attempt cap would never trip and the queue fires fix runs forever.
    mergeSpy.mockResolvedValueOnce({ sha: '', merged: false, message: 'still conflicting' });
    const prId = await insertPr(db, {
      summary: cleanSummary(),
      mergeQueueState: { status: 'fixing', attempts: 2, lastFixTaskId: 'prev', accounted: false },
    });
    await insertTask(db, 'prev', 'completed', prId);

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState;
    expect(state.attempts).toBe(2); // held — NOT reset to 0
  });

  it('never fires past the retry budget, even after a failed-merge flap downgraded the status', async () => {
    // Budget already spent (attempts == MAX) but status was knocked back to
    // 'waiting' by an earlier failed merge on a transient clean reading. The
    // hard cap must re-settle it to 'blocked' and fire nothing.
    const prId = await insertPr(db, {
      summary: conflictSummary(),
      mergeQueueState: { status: 'waiting', attempts: 3, accounted: true },
    });

    await mergeQueueProcessor.runOnce();

    expect(await countTasks(db)).toBe(0); // no 4th run
    expect(mergeSpy).not.toHaveBeenCalled();
    expect((await getPr(db, prId)).mergeQueueState).toMatchObject({ status: 'blocked' });
  });

  it('does not fire a duplicate while its own run is active, even if row.taskId was reassigned', async () => {
    // The queue fired 'qfix' (still in flight). Another flow then reassigned the
    // PR's row.taskId to a now-completed task 'other'. The guard must recognise
    // the queue's OWN run (qfix) as active and back off — keying only on
    // row.taskId would miss it and fire a concurrent duplicate.
    const prId = await insertPr(db, {
      summary: conflictSummary(),
      mergeQueueState: { status: 'fixing', attempts: 1, lastFixTaskId: 'qfix', accounted: false },
    });
    await insertTask(db, 'qfix', 'in_progress', prId);
    await insertTask(db, 'other', 'completed', prId);
    await db.update(pullRequestsTable).set({ taskId: 'other' }).where(eq(pullRequestsTable.id, prId));

    await mergeQueueProcessor.runOnce();

    expect(await countTasks(db)).toBe(2); // qfix + other — no duplicate fired
    expect(mergeSpy).not.toHaveBeenCalled();
    expect((await getPr(db, prId)).mergeQueueState).toMatchObject({ status: 'fixing' });
  });

  // A hard-blocked head must not gate the PRs queued behind it — the tick
  // walks past it to the first actionable PR, while still merging at most one
  // same-base PR per tick.
  describe('blocked head skipping', () => {
    it('skips a blocked head and merges the next same-base PR in the same tick', async () => {
      const blocked = await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(1000),
        mergeQueueState: {
          status: 'blocked',
          attempts: 3,
          accounted: true,
          blockReason: 'merge conflicts with the base branch',
        },
      });
      const next = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueuedAt: new Date(2000),
      });

      await mergeQueueProcessor.runOnce();

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect((await getPr(db, next)).state).toBe('merged');
      // The blocked head is untouched: still queued, still blocked, no re-ping.
      const blockedRow = await getPr(db, blocked);
      expect(blockedRow.state).toBe('open');
      expect(blockedRow.mergeQueued).toBe(true);
      expect(blockedRow.mergeQueueState).toMatchObject({ status: 'blocked', attempts: 3 });
      expect(blockedSpy).not.toHaveBeenCalled();
    });

    it('skips multiple blocked PRs to reach the first actionable one', async () => {
      await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(1000),
        mergeQueueState: { status: 'blocked', attempts: 3, accounted: true },
      });
      await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(2000),
        mergeQueueState: { status: 'blocked', attempts: 3, accounted: true },
      });
      const third = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueuedAt: new Date(3000),
      });

      await mergeQueueProcessor.runOnce();

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect((await getPr(db, third)).state).toBe('merged');
    });

    it('still merges only one same-base PR per tick after skipping a blocked head', async () => {
      await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(1000),
        mergeQueueState: { status: 'blocked', attempts: 3, accounted: true },
      });
      const second = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueuedAt: new Date(2000),
      });
      const third = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueuedAt: new Date(3000),
      });

      await mergeQueueProcessor.runOnce();

      // The first actionable PR consumed the group's turn.
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect((await getPr(db, second)).state).toBe('merged');
      expect((await getPr(db, third)).state).toBe('open');
    });

    it('fires the fix run for a conflicting PR sitting behind a blocked head', async () => {
      await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(1000),
        mergeQueueState: { status: 'blocked', attempts: 3, accounted: true },
      });
      const second = await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(2000),
      });

      await mergeQueueProcessor.runOnce();

      expect(await countTasks(db)).toBe(1); // the second PR's fix run
      const state = (await getPr(db, second)).mergeQueueState as QueueState;
      expect(state.status).toBe('fixing');
    });

    it('lets a blocked head that reads clean re-arm and consume the turn', async () => {
      const blocked = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueuedAt: new Date(1000),
        mergeQueueState: { status: 'blocked', attempts: 3, accounted: true },
      });
      const second = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueuedAt: new Date(2000),
      });

      await mergeQueueProcessor.runOnce();

      // The recovered head merges; the second still waits its turn.
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect((await getPr(db, blocked)).state).toBe('merged');
      expect((await getPr(db, second)).state).toBe('open');
    });

    it('skips past a head re-settled to blocked by the hard cap, in the same tick', async () => {
      // Budget spent but status flapped to 'waiting' — the hard cap re-settles
      // it to 'blocked' and the next PR proceeds without waiting a tick.
      const capped = await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(1000),
        mergeQueueState: { status: 'waiting', attempts: 3, accounted: true },
      });
      const next = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueuedAt: new Date(2000),
      });

      await mergeQueueProcessor.runOnce();

      expect((await getPr(db, capped)).mergeQueueState).toMatchObject({ status: 'blocked' });
      expect((await getPr(db, next)).state).toBe('merged');
      expect(await countTasks(db)).toBe(0); // no 4th fix run for the capped head
    });

    it('advances past a head in the very tick it transitions to blocked, notifying once', async () => {
      const justBlocking = await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(1000),
        mergeQueueState: { status: 'fixing', attempts: 2, lastFixTaskId: 'prev', accounted: false },
      });
      await insertTask(db, 'prev', 'completed', justBlocking);
      await db
        .update(pullRequestsTable)
        .set({ taskId: 'prev' })
        .where(eq(pullRequestsTable.id, justBlocking));
      const next = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueuedAt: new Date(2000),
      });

      await mergeQueueProcessor.runOnce();

      expect((await getPr(db, justBlocking)).mergeQueueState).toMatchObject({
        status: 'blocked',
        attempts: 3,
      });
      expect(blockedSpy).toHaveBeenCalledTimes(1);
      expect((await getPr(db, next)).state).toBe('merged');
    });

    it('holds the group while the head is fixing — only hard-blocked heads are skipped', async () => {
      const fixing = await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(1000),
        mergeQueueState: { status: 'fixing', attempts: 1, lastFixTaskId: 'running', accounted: false },
      });
      await insertTask(db, 'running', 'in_progress', fixing);
      const second = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueuedAt: new Date(2000),
      });

      await mergeQueueProcessor.runOnce();

      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await getPr(db, second)).state).toBe('open');
    });

    it('echoes the acted-on PR\'s real queue position on the WS badge', async () => {
      await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(1000),
        mergeQueueState: { status: 'blocked', attempts: 3, accounted: true },
      });
      const second = await insertPr(db, {
        summary: conflictSummary(),
        mergeQueuedAt: new Date(2000),
      });
      const emitSpy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');

      await mergeQueueProcessor.runOnce();

      const echo = emitSpy.mock.calls
        .map((c) => c[1] as { id: string; mergeQueueState?: { status: string; position: number } | null })
        .filter((p) => p.id === second && p.mergeQueueState)
        .pop();
      expect(echo?.mergeQueueState).toMatchObject({ status: 'fixing', position: 2 });
    });
  });

  it('re-arms a blocked PR once it is observed clean, then merges it', async () => {
    await insertPr(db, {
      summary: cleanSummary(),
      mergeQueueState: { status: 'blocked', attempts: 3, accounted: true },
    });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps a PR queued when GitHub returns merged:false', async () => {
    mergeSpy.mockResolvedValueOnce({ sha: '', merged: false, message: 'Base branch was modified' });
    const prId = await insertPr(db, { summary: cleanSummary() });

    await mergeQueueProcessor.runOnce();

    const pr = await getPr(db, prId);
    expect(pr.state).toBe('open');
    expect(pr.mergeQueued).toBe(true);
    const state = pr.mergeQueueState as QueueState;
    expect(state.status).toBe('waiting');
    expect(state.lastError).toContain('Base branch was modified');
    // Reacted to the failed merge by refetching so the BEHIND/conflict state
    // surfaces now instead of after FRESHNESS_MS.
    expect(refreshSpy).toHaveBeenCalledWith('ws1', 'a', 'b', expect.any(Number));
  });

  it('keeps a PR queued and refetches when the merge throws (e.g. 405 conflicts)', async () => {
    mergeSpy.mockRejectedValueOnce(
      new Error('GitHub API error 405 Method Not Allowed: Pull Request has merge conflicts')
    );
    const prId = await insertPr(db, { summary: cleanSummary() });

    await expect(mergeQueueProcessor.runOnce()).resolves.toBeUndefined();

    const pr = await getPr(db, prId);
    expect(pr.state).toBe('open');
    expect(pr.mergeQueued).toBe(true);
    expect((pr.mergeQueueState as QueueState).lastError).toContain('merge conflicts');
    // The 405 means our cached mergeability was stale — refetch immediately so
    // the conflict hits the cache + UI and the next tick fires the fix run.
    expect(refreshSpy).toHaveBeenCalledWith('ws1', 'a', 'b', expect.any(Number));
  });

  it('does not refetch after a successful merge', async () => {
    await insertPr(db, { summary: cleanSummary() });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  // The June 2026 prod incident class: GitHub completes the merge but we never
  // record it (lost response, wedged tick, redeploy mid-merge, or an external
  // merge). The REST "is it actually merged?" verify must turn each of these
  // failure paths into the success path, or the queue stalls forever behind a
  // head it keeps trying to re-merge.
  describe('verify-merged recovery', () => {
    it('records the merge when the attempt throws 405 but GitHub says merged', async () => {
      mergeSpy.mockRejectedValueOnce(
        new Error('GitHub API error 405 Method Not Allowed: Pull Request is not mergeable')
      );
      getPrSpy.mockResolvedValueOnce({
        state: 'closed',
        merged: true,
        merged_at: '2026-06-11T19:13:50Z',
      } as never);
      const prId = await insertPr(db, { summary: cleanSummary() });

      await mergeQueueProcessor.runOnce();

      const pr = await getPr(db, prId);
      expect(pr.state).toBe('merged');
      expect(pr.mergeQueued).toBe(false);
      expect(pr.mergeQueueState).toBeNull();
      expect(pr.mergedAt).toBeTruthy();
      // Recovery is a success, not a failure — no doomed refetch loop.
      expect(refreshSpy).not.toHaveBeenCalled();
    });

    it('records the merge when GitHub returns merged:false but the PR is in fact merged', async () => {
      mergeSpy.mockResolvedValueOnce({ sha: '', merged: false, message: 'Already merged' });
      getPrSpy.mockResolvedValueOnce({
        state: 'closed',
        merged: true,
        merged_at: '2026-06-11T19:13:50Z',
      } as never);
      const prId = await insertPr(db, { summary: cleanSummary() });

      await mergeQueueProcessor.runOnce();

      const pr = await getPr(db, prId);
      expect(pr.state).toBe('merged');
      expect(pr.mergeQueued).toBe(false);
    });

    it('recovers a head stuck in status=merging from a tick that died mid-merge', async () => {
      // The row a wedged/killed tick leaves behind: open + queued +
      // status='merging', while GitHub already merged the PR.
      getPrSpy.mockResolvedValue({
        state: 'closed',
        merged: true,
        merged_at: '2026-06-11T19:13:50Z',
      } as never);
      const prId = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueueState: { status: 'merging', attempts: 0, accounted: true },
      });

      await mergeQueueProcessor.runOnce();

      const pr = await getPr(db, prId);
      expect(pr.state).toBe('merged');
      expect(pr.mergeQueued).toBe(false);
      // Recovered WITHOUT re-attempting the merge.
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('proceeds normally on re-entry with status=merging when GitHub says still open', async () => {
      const prId = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueueState: { status: 'merging', attempts: 0, accounted: true },
      });

      await mergeQueueProcessor.runOnce();

      // Not merged upstream → falls through to a fresh merge attempt.
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      const pr = await getPr(db, prId);
      expect(pr.state).toBe('merged');
    });

    it('advances the next same-base PR on the tick after a 405-recovery', async () => {
      mergeSpy.mockRejectedValueOnce(new Error('405 Pull Request is not mergeable'));
      getPrSpy.mockResolvedValueOnce({
        state: 'closed',
        merged: true,
        merged_at: '2026-06-11T19:13:50Z',
      } as never);
      const first = await insertPr(db, {
        summary: cleanSummary(),
        mergeQueuedAt: new Date(Date.now() - 60_000),
      });
      const second = await insertPr(db, { summary: cleanSummary() });

      await mergeQueueProcessor.runOnce(); // head recovers via verify
      await mergeQueueProcessor.runOnce(); // next PR becomes head and merges

      expect((await getPr(db, first)).state).toBe('merged');
      expect((await getPr(db, second)).state).toBe('merged');
      expect(mergeSpy).toHaveBeenCalledTimes(2); // 1 failed head + 1 clean second
    });
  });

  // The tick's opening self-heal: rows that left `open` while still flagged
  // queued (a sweep flipped the state without the reset) are invisible to the
  // open-only head select, so their stale flags must be scrubbed here.
  describe('stale queue-flag self-heal', () => {
    it('clears queue bookkeeping on a queued row that is no longer open', async () => {
      const prId = await insertPr(db, {
        summary: cleanSummary(),
        state: 'merged',
        mergeQueueState: { status: 'merging', attempts: 0, accounted: true },
      });

      await mergeQueueProcessor.runOnce();

      const pr = await getPr(db, prId);
      expect(pr.mergeQueued).toBe(false);
      expect(pr.mergeQueuedAt).toBeNull();
      expect(pr.mergeQueueState).toBeNull();
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('leaves open queued rows untouched', async () => {
      // Conflicting → stays queued through the tick (fix-run path).
      const prId = await insertPr(db, { summary: conflictSummary() });

      await mergeQueueProcessor.runOnce();

      const pr = await getPr(db, prId);
      expect(pr.mergeQueued).toBe(true);
    });
  });

  // A force-released wedged tick can resume minutes later holding a stale row
  // snapshot — it must re-check the live row before merging. Drive processHead
  // directly with the stale snapshot to simulate the resumed tick.
  describe('stale-tick guard before merging', () => {
    it('aborts the merge when the live row was dequeued after the snapshot was taken', async () => {
      const prId = await insertPr(db, { summary: cleanSummary() });
      const staleSnapshot = await getPr(db, prId); // queued + open, as the wedged tick saw it
      await db
        .update(pullRequestsTable)
        .set({ mergeQueued: false, mergeQueuedAt: null, mergeQueueState: null })
        .where(eq(pullRequestsTable.id, prId));

      const internals = mergeQueueProcessor as unknown as {
        processHead(row: typeof staleSnapshot): Promise<void>;
      };
      await internals.processHead(staleSnapshot);

      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await getPr(db, prId)).state).toBe('open');
    });

    it('aborts the merge when the live row already left open', async () => {
      const prId = await insertPr(db, { summary: cleanSummary() });
      const staleSnapshot = await getPr(db, prId);
      await db
        .update(pullRequestsTable)
        .set({ state: 'merged', mergeQueued: false, mergeQueueState: null })
        .where(eq(pullRequestsTable.id, prId));

      const internals = mergeQueueProcessor as unknown as {
        processHead(row: typeof staleSnapshot): Promise<void>;
      };
      await internals.processHead(staleSnapshot);

      expect(mergeSpy).not.toHaveBeenCalled();
    });
  });

  // The top-of-tick freshness refetch is an opportunistic GraphQL poll. When the
  // account's points budget is in the reserve it must back off (like the
  // reconcile sweep) and proceed on the existing row — burning the last points
  // here is what hard-trips the rate limit. When the budget is healthy it runs.
  describe('freshness refetch — GraphQL budget deferral', () => {
    async function staleQueuedPr() {
      const prId = await insertPr(db, { summary: cleanSummary() });
      await db
        .update(pullRequestsTable)
        .set({ lastPolledAt: new Date(Date.now() - 10 * 60_000) }) // well past FRESHNESS_MS
        .where(eq(pullRequestsTable.id, prId));
      return getPr(db, prId);
    }
    const runProcessHead = async (row: unknown) => {
      const internals = mergeQueueProcessor as unknown as { processHead(r: unknown): Promise<unknown> };
      await internals.processHead(row);
    };

    it('refetches a stale row when the budget is healthy', async () => {
      vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(false);
      const row = await staleQueuedPr();
      await runProcessHead(row);
      expect(refreshSpy).toHaveBeenCalledWith('ws1', 'a', 'b', row.number);
    });

    it('skips the stale refetch when the budget is in the reserve', async () => {
      vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(true);
      const row = await staleQueuedPr();
      await runProcessHead(row);
      expect(refreshSpy).not.toHaveBeenCalled();
    });
  });

  it('does not fire a fix run when the workspace has no connected cloud env', async () => {
    await seedUser(db, { id: OWNER2 });
    await db.insert(workspacesTable).values({ id: 'ws2', ownerId: OWNER2, name: 'ws2', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo2',
      workspaceId: 'ws2',
      name: 'c/d',
      url: 'https://github.com/c/d',
      defaultBranch: 'main',
    });
    await insertPr(db, { summary: conflictSummary(), workspaceId: 'ws2', repositoryId: 'repo2' });

    await mergeQueueProcessor.runOnce();

    expect(await countTasks(db)).toBe(0);
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('ignores PRs that are not open or not queued', async () => {
    await insertPr(db, { summary: cleanSummary(), state: 'merged' });
    await insertPr(db, { summary: cleanSummary(), mergeQueued: false });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).not.toHaveBeenCalled();
  });

  // A hung await once left `ticking` set forever, silently freezing the queue
  // mid-drain (15 mergeable PRs stuck, no logs). The watchdog must force-release
  // a tick held past MAX_TICK_MS so the loop recovers on its own.
  describe('tick watchdog (wedge recovery)', () => {
    it('force-releases a tick wedged past the max duration so the loop recovers', async () => {
      vi.useFakeTimers();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const prId = await insertPr(db, { summary: cleanSummary() });

        // First tick wedges: the merge never resolves (a hung await the
        // request-level timeout didn't catch, or a stalled DB/dispatch call).
        // It loads the row + persists status='merging', then hangs — leaving
        // `ticking` held.
        mergeSpy.mockImplementationOnce(() => new Promise(() => {}));

        // Fire the wedged tick but never await it — it never returns.
        void mergeQueueProcessor.runOnce();
        await vi.advanceTimersByTimeAsync(0); // flush up to the hung merge

        // Before MAX_TICK_MS, a re-tick is a no-op: the lock is still held.
        await mergeQueueProcessor.runOnce();
        expect(mergeSpy).toHaveBeenCalledTimes(1);

        // Past MAX_TICK_MS, the next tick force-releases and processes the
        // still-queued PR, which merges via the default mock.
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
        await mergeQueueProcessor.runOnce();

        expect(mergeSpy).toHaveBeenCalledTimes(2);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringMatching(/previous tick wedged for .* force-releasing/)
        );
        const pr = await getPr(db, prId);
        expect(pr.state).toBe('merged');
        expect(pr.mergeQueued).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // The "#N" badge counts only stay correct live if sibling positions are
  // rebroadcast when the group's membership changes.
  describe('live position broadcasts', () => {
    /** Latest position broadcast for a PR id across all emit calls. */
    function lastPositionFor(
      spy: ReturnType<typeof vi.spyOn>,
      prId: string
    ): { mergeQueued?: boolean; position?: number } | undefined {
      const calls = spy.mock.calls.filter(
        (c) => (c[1] as { id: string }).id === prId
      );
      if (calls.length === 0) return undefined;
      const p = calls[calls.length - 1][1] as {
        mergeQueued?: boolean;
        mergeQueueState?: { position: number } | null;
      };
      return { mergeQueued: p.mergeQueued, position: p.mergeQueueState?.position };
    }

    it('reshuffles survivors after the head merges (#2 → #1)', async () => {
      // Three same-base PRs, FIFO by queued-at → positions 1, 2, 3.
      await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(1000) });
      const pr2 = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(2000) });
      const pr3 = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(3000) });
      const emitSpy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');

      await mergeQueueProcessor.runOnce();

      // Head merged; the two survivors are rebroadcast as #1 and #2.
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(lastPositionFor(emitSpy, pr2)).toEqual({ mergeQueued: true, position: 1 });
      expect(lastPositionFor(emitSpy, pr3)).toEqual({ mergeQueued: true, position: 2 });
    });

    it('broadcasts a contiguous 1-based order for the whole queue', async () => {
      const a = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(3000) });
      const b = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(1000) });
      const c = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(2000) });
      const emitSpy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');

      await broadcastMergeQueuePositions('ws1');

      // Ordered by queued-at, not insert order.
      expect(lastPositionFor(emitSpy, b)).toEqual({ mergeQueued: true, position: 1 });
      expect(lastPositionFor(emitSpy, c)).toEqual({ mergeQueued: true, position: 2 });
      expect(lastPositionFor(emitSpy, a)).toEqual({ mergeQueued: true, position: 3 });
    });
  });
  describe('tick bounding', () => {
    it('defers a group while its account is rate-gate blocked, then resumes', async () => {
      const prId = await insertPr(db, { summary: cleanSummary() });
      const accountKey = githubService.accountKeyFor('ws1');
      githubRateGate.block(accountKey, Date.now() + 60_000, 'test backoff');

      await mergeQueueProcessor.runOnce();

      // No GitHub call was even attempted — the group deferred instead of
      // sleeping up to 60s behind waitIfBlocked inside every API call.
      expect(mergeSpy).not.toHaveBeenCalled();
      const still = await getPr(db, prId);
      expect(still.mergeQueued).toBe(true);
      expect(still.state).toBe('open');

      githubRateGate._reset();
      await mergeQueueProcessor.runOnce();
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect((await getPr(db, prId)).state).toBe('merged');
    });

    it('records a debug-bus tick when skipping because the guard is held', async () => {
      const tickSpy = vi.spyOn(debugBus, 'pollerTick');
      const guard = (mergeQueueProcessor as unknown as { guard: { tryBegin(): boolean; end(): void } })
        .guard;
      expect(guard.tryBegin()).toBe(true); // simulate a long tick in flight
      try {
        await insertPr(db, { summary: cleanSummary() });
        await mergeQueueProcessor.runOnce();
        // The skip itself must be visible — previously the early return
        // recorded nothing and the poller card just aged.
        expect(mergeSpy).not.toHaveBeenCalled();
        expect(tickSpy).toHaveBeenCalledWith(
          'merge_queue',
          expect.objectContaining({
            ok: true,
            summary: expect.stringContaining('skipped — previous tick still in flight'),
          })
        );
      } finally {
        guard.end();
      }
    });
  });
});

describe('computeQueuePositions', () => {
  type Row = {
    id: string;
    mergeQueued: boolean;
    mergeQueuedAt: Date | null;
    repositoryId: string;
    lastSummary: unknown;
  };
  function row(id: string, ms: number, opts: Partial<Row> = {}): Row {
    return {
      id,
      mergeQueued: true,
      mergeQueuedAt: new Date(ms),
      repositoryId: 'repo1',
      lastSummary: { baseBranch: 'main' },
      ...opts,
    };
  }

  it('numbers a single group 1-based in FIFO order', () => {
    const positions = computeQueuePositions([row('a', 3000), row('b', 1000), row('c', 2000)]);
    expect(positions.get('b')).toBe(1);
    expect(positions.get('c')).toBe(2);
    expect(positions.get('a')).toBe(3);
  });

  it('numbers each (repo, base) group independently', () => {
    const positions = computeQueuePositions([
      row('a', 1000, { repositoryId: 'r1', lastSummary: { baseBranch: 'main' } }),
      row('b', 2000, { repositoryId: 'r1', lastSummary: { baseBranch: 'main' } }),
      row('c', 1500, { repositoryId: 'r1', lastSummary: { baseBranch: 'dev' } }),
      row('d', 1200, { repositoryId: 'r2', lastSummary: { baseBranch: 'main' } }),
    ]);
    expect(positions.get('a')).toBe(1);
    expect(positions.get('b')).toBe(2);
    expect(positions.get('c')).toBe(1); // different base → its own group
    expect(positions.get('d')).toBe(1); // different repo → its own group
  });

  it('excludes PRs that are not queued', () => {
    const positions = computeQueuePositions([
      row('a', 1000),
      row('b', 2000, { mergeQueued: false }),
      row('c', 3000),
    ]);
    expect(positions.has('b')).toBe(false);
    expect(positions.get('a')).toBe(1);
    expect(positions.get('c')).toBe(2); // 'b' doesn't consume a slot
  });
});
