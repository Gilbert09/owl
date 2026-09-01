import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, isNull, sql } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
  workspaces as workspacesTable,
} from '../db/schema.js';

/**
 * Migration 0048's backfill of `tasks.pull_request_id`.
 *
 * The migration itself has already run by the time a test DB exists, so this
 * re-runs its two UPDATE statements against rows shaped the way production's
 * were before it: linked only by the forward pointer (`pull_requests.task_id`)
 * or only by the jsonb pointer in `tasks.metadata`.
 *
 * Worth a test because a backfill runs exactly once, in production, with no
 * second chance — and because the second statement's EXISTS guard is
 * load-bearing: metadata can name a PR row that has since been deleted, and
 * the new foreign key would reject it.
 */

const BACKFILL_FROM_FORWARD_POINTER = sql`
  UPDATE "tasks" t
    SET "pull_request_id" = pr."id"
    FROM "pull_requests" pr
    WHERE pr."task_id" = t."id" AND t."pull_request_id" IS NULL
`;

const BACKFILL_FROM_METADATA = sql`
  UPDATE "tasks" t
    SET "pull_request_id" = t."metadata" -> 'pullRequest' ->> 'id'
    WHERE t."pull_request_id" IS NULL
      AND t."metadata" -> 'pullRequest' ->> 'id' IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "pull_requests" p
        WHERE p."id" = t."metadata" -> 'pullRequest' ->> 'id'
      )
`;

describe('migration 0048 — tasks.pull_request_id backfill', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws1' });
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

  async function insertTask(id: string, metadata?: unknown) {
    await db.insert(tasksTable).values({
      id,
      workspaceId: 'ws1',
      type: 'pr_response',
      status: 'completed',
      priority: 'medium',
      title: 't',
      description: 'd',
      repositoryId: 'repo1',
      metadata: metadata as never,
    });
  }

  async function insertPr(id: string, number: number, taskId: string | null) {
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      taskId,
      owner: 'a',
      repo: 'b',
      number,
      state: 'open',
      lastPolledAt: new Date(),
      lastSummary: {},
    });
  }

  const linkOf = async (taskId: string) =>
    (
      await db
        .select({ prId: tasksTable.pullRequestId })
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId))
        .limit(1)
    )[0]?.prId ?? null;

  it('recovers the link from the forward pointer', async () => {
    await insertTask('task-a');
    await insertPr('pr-a', 1, 'task-a');

    await db.execute(BACKFILL_FROM_FORWARD_POINTER);

    expect(await linkOf('task-a')).toBe('pr-a');
  });

  it('recovers the link from task metadata when the PR has moved on', async () => {
    // The case the forward pointer cannot answer: two tasks worked this PR and
    // `task_id` names only the later one, so the earlier task is recoverable
    // solely from its own metadata.
    await insertTask('task-old', { pullRequest: { id: 'pr-b', number: 2, url: '', createdAt: '' } });
    await insertTask('task-new', { pullRequest: { id: 'pr-b', number: 2, url: '', createdAt: '' } });
    await insertPr('pr-b', 2, 'task-new');

    await db.execute(BACKFILL_FROM_FORWARD_POINTER);
    expect(await linkOf('task-old')).toBeNull(); // invisible to statement 1
    await db.execute(BACKFILL_FROM_METADATA);

    expect(await linkOf('task-old')).toBe('pr-b');
    expect(await linkOf('task-new')).toBe('pr-b');
  });

  it('skips metadata naming a PR row that no longer exists', async () => {
    // Without the EXISTS guard this row violates the new foreign key and the
    // whole migration aborts.
    await insertTask('task-orphan', {
      pullRequest: { id: 'pr-deleted', number: 9, url: '', createdAt: '' },
    });

    await db.execute(BACKFILL_FROM_FORWARD_POINTER);
    await db.execute(BACKFILL_FROM_METADATA);

    expect(await linkOf('task-orphan')).toBeNull();
  });

  it('leaves a task with no PR association alone', async () => {
    await insertTask('task-plain');

    await db.execute(BACKFILL_FROM_FORWARD_POINTER);
    await db.execute(BACKFILL_FROM_METADATA);

    const unlinked = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(isNull(tasksTable.pullRequestId));
    expect(unlinked.map((r) => r.id)).toEqual(['task-plain']);
  });

  it('nulls the link rather than deleting the task when its PR is removed', async () => {
    await insertTask('task-c');
    await insertPr('pr-c', 3, 'task-c');
    await db.execute(BACKFILL_FROM_FORWARD_POINTER);
    expect(await linkOf('task-c')).toBe('pr-c');

    // Un-watching a PR deletes its row; the run that happened still happened.
    await db.update(pullRequestsTable).set({ taskId: null }).where(eq(pullRequestsTable.id, 'pr-c'));
    await db.delete(pullRequestsTable).where(eq(pullRequestsTable.id, 'pr-c'));

    const rows = await db.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.id, 'task-c'));
    expect(rows).toHaveLength(1);
    expect(await linkOf('task-c')).toBeNull();
  });
});
