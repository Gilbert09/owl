import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { openPullRequestForTask } from '../services/taskPullRequest.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../db/schema.js';
import { environmentService } from '../services/environment.js';
import { gitService } from '../services/git.js';
import { githubService } from '../services/github.js';
import * as ai from '../services/ai.js';

async function seed(db: Database, overrides: { repoUrl?: string } = {}): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({
    id: 'ws1',
    ownerId: TEST_USER_ID,
    name: 'mine',
    settings: {},
  });
  await db.insert(environmentsTable).values({
    id: 'env1',
    ownerId: TEST_USER_ID,
    name: 'local',
    type: 'local',
    status: 'connected',
    config: {},
  });
  await db.insert(repositoriesTable).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: 'acme/widgets',
    url: overrides.repoUrl ?? 'https://github.com/acme/widgets',
    localPath: '/tmp/widgets',
    defaultBranch: 'main',
  });
}

async function insertTask(
  db: Database,
  overrides: Partial<{
    id: string;
    branch: string | null;
    repositoryId: string | null;
    assignedEnvironmentId: string | null;
    metadata: Record<string, unknown>;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? 't-pr';
  const now = new Date();
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'awaiting_review',
    priority: 'medium',
    title: 'Add login',
    description: 'd',
    prompt: 'add login',
    repositoryId: overrides.repositoryId === undefined ? 'repo1' : overrides.repositoryId,
    branch: overrides.branch === undefined ? 'fastowl/t-pr-add-login' : overrides.branch,
    assignedEnvironmentId:
      overrides.assignedEnvironmentId === undefined ? 'env1' : overrides.assignedEnvironmentId,
    metadata: overrides.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function readMeta(db: Database, taskId: string): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ metadata: tasksTable.metadata })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return (rows[0]?.metadata as Record<string, unknown>) ?? {};
}

describe('openPullRequestForTask', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    // Short-circuit all outbound calls by default. Individual tests
    // override what they care about.
    vi.spyOn(gitService, 'getDiff').mockResolvedValue('');
    vi.spyOn(gitService, 'getDiffStat').mockResolvedValue('');
    vi.spyOn(environmentService, 'run').mockResolvedValue({
      stdout: '',
      stderr: '',
      code: 1, // `cat` of missing PR template → not found, drives template=undefined
    });
    vi.spyOn(ai, 'generatePullRequestContent').mockResolvedValue({
      title: 'feat: add login',
      body: 'LLM-generated body',
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('no-ops when the task has no branch', async () => {
    await seed(db);
    const id = await insertTask(db, { branch: null });
    const createPrSpy = vi.spyOn(githubService, 'createPullRequest');

    await openPullRequestForTask(id);

    expect(createPrSpy).not.toHaveBeenCalled();
    const meta = await readMeta(db, id);
    expect(meta.pullRequest).toBeUndefined();
    expect(meta.pullRequestError).toBeUndefined();
  });

  it('no-ops when the task has no repositoryId', async () => {
    await seed(db);
    const id = await insertTask(db, { repositoryId: null });
    const createPrSpy = vi.spyOn(githubService, 'createPullRequest');

    await openPullRequestForTask(id);

    expect(createPrSpy).not.toHaveBeenCalled();
    const meta = await readMeta(db, id);
    expect(meta.pullRequest).toBeUndefined();
  });

  it('no-ops when the task has no assignedEnvironmentId', async () => {
    await seed(db);
    const id = await insertTask(db, { assignedEnvironmentId: null });
    const createPrSpy = vi.spyOn(githubService, 'createPullRequest');

    await openPullRequestForTask(id);

    expect(createPrSpy).not.toHaveBeenCalled();
  });

  it('no-ops for a non-github repo URL', async () => {
    await seed(db, { repoUrl: 'https://gitlab.com/acme/widgets' });
    const id = await insertTask(db);
    const createPrSpy = vi.spyOn(githubService, 'createPullRequest');

    await openPullRequestForTask(id);

    expect(createPrSpy).not.toHaveBeenCalled();
  });

  it('persists metadata.pullRequest on success', async () => {
    await seed(db);
    const id = await insertTask(db);
    vi.spyOn(githubService, 'createPullRequest').mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/acme/widgets/pull/42',
      user: { login: 'me' },
      head: { ref: 'fastowl/abc-login', sha: 'sha-x' },
    } as Awaited<ReturnType<typeof githubService.createPullRequest>>);

    await openPullRequestForTask(id);

    const meta = await readMeta(db, id);
    expect(meta.pullRequest).toEqual(
      expect.objectContaining({
        number: 42,
        url: 'https://github.com/acme/widgets/pull/42',
      })
    );
    expect(meta.pullRequestError).toBeUndefined();
  });

  it('forwards the LLM-generated title + body + head/base to githubService', async () => {
    await seed(db);
    const id = await insertTask(db, { branch: 'fastowl/abc-login' });
    const createPr = vi
      .spyOn(githubService, 'createPullRequest')
      .mockResolvedValue({
        number: 7,
        html_url: 'x',
        user: { login: 'me' },
        head: { ref: 'fastowl/abc-login', sha: 'sha-x' },
      } as Awaited<ReturnType<typeof githubService.createPullRequest>>);

    await openPullRequestForTask(id);

    expect(createPr).toHaveBeenCalledWith(
      'ws1',
      'acme',
      'widgets',
      expect.objectContaining({
        title: 'feat: add login',
        body: 'LLM-generated body',
        head: 'fastowl/abc-login',
        base: 'main',
      })
    );
  });

  it('persists metadata.pullRequestError when GitHub createPullRequest throws', async () => {
    await seed(db);
    const id = await insertTask(db);
    vi.spyOn(githubService, 'createPullRequest').mockRejectedValue(
      new Error('PR already exists for this branch')
    );

    await openPullRequestForTask(id);

    const meta = await readMeta(db, id);
    expect(meta.pullRequest).toBeUndefined();
    expect(meta.pullRequestError).toBe('PR already exists for this branch');
  });

  it('on retry success, clears pullRequestError and sets pullRequest', async () => {
    await seed(db);
    const id = await insertTask(db, {
      metadata: { pullRequestError: 'temporary flake' },
    });
    vi.spyOn(githubService, 'createPullRequest').mockResolvedValue({
      number: 13,
      html_url: 'https://github.com/acme/widgets/pull/13',
      user: { login: 'me' },
      head: { ref: 'fastowl/abc-login', sha: 'sha-x' },
    } as Awaited<ReturnType<typeof githubService.createPullRequest>>);

    await openPullRequestForTask(id);

    const meta = await readMeta(db, id);
    expect(meta.pullRequestError).toBeUndefined();
    expect(meta.pullRequest).toEqual(
      expect.objectContaining({ number: 13 })
    );
  });

  it('uses a PR template when one is present in the repo', async () => {
    await seed(db);
    const id = await insertTask(db);
    vi.spyOn(githubService, 'createPullRequest').mockResolvedValue({
      number: 5,
      html_url: 'x',
      user: { login: 'me' },
      head: { ref: 'fastowl/abc-login', sha: 'sha-x' },
    } as Awaited<ReturnType<typeof githubService.createPullRequest>>);

    const runSpy = vi.spyOn(environmentService, 'run').mockImplementation(
      async (_envId, binary, args) => {
        const [filePath] = args;
        if (binary === 'cat' && filePath === '.github/pull_request_template.md') {
          return { stdout: '## Why\n\n<!-- fill me -->\n', stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 1 };
      }
    );
    const genSpy = vi
      .spyOn(ai, 'generatePullRequestContent')
      .mockResolvedValue({ title: 'feat', body: 'body-from-template' });

    await openPullRequestForTask(id);

    // Verify the template content was passed through to the LLM.
    expect(genSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        templateContent: '## Why\n\n<!-- fill me -->\n',
      })
    );
    // And cat was queried via the environmentService (daemon run op).
    const catCalls = runSpy.mock.calls.filter((c) => c[1] === 'cat');
    expect(catCalls.length).toBeGreaterThan(0);
  });

  it('swallows its own unexpected errors (never throws to the caller)', async () => {
    await seed(db);
    const id = await insertTask(db);
    // Make the LLM helper throw — openPullRequestForTask should still
    // return cleanly without tripping the outer try/catch.
    vi.spyOn(ai, 'generatePullRequestContent').mockRejectedValue(new Error('ai broke'));

    await expect(openPullRequestForTask(id)).resolves.toBeUndefined();
  });
});
