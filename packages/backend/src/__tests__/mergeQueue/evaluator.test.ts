// Pipeline integration tests for merge queue v2: the evaluator walk, the
// executor's GitHub/task side effects, trigger wiring off the domain-event
// bus, and the reconciler — against a real (pglite) DB with the same
// githubService spy surface the v1 suite used. Decision-table semantics live
// in decide.test.ts; these cases cover what only the pipeline can prove.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { encryptString } from '../../services/tokenCrypto.js';
import { githubService, MergeNotPermittedForAppError } from '../../services/github.js';
import { githubRateGate } from '../../services/githubRateGate.js';
import { prMonitorService } from '../../services/prMonitor.js';
import * as websocketModule from '../../services/websocket.js';
import { domainEvents } from '../../services/events.js';
import { blockerSignature, queueSignature } from '../../services/mergeQueue/decide.js';
import { createTestDb, seedUser } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  integrations as integrationsTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  tasks as tasksTable,
  settings as settingsTable,
  mergeQueueEntries,
  mergeQueueEvents,
} from '../../db/schema.js';
import { registerCloudProvider } from '../../services/cloudProviders/registry.js';
import { postHogCodeProvider } from '../../services/cloudProviders/posthog/provider.js';
import * as taskCreateModule from '../../services/taskCreate.js';
import { TaskLimitError } from '../../services/billing/entitlements.js';
import { ensureActiveEntry, getActiveEntryForPr } from '../../services/mergeQueue/store.js';
import {
  _resetEngineCache,
  evaluateGroupNow,
} from '../../services/mergeQueue/evaluator.js';
import { initMergeQueueTriggers } from '../../services/mergeQueue/triggers.js';
import { mergeQueueReconciler } from '../../services/mergeQueue/reconciler.js';

const { mockRequiresSigning, mockUnsignedCount, mockMarkSigning } = vi.hoisted(() => ({
  mockRequiresSigning: vi.fn(),
  mockUnsignedCount: vi.fn(),
  mockMarkSigning: vi.fn(),
}));
vi.mock('../../services/repoSigning.js', () => ({
  requiresSignedCommits: mockRequiresSigning,
  markSigningRequired: mockMarkSigning,
  _resetRepoSigningCache: vi.fn(),
}));
vi.mock('../../services/githubGraphql.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/githubGraphql.js')>()),
  fetchUnsignedCommitCount: mockUnsignedCount,
}));
const { mockCapability, mockEnableAutoMerge, mockDisableAutoMerge } = vi.hoisted(() => ({
  mockCapability: vi.fn(),
  mockEnableAutoMerge: vi.fn(),
  mockDisableAutoMerge: vi.fn(),
}));
vi.mock('../../services/githubAutoMerge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/githubAutoMerge.js')>()),
  getAutoMergeCapability: mockCapability,
  enableAutoMerge: mockEnableAutoMerge,
  disableAutoMerge: mockDisableAutoMerge,
}));
// External merge gate (trunk.io / GitHub native queue). Mocked so the probe
// never reaches out, and so a test can put a group behind a gate explicitly.
const { mockGetGate, mockMarkGate, mockClearGate, mockSubmitLabel } = vi.hoisted(() => ({
  mockGetGate: vi.fn(),
  mockMarkGate: vi.fn(),
  mockClearGate: vi.fn(),
  mockSubmitLabel: vi.fn(),
}));
// Analytics: the queue captures `pr_merged` on a successful merge. Mocked so
// nothing posts and the call is assertable.
const { mockCaptureWorkspaceEvent } = vi.hoisted(() => ({
  mockCaptureWorkspaceEvent: vi.fn(),
}));
vi.mock('../../services/analytics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/analytics.js')>()),
  captureWorkspaceEvent: mockCaptureWorkspaceEvent,
}));
vi.mock('../../services/repoMergeGate.js', () => ({
  getExternalMergeGate: mockGetGate,
  markExternalMergeGate: mockMarkGate,
  clearExternalMergeGate: mockClearGate,
  getExternalQueueSubmitLabel: mockSubmitLabel,
  _resetMergeGateCache: vi.fn(),
  _resetSubmitLabelCache: vi.fn(),
}));

process.env.TALYN_TOKEN_KEY ??= randomBytes(32).toString('base64');
registerCloudProvider(postHogCodeProvider);

const OWNER = 'user-mqv2';

function cleanSummary(base = 'main', headSha = 'abc') {
  return {
    title: 'PR title',
    author: 'me',
    draft: false,
    headBranch: 'feat',
    baseBranch: base,
    headSha,
    url: 'https://github.com/a/b/pull/1',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    blockingReason: 'mergeable',
    checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0,
  };
}

/**
 * The two signatures the external-queue tests seed, built with the SAME helpers
 * the engine uses rather than hand-written strings — a literal would silently
 * stop matching the moment a field joins the signature.
 */
const TRUNK_FAILED_SIGNATURE = queueSignature({
  provider: 'trunk',
  state: 'failed',
  source: 'label',
  evidence: 'trunk-failed',
});
/** What a fix run would be left with on a PR whose own branch reads clean. */
const CLEAN_BLOCKED_SIGNATURE = blockerSignature({
  state: 'open',
  headSha: 'abc',
  mergeStateStatus: 'CLEAN',
  autoMergeEnabledBy: null,
  summary: {
    url: 'https://github.com/a/b/pull/1',
    headBranch: 'feat',
    baseBranch: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    blockingReason: 'mergeable',
    checks: { total: 1, failed: 0, inProgress: 0 },
    unresolvedReviewThreads: 0,
  },
});

function conflictSummary(base = 'main', headSha = 'abc') {
  return {
    ...cleanSummary(base, headSha),
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    blockingReason: 'merge_conflicts',
  };
}

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

async function setEngine(db: Database, engine: 'v1' | 'v2'): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ key: 'merge_queue_engine', value: engine })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: engine } });
  _resetEngineCache();
}

let prCounter = 0;

async function insertQueuedPr(
  db: Database,
  overrides: {
    summary?: Record<string, unknown>;
    state?: string;
    taskId?: string | null;
    entry?: Partial<{
      status: string;
      baseBranch: string;
      blockedCode: string | null;
      blockedReason: string | null;
      headSha: string;
      fixAttempts: number;
      fixTaskId: string | null;
      fixTaskAccounted: boolean;
      mergeStartedAt: Date | null;
      lastEvaluatedAt: Date | null;
    }>;
  } = {}
): Promise<{ prId: string; entryId: string }> {
  const prId = `pr-${++prCounter}`;
  const summary = overrides.summary ?? cleanSummary();
  await db.insert(pullRequestsTable).values({
    id: prId,
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: overrides.taskId ?? null,
    owner: 'a',
    repo: 'b',
    number: prCounter,
    state: overrides.state ?? 'open',
    mergeQueued: true,
    mergeQueuedAt: new Date(),
    mergeMethod: 'squash',
    mergeQueueState: { status: 'waiting', attempts: 0, accounted: true },
    lastPolledAt: new Date(),
    lastSummary: summary,
  });
  const entryId = await ensureActiveEntry(
    {
      pullRequestId: prId,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      baseBranch: (summary as { baseBranch?: string }).baseBranch ?? 'main',
      mergeMethod: 'squash',
      headSha: (summary as { headSha?: string }).headSha ?? '',
      trigger: 'test:seed',
    },
    db
  );
  if (overrides.entry) {
    await db
      .update(mergeQueueEntries)
      .set(overrides.entry as never)
      .where(eq(mergeQueueEntries.id, entryId));
  }
  return { prId, entryId };
}

async function insertTask(db: Database, id: string, status: string): Promise<void> {
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
    metadata: {},
  });
}

async function entryOf(db: Database, prId: string) {
  return (await getActiveEntryForPr(prId, db)) ?? null;
}

async function eventsOf(db: Database, entryId: string) {
  return db.select().from(mergeQueueEvents).where(eq(mergeQueueEvents.entryId, entryId));
}

async function countTasks(db: Database): Promise<number> {
  return (await db.select({ id: tasksTable.id }).from(tasksTable)).length;
}

describe('mergeQueue v2 pipeline', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let mergeSpy: ReturnType<typeof vi.spyOn>;
  let getPrSpy: ReturnType<typeof vi.spyOn>;
  let refreshSpy: ReturnType<typeof vi.spyOn>;
  let blockedSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    prCounter = 0;
    await seedBase(db);
    await setEngine(db, 'v2');
    mergeSpy = vi
      .spyOn(githubService, 'mergePullRequest')
      .mockResolvedValue({ sha: 'merged-sha', merged: true, message: 'ok' });
    getPrSpy = vi
      .spyOn(githubService, 'getPullRequest')
      .mockResolvedValue({ state: 'open', merged: false, merged_at: null } as never);
    vi.spyOn(githubService, 'rerequestFailedCheckRuns').mockResolvedValue({
      requested: 0,
      reason: 'no-failing-check-runs',
    });
    refreshSpy = vi.spyOn(prMonitorService, 'refreshPr').mockResolvedValue(undefined);
    blockedSpy = vi.spyOn(websocketModule, 'emitMergeQueueBlocked').mockImplementation(() => {});
    mockRequiresSigning.mockReset().mockResolvedValue(false);
    mockUnsignedCount.mockReset().mockResolvedValue(0);
    mockMarkSigning.mockReset();
    // Auto-merge defaults: repo doesn't support it, so every non-hybrid test
    // takes the direct-merge path exactly as before Push E.
    mockCapability.mockReset().mockResolvedValue('unavailable');
    mockEnableAutoMerge.mockReset().mockResolvedValue({ armed: true });
    mockDisableAutoMerge.mockReset().mockResolvedValue(true);
    // No external merge gate by default — the ordinary direct-merge world.
    mockGetGate.mockReset().mockResolvedValue(null);
    mockMarkGate.mockReset();
    mockClearGate.mockReset();
    // External-queue submit doors, all off by default: no provider instruction
    // comment, no submit label — so the auto-merge door is what runs unless a
    // test opts into another one.
    mockSubmitLabel.mockReset().mockResolvedValue(null);
    vi.spyOn(githubService, 'listIssueComments').mockResolvedValue([]);
    vi.spyOn(githubService, 'createIssueComment').mockResolvedValue(undefined);
    vi.spyOn(githubService, 'addPullRequestLabels').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    githubRateGate._reset();
    _resetEngineCache();
  });

  it('merges a clean head end-to-end: entry terminal, PR row terminal, timeline written', async () => {
    const { prId, entryId } = await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(await entryOf(db, prId)).toBeNull(); // no longer active
    const entryRow = (
      await db.select().from(mergeQueueEntries).where(eq(mergeQueueEntries.id, entryId))
    )[0]!;
    expect(entryRow.status).toBe('merged');
    const pr = (
      await db.select().from(pullRequestsTable).where(eq(pullRequestsTable.id, prId))
    )[0]!;
    expect(pr.state).toBe('merged');
    expect(pr.mergeQueued).toBe(false);
    expect(pr.mergeQueueState).toBeNull();
    const codes = (await eventsOf(db, entryId)).map((e) => e.code);
    expect(codes).toContain('merge_attempt');
    expect(codes).toContain('merged');
  });

  // Regression: `pr_merged` used to be captured ONLY by the desktop/web merge
  // button, so every queue merge was invisible and the analytics tile read a
  // near-flat zero while the queue was merging daily.
  it('captures pr_merged so queue merges are not invisible to analytics', async () => {
    await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(mockCaptureWorkspaceEvent).toHaveBeenCalledWith(
      expect.any(String),
      'pr_merged',
      expect.objectContaining({ source: 'merge_queue' })
    );
  });

  it('does NOT capture pr_merged when GitHub declines the merge', async () => {
    mergeSpy.mockResolvedValueOnce({ sha: '', merged: false, message: 'not merged' });
    await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(mockCaptureWorkspaceEvent).not.toHaveBeenCalledWith(
      expect.any(String),
      'pr_merged',
      expect.anything()
    );
  });

  it('does nothing while the v1 engine drives (dormant)', async () => {
    await setEngine(db, 'v1');
    await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('serializes same-base entries — one merge per evaluation, FIFO', async () => {
    const first = await insertQueuedPr(db);
    const second = await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(await entryOf(db, first.prId)).toBeNull(); // head merged
    expect((await entryOf(db, second.prId))?.status).toBe('queued'); // waits its turn
  });

  it('fires the cloud fix run for a conflicting head and holds the group', async () => {
    const head = await insertQueuedPr(db, { summary: conflictSummary() });
    const behind = await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(await countTasks(db)).toBe(1);
    const entry = await entryOf(db, head.prId);
    expect(entry?.status).toBe('fixing');
    expect(entry?.fixTaskId).toBeTruthy();
    // Genuine blocker holds the group — the clean sibling must NOT merge.
    expect(mergeSpy).not.toHaveBeenCalled();
    expect((await entryOf(db, behind.prId))?.status).toBe('queued');
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
    const head = await insertQueuedPr(db, { summary: conflictSummary() });
    const number = head.prId.replace('pr-', '');

    await evaluateGroupNow('repo1', 'main', 'test');

    const tasks = await db.select({ prompt: tasksTable.prompt }).from(tasksTable);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt?.startsWith(`Custom for a/b#${number} on feat`)).toBe(true);
    expect(tasks[0].prompt).toContain('git_signed_commit');
    expect(tasks[0].prompt).not.toContain('Every reviewer comment');
  });

  it('advances past a draft head so the ready sibling merges in the same evaluation', async () => {
    const draft = await insertQueuedPr(db, { summary: draftSummary() });
    const ready = await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    expect((await entryOf(db, draft.prId))?.blockedCode).toBe('draft');
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(await entryOf(db, ready.prId)).toBeNull(); // merged
    expect(blockedSpy).not.toHaveBeenCalled(); // drafts never notify
  });

  // End-to-end shape of the progress rule: the FIRST completed run records what
  // it was left with and re-fires; the SECOND, left with the identical problem,
  // blocks. Driven through the real lifecycle rather than a seeded counter, so
  // it also proves the signature actually round-trips through the column.
  // The visual-review lookup is a PostHog round-trip. Without this gate it
  // would fire for every blocked PR in every workspace holding PostHog
  // credentials — including the great majority of repos that have no visual
  // review at all.
  it('never asks PostHog about visual review when the workspace has not configured it', async () => {
    const vr = await import('../../services/visualReview.js');
    const spy = vi.spyOn(vr, 'gatingRunForPr');
    await insertQueuedPr(db, { summary: conflictSummary() });

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('re-fires after one failed run, then blocks when the same problem recurs', async () => {
    await insertTask(db, 'task-1', 'completed');
    const { prId } = await insertQueuedPr(db, {
      summary: conflictSummary(),
      entry: { status: 'fixing', fixTaskId: 'task-1', fixTaskAccounted: false },
    });

    // Run 1 accounted: the conflict is new to this head → record it and re-fire.
    await evaluateGroupNow('repo1', 'main', 'test');
    const afterFirst = await entryOf(db, prId);
    expect(afterFirst?.status).toBe('fixing');
    expect(afterFirst?.fixAttempts).toBe(1);
    expect(afterFirst?.seenSignatures).toHaveLength(1);
    expect(blockedSpy).not.toHaveBeenCalled();
    expect(await countTasks(db)).toBe(2); // the re-fire

    // Run 2 finishes and leaves the PR conflicting in exactly the same way.
    await db
      .update(tasksTable)
      .set({ status: 'completed' })
      .where(eq(tasksTable.id, afterFirst!.fixTaskId!));
    await db
      .update(mergeQueueEntries)
      .set({ fixTaskAccounted: false })
      .where(eq(mergeQueueEntries.id, afterFirst!.id));

    await evaluateGroupNow('repo1', 'main', 'test');
    const entry = await entryOf(db, prId);
    expect(entry?.status).toBe('blocked');
    expect(entry?.blockedCode).toBe('no_progress');
    expect(entry?.seenSignatures).toHaveLength(1); // not grown by the repeat
    expect(blockedSpy).toHaveBeenCalledTimes(1);
    expect(await countTasks(db)).toBe(2); // no 3rd run

    // Re-evaluation while still blocked: no re-notify, no churn.
    await evaluateGroupNow('repo1', 'main', 'test');
    expect(blockedSpy).toHaveBeenCalledTimes(1);
  });

  it('a new head resets budgets and un-blocks (self-healing)', async () => {
    const { prId } = await insertQueuedPr(db, {
      summary: conflictSummary('main', 'sha-NEW'),
      entry: {
        status: 'blocked',
        blockedCode: 'no_progress',
        blockedReason: 'x',
        headSha: 'sha-OLD',
        fixAttempts: 3,
        seenSignatures: ['fix|merge_conflicts|CONFLICTING|DIRTY|-|checks=0/0|failing=?|threads=0'],
      },
    });

    await evaluateGroupNow('repo1', 'main', 'test');

    const entry = await entryOf(db, prId);
    expect(entry?.headSha).toBe('sha-NEW');
    expect(entry?.fixAttempts).toBe(0);
    expect(entry?.seenSignatures).toEqual([]);
    expect(entry?.status).toBe('fixing'); // fresh budget → fix run fired
    expect(await countTasks(db)).toBe(1);
  });

  // Claim-first dispatch (Session 72): the entry is CLAIMED via CAS before the
  // cloud task is created, so concurrent cross-replica evaluations collapse to
  // one dispatch instead of a duplicate burst.
  it('claims the entry (status=fixing) BEFORE creating the task', async () => {
    const { prId, entryId } = await insertQueuedPr(db, { summary: conflictSummary() });
    let statusAtCreate: string | undefined;
    let fixTaskIdAtCreate: string | null | undefined;
    const orig = taskCreateModule.createCloudTask;
    const spy = vi
      .spyOn(taskCreateModule, 'createCloudTask')
      .mockImplementation(async (input) => {
        const row = (
          await db
            .select({ status: mergeQueueEntries.status, fixTaskId: mergeQueueEntries.fixTaskId })
            .from(mergeQueueEntries)
            .where(eq(mergeQueueEntries.id, entryId))
        )[0]!;
        statusAtCreate = row.status;
        fixTaskIdAtCreate = row.fixTaskId;
        return orig(input);
      });

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(statusAtCreate).toBe('fixing'); // claimed before the task exists
    expect(fixTaskIdAtCreate).toBeNull(); // not linked until Phase C
    const entry = await entryOf(db, prId);
    expect(entry?.status).toBe('fixing');
    expect(entry?.fixTaskId).toBeTruthy(); // linked after create
    expect(await countTasks(db)).toBe(1);
  });

  it('rolls the claim back to queued and burns nothing on a task-limit deferral', async () => {
    const { prId } = await insertQueuedPr(db, { summary: conflictSummary() });
    vi.spyOn(taskCreateModule, 'createCloudTask').mockRejectedValue(new TaskLimitError(3, 3));

    await evaluateGroupNow('repo1', 'main', 'test');

    const entry = await entryOf(db, prId);
    expect(entry?.status).toBe('queued'); // claim reverted
    expect(entry?.fixKind).toBeNull();
    expect(entry?.fixAttempts).toBe(0); // no attempt burned
    expect(entry?.fixTaskId).toBeNull();
    expect(await countTasks(db)).toBe(0); // nothing dispatched
  });

  it('re-fires a dispatch left half-claimed (fixing + null fixTaskId) by a crash', async () => {
    // A crash between claim and link leaves the entry fixing+null. The next
    // evaluation (reconciler staleness sweep in prod) sees a null fixTaskId as
    // no active run and re-fires — natural recovery, no wedge.
    const { prId } = await insertQueuedPr(db, {
      summary: conflictSummary(),
      entry: { status: 'fixing', fixTaskId: null },
    });

    await evaluateGroupNow('repo1', 'main', 'test');

    const entry = await entryOf(db, prId);
    expect(entry?.status).toBe('fixing');
    expect(entry?.fixTaskId).toBeTruthy(); // re-claimed + linked
    expect(await countTasks(db)).toBe(1); // exactly one, not a duplicate
  });

  it('recovers a head stuck in status=merging from a crashed evaluation (verify-merged)', async () => {
    getPrSpy.mockResolvedValue({
      state: 'closed',
      merged: true,
      merged_at: '2026-07-16T10:00:00Z',
    } as never);
    const { prId } = await insertQueuedPr(db, {
      entry: { status: 'merging', mergeStartedAt: new Date(Date.now() - 120_000) },
    });

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(mergeSpy).not.toHaveBeenCalled(); // never re-attempts the doomed merge
    const pr = (
      await db.select().from(pullRequestsTable).where(eq(pullRequestsTable.id, prId))
    )[0]!;
    expect(pr.state).toBe('merged');
  });

  it('keeps a PR queued and refetches when the merge throws (405 conflicts)', async () => {
    mergeSpy.mockRejectedValue(new Error('405: Pull Request has merge conflicts'));
    const { prId } = await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    const entry = await entryOf(db, prId);
    expect(entry?.status).toBe('queued');
    expect(entry?.lastError).toContain('merge conflicts');
    expect(refreshSpy).toHaveBeenCalled();
  });

  describe('external merge queue (trunk.io / GitHub native)', () => {
    /** posthog/posthog's world: `master` is behind trunk's ruleset. */
    const gated = () => mockGetGate.mockResolvedValue('confirmed');

    it('submits a clean head to the queue instead of merging it', async () => {
      gated();
      mockCapability.mockResolvedValue('available');
      const { prId, entryId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), nodeId: 'PR_node' },
      });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mergeSpy).not.toHaveBeenCalled(); // the doomed call is never made
      expect(mockEnableAutoMerge).toHaveBeenCalledTimes(1);
      const entry = await entryOf(db, prId);
      expect(entry?.status).toBe('awaiting_external');
      expect(entry?.externalSubmitVia).toBe('auto_merge');
      expect(entry?.submitAttempts).toBe(1);
      expect((await eventsOf(db, entryId)).map((e) => e.code)).toContain('external_submitted');
    });

    it("posts the provider's own submit command when its instruction comment is on the PR", async () => {
      gated();
      mockCapability.mockResolvedValue('available');
      vi.spyOn(githubService, 'listIssueComments').mockResolvedValue([
        {
          body:
            '<!-- Trunk Merge -->\\nMerging to `master` in this repository is managed by Trunk. ' +
            'To merge this pull request, check the box to the left or comment `/trunk merge` below.',
        },
      ]);
      const comment = vi.spyOn(githubService, 'createIssueComment').mockResolvedValue(undefined);
      const { prId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), nodeId: 'PR_node' },
      });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(comment).toHaveBeenCalledWith('ws1', 'a', 'b', expect.any(Number), '/trunk merge');
      // Arming auto-merge does NOT submit to trunk, so the command door must
      // not also arm it (verified live on #74354).
      expect(mockEnableAutoMerge).not.toHaveBeenCalled();
      const entry = await entryOf(db, prId);
      expect(entry?.status).toBe('awaiting_external');
      expect(entry?.externalSubmitVia).toBe('comment');
      expect(entry?.externalSubmittedAt).not.toBeNull();
    });

    it("applies the repo's submit label when there is no instruction comment", async () => {
      gated();
      mockCapability.mockResolvedValue('available');
      mockSubmitLabel.mockResolvedValue('trunk-merge-queue-submit');
      const addLabels = vi
        .spyOn(githubService, 'addPullRequestLabels')
        .mockResolvedValue(undefined);
      const { prId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), nodeId: 'PR_node' },
      });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(addLabels).toHaveBeenCalledWith('ws1', 'a', 'b', expect.any(Number), [
        'trunk-merge-queue-submit',
      ]);
      const entry = await entryOf(db, prId);
      expect(entry?.status).toBe('awaiting_external');
      expect(entry?.externalSubmitVia).toBe('label');
    });

    it('learns the gate from a protected-ref 405 and submits in the same evaluation', async () => {
      mockGetGate.mockResolvedValue(null); // not known yet — the merge finds out
      mockCapability.mockResolvedValue('available');
      mergeSpy.mockRejectedValue(new Error('405: Cannot update this protected ref'));
      const { prId, entryId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), nodeId: 'PR_node' },
      });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mockMarkGate).toHaveBeenCalledWith('ws1', 'a', 'b', 'main');
      const entry = await entryOf(db, prId);
      expect(entry?.status).toBe('awaiting_external');
      const codes = (await eventsOf(db, entryId)).map((e) => e.code);
      expect(codes).toContain('external_merge_gate');
      expect(codes).toContain('external_submitted');
      expect(await countTasks(db)).toBe(0); // never burns a fix run on a gate
    });

    it('blocks manually only when no door exists (no auto-merge, no submit label)', async () => {
      gated();
      mockCapability.mockResolvedValue('unavailable');
      mockSubmitLabel.mockResolvedValue(null);
      const { prId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), nodeId: 'PR_node' },
      });

      await evaluateGroupNow('repo1', 'main', 'test');

      const entry = await entryOf(db, prId);
      expect(entry?.status).toBe('blocked_manual');
      expect(entry?.blockedCode).toBe('external_gate');
      expect(blockedSpy).toHaveBeenCalledTimes(1);
    });

    it('takes an ejected PR back and resubmits it', async () => {
      gated();
      mockCapability.mockResolvedValue('available');
      const { prId, entryId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), nodeId: 'PR_node', labels: ['trunk-failed'], autoMergeBy: null },
        entry: { status: 'awaiting_external' },
      });
      await db
        .update(mergeQueueEntries)
        .set({ externalSubmitVia: 'auto_merge', submitAttempts: 1 } as never)
        .where(eq(mergeQueueEntries.id, entryId));

      await evaluateGroupNow('repo1', 'main', 'test');

      const entry = await entryOf(db, prId);
      expect(entry?.status).toBe('awaiting_external');
      expect(entry?.submitAttempts).toBe(2);
      const codes = (await eventsOf(db, entryId)).map((e) => e.code);
      expect(codes).toContain('external_queue_ejected');
    });

    /**
     * The queue failed a PR whose own branch is green. That is fixable — but
     * only from the queue's failure output, since the PR's checks say nothing
     * is wrong. See queueFailureRule.
     */
    it('dispatches a queue-failure run when the queue fails it the same way twice', async () => {
      gated();
      mockCapability.mockResolvedValue('available');
      const { prId, entryId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), nodeId: 'PR_node', labels: ['trunk-failed'] },
        entry: { status: 'awaiting_external' },
      });
      await db
        .update(mergeQueueEntries)
        .set({
          externalSubmitVia: 'auto_merge',
          submitAttempts: 1,
          seenSignatures: [TRUNK_FAILED_SIGNATURE],
        } as never)
        .where(eq(mergeQueueEntries.id, entryId));

      const spy = vi
        .spyOn(taskCreateModule, 'createCloudTask')
        .mockResolvedValue({ id: 'task-queue-fix' } as never);

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(spy).toHaveBeenCalled();
      const input = spy.mock.calls[0]![0] as { prompt: string; title: string };
      // The run must be pointed at the QUEUE's failure, not the PR's checks.
      expect(input.prompt).toContain('MERGE QUEUE FAILED THIS PR');
      expect(input.title).toContain('after a merge-queue failure');

      const entry = await entryOf(db, prId);
      expect(entry?.fixKind).toBe('queue_failure');
      expect(mockEnableAutoMerge).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('gives up (self-healing block) once a fix run has failed this blocker too', async () => {
      gated();
      mockCapability.mockResolvedValue('available');
      const { prId, entryId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), nodeId: 'PR_node', labels: ['trunk-failed'] },
        entry: { status: 'awaiting_external' },
      });
      await db
        .update(mergeQueueEntries)
        .set({
          externalSubmitVia: 'auto_merge',
          submitAttempts: 1,
          seenSignatures: [TRUNK_FAILED_SIGNATURE, CLEAN_BLOCKED_SIGNATURE],
        } as never)
        .where(eq(mergeQueueEntries.id, entryId));

      await evaluateGroupNow('repo1', 'main', 'test');

      const entry = await entryOf(db, prId);
      expect(entry?.status).toBe('blocked');
      expect(entry?.blockedCode).toBe('external_queue_rejected');
      expect(mockEnableAutoMerge).not.toHaveBeenCalled();
    });

    it('waits, doing nothing, while the provider is testing the PR', async () => {
      gated();
      const { prId, entryId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), nodeId: 'PR_node', labels: ['trunk-testing'] },
        entry: { status: 'awaiting_external' },
      });
      await db
        .update(mergeQueueEntries)
        .set({ externalSubmitVia: 'auto_merge', submitAttempts: 1 } as never)
        .where(eq(mergeQueueEntries.id, entryId));

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mockEnableAutoMerge).not.toHaveBeenCalled();
      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await entryOf(db, prId))?.status).toBe('awaiting_external');
    });

    it('submits every entry in the group in one walk — the provider does the ordering', async () => {
      gated();
      mockCapability.mockResolvedValue('available');
      const first = await insertQueuedPr(db, { summary: { ...cleanSummary(), nodeId: 'PR_1' } });
      const second = await insertQueuedPr(db, { summary: { ...cleanSummary(), nodeId: 'PR_2' } });

      await evaluateGroupNow('repo1', 'main', 'test');

      // Ordered mode would have stopped after the head's `hold`; a gated group
      // is always eager, so both PRs are in the external queue after one walk.
      expect((await entryOf(db, first.prId))?.status).toBe('awaiting_external');
      expect((await entryOf(db, second.prId))?.status).toBe('awaiting_external');
    });
  });

  it('hard-blocks (blocked_manual) on an App refusal with no failing check, notifying once', async () => {
    mergeSpy.mockRejectedValue(new MergeNotPermittedForAppError('Merge refused for the App.'));
    const { prId } = await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    const entry = await entryOf(db, prId);
    expect(entry?.status).toBe('blocked_manual');
    expect(entry?.blockedCode).toBe('app_refused_hard');
    expect(blockedSpy).toHaveBeenCalledTimes(1);
    expect(await countTasks(db)).toBe(0); // a fix run can't grant permission
  });

  it('re-signs instead of merging when the base requires signatures and commits are unsigned', async () => {
    mockRequiresSigning.mockResolvedValue(true);
    mockUnsignedCount.mockResolvedValue(2);
    const { prId } = await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(mergeSpy).not.toHaveBeenCalled();
    const entry = await entryOf(db, prId);
    expect(entry?.status).toBe('fixing');
    expect(entry?.fixKind).toBe('resign');
    expect(entry?.resignAttempts).toBe(1);
    // The probe memoized per head — a re-evaluation must not re-fetch.
    mockUnsignedCount.mockClear();
    await evaluateGroupNow('repo1', 'main', 'test');
    expect(mockUnsignedCount).not.toHaveBeenCalled();
  });

  it('defers the whole group while the REST rate gate is blocked', async () => {
    githubRateGate.block(githubService.accountKeyFor('ws1'), Date.now() + 60_000, 'test backoff');
    await insertQueuedPr(db);

    await evaluateGroupNow('repo1', 'main', 'test');

    expect(mergeSpy).not.toHaveBeenCalled();
  });

  describe('triggers', () => {
    it('a pr:snapshot event evaluates the entry group (webhook-speed merges)', async () => {
      initMergeQueueTriggers();
      const { prId } = await insertQueuedPr(db);

      domainEvents.emit('pr:snapshot', {
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        prId,
        baseBranch: 'main',
        state: 'open',
        trigger: 'test:webhook',
      });

      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(1));
    });

    it('a task:status terminal event re-evaluates the entry owning that fix run', async () => {
      initMergeQueueTriggers();
      await insertTask(db, 'task-t', 'completed');
      const { prId } = await insertQueuedPr(db, {
        // Fix run done, PR now clean → the trigger should merge it.
        entry: { status: 'fixing', fixTaskId: 'task-t', fixTaskAccounted: false },
      });

      domainEvents.emit('task:status', { workspaceId: 'ws1', taskId: 'task-t', status: 'completed' });

      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(1));
      expect(await entryOf(db, prId)).toBeNull();
    });
  });


  // The feature end to end: a chain of PRs where each one's base is the
  // previous one's head, drained bottom-up into the real base one at a time.
  describe('merge stack', () => {
    /** A(feat-a→main) <- B(feat-b→feat-a) <- C(feat-c→feat-b), all queued. */
    async function seedStack() {
      const a = await insertQueuedPr(db, {
        summary: { ...cleanSummary('main'), headBranch: 'feat-a' },
      });
      const b = await insertQueuedPr(db, {
        summary: { ...cleanSummary('feat-a'), headBranch: 'feat-b' },
      });
      const c = await insertQueuedPr(db, {
        summary: { ...cleanSummary('feat-b'), headBranch: 'feat-c' },
      });
      return { a, b, c };
    }

    /** Mark a PR merged the way the real merge path leaves it. */
    async function markMerged(prId: string): Promise<void> {
      await db
        .update(pullRequestsTable)
        .set({ state: 'merged', mergedAt: new Date(), mergeQueued: false })
        .where(eq(pullRequestsTable.id, prId));
    }

    it('merges only the root — the two above it park', async () => {
      const { a, b, c } = await seedStack();

      // While the root is still open, neither child may do anything.
      await evaluateGroupNow('repo1', 'feat-a', 'test');
      await evaluateGroupNow('repo1', 'feat-b', 'test');

      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await entryOf(db, b.prId))?.status).toBe('awaiting_stack');
      expect((await entryOf(db, b.prId))?.stackParentNumber).toBe(1);
      expect((await entryOf(db, c.prId))?.status).toBe('awaiting_stack');

      // The root itself merges normally.
      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(await entryOf(db, a.prId)).toBeNull();
    });

    it('retargets the child onto the real base once the root lands', async () => {
      const { a, b } = await seedStack();
      const patchSpy = vi
        .spyOn(githubService, 'updatePullRequest')
        .mockResolvedValue({} as never);
      await evaluateGroupNow('repo1', 'main', 'test');
      await markMerged(a.prId);
      mergeSpy.mockClear();

      await evaluateGroupNow('repo1', 'feat-a', 'test');

      expect(patchSpy).toHaveBeenCalledTimes(1);
      expect(patchSpy).toHaveBeenCalledWith('ws1', 'a', 'b', 2, { base: 'main' });
      const entry = await entryOf(db, b.prId);
      expect(entry).toMatchObject({
        baseBranch: 'main',
        status: 'queued',
        retargetAttempts: 1,
        // Kept, not cleared: it is how a later fix run learns this branch may
        // still carry #1's original commits after a squash-merge.
        stackParentNumber: 1,
      });
      // The context was built against feat-a, an unprotected feature branch —
      // merging in the same walk would use signing/gate probes from the wrong
      // base. The new group's own walk does the merge.
      expect(mergeSpy).not.toHaveBeenCalled();
      const codes = (await eventsOf(db, b.entryId)).map((e) => e.code);
      expect(codes).toContain('stack_retargeted');
    });

    it('clears the memos probed against the old base on retarget', async () => {
      const { a, b } = await seedStack();
      vi.spyOn(githubService, 'updatePullRequest').mockResolvedValue({} as never);
      await db
        .update(mergeQueueEntries)
        .set({ signingCheckedSha: 'abc', unsignedCount: 3, fixAttempts: 2 })
        .where(eq(mergeQueueEntries.id, b.entryId));
      await markMerged(a.prId);

      await evaluateGroupNow('repo1', 'feat-a', 'test');

      // Signing rules and external gates live on the REAL base, so a memo
      // taken against a feature branch is how a PR merges past a rule it was
      // never checked against.
      expect(await entryOf(db, b.prId)).toMatchObject({
        signingCheckedSha: null,
        unsignedCount: null,
        fixAttempts: 0,
      });
    });

    it('issues no PATCH when GitHub already retargeted the PR itself', async () => {
      // GitHub retargets children when the parent's head branch is deleted. The
      // base reconcile absorbs that before decide ever sees a stack parent, so
      // the queue follows GitHub rather than fighting it.
      const { a, b } = await seedStack();
      const patchSpy = vi
        .spyOn(githubService, 'updatePullRequest')
        .mockResolvedValue({} as never);
      await markMerged(a.prId);
      await db
        .update(pullRequestsTable)
        .set({ lastSummary: { ...cleanSummary('main'), headBranch: 'feat-b' } })
        .where(eq(pullRequestsTable.id, b.prId));

      await evaluateGroupNow('repo1', 'feat-a', 'test');

      expect(patchSpy).not.toHaveBeenCalled();
      await vi.waitFor(async () =>
        expect((await entryOf(db, b.prId))?.baseBranch).toBe('main')
      );
    });

    it('the parent merging schedules the parked child group', async () => {
      // Nothing else would: every trigger the child has keys on feat-a, and
      // the parent's own events are about main.
      initMergeQueueTriggers();
      const { a } = await seedStack();
      const patchSpy = vi
        .spyOn(githubService, 'updatePullRequest')
        .mockResolvedValue({} as never);
      await markMerged(a.prId);

      domainEvents.emit('pr:snapshot', {
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        prId: a.prId,
        baseBranch: 'main',
        headBranch: 'feat-a',
        state: 'merged',
        trigger: 'test:webhook',
      });

      // The retarget is proof the feat-a group was walked at all.
      await vi.waitFor(() =>
        expect(patchSpy).toHaveBeenCalledWith('ws1', 'a', 'b', 2, { base: 'main' })
      );
    });

    it('drains the whole stack bottom-up, one at a time', async () => {
      // Each rung is walked once; the retarget schedules the next group itself,
      // so the merges after rung 1 come from the pipeline rather than the test
      // driving them. That IS the feature.
      const { a, b, c } = await seedStack();
      vi.spyOn(githubService, 'updatePullRequest').mockResolvedValue({} as never);

      await evaluateGroupNow('repo1', 'main', 'test');
      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(1));
      await markMerged(a.prId);

      await evaluateGroupNow('repo1', 'feat-a', 'test');
      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(2));
      await markMerged(b.prId);

      await evaluateGroupNow('repo1', 'feat-b', 'test');
      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(3));
      await vi.waitFor(async () => expect(await entryOf(db, c.prId)).toBeNull());
    });

    it('parks a child even in eager mode', async () => {
      await db
        .update(workspacesTable)
        .set({ settings: { mergeQueueMode: 'eager' } })
        .where(eq(workspacesTable.id, 'ws1'));
      const { b } = await seedStack();

      await evaluateGroupNow('repo1', 'feat-a', 'test');

      expect((await entryOf(db, b.prId))?.status).toBe('awaiting_stack');
    });

    it('never submits a parked child to an external merge queue', async () => {
      // trunk.io refuses stacked PRs outright, so submitting one is a
      // guaranteed round trip to blocked_manual.
      mockGetGate.mockResolvedValue('confirmed');
      const { b } = await seedStack();

      await evaluateGroupNow('repo1', 'feat-a', 'test');

      expect(mockSubmitLabel).not.toHaveBeenCalled();
      expect((await entryOf(db, b.prId))?.status).toBe('awaiting_stack');
    });

    it('disarms a Talyn auto-merge when parking, so GitHub cannot land it early', async () => {
      const { b } = await seedStack();
      await db
        .update(mergeQueueEntries)
        .set({ status: 'automerge_armed', automergeArmedBy: 'talyn' })
        .where(eq(mergeQueueEntries.id, b.entryId));
      await db
        .update(pullRequestsTable)
        .set({
          lastSummary: {
            ...cleanSummary('feat-a'),
            headBranch: 'feat-b',
            nodeId: 'PR_node',
            autoMergeBy: 'talyn',
          },
        })
        .where(eq(pullRequestsTable.id, b.prId));

      await evaluateGroupNow('repo1', 'feat-a', 'test');

      expect(mockDisableAutoMerge).toHaveBeenCalled();
      expect((await entryOf(db, b.prId))?.status).toBe('awaiting_stack');
    });

    it('blocks a child whose parent was closed without merging', async () => {
      const { a, b } = await seedStack();
      await db
        .update(pullRequestsTable)
        .set({ state: 'closed' })
        .where(eq(pullRequestsTable.id, a.prId));

      await evaluateGroupNow('repo1', 'feat-a', 'test');

      const entry = await entryOf(db, b.prId);
      expect(entry?.status).toBe('blocked');
      expect(entry?.blockedCode).toBe('stack_parent_abandoned');
      expect(blockedSpy).toHaveBeenCalled();
    });

    it('blocks, and does not merge, when the retarget is refused', async () => {
      const { a, b } = await seedStack();
      vi.spyOn(githubService, 'updatePullRequest').mockRejectedValue(new Error('422'));
      getPrSpy.mockResolvedValue({ state: 'open', base: { ref: 'feat-a' } } as never);
      await markMerged(a.prId);
      mergeSpy.mockClear();

      await evaluateGroupNow('repo1', 'feat-a', 'test');

      const entry = await entryOf(db, b.prId);
      expect(entry?.blockedCode).toBe('stack_retarget_failed');
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('treats a lost PATCH response as success when GitHub already moved the base', async () => {
      const { a, b } = await seedStack();
      vi.spyOn(githubService, 'updatePullRequest').mockRejectedValue(new Error('boom'));
      getPrSpy.mockResolvedValue({ state: 'open', base: { ref: 'main' } } as never);
      await markMerged(a.prId);

      await evaluateGroupNow('repo1', 'feat-a', 'test');

      expect((await entryOf(db, b.prId))?.baseBranch).toBe('main');
    });
  });

  describe('merge-queue mode (workspace setting)', () => {
    async function setMode(mode: 'ordered' | 'eager'): Promise<void> {
      await db
        .update(workspacesTable)
        .set({ settings: { mergeQueueMode: mode } })
        .where(eq(workspacesTable.id, 'ws1'));
    }

    it("eager: every clean entry merges in one evaluation — nothing waits behind a sibling", async () => {
      await setMode('eager');
      const a = await insertQueuedPr(db);
      const b = await insertQueuedPr(db);
      const c = await insertQueuedPr(db);

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mergeSpy).toHaveBeenCalledTimes(3);
      expect(await entryOf(db, a.prId)).toBeNull();
      expect(await entryOf(db, b.prId)).toBeNull();
      expect(await entryOf(db, c.prId)).toBeNull();
    });

    it('eager: a blocked head does not gate — it gets its fix run AND the clean sibling merges', async () => {
      await setMode('eager');
      const head = await insertQueuedPr(db, { summary: conflictSummary() });
      const ready = await insertQueuedPr(db);

      await evaluateGroupNow('repo1', 'main', 'test');

      expect((await entryOf(db, head.prId))?.status).toBe('fixing');
      expect(await countTasks(db)).toBe(1); // fix run for the head
      expect(mergeSpy).toHaveBeenCalledTimes(1); // sibling merged past it
      expect(await entryOf(db, ready.prId)).toBeNull();
    });

    it('ordered (default): unchanged — one same-base merge per evaluation', async () => {
      await setMode('ordered');
      const first = await insertQueuedPr(db);
      const second = await insertQueuedPr(db);

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect((await entryOf(db, second.prId))?.status).toBe('queued');
      expect(await entryOf(db, first.prId)).toBeNull();
    });
  });

  describe('auto-merge hybrid', () => {
    /** Required checks running + node id cached — the armable state. */
    const armableSummary = () => ({
      ...cleanSummary(),
      nodeId: 'PR_node123',
      mergeStateStatus: 'BLOCKED',
      blockingReason: 'blocked',
      checks: { total: 2, passed: 1, failed: 0, inProgress: 1, skipped: 0 },
    });

    it('arms the head (expectedHeadOid-pinned) when clean-but-awaiting-CI and capability allows', async () => {
      mockCapability.mockResolvedValue('available');
      const { prId } = await insertQueuedPr(db, { summary: armableSummary() });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mockEnableAutoMerge).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'PR_node123', expectedHeadOid: 'abc', mergeMethod: 'squash' })
      );
      const entry = await entryOf(db, prId);
      expect(entry?.status).toBe('automerge_armed');
      expect(entry?.automergeArmedBy).toBe('talyn');
      expect(mergeSpy).not.toHaveBeenCalled(); // GitHub owns the merge moment
    });

    it('falls back to a direct merge when GitHub refuses to arm a clean PR', async () => {
      mockCapability.mockResolvedValue('available');
      mockEnableAutoMerge.mockResolvedValue({ armed: false, reason: 'clean_status' });
      const { prId } = await insertQueuedPr(db, { summary: armableSummary() });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(await entryOf(db, prId)).toBeNull(); // merged
    });

    it('waits as awaiting_ci when the repo has auto-merge disabled', async () => {
      mockCapability.mockResolvedValue('unavailable');
      const { prId } = await insertQueuedPr(db, { summary: armableSummary() });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mockEnableAutoMerge).not.toHaveBeenCalled();
      expect((await entryOf(db, prId))?.status).toBe('awaiting_ci');
    });

    it('adopts a user-armed auto-merge without calling GitHub and never disarms it', async () => {
      mockCapability.mockResolvedValue('available');
      const { prId } = await insertQueuedPr(db, {
        summary: { ...armableSummary(), autoMergeBy: 'some-human' },
      });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mockEnableAutoMerge).not.toHaveBeenCalled();
      const entry = await entryOf(db, prId);
      expect(entry?.status).toBe('automerge_armed');
      expect(entry?.automergeArmedBy).toBe('user');
    });

    it('a clean sibling waits while the head is armed (one merge in flight per group)', async () => {
      mockCapability.mockResolvedValue('available');
      await insertQueuedPr(db, { summary: armableSummary() });
      const sibling = await insertQueuedPr(db);

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await entryOf(db, sibling.prId))?.status).toBe('queued');
    });

    it('updates a BEHIND branch server-side instead of firing a paid fix run', async () => {
      const updateSpy = vi
        .spyOn(githubService, 'updatePullRequestBranch')
        .mockResolvedValue('ok');
      const { prId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), mergeStateStatus: 'BEHIND' },
      });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(await countTasks(db)).toBe(0); // no cloud run
      expect((await entryOf(db, prId))?.status).toBe('awaiting_ci');
      expect(refreshSpy).toHaveBeenCalled();
    });

    it('falls back to the fix run when the server-side update conflicts', async () => {
      vi.spyOn(githubService, 'updatePullRequestBranch').mockResolvedValue('conflict');
      const { prId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), mergeStateStatus: 'BEHIND' },
      });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(await countTasks(db)).toBe(1);
      expect((await entryOf(db, prId))?.status).toBe('fixing');
    });
  });

  describe('reconciler', () => {
    it('retries pending disarms until GitHub confirms', async () => {
      const { entryId } = await insertQueuedPr(db, {
        summary: { ...cleanSummary(), nodeId: 'PR_node123' },
        entry: { lastEvaluatedAt: new Date() },
      });
      await db
        .update(mergeQueueEntries)
        .set({ pendingDisarm: true })
        .where(eq(mergeQueueEntries.id, entryId));

      await mergeQueueReconciler.runOnce();

      expect(mockDisableAutoMerge).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'PR_node123' })
      );
      const row = (
        await db.select().from(mergeQueueEntries).where(eq(mergeQueueEntries.id, entryId))
      )[0]!;
      expect(row.pendingDisarm).toBe(false);
    });

    it('heals entries whose PR left open outside the pipeline', async () => {
      const { prId, entryId } = await insertQueuedPr(db, { state: 'merged' });

      await mergeQueueReconciler.runOnce();

      expect(await entryOf(db, prId)).toBeNull();
      const row = (
        await db.select().from(mergeQueueEntries).where(eq(mergeQueueEntries.id, entryId))
      )[0]!;
      expect(row.status).toBe('merged');
    });

    it('re-evaluates stale groups (the dropped-webhook net)', async () => {
      await insertQueuedPr(db, { entry: { lastEvaluatedAt: new Date(Date.now() - 10 * 60_000) } });

      await mergeQueueReconciler.runOnce();

      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(1));
    });

    it('is dormant on the v1 engine', async () => {
      await setEngine(db, 'v1');
      await insertQueuedPr(db, { entry: { lastEvaluatedAt: null } });

      await mergeQueueReconciler.runOnce();

      expect(mergeSpy).not.toHaveBeenCalled();
    });
  });

  // The entry's base_branch is a denormalized group key. It used to be written
  // only at enqueue, so a retargeted PR was stranded in a group nothing walked
  // — and worse, its signing/gate probes ran against a base it no longer
  // targeted. The evaluation now reconciles it and bails before probing.
  describe('base branch reconciliation', () => {
    it('rewrites a stale group key and merges nothing on that walk', async () => {
      const { prId, entryId } = await insertQueuedPr(db, {
        summary: cleanSummary('main'),
        entry: { baseBranch: 'stale' },
      });

      await evaluateGroupNow('repo1', 'stale', 'test');

      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await entryOf(db, prId))?.baseBranch).toBe('main');
      const events = await eventsOf(db, entryId);
      const moved = events.find((e) => e.code === 'base_branch_changed');
      expect(moved).toBeDefined();
      expect(moved?.detail).toMatchObject({ from: 'stale', to: 'main' });
    });

    it('schedules the group the entry moved to, so it is not stranded', async () => {
      await insertQueuedPr(db, {
        summary: cleanSummary('main'),
        entry: { baseBranch: 'stale' },
      });

      await evaluateGroupNow('repo1', 'stale', 'test');

      // Nothing else keys on 'main' for this entry — if the walk didn't
      // reschedule, the PR would sit queued forever.
      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(1));
    });

    it('leaves a matching base alone (no churn on the common path)', async () => {
      const { entryId } = await insertQueuedPr(db, { summary: cleanSummary('main') });

      await evaluateGroupNow('repo1', 'main', 'test');

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      const events = await eventsOf(db, entryId);
      expect(events.some((e) => e.code === 'base_branch_changed')).toBe(false);
    });

    it('ignores an empty live base rather than blanking the key', async () => {
      const { baseBranch: _drop, ...noBase } = cleanSummary('main');
      const { entryId } = await insertQueuedPr(db, {
        summary: noBase,
        entry: { baseBranch: 'main' },
      });

      await evaluateGroupNow('repo1', 'main', 'test');

      const entryRow = (
        await db.select().from(mergeQueueEntries).where(eq(mergeQueueEntries.id, entryId))
      )[0]!;
      expect(entryRow.baseBranch).toBe('main');
      const events = await eventsOf(db, entryId);
      expect(events.some((e) => e.code === 'base_branch_changed')).toBe(false);
    });

    it('refreshes the key on re-arm, so a requeue un-strands a retargeted PR', async () => {
      const { prId } = await insertQueuedPr(db, {
        summary: cleanSummary('main'),
        entry: { baseBranch: 'stale', status: 'blocked', blockedCode: 'app_refused_hard' },
      });

      await ensureActiveEntry(
        {
          pullRequestId: prId,
          workspaceId: 'ws1',
          repositoryId: 'repo1',
          baseBranch: 'main',
          mergeMethod: 'squash',
          headSha: 'abc',
          trigger: 'user:enqueue',
        },
        db
      );

      const entry = await entryOf(db, prId);
      expect(entry?.baseBranch).toBe('main');
      expect(entry?.status).toBe('queued');
    });
  });
});
