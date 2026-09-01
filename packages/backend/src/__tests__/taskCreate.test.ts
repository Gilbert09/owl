import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createCloudTask } from '../services/taskCreate.js';
import { getSkillUsage } from '../services/skills.js';
import * as skillsModule from '../services/skills.js';
import * as prCacheModule from '../services/prCache.js';
import * as websocketModule from '../services/websocket.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  environments as environmentsTable,
  tasks as tasksTable,
} from '../db/schema.js';

describe('createCloudTask', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      defaultBranch: 'main',
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function seedPr(over: { id?: string; workspaceId?: string } = {}): Promise<string> {
    const id = over.id ?? 'pr1';
    const workspaceId = over.workspaceId ?? 'ws1';
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId,
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      state: 'open',
      lastSummary: { url: 'https://github.com/acme/widgets/pull/42' },
    });
    return id;
  }

  it('inserts a queued task with defaults and returns the row', async () => {
    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'code_writing',
      title: 'Do the thing',
      description: 'desc',
      repositoryId: 'repo1',
    });

    expect(row.status).toBe('queued');
    expect(row.priority).toBe('medium');
    expect(row.repositoryId).toBe('repo1');
    expect(row.prompt).toBeNull();
    expect(row.metadata).toBeNull();

    const persisted = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, row.id))
      .limit(1);
    expect(persisted[0]?.status).toBe('queued');
  });

  it('honours explicit priority, prompt and environment', async () => {
    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      prompt: 'fix it',
      priority: 'urgent',
      repositoryId: 'repo1',
      assignedEnvironmentId: null,
    });

    expect(row.priority).toBe('urgent');
    expect(row.prompt).toBe('fix it');
    expect(row.assignedEnvironmentId).toBeNull();
  });

  it('stashes runtimeAdapter + model overrides on metadata for dispatch', async () => {
    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'code_writing',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      runtimeAdapter: 'codex',
      model: 'gpt-5',
    });

    expect(row.metadata).toEqual({ runtimeAdapter: 'codex', model: 'gpt-5' });
  });

  it('stashes a pullRequest pointer on metadata and reverse-links the PR row', async () => {
    const prId = await seedPr();

    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      pullRequestId: prId,
    });

    const meta = row.metadata as { pullRequest?: { id: string; number: number; url: string } };
    expect(meta.pullRequest?.id).toBe(prId);
    expect(meta.pullRequest?.number).toBe(42);
    expect(meta.pullRequest?.url).toBe('https://github.com/acme/widgets/pull/42');

    const prRows = await db
      .select({ taskId: pullRequestsTable.taskId })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, prId))
      .limit(1);
    expect(prRows[0]?.taskId).toBe(row.id);
  });

  it('skips the PR pointer when the PR belongs to a different workspace', async () => {
    await seedUser(db, { id: 'user-other' });
    await db.insert(workspacesTable).values({
      id: 'ws2',
      ownerId: 'user-other',
      name: 'other',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1', // FK requirement only; the PR row carries its own workspaceId
      workspaceId: 'ws1',
      name: 'x',
      url: 'x',
      defaultBranch: 'main',
    }).onConflictDoNothing();
    const prId = await seedPr({ id: 'pr-foreign', workspaceId: 'ws2' });

    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      pullRequestId: prId,
    });

    expect(row.metadata).toBeNull();
    const prRows = await db
      .select({ taskId: pullRequestsTable.taskId })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, prId))
      .limit(1);
    expect(prRows[0]?.taskId).toBeNull();
  });

  it('still creates the task when the PR link fails', async () => {
    const prId = await seedPr();
    vi.spyOn(prCacheModule, 'attachTaskToPullRequestRow').mockRejectedValue(
      new Error('boom')
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      pullRequestId: prId,
    });

    expect(row.status).toBe('queued');
    expect(errSpy).toHaveBeenCalled();
  });

  it('persists metadata.skill and bumps the workspace skill-usage counter', async () => {
    const skill = {
      key: 'repo:acme/widgets:reviewer',
      name: 'reviewer',
      source: 'repo' as const,
      repositoryId: 'repo1',
    };

    const first = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      skill,
    });
    expect((first.metadata as { skill?: unknown }).skill).toEqual(skill);

    await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't2',
      description: '',
      repositoryId: 'repo1',
      skill,
    });

    // The bump is fire-and-forget; give the microtask a beat to land.
    await vi.waitFor(async () => {
      const usage = await getSkillUsage('ws1');
      expect(usage[skill.key]?.count).toBe(2);
    });
  });

  it('creates the task even when the usage bump fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(skillsModule, 'bumpSkillUsage').mockRejectedValue(new Error('db down'));

    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 't',
      description: '',
      repositoryId: 'repo1',
      skill: { key: 'local:x', name: 'x', source: 'local' },
    });
    expect(row.status).toBe('queued');
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
  });

  it('announces the new task over the workspace WS room', async () => {
    const spy = vi.spyOn(websocketModule, 'emitTaskCreated');

    const row = await createCloudTask({
      workspaceId: 'ws1',
      type: 'code_writing',
      title: 'announce me',
      description: '',
      repositoryId: 'repo1',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [workspaceId, task] = spy.mock.calls[0];
    expect(workspaceId).toBe('ws1');
    expect(task.id).toBe(row.id);
    expect(task.title).toBe('announce me');
  });
});

/**
 * Repeat runs at one PR reuse the finished task instead of inserting another.
 *
 * A PR that keeps needing work (auto-keep, merge-queue fixes) accumulated one
 * task per run — and, because each new task created a new REMOTE task, one
 * provider session per run too, which is what made PostHog's session list
 * unreadable: the same "Get PostHog/posthog#90517 mergeable" a dozen times
 * over. Reuse gives one task per (PR, type) here and one session per PR there,
 * with the repeat runs hanging off it.
 *
 * The keying and the metadata carry-over are the parts that can go quietly
 * wrong, so they are what these pin.
 */
describe('createCloudTask — reusing a task for the same PR', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      defaultBranch: 'main',
    });
    await db.insert(pullRequestsTable).values({
      id: 'pr1',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      state: 'open',
      lastSummary: { url: 'https://github.com/acme/widgets/pull/42' },
    });
    await db.insert(pullRequestsTable).values({
      id: 'pr2',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 43,
      state: 'open',
      lastSummary: { url: 'https://github.com/acme/widgets/pull/43' },
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  const run = (over: Record<string, unknown> = {}) =>
    createCloudTask({
      workspaceId: 'ws1',
      type: 'pr_response',
      title: 'Get acme/widgets#42 mergeable',
      description: 'desc',
      repositoryId: 'repo1',
      pullRequestId: 'pr1',
      ...over,
    } as Parameters<typeof createCloudTask>[0]);

  /** Settle a task the way a finished run would. */
  async function finish(id: string, status = 'completed'): Promise<void> {
    await db
      .update(tasksTable)
      .set({ status, completedAt: new Date() })
      .where(eq(tasksTable.id, id));
  }

  async function taskCount(): Promise<number> {
    return (await db.select({ id: tasksTable.id }).from(tasksTable)).length;
  }

  async function envFor(type: string): Promise<string> {
    const id = `env-${type}`;
    await db.insert(environmentsTable).values({
      id,
      ownerId: TEST_USER_ID,
      name: type,
      type,
      config: {},
    });
    return id;
  }

  it('reuses the finished task rather than inserting a second one', async () => {
    const first = await run();
    await finish(first.id);

    const second = await run({ title: 'Get acme/widgets#42 mergeable (again)' });

    expect(second.id).toBe(first.id);
    expect(await taskCount()).toBe(1);
  });

  it('re-arms the reused row: new prompt, back to queued, last run cleared', async () => {
    const first = await run({ prompt: 'first prompt' });
    await db
      .update(tasksTable)
      .set({
        status: 'failed',
        completedAt: new Date(),
        transcript: [{ type: 'text' }],
        result: { error: 'boom' },
        branch: 'old-branch',
      })
      .where(eq(tasksTable.id, first.id));

    const second = await run({ prompt: 'second prompt' });

    expect(second.status).toBe('queued');
    expect(second.prompt).toBe('second prompt');
    // The previous run's output must not read as this one's.
    expect(second.transcript).toBeNull();
    expect(second.result).toBeNull();
    expect(second.branch).toBeNull();
    expect(second.completedAt).toBeNull();
  });

  it('does NOT touch a task that is still running', async () => {
    // Rewriting a live task's prompt would redirect a run already in flight.
    const first = await run();
    // left `queued` — never settled
    const second = await run();

    expect(second.id).not.toBe(first.id);
    expect(await taskCount()).toBe(2);
  });

  it('keys on the PR — a different PR gets its own task', async () => {
    const first = await run();
    await finish(first.id);

    const other = await run({ pullRequestId: 'pr2' });

    expect(other.id).not.toBe(first.id);
    expect(await taskCount()).toBe(2);
  });

  it('keys on the task type — a review does not land in the fix task', async () => {
    const fix = await run({ type: 'pr_response' });
    await finish(fix.id);

    const review = await run({ type: 'pr_review' });

    expect(review.id).not.toBe(fix.id);
    expect(await taskCount()).toBe(2);
  });

  it('never reuses a task with no PR at all', async () => {
    // Freeform tasks have nothing to key on; two of them are two tasks.
    const first = await run({ pullRequestId: null, type: 'code_writing' });
    await finish(first.id);
    const second = await run({ pullRequestId: null, type: 'code_writing' });

    expect(second.id).not.toBe(first.id);
  });

  describe('the remote handle it carries over', () => {
    it('keeps the PostHog task id, so the repeat run joins the same session', async () => {
      const envId = await envFor('posthog_code');
      const first = await run({ assignedEnvironmentId: envId });
      await db
        .update(tasksTable)
        .set({
          metadata: {
            posthogTaskId: 'remote-1',
            posthogProjectId: 99,
            posthogHost: 'https://us.posthog.com',
            posthogRunId: 'run-1',
            posthogStatus: 'completed',
            posthogLogUrl: 'https://logs',
          },
        })
        .where(eq(tasksTable.id, first.id));
      await finish(first.id);

      const second = await run({ assignedEnvironmentId: envId });
      const meta = second.metadata as Record<string, unknown>;

      expect(meta.posthogTaskId).toBe('remote-1');
      expect(meta.posthogProjectId).toBe(99);
      expect(meta.posthogHost).toBe('https://us.posthog.com');
    });

    it('drops the RUN fields — carrying them wedges the task in queued forever', async () => {
      // The executor returns early on "has a task id AND a run id", treating
      // the dispatch as already done. This is the assertion that keeps a
      // reused task from silently never running.
      const envId = await envFor('posthog_code');
      const first = await run({ assignedEnvironmentId: envId });
      await db
        .update(tasksTable)
        .set({ metadata: { posthogTaskId: 'remote-1', posthogRunId: 'run-1', posthogStatus: 'completed' } })
        .where(eq(tasksTable.id, first.id));
      await finish(first.id);

      const meta = (await run({ assignedEnvironmentId: envId })).metadata as Record<string, unknown>;

      expect(meta.posthogRunId).toBeUndefined();
      expect(meta.posthogStatus).toBeUndefined();
      expect(meta.posthogLogUrl).toBeUndefined();
    });

    it('drops the handle when the workspace has switched providers', async () => {
      // Only PostHog can start another run on an existing remote task. Handing
      // a PostHog id to another provider would satisfy its "already dispatched"
      // guard and the task would never run.
      const posthogEnv = await envFor('posthog_code');
      const first = await run({ assignedEnvironmentId: posthogEnv });
      await db
        .update(tasksTable)
        .set({ metadata: { posthogTaskId: 'remote-1' } })
        .where(eq(tasksTable.id, first.id));
      await finish(first.id);

      const claudeEnv = await envFor('claude_code');
      const meta = (await run({ assignedEnvironmentId: claudeEnv })).metadata as Record<
        string,
        unknown
      > | null;

      expect(meta?.posthogTaskId).toBeUndefined();
    });

    it('drops a cloudTask handle — no other provider can re-run one', async () => {
      const claudeEnv = await envFor('claude_code');
      const first = await run({ assignedEnvironmentId: claudeEnv });
      await db
        .update(tasksTable)
        .set({ metadata: { cloudTask: { provider: 'claude_code', remoteTaskId: 'sess-1' } } })
        .where(eq(tasksTable.id, first.id));
      await finish(first.id);

      const meta = (await run({ assignedEnvironmentId: claudeEnv })).metadata as Record<
        string,
        unknown
      > | null;

      expect(meta?.cloudTask).toBeUndefined();
    });
  });
});
