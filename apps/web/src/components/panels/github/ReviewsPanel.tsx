import { useEffect, useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import type { TaskStatus, AnyCloudProviderType, PRFilterDefinition } from '@talyn/shared';
import { prMatchesAnyFilter } from '@talyn/shared';
import { taskCloudProvider } from '../../../lib/providerMeta';
import { GitHubPageShell } from './GitHubPageShell';
import { PRTable, reviewRequestSearchText } from './prTableShared';
import {
  ClearFiltersButton,
  RepoFilter,
  SortToggle,
  compareByCreated,
  prMatchesText,
  type SortDir,
} from './filters';
import { PRFilterModal, SavedFilterBar, useSavedPRFilters } from './savedFilters';
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

  // Saved filters: the definitions are workspace-scoped, the selection is not.
  const savedFilters = useSavedPRFilters();
  const [activeFilterIds, setActiveFilterIds] = useState<string[]>([]);
  const [filterModal, setFilterModal] = useState<
    { open: false } | { open: true; editing: PRFilterDefinition | null }
  >({ open: false });

  // A selection can outlive its filter (deleted here, or on another client).
  // Drop the stale ids or the page silently filters against nothing.
  useEffect(() => {
    setActiveFilterIds((prev) => {
      const next = prev.filter((id) => savedFilters.filters.some((f) => f.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [savedFilters.filters]);

  const activeCriteria = useMemo(
    () =>
      savedFilters.filters.filter((f) => activeFilterIds.includes(f.id)).map((f) => f.criteria),
    [savedFilters.filters, activeFilterIds]
  );

  const taskStatusById = useMemo(() => {
    const m = new Map<string, TaskStatus>();
    for (const t of tasks) m.set(t.id, t.status);
    return m;
  }, [tasks]);

  const taskProviderById = useMemo(() => {
    const m = new Map<string, AnyCloudProviderType | null>();
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

  // The page's cohort before any filter — what the chips count against and
  // what the modal previews a draft filter over.
  const cohort = useMemo(() => rows.filter((r) => r.reviewRequested), [rows]);

  const filtered = useMemo(() => {
    let out = cohort;
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
    if (activeCriteria.length > 0) out = out.filter((r) => prMatchesAnyFilter(r, activeCriteria));
    return out.slice().sort((a, b) => compareByCreated(a, b, sortDir));
  }, [cohort, repoFilter, search, requestedFilter, sortDir, viewerLogin, activeCriteria]);

  const anyFilterActive =
    repoFilter !== 'all' ||
    search.trim().length > 0 ||
    requestedFilter !== 'all' ||
    activeFilterIds.length > 0;

  const clearFilters = () => {
    setRepoFilter('all');
    setSearch('');
    setRequestedFilter('all');
    setActiveFilterIds([]);
  };

  return (
    <>
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
            <ClearFiltersButton active={anyFilterActive} onClear={clearFilters} />
          </>
        }
        filtersSecondary={
          <SavedFilterBar
            filters={savedFilters.filters}
            activeIds={activeFilterIds}
            rows={cohort}
            onToggle={(id) =>
              setActiveFilterIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
              )
            }
            onNew={() => setFilterModal({ open: true, editing: null })}
            onEdit={(f) => setFilterModal({ open: true, editing: f })}
          />
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
            onStopTask={actions.stopTask}
            onMerge={actions.mergeRow}
            onSetMergeQueue={actions.setMergeQueue}
            onSetWatching={actions.setWatching}
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
      <PRFilterModal
        open={filterModal.open}
        editing={filterModal.open ? filterModal.editing : null}
        onClose={() => setFilterModal({ open: false })}
        onSave={savedFilters.upsert}
        onDelete={async (id) => {
          setActiveFilterIds((prev) => prev.filter((x) => x !== id));
          return savedFilters.remove(id);
        }}
        saving={savedFilters.saving}
        rows={cohort}
      />
    </>
  );
}
