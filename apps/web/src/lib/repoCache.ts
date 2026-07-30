import type { GitHubRepo } from './api';

// Repo-list cache (localStorage). The full repo set (user + all orgs) is
// expensive to fetch, so we cache it per workspace and only re-fetch on an
// explicit refresh or once the cache ages past the TTL. Shared by the
// Settings "Watched Repositories" card and the onboarding repo step so both
// read/write the same key instead of fighting two caches.
export const REPO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
export const repoCacheKey = (workspaceId: string) => `fastowl:github-repos:${workspaceId}`;

export function readRepoCache(
  workspaceId: string
): { repos: GitHubRepo[]; fetchedAt: number } | null {
  try {
    const raw = localStorage.getItem(repoCacheKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.repos) || typeof parsed.fetchedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRepoCache(workspaceId: string, repos: GitHubRepo[], fetchedAt: number): void {
  try {
    localStorage.setItem(repoCacheKey(workspaceId), JSON.stringify({ repos, fetchedAt }));
  } catch {
    // Quota/serialization failure — non-fatal, we just won't cache.
  }
}

/** Coarse "x ago" for the repo-cache freshness hint. */
export function formatAge(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}
