// The repo's real default branch, asked of GitHub and written back.
//
// # Why this exists
//
// `repositories.default_branch` has been a lie since the column was added:
// `prMonitor.addWatchedRepo` hardcodes `'main'` and nothing has ever corrected
// it. Every repo in every workspace carries `main` whether or not that branch
// exists.
//
// It was known — `skills.ts` documents it and names posthog/posthog as the
// example — but the workaround there was to stop reading the column (the
// contents API resolves the default branch itself when passed no ref). That
// works for skills and cannot work for the fleet: a golden image is keyed on
// `(repo, baseBranch)`, so the branch NAME is part of the identity and there is
// nothing to omit.
//
// The result was a bake that failed in 2.5 seconds, every time, forever:
//
//	==> Baking PostHog/posthog@main
//	fatal: Remote branch main not found in upstream origin
//
// So PostHog/posthog never got a golden, every run fell back to the base image,
// and every run cloned a large monorepo by hand — which is also how it ran out
// of disk. One wrong string, three symptoms, none of which pointed at it.
//
// # Why it writes back
//
// Correcting `addWatchedRepo` alone would fix only repos added after the
// deploy. Every existing row would keep its wrong branch and keep failing, and
// a migration cannot call GitHub. So this reads through and persists, which
// means the first dispatch after deploy repairs the row for good.

import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { repositories as repositoriesTable } from '../db/schema.js';
import { githubService } from './github.js';
import { parseRepoUrl } from './repoIdentity.js';

/**
 * Only long enough to collapse the burst a single dispatch causes. Not a
 * correctness cache — a repo that changes its default branch must not need a
 * backend restart to be noticed, and the write-back means the DB is the real
 * store anyway.
 */
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { branch: string; at: number }>();

/** Test seam. */
export function resetRepoDefaultBranchCache(): void {
  cache.clear();
}

/**
 * GitHub's answer for `owner/repo`, or null when we could not ask.
 *
 * Null rather than a guess: every caller already has a stored value, and a
 * stored value that might be right beats `'main'`, which for the repo that
 * prompted this is definitely wrong.
 */
export async function fetchDefaultBranch(
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<string | null> {
  const key = `${workspaceId}:${owner}/${repo}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.branch;

  try {
    const info = await githubService.getRepository(workspaceId, owner, repo);
    const branch = info?.default_branch?.trim();
    if (!branch) return null;
    cache.set(key, { branch, at: Date.now() });
    return branch;
  } catch (err) {
    // Never fatal. A dispatch that cannot reach GitHub should still run with
    // whatever branch we have on file; failing the task over a metadata
    // refresh would trade a slow path for no path at all.
    console.warn(
      `[repo] could not read the default branch for ${owner}/${repo}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

/**
 * The default branch for a stored repository row, refreshed from GitHub and
 * persisted when it turns out to be wrong.
 *
 * Returns the stored value unchanged when GitHub is unreachable, so this is
 * safe to put on a dispatch path.
 */
export async function reconcileDefaultBranch(input: {
  repositoryId: string;
  workspaceId: string;
  url: string;
  stored: string;
}): Promise<string> {
  const identity = parseRepoUrl(input.url);
  if (!identity) return input.stored;

  const actual = await fetchDefaultBranch(input.workspaceId, identity.owner, identity.repo);
  if (!actual || actual === input.stored) return input.stored || 'main';

  await getDbClient()
    .update(repositoriesTable)
    .set({ defaultBranch: actual })
    .where(eq(repositoriesTable.id, input.repositoryId));
  console.log(
    `[repo] ${identity.fullName} default branch corrected: ${input.stored || '(empty)'} -> ${actual}`,
  );
  return actual;
}
