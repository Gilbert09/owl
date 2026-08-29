import { useEffect, useMemo, useState } from 'react';
import { GitPullRequest } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import type { TaskStatus, AnyCloudProviderType, PRFilterDefinition } from '@talyn/shared';
import { prMatchesAnyFilter } from '@talyn/shared';
import { taskCloudProvider } from '../../../lib/providerMeta';
import { cn } from '../../../lib/utils';
import { GitHubPageShell } from './GitHubPageShell';
import { PRTable, isNeedsAttention, isAwaitingReview, isReadyToMerge } from './prTableShared';
import { ClearFiltersButton, RepoFilter, SortToggle, prMatchesText, type SortDir } from './filters';
import { PRFilterModal, SavedFilterBar, useSavedPRFilters } from './savedFilters';
import { buildStackedRows } from './stacks';
import { useGitHubActions } from './useGitHubActions';

/**
 * "My PRs" — every open PR you authored, across watched repos. Carries the
 * repo dropdown, the created-at sort, the "Needs attention" toggle (blocking
 * issues you own), the "Needs review" toggle (still awaiting a review), and
 * the "Ready to merge" toggle (nothing left to do but merge).
 */
export function MyPRsPanel() {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const tasks = useWorkspaceStore((s) => s.tasks);
  const environments = useWorkspaceStore((s) => s.environments);
  const rows = usePullRequestStore((s) => s.rows);
  const viewerLogin = usePullRequestStore((s) => s.viewerLogin);
  const actions = useGitHubActions();

  const [repoFilter, setRepoFilter] = useState('all');
  const [needsAttention, setNeedsAttention] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [readyToMerge, setReadyToMerge] = useState(false);
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

  const attentionCount = useMemo(
    () => rows.filter((r) => r.authored && isNeedsAttention(r)).length,
    [rows]
  );
  const reviewCount = useMemo(
    () => rows.filter((r) => r.authored && isAwaitingReview(r)).length,
    [rows]
  );
  const readyCount = useMemo(
    () => rows.filter((r) => r.authored && isReadyToMerge(r)).length,
    [rows]
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

  // The page's cohort before any filter — what the chips count against and
  // what the modal previews a draft filter over.
  const cohort = useMemo(() => rows.filter((r) => r.authored), [rows]);

  const filtered = useMemo(() => {
    let out = cohort;
    if (repoFilter !== 'all') out = out.filter((r) => r.repositoryId === repoFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => prMatchesText(r, q));
    }
    if (needsAttention) out = out.filter(isNeedsAttention);
    if (needsReview) out = out.filter(isAwaitingReview);
    if (readyToMerge) out = out.filter(isReadyToMerge);
    if (activeCriteria.length > 0) out = out.filter((r) => prMatchesAnyFilter(r, activeCriteria));
    return out;
  }, [cohort, repoFilter, search, needsAttention, needsReview, readyToMerge, activeCriteria]);

  const anyFilterActive =
    repoFilter !== 'all' ||
    search.trim().length > 0 ||
    needsAttention ||
    needsReview ||
    readyToMerge ||
    activeFilterIds.length > 0;

  const clearFilters = () => {
    setRepoFilter('all');
    setSearch('');
    setNeedsAttention(false);
    setNeedsReview(false);
    setReadyToMerge(false);
    setActiveFilterIds([]);
  };

  // Group stacked PRs together (root-first, dependents indented) while keeping
  // the active sort for roots. `meta` drives the per-row indent + accent bar.
  const { ordered, meta: stackMeta } = useMemo(
    () => buildStackedRows(filtered, sortDir),
    [filtered, sortDir]
  );

  return (
    <>
      <GitHubPageShell
        title="My PRs"
        icon={<GitPullRequest className="h-5 w-5" />}
        activeView="mine"
        search={search}
        onSearch={setSearch}
        rows={ordered}
        stackMeta={stackMeta}
        filters={
          <>
            <RepoFilter
              value={repoFilter}
              onChange={setRepoFilter}
              repos={repositories.map((r) => ({ id: r.id, name: r.fullName }))}
            />
            <button
              type="button"
              onClick={() => setNeedsAttention((v) => !v)}
              className={cn(
                'rounded-md border px-2 py-1 transition-colors',
                needsAttention
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              title="Only show PRs with blocking issues (conflicts, changes requested, failing checks)"
            >
              Needs attention
              {attentionCount > 0 && <span className="ml-1">{attentionCount}</span>}
            </button>
            <button
              type="button"
              onClick={() => setNeedsReview((v) => !v)}
              className={cn(
                'rounded-md border px-2 py-1 transition-colors',
                needsReview
                  ? 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              title="Only show PRs you opened that are still waiting on a review"
            >
              Needs review
              {reviewCount > 0 && <span className="ml-1">{reviewCount}</span>}
            </button>
            <button
              type="button"
              onClick={() => setReadyToMerge((v) => !v)}
              className={cn(
                'rounded-md border px-2 py-1 transition-colors',
                readyToMerge
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              title="Only show PRs that are fully ready to merge (approved or no review needed, checks green, no conflicts)"
            >
              Ready to merge
              {readyCount > 0 && <span className="ml-1">{readyCount}</span>}
            </button>
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
            rows={ordered}
            variant="mine"
            stackMeta={stackMeta}
            viewerLogin={viewerLogin}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpenTask={actions.openTask}
            onStopTask={actions.stopTask}
            onMerge={actions.mergeRow}
            onSetMergeQueue={actions.setMergeQueue}
            onSetMergeQueueStack={actions.setMergeQueueStack}
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
