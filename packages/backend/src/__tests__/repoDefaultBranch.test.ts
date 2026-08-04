import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import {
  repositories as repositoriesTable,
  workspaces as workspacesTable,
  users as usersTable,
} from '../db/schema.js';
import type { Database } from '../db/client.js';

/**
 * The repo's default branch, asked of GitHub instead of assumed.
 *
 * The bug: `repositories.default_branch` was hardcoded to 'main' by
 * `addWatchedRepo` and nothing ever corrected it. Survivable almost
 * everywhere — `skills.ts` sidesteps it by passing no ref — and fatal for the
 * fleet, whose golden images are keyed on `(repo, baseBranch)`. The bake ran
 * `git clone --branch main` against PostHog/posthog, git answered "Remote
 * branch main not found", and the bake failed in 2.5 seconds on every single
 * dispatch. No golden, every run on the base image, every run cloning a large
 * monorepo by hand.
 *
 * So the load-bearing case here is `master`, and the second one is that a
 * GitHub outage must NOT take a dispatch down with it.
 */

const REPO_ID = 'repo-1';
const WS_ID = 'ws-1';

let db: Database;
let cleanup: () => Promise<void>;
const getRepository = vi.fn();

vi.mock('../services/github.js', () => ({
  githubService: {
    getRepository: (...args: unknown[]) => getRepository(...args),
  },
}));

async function seed(storedBranch: string) {
  await db.insert(usersTable).values({ id: 'owner-1', email: 'op@talyn.dev' } as never);
  await db.insert(workspacesTable).values({
    id: WS_ID,
    name: 'ws',
    ownerId: 'owner-1',
    createdAt: new Date(),
  } as never);
  await db.insert(repositoriesTable).values({
    id: REPO_ID,
    workspaceId: WS_ID,
    name: 'PostHog/posthog',
    url: 'https://github.com/PostHog/posthog',
    defaultBranch: storedBranch,
    createdAt: new Date(),
  } as never);
}

async function readStoredBranch(): Promise<string> {
  const rows = await db
    .select({ b: repositoriesTable.defaultBranch })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.id, REPO_ID));
  return rows[0].b;
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  getRepository.mockReset();
  const mod = await import('../services/repoDefaultBranch.js');
  mod.resetRepoDefaultBranchCache();
});

afterEach(async () => {
  await cleanup();
});

describe('reconcileDefaultBranch', () => {
  it('corrects a stored branch that does not exist, and persists it', async () => {
    // THE case. Every existing row says 'main'; posthog is 'master'.
    await seed('main');
    getRepository.mockResolvedValue({ default_branch: 'master' });
    const { reconcileDefaultBranch } = await import('../services/repoDefaultBranch.js');

    const got = await reconcileDefaultBranch({
      repositoryId: REPO_ID,
      workspaceId: WS_ID,
      url: 'https://github.com/PostHog/posthog',
      stored: 'main',
    });

    expect(got).toBe('master');
    // Persisted, because a migration cannot ask GitHub and every existing row
    // is wrong — the first dispatch after deploy has to repair it.
    expect(await readStoredBranch()).toBe('master');
  });

  it('does not write when the stored branch is already right', async () => {
    await seed('master');
    getRepository.mockResolvedValue({ default_branch: 'master' });
    const { reconcileDefaultBranch } = await import('../services/repoDefaultBranch.js');

    const got = await reconcileDefaultBranch({
      repositoryId: REPO_ID,
      workspaceId: WS_ID,
      url: 'https://github.com/PostHog/posthog',
      stored: 'master',
    });
    expect(got).toBe('master');
    expect(getRepository).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['GitHub throws', () => getRepository.mockRejectedValue(new Error('502'))],
    ['GitHub returns no branch', () => getRepository.mockResolvedValue({ default_branch: '' })],
    ['GitHub returns nothing', () => getRepository.mockResolvedValue(undefined)],
  ])('keeps the stored branch when %s', async (_label, arrange) => {
    // A dispatch must not fail over a metadata refresh — that trades a slow
    // path for no path at all.
    await seed('master');
    arrange();
    const { reconcileDefaultBranch } = await import('../services/repoDefaultBranch.js');

    const got = await reconcileDefaultBranch({
      repositoryId: REPO_ID,
      workspaceId: WS_ID,
      url: 'https://github.com/PostHog/posthog',
      stored: 'master',
    });
    expect(got).toBe('master');
    expect(await readStoredBranch()).toBe('master');
  });

  it('falls back to main only when nothing is stored and GitHub is silent', async () => {
    await seed('main');
    getRepository.mockRejectedValue(new Error('down'));
    const { reconcileDefaultBranch } = await import('../services/repoDefaultBranch.js');

    const got = await reconcileDefaultBranch({
      repositoryId: REPO_ID,
      workspaceId: WS_ID,
      url: 'https://github.com/PostHog/posthog',
      stored: '',
    });
    expect(got).toBe('main');
  });

  it('leaves a row alone when the URL is not parseable as a GitHub repo', async () => {
    await seed('trunk');
    const { reconcileDefaultBranch } = await import('../services/repoDefaultBranch.js');

    const got = await reconcileDefaultBranch({
      repositoryId: REPO_ID,
      workspaceId: WS_ID,
      url: 'https://gitlab.example/thing',
      stored: 'trunk',
    });
    expect(got).toBe('trunk');
    expect(getRepository).not.toHaveBeenCalled();
  });
});

describe('fetchDefaultBranch caching', () => {
  it('collapses repeated asks for the same repo', async () => {
    getRepository.mockResolvedValue({ default_branch: 'master' });
    const { fetchDefaultBranch } = await import('../services/repoDefaultBranch.js');

    await fetchDefaultBranch(WS_ID, 'PostHog', 'posthog');
    await fetchDefaultBranch(WS_ID, 'PostHog', 'posthog');
    expect(getRepository).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure — the next dispatch asks again', async () => {
    // Caching "we could not reach GitHub" would extend one blip into five
    // minutes of dispatches running on the wrong branch.
    getRepository.mockRejectedValueOnce(new Error('boom'));
    getRepository.mockResolvedValue({ default_branch: 'master' });
    const { fetchDefaultBranch } = await import('../services/repoDefaultBranch.js');

    expect(await fetchDefaultBranch(WS_ID, 'PostHog', 'posthog')).toBeNull();
    expect(await fetchDefaultBranch(WS_ID, 'PostHog', 'posthog')).toBe('master');
  });

  it('keys the cache per workspace — two workspaces do not share an answer', async () => {
    getRepository.mockResolvedValueOnce({ default_branch: 'master' });
    getRepository.mockResolvedValueOnce({ default_branch: 'develop' });
    const { fetchDefaultBranch } = await import('../services/repoDefaultBranch.js');

    expect(await fetchDefaultBranch('ws-a', 'o', 'r')).toBe('master');
    expect(await fetchDefaultBranch('ws-b', 'o', 'r')).toBe('develop');
  });
});
