import React, { useEffect, useRef } from 'react';
import { Github, Settings, Search, RefreshCw, Copy, X, GitPullRequest, Loader2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { ScrollArea } from '../../ui/scroll-area';
import { PRDetailSheet } from '../../widgets/PRDetailSheet';
import { api, type PRRow } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import { useGitHubActions } from './useGitHubActions';
import type { StackMeta } from './stacks';
import { refreshPullRequests } from '../../../hooks/usePullRequestSync';

/**
 * Shared chrome for the three GitHub pages (My PRs, Reviews, Merge Queue):
 * the header (title + Copy list / Refresh / Settings), the filter bar (a
 * page-specific `filters` slot + a common search box with ⌘F), the loading /
 * error / empty / disconnected states, and the list+detail split layout.
 *
 * The page passes its already-filtered+sorted `rows` and renders the list
 * body via the `children` render-prop, which receives the shared selection
 * state so clicking a row opens the detail sheet beside the list.
 */
interface GitHubPageShellProps {
  title: string;
  icon?: React.ReactNode;
  /** Which cohort to tell the backend is on screen (adaptive polling). */
  activeView: 'mine' | 'review' | 'all';
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder?: string;
  /** Page-specific filter controls, rendered left of the search box. */
  filters?: React.ReactNode;
  /** The page's filtered + sorted rows — drives Copy list + empty states. */
  rows: PRRow[];
  /** Per-row stack placement (when the page stacks PRs) — Copy list uses it
   *  to indent stacked PRs under their parent. */
  stackMeta?: Map<string, StackMeta>;
  /** Empty-state copy shown when GitHub is connected but the page has no rows.
   *  Defaults to the generic "no PRs match the current filters" message. */
  emptyIcon?: React.ReactNode;
  emptyTitle?: string;
  emptyHint?: string;
  children: (sel: { selectedId: string | null; onSelect: (id: string) => void }) => React.ReactNode;
}

export function GitHubPageShell({
  title,
  icon,
  activeView,
  search,
  onSearch,
  searchPlaceholder = 'Search title, repo or #number… (⌘F)',
  filters,
  rows,
  stackMeta,
  emptyIcon,
  emptyTitle = 'No pull requests match the current filters.',
  emptyHint,
  children,
}: GitHubPageShellProps) {
  const setActivePanel = useWorkspaceStore((s) => s.setActivePanel);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const loading = usePullRequestStore((s) => s.loading);
  const error = usePullRequestStore((s) => s.error);
  const connected = usePullRequestStore((s) => s.connected);
  const allRows = usePullRequestStore((s) => s.rows);
  const { copyList, connect } = useGitHubActions();

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+F focuses the PR search box. Each page mounts its own shell, so
  // the listener is naturally scoped to the active page.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Tell the backend which cohort is on screen so it polls that one hard and
  // the others slackly. Re-announce on WS reconnect (the registry is in-memory
  // and a backend restart forgets it), and signal 'none' on unmount so a
  // backgrounded page drops to slack polling.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    const announce = () =>
      void api.pullRequests.setView(currentWorkspaceId, activeView).catch(() => {});
    announce();
    const off = api.ws.on('connection:status', (p) => {
      if ((p as { connected?: boolean })?.connected) announce();
    });
    return () => {
      off();
      void api.pullRequests.setView(currentWorkspaceId, 'none').catch(() => {});
    };
  }, [currentWorkspaceId, activeView]);

  return (
    <div className="flex h-full flex-col">
      {/* The header doubles as the frameless window's drag region on macOS;
          interactive controls opt out with app-region-no-drag. */}
      <header className="app-region-drag flex items-center justify-between border-b p-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {icon ?? <Github className="h-5 w-5" />}
          {title}
        </h2>
        <div className="app-region-no-drag flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copyList(rows, stackMeta)}
            disabled={rows.length === 0}
            title="Copy the filtered PRs as a list for Slack"
          >
            <Copy className="mr-1 h-4 w-4" />
            Copy list
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refreshPullRequests()}
            disabled={loading}
            title="Refresh list"
          >
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
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

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
        {filters}
        <div className="relative ml-auto flex-1 min-w-[160px] max-w-md">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={searchPlaceholder}
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

      {/* The list always keeps its full width; the detail panel floats over its
          right edge as a `contained` overlay (absolute to this relative row)
          rather than squishing the columns. The visible left of the list stays
          clickable, so clicking another PR switches the open panel. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-hidden">
          {/* First load (no rows yet): a centered spinner instead of flashing
              the empty state while the initial PR fetch is in flight. */}
          {loading && rows.length === 0 && !error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-sm">Loading pull requests…</p>
            </div>
          ) : (
          <ScrollArea className="h-full">
            {error && (
              <div className="m-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400">
                {error}
              </div>
            )}
            {!loading && rows.length === 0 && !error && connected === false && (
              <div className="flex flex-col items-center justify-center p-10 text-center text-muted-foreground">
                <Github className="mb-2 h-8 w-8 opacity-50" />
                <p className="text-sm">GitHub isn't connected for this workspace.</p>
                <p className="mt-1 text-xs">
                  Connect GitHub to watch pull requests across your repos.
                </p>
                <Button size="sm" className="mt-3" onClick={() => void connect()}>
                  <Github className="mr-1 h-4 w-4" />
                  Connect GitHub
                </Button>
              </div>
            )}
            {!loading && rows.length === 0 && !error && connected !== false && (
              <div className="flex flex-col items-center justify-center p-10 text-center text-muted-foreground">
                <div className="mb-2 opacity-50">
                  {emptyIcon ?? <GitPullRequest className="h-8 w-8" />}
                </div>
                <p className="text-sm">{emptyTitle}</p>
                {emptyHint && <p className="mt-1 max-w-xs text-xs">{emptyHint}</p>}
              </div>
            )}
            {rows.length > 0 && children({ selectedId, onSelect: setSelectedId })}
          </ScrollArea>
          )}
        </div>

        <PRDetailSheet
          pullRequestId={selectedId}
          onClose={() => setSelectedId(null)}
          layout="contained"
          seedRow={allRows.find((r) => r.id === selectedId) ?? null}
        />
      </div>
    </div>
  );
}
