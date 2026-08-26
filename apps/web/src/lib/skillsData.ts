// Skills data loader + renderer-side cache. Skills must be *immediately*
// usable: the app prefetches local + repo skills as soon as the workspace's
// repos are known (see useInitialDataLoad), and the picker/Settings render
// straight from this cache while a background refresh keeps it fresh
// (stale-while-revalidate). The backend keeps its own 10-min repo cache, so
// a prefetch also warms discovery server-side.

import type { ListSkillsResponse, SkillSummary, SkillUsageEntry } from '@talyn/shared';
import { api } from './api';
import { toLocalSkillSummaries } from './skills';
import type { LocalSkillFile } from './env';

export interface SkillsSnapshot {
  /** All sources merged: repo skills, platform skills, local skills. */
  skills: SkillSummary[];
  /** Raw IPC listing — the launch flow reads local content from here. */
  localFiles: LocalSkillFile[];
  usage: Record<string, SkillUsageEntry>;
  repoStatus: ListSkillsResponse['repoStatus'];
  /** Why repo discovery failed, when it did — GitHub's own message. */
  repoError?: string;
}

const cache = new Map<string, SkillsSnapshot>();

function cacheKey(workspaceId: string, repositoryId: string | null): string {
  return `${workspaceId}:${repositoryId ?? ''}`;
}

export function getCachedSkills(
  workspaceId: string,
  repositoryId: string | null
): SkillsSnapshot | undefined {
  return cache.get(cacheKey(workspaceId, repositoryId));
}

/** Test hook. */
export function clearSkillsCache(): void {
  cache.clear();
}

/**
 * Fetch the backend skills list + the local IPC listing and cache the merged
 * snapshot. On a backend failure the previous snapshot is kept (and returned)
 * rather than blanked — a flaky request must not empty an already-warm picker.
 */
export async function loadSkills(
  workspaceId: string,
  repositoryId: string | null,
  opts: { refreshRepo?: boolean } = {}
): Promise<{ snapshot: SkillsSnapshot; error: string | null }> {
  const key = cacheKey(workspaceId, repositoryId);
  // The desktop also reads ~/.claude/skills over IPC and merges an "On this
  // machine" group in. A browser has no filesystem, so that group is simply
  // absent here — platform and repo skills are unaffected. See
  // HAS_LOCAL_SKILLS, which the UI uses to hide the group rather than render
  // a permanently empty one.
  const [backend] = await Promise.allSettled([
    api.skills.list(workspaceId, repositoryId ?? undefined, opts.refreshRepo),
  ]);
  const local = { status: 'fulfilled' as const, value: [] as LocalSkillFile[] };

  const localFiles = local.status === 'fulfilled' ? local.value : [];
  const localSummaries = toLocalSkillSummaries(localFiles);

  if (backend.status === 'fulfilled') {
    const snapshot: SkillsSnapshot = {
      skills: [...backend.value.repo, ...backend.value.platform, ...localSummaries],
      localFiles,
      usage: backend.value.usage,
      repoStatus: backend.value.repoStatus,
      repoError: backend.value.repoError,
    };
    cache.set(key, snapshot);
    return { snapshot, error: null };
  }

  const error =
    backend.reason instanceof Error ? backend.reason.message : 'Failed to load skills';
  const stale = cache.get(key);
  if (stale) return { snapshot: stale, error };
  return {
    snapshot: { skills: localSummaries, localFiles, usage: {}, repoStatus: 'error', repoError: error },
    error,
  };
}

/**
 * Warm the cache for a workspace: local skills plus repo discovery for every
 * watched repo, so the first picker open renders instantly. Fire-and-forget;
 * failures are non-fatal (the picker falls back to fetch-on-open).
 */
export async function prefetchSkills(
  workspaceId: string,
  repositoryIds: string[]
): Promise<void> {
  const targets: (string | null)[] = repositoryIds.length > 0 ? repositoryIds : [null];
  await Promise.allSettled(targets.map((repoId) => loadSkills(workspaceId, repoId)));
}
