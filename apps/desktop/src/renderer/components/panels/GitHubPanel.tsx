import React, { useEffect, useMemo, useState } from 'react';
import {
  Github,
  Settings,
  Search,
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  X,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { api, type PRRow, type PRSummaryShape, type PRState } from '../../lib/api';
import { PRStatusPill } from '../widgets/PRStatusPill';
import { PRDetailSheet } from '../widgets/PRDetailSheet';
import { cn } from '../../lib/utils';

/**
 * The GitHub page — every user-authored PR across watched repos at a
 * glance. Phase 5 of the rebuild:
 *
 *   - Filter bar: state, repo, search, "needs attention" toggle.
 *   - Table: title, author, branch refs, status pill (5-segment
 *     check rollup inline), updated time. Sortable by updated.
 *   - Side-sheet: opens on row click. Same component the task screen
 *     uses; tabs come in a follow-up commit.
 *
 * Subscribes to `pull_request:updated` to patch rows in place — no
 * full refetch on every WS event. The list is fetched once on mount
 * and kept fresh by the WS deltas + an explicit refresh button.
 */

type StateFilter = 'open' | 'closed' | 'merged' | 'all';

const STATE_OPTIONS: Array<{ value: StateFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

export function GitHubPanel() {
  const { setActivePanel, currentWorkspaceId, repositories } = useWorkspaceStore();
  const [rows, setRows] = useState<PRRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [needsAttention, setNeedsAttention] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Initial fetch + refetch on filter change.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.pullRequests
      .list({
        workspaceId: currentWorkspaceId,
        state: stateFilter,
        repo: repoFilter === 'all' ? undefined : repoFilter,
      })
      .then((data) => {
        if (cancelled) return;
        setRows(data);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, stateFilter, repoFilter]);

  // Live updates from the prMonitor.
  useEffect(() => {
    const unsubscribe = api.ws.on('pull_request:updated', (payload) => {
      const p = payload as {
        id: string;
        state: PRState;
        lastSummary: PRSummaryShape;
      };
      setRows((prev) => {
        const idx = prev.findIndex((r) => r.id === p.id);
        if (idx === -1) {
          // New PR — refetch the whole list rather than hand-merging
          // (we'd need workspaceId/repositoryId to insert, and the
          // backend already enforces ordering by lastPolledAt).
          if (currentWorkspaceId) {
            api.pullRequests
              .list({
                workspaceId: currentWorkspaceId,
                state: stateFilter,
                repo: repoFilter === 'all' ? undefined : repoFilter,
              })
              .then(setRows)
              .catch(() => {});
          }
          return prev;
        }
        const next = prev.slice();
        next[idx] = {
          ...next[idx],
          state: p.state,
          summary: p.lastSummary,
        };
        return next;
      });
    });
    return unsubscribe;
  }, [currentWorkspaceId, stateFilter, repoFilter]);

  const filtered = useMemo(() => {
    let out = rows;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => {
        const title = r.summary.title?.toLowerCase() ?? '';
        const repo = `${r.owner}/${r.repo}`.toLowerCase();
        return title.includes(q) || repo.includes(q);
      });
    }
    if (needsAttention) {
      out = out.filter(
        (r) =>
          r.summary.blockingReason === 'changes_requested' ||
          r.summary.blockingReason === 'checks_failed' ||
          r.summary.blockingReason === 'merge_conflicts'
      );
    }
    return out;
  }, [rows, search, needsAttention]);

  async function handleRefresh() {
    if (!currentWorkspaceId) return;
    setLoading(true);
    try {
      const data = await api.pullRequests.list({
        workspaceId: currentWorkspaceId,
        state: stateFilter,
        repo: repoFilter === 'all' ? undefined : repoFilter,
      });
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b p-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Github className="h-5 w-5" />
          GitHub
        </h2>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRefresh}
            disabled={loading}
            title="Refresh list"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActivePanel('settings')}
            title="GitHub settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <FilterBar
        stateFilter={stateFilter}
        onStateFilter={setStateFilter}
        repoFilter={repoFilter}
        onRepoFilter={setRepoFilter}
        repos={repositories.map((r) => ({ id: r.id, name: r.fullName }))}
        search={search}
        onSearch={setSearch}
        needsAttention={needsAttention}
        onNeedsAttention={setNeedsAttention}
      />

      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          {error && (
            <div className="m-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400">
              {error}
            </div>
          )}
          {!loading && filtered.length === 0 && !error && (
            <div className="flex flex-col items-center justify-center p-10 text-center text-muted-foreground">
              <GitPullRequest className="mb-2 h-8 w-8 opacity-50" />
              <p className="text-sm">No pull requests match the current filters.</p>
            </div>
          )}
          {filtered.length > 0 && (
            <PRTable
              rows={filtered}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </ScrollArea>
      </div>

      <PRDetailSheet pullRequestId={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}

interface FilterBarProps {
  stateFilter: StateFilter;
  onStateFilter: (v: StateFilter) => void;
  repoFilter: string;
  onRepoFilter: (v: string) => void;
  repos: Array<{ id: string; name: string }>;
  search: string;
  onSearch: (v: string) => void;
  needsAttention: boolean;
  onNeedsAttention: (v: boolean) => void;
}

function FilterBar({
  stateFilter,
  onStateFilter,
  repoFilter,
  onRepoFilter,
  repos,
  search,
  onSearch,
  needsAttention,
  onNeedsAttention,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
      {/* State pills */}
      <div className="flex rounded-md border bg-muted/40 p-0.5">
        {STATE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onStateFilter(opt.value)}
            className={cn(
              'rounded px-2 py-1 transition-colors',
              stateFilter === opt.value
                ? 'bg-background shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Repo dropdown — native select keeps the bar compact + keyboard-friendly. */}
      <select
        value={repoFilter}
        onChange={(e) => onRepoFilter(e.target.value)}
        className="h-7 rounded-md border bg-background px-2 py-0 text-xs leading-7"
      >
        <option value="all">All repos</option>
        {repos.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>

      {/* Needs attention toggle. */}
      <button
        type="button"
        onClick={() => onNeedsAttention(!needsAttention)}
        className={cn(
          'rounded-md border px-2 py-1 transition-colors',
          needsAttention
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
            : 'text-muted-foreground hover:text-foreground'
        )}
        title="Only show PRs with blocking issues (conflicts, changes requested, failing checks)"
      >
        Needs attention
      </button>

      {/* Search input — flex-1 so it grows. */}
      <div className="relative ml-auto flex-1 min-w-[160px] max-w-md">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search title or repo…"
          className="h-7 pl-7 pr-7 text-xs"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            title="Clear"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

interface PRTableProps {
  rows: PRRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function PRTable({ rows, selectedId, onSelect }: PRTableProps) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-background text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-4 py-2 text-left font-medium">Title</th>
          <th className="px-2 py-2 text-left font-medium">Branch</th>
          <th className="px-2 py-2 text-left font-medium">Status</th>
          <th className="px-2 py-2 text-left font-medium">Updated</th>
          <th className="w-8 px-2 py-2"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <PRTableRow
            key={row.id}
            row={row}
            isSelected={row.id === selectedId}
            onSelect={() => onSelect(row.id)}
          />
        ))}
      </tbody>
    </table>
  );
}

function PRTableRow({
  row,
  isSelected,
  onSelect,
}: {
  row: PRRow;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const summary = row.summary;
  const updatedTooltip = new Date(summary.updatedAt || row.lastPolledAt).toLocaleString();
  return (
    <tr
      className={cn(
        'cursor-pointer border-b transition-colors hover:bg-muted/40',
        isSelected && 'bg-muted/40'
      )}
      onClick={onSelect}
    >
      <td className="px-4 py-2">
        <div className="flex flex-col gap-0.5">
          <span className="truncate font-medium">{summary.title || '(no title)'}</span>
          <span className="text-xs text-muted-foreground">
            {row.owner}/{row.repo}#{row.number} · @{summary.author || 'unknown'}
            {summary.draft && (
              <span className="ml-2 rounded bg-zinc-200 px-1 py-0.5 text-[10px] uppercase text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300">
                Draft
              </span>
            )}
            {row.taskId && (
              <span className="ml-2 rounded bg-blue-200 px-1 py-0.5 text-[10px] uppercase text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                Task
              </span>
            )}
          </span>
        </div>
      </td>
      <td className="px-2 py-2 text-xs">
        <span className="font-mono">
          <span className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">
            {summary.headBranch}
          </span>
          <span className="px-1 text-muted-foreground">→</span>
          <span className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">
            {summary.baseBranch}
          </span>
        </span>
      </td>
      <td className="px-2 py-2">
        <PRStatusPill blockingReason={summary.blockingReason} checks={summary.checks} />
      </td>
      <td className="px-2 py-2 text-xs text-muted-foreground" title={updatedTooltip}>
        {formatRelative(summary.updatedAt || row.lastPolledAt)}
      </td>
      <td className="px-2 py-2">
        <a
          href={summary.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-muted-foreground hover:text-foreground"
          title="Open on GitHub"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </td>
    </tr>
  );
}

/** Small relative-time helper; no dependency on date-fns. */
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

