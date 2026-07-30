import { useEffect, useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import type { TaskStatus, CloudProviderType } from '@talyn/shared';
import { taskCloudProvider } from '../../../lib/providerMeta';
import { GitHubPageShell } from './GitHubPageShell';
import { PRTable, reviewRequestSearchText } from './prTableShared';
import { RepoFilter, SortToggle, compareByCreated, prMatchesText, type SortDir } from './filters';
import { useGitHubActions } from './useGitHubActions';

/**
 * "Reviews" — every open PR awaiting your review (you're a requested reviewer,
 * directly or via a team, and haven't reviewed yet). Carries the repo
 * dropdown, the created-at sort, and the "Requested via" filter (directly to
 * you, or via a specific team).
 */
export function ReviewsPanel() {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const tasks = useWorkspaceStore((s) => s.tasks);
  const environments = useWorkspaceStore((s) => s.environments);
  const rows = usePullRequestStore((s) => s.rows);
  const viewerLogin = usePullRequestStore((s) => s.viewerLogin);
  const actions = useGitHubActions();

  const [repoFilter, setRepoFilter] = useState('all');
  const [requestedFilter, setRequestedFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const taskStatusById = useMemo(() => {
    const m = new Map<string, TaskStatus>();
    for (const t of tasks) m.set(t.id, t.status);
    return m;
  }, [tasks]);

  const taskProviderById = useMemo(() => {
    const m = new Map<string, CloudProviderType | null>();
    for (const t of tasks) m.set(t.id, taskCloudProvider(t, environments));
    return m;
  }, [tasks, environments]);

  // The distinct "requested via" options present in the review-requested rows.
  const requestedOptions = useMemo(() => {
    const teams = new Set<string>();
    let hasDirect = false;
    for (const r of rows) {
      if (!r.reviewRequested) continue;
      const via = r.summary.reviewRequestVia;
      if (!via) continue;
      if (via.direct) hasDirect = true;
      for (const t of via.teams) teams.add(t);
    }
    const opts: Array<{ value: string; label: string }> = [];
    if (hasDirect) {
      opts.push({ value: 'direct', label: `Directly${viewerLogin ? ` (@${viewerLogin})` : ''}` });
    }
    for (const t of [...teams].sort()) opts.push({ value: `team:${t}`, label: `@${t}` });
    return opts;
  }, [rows, viewerLogin]);

  // Drop a stale Requested selection when its option disappears from the list,
  // so it can't silently filter to nothing.
  useEffect(() => {
    if (requestedFilter !== 'all' && !requestedOptions.some((o) => o.value === requestedFilter)) {
      setRequestedFilter('all');
    }
  }, [requestedOptions, requestedFilter]);

  const filtered = useMemo(() => {
    let out = rows.filter((r) => r.reviewRequested);
    if (repoFilter !== 'all') out = out.filter((r) => r.repositoryId === repoFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(
        (r) =>
          prMatchesText(r, q) ||
          // Also match the requester (team name / your handle).
          reviewRequestSearchText(r.summary, viewerLogin).includes(q)
      );
    }
    if (requestedFilter !== 'all') {
      out = out.filter((r) => {
        const via = r.summary.reviewRequestVia;
        if (!via) return false;
        if (requestedFilter === 'direct') return via.direct;
        if (requestedFilter.startsWith('team:')) return via.teams.includes(requestedFilter.slice(5));
        return true;
      });
    }
    return out.slice().sort((a, b) => compareByCreated(a, b, sortDir));
  }, [rows, repoFilter, search, requestedFilter, sortDir, viewerLogin]);

  return (
    <GitHubPageShell
      title="Reviews"
      icon={<Eye className="h-5 w-5" />}
      activeView="review"
      search={search}
      onSearch={setSearch}
      rows={filtered}
      filters={
        <>
          <RepoFilter
            value={repoFilter}
            onChange={setRepoFilter}
            repos={repositories.map((r) => ({ id: r.id, name: r.fullName }))}
          />
          {requestedOptions.length > 0 && (
            <select
              value={requestedFilter}
              onChange={(e) => setRequestedFilter(e.target.value)}
              className="h-7 rounded-md border bg-background px-2 py-0 text-xs leading-7"
              title="Filter by who requested your review"
            >
              <option value="all">Any requester</option>
              {requestedOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <SortToggle sortDir={sortDir} onToggle={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))} />
        </>
      }
    >
      {({ selectedId, onSelect }) => (
        <PRTable
          rows={filtered}
          variant="review"
          viewerLogin={viewerLogin}
          selectedId={selectedId}
          onSelect={onSelect}
          onOpenTask={actions.openTask}
          onMerge={actions.mergeRow}
          onSetMergeQueue={actions.setMergeQueue}
          onCreatePostHogTask={actions.createPostHogTask}
          onRunSkill={actions.runSkillTask}
          taskAsk={actions.taskAsk}
          taskProviders={actions.taskProviders}
          onOpenIntegrations={actions.openIntegrations}
          taskStatusById={taskStatusById}
          taskProviderById={taskProviderById}
        />
      )}
    </GitHubPageShell>
  );
}
