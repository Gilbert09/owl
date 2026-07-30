// React binding for the skills cache (lib/skillsData.ts). Renders instantly
// from the prefetched snapshot when one exists — skills are meant to be
// immediately usable — and refreshes in the background on mount
// (stale-while-revalidate).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListSkillsResponse, SkillSummary, SkillUsageEntry } from '@talyn/shared';
import { getCachedSkills, loadSkills, type SkillsSnapshot } from '../lib/skillsData';
import type { LocalSkillFile } from '../lib/env';

export interface UseSkillsResult {
  /** All sources merged: repo skills, platform skills, local skills. */
  skills: SkillSummary[];
  /** Raw IPC listing — the launch flow reads local content from here. */
  localFiles: LocalSkillFile[];
  usage: Record<string, SkillUsageEntry>;
  repoStatus: ListSkillsResponse['repoStatus'];
  /** True only while fetching with nothing cached to show. */
  loading: boolean;
  /** True while ANY fetch is in flight, cached or not — drives refresh spinners. */
  refreshing: boolean;
  error: string | null;
  /** Re-fetch; `refreshRepo` busts the backend's repo-skill cache. */
  refresh: (opts?: { refreshRepo?: boolean }) => Promise<void>;
}

const EMPTY: SkillsSnapshot = { skills: [], localFiles: [], usage: {}, repoStatus: 'none' };

export function useSkills(
  workspaceId: string | null,
  repositoryId: string | null
): UseSkillsResult {
  const cached = workspaceId ? getCachedSkills(workspaceId, repositoryId) : undefined;
  const [snapshot, setSnapshot] = useState<SkillsSnapshot>(cached ?? EMPTY);
  const [loading, setLoading] = useState(Boolean(workspaceId && !cached));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const refresh = useCallback(
    async (opts: { refreshRepo?: boolean } = {}) => {
      if (!workspaceId) return;
      const seq = ++requestSeq.current;
      // Serve whatever's cached instantly; the full-body spinner only shows on
      // a cold key, but `refreshing` is on for the whole fetch either way.
      if (!getCachedSkills(workspaceId, repositoryId)) setLoading(true);
      setRefreshing(true);
      const result = await loadSkills(workspaceId, repositoryId, opts);
      if (seq !== requestSeq.current) return; // stale response — a newer refresh ran
      setSnapshot(result.snapshot);
      setError(result.error);
      setLoading(false);
      setRefreshing(false);
    },
    [workspaceId, repositoryId]
  );

  useEffect(() => {
    // Key changed: swap to that key's cached snapshot (or empty) immediately,
    // then revalidate in the background.
    const next = workspaceId ? getCachedSkills(workspaceId, repositoryId) : undefined;
    setSnapshot(next ?? EMPTY);
    setLoading(Boolean(workspaceId && !next));
    setError(null);
    void refresh();
  }, [refresh, workspaceId, repositoryId]);

  return { ...snapshot, loading, refreshing, error, refresh };
}
