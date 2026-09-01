import React, { useEffect, useMemo, useState } from 'react';
import { coarseQueueStatus } from '@talyn/shared';
import {
  ExternalLink,
  RefreshCw,
  X,
  Loader2,
  FileText,
  FilePlus,
  FileMinus,
  FileDiff,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  CircleDot,
  GitMerge,
  MessageSquare,
  Layers,
  Check,
  XCircle,
  Eye,
  AlertTriangle,
  ListChecks,
  GitBranch,
} from 'lucide-react';
import { PatchDiff } from '@pierre/diffs/react';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import { renderMarkdownish } from '../../lib/markdown';
import {
  api,
  type PRRow,
  type PRSummaryShape,
  type PRFreshDetail,
  type PRFile,
  type PRCheckContext,
  type PRCheckState,
  type PRReviewDetail,
  type PRReviewThread,
  type MergeQueueTimelineEvent,
} from '../../lib/api';
import { prime } from '../../lib/prSummaryCache';
import { useOnReconnect } from '../../hooks/useOnReconnect';
import { PRStatusPill } from './PRStatusPill';
import { PRReviewPill } from './PRReviewPill';
import { toast } from '../../stores/toast';
import { trackEvent } from '../../lib/analytics';
import { usePullRequestStore } from '../../stores/pullRequests';
import { stackSelection } from '../panels/github/stacks';

/**
 * Slide-in detail panel for a PR. Phase 4 ships the skeleton —
 * Phase 5 fleshes out the Files / Checks / Reviews tabs.
 *
 * Skeleton features:
 *   - Fetches GET /pull-requests/:id on open (cached row + fresh
 *     GraphQL detail in one response).
 *   - Header: title, branch refs, status pill, refresh button,
 *     "Open on GitHub" link, close button.
 *   - Body: the recent reviews/comments lists from the fresh fetch
 *     (placeholder until Phase 5 builds proper tabs).
 *
 * No write actions — every "act on this PR" path deep-links to
 * github.com.
 */

interface PRDetailSheetProps {
  pullRequestId: string | null;
  onClose: () => void;
  /**
   * `overlay` (default) — a viewport-fixed slide-in over the right edge (task
   * screen / QueuePanel). `contained` — absolutely positioned over the right of
   * its (relative) parent, so it floats on top of the adjacent list instead of
   * squishing it, while leaving the surrounding header/filters untouched (GitHub
   * page). `inline` — an in-flow flex sibling that takes its own width.
   */
  layout?: 'overlay' | 'inline' | 'contained';
  /**
   * The list's already-loaded row for this PR. When supplied, the panel
   * renders the cached summary instantly on switch and refreshes the
   * detail (reviews/files/check rows) in place — no full-panel spinner.
   */
  seedRow?: PRRow | null;
}

export function PRDetailSheet({
  pullRequestId,
  onClose,
  layout = 'overlay',
  seedRow = null,
}: PRDetailSheetProps) {
  const [data, setData] = useState<{
    row: PRRow;
    fresh: (PRSummaryShape & PRFreshDetail) | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether PostHog Code is connected for this PR's workspace — gates the
  // auto-keep-mergeable toggle (the watcher dispatches via PostHog Code).
  const [posthogConnected, setPosthogConnected] = useState(false);
  const [togglingAutoKeep, setTogglingAutoKeep] = useState(false);
  const [togglingQueue, setTogglingQueue] = useState(false);
  // The PRs this one is stacked on, root-first. Derived from the open rows in
  // the store (the sheet gets no stackMeta), by the same rule the backend uses.
  // Only decides whether to offer "Merge stack" — the server re-resolves the
  // chain on the call itself.
  const openRows = usePullRequestStore((s) => s.rows);
  const { targets: stackTargets, isRoot: isStackRoot, base: stackBase } = useMemo(
    () =>
      pullRequestId
        ? stackSelection(openRows, pullRequestId)
        : { targets: [] as PRRow[], isRoot: false, base: undefined },
    [openRows, pullRequestId]
  );

  useEffect(() => {
    if (!pullRequestId) {
      setData(null);
      return;
    }
    trackEvent('pr_detail_opened');
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.pullRequests
      .get(pullRequestId)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        // Warm the shared cache so the task-header status pill paints
        // instantly next time this PR is shown.
        prime(res.row.id, { summary: res.row.summary, state: res.row.state });
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
  }, [pullRequestId]);

  // Reconnect catch-up: this panel keeps itself fresh only through its own
  // `pull_request:updated` subscription below, so updates broadcast while the
  // socket was down are lost — and the store's reconnect re-list never flows
  // back into our local `data`. Refetch the whole detail (summary + fresh
  // timeline/files) on a genuine reconnect.
  useOnReconnect(() => {
    if (!pullRequestId) return;
    api.pullRequests
      .get(pullRequestId)
      .then((res) => {
        // Guard against the user having switched PRs while the fetch ran.
        setData((prev) => (prev && prev.row.id === res.row.id ? res : prev));
        prime(res.row.id, { summary: res.row.summary, state: res.row.state });
      })
      .catch(() => {
        // Best-effort — the next monitor broadcast will patch the summary.
      });
  });

  // Subscribe to pull_request:updated to keep the visible PR fresh
  // when the monitor refetches in the background.
  useEffect(() => {
    if (!pullRequestId) return;
    const unsubscribe = api.ws.on('pull_request:updated', (payload) => {
      const p = payload as {
        id: string;
        lastSummary: unknown;
        autoKeepMergeable?: boolean;
        autoMergeState?: { attempts: number; paused: boolean } | null;
        mergeQueued?: boolean;
        mergeQueue?: PRRow['mergeQueue'];
      };
      if (p.id !== pullRequestId) return;
      setData((prev) => {
        // Guard against patching a stale row mid-switch.
        if (!prev || prev.row.id !== p.id) return prev;
        return {
          ...prev,
          row: {
            ...prev.row,
            // Merge, not replace: incremental echoes carry only the changed slice
            // (e.g. `{ checks }`); full echoes carry every field so it's a no-op.
            summary: { ...prev.row.summary, ...(p.lastSummary as Partial<PRSummaryShape>) },
            autoKeepMergeable: p.autoKeepMergeable ?? prev.row.autoKeepMergeable,
            autoMergeState:
              p.autoMergeState !== undefined ? p.autoMergeState : prev.row.autoMergeState,
            mergeQueued: p.mergeQueued ?? prev.row.mergeQueued,
            mergeQueue: p.mergeQueue !== undefined ? p.mergeQueue : prev.row.mergeQueue,
          },
        };
      });
    });
    return unsubscribe;
  }, [pullRequestId]);

  // Esc closes the panel.
  useEffect(() => {
    if (!pullRequestId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pullRequestId, onClose]);

  // Adaptive polling: while this sheet is open the PR is "focused"
  // and the backend tightens its TTL to 30 s. Cleared on close /
  // unmount so unrelated PRs return to the normal cadence.
  useEffect(() => {
    if (!pullRequestId) return;
    api.pullRequests.focus(pullRequestId, true).catch(() => {});
    return () => {
      api.pullRequests.focus(pullRequestId, false).catch(() => {});
    };
  }, [pullRequestId]);

  // PostHog Code connection status for this PR's workspace — gates the
  // auto-keep-mergeable toggle (no provider → nothing to dispatch to).
  const workspaceId = data?.row.workspaceId ?? seedRow?.workspaceId ?? null;
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    api.posthog
      .getStatus(workspaceId)
      .then((s) => {
        if (!cancelled) setPosthogConnected(s.connected);
      })
      .catch(() => {
        if (!cancelled) setPosthogConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function handleToggleAutoKeep(enabled: boolean) {
    if (!pullRequestId) return;
    setTogglingAutoKeep(true);
    // Optimistic — the WS echo will confirm, but the toggle should feel instant.
    setData((prev) =>
      prev
        ? {
            ...prev,
            row: {
              ...prev.row,
              autoKeepMergeable: enabled,
              autoMergeState: enabled ? { attempts: 0, paused: false } : null,
            },
          }
        : prev
    );
    try {
      await api.pullRequests.setAutoKeepMergeable(pullRequestId, enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update auto-keep-mergeable');
      // Roll back the optimistic flip.
      setData((prev) =>
        prev ? { ...prev, row: { ...prev.row, autoKeepMergeable: !enabled } } : prev
      );
    } finally {
      setTogglingAutoKeep(false);
    }
  }

  /**
   * Queue this PR together with everything it is stacked on. The sheet has no
   * `stackMeta`, so membership is derived here from the open rows in the store
   * — the same rule the backend uses. The server re-resolves the chain on the
   * call itself; this only decides whether to offer the button and what to say
   * on it.
   */
  async function handleQueueStack() {
    if (!pullRequestId) return;
    setTogglingQueue(true);
    try {
      await api.pullRequests.setMergeQueueStack(pullRequestId, true, {
        includeDescendants: isStackRoot,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue the stack');
    } finally {
      setTogglingQueue(false);
    }
  }

  async function handleToggleQueue(enabled: boolean) {
    if (!pullRequestId) return;
    setTogglingQueue(true);
    // Optimistic — the WS echo confirms with the authoritative position.
    setData((prev) =>
      prev
        ? {
            ...prev,
            row: {
              ...prev.row,
              mergeQueued: enabled,
              // Membership only — never invent a `mergeQueue` payload, which
              // would render and stick until the echo lands.
              ...(enabled ? {} : { mergeQueue: null }),
            },
          }
        : prev
    );
    try {
      await api.pullRequests.setMergeQueue(pullRequestId, enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update merge queue');
      setData((prev) =>
        prev ? { ...prev, row: { ...prev.row, mergeQueued: !enabled } } : prev
      );
    } finally {
      setTogglingQueue(false);
    }
  }

  // What to render: the fetched detail once it matches the current PR,
  // else the list-supplied cached row (instant) while the detail loads.
  // The id guard stops the previous PR's detail flashing during a switch.
  const view = useMemo(() => {
    if (data && data.row.id === pullRequestId) return data;
    if (seedRow && seedRow.id === pullRequestId) {
      return { row: seedRow, fresh: null as (PRSummaryShape & PRFreshDetail) | null };
    }
    return null;
  }, [data, seedRow, pullRequestId]);

  // True until the fresh detail fetch for the *current* PR resolves —
  // drives a minimal in-place spinner rather than a full-panel one. Once
  // it resolves, `data` carries this PR's id (fresh may still be null if
  // the fetch came back empty, e.g. env offline).
  const detailPending = data?.row.id !== pullRequestId;

  async function handleRefresh(): Promise<void> {
    if (!pullRequestId) return;
    setRefreshing(true);
    setError(null);
    try {
      // POST /refresh upserts the row and the WS event drives the UI
      // patch. Re-fetch the detail in case the fresh GraphQL fan-out
      // changed (recent reviews/comments).
      await api.pullRequests.refresh(pullRequestId);
      const next = await api.pullRequests.get(pullRequestId);
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleMerge(): Promise<void> {
    if (!pullRequestId) return;
    setMerging(true);
    setError(null);
    try {
      await api.pullRequests.merge(pullRequestId);
      const next = await api.pullRequests.get(pullRequestId);
      setData(next);
      setConfirmMerge(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge failed');
    } finally {
      setMerging(false);
    }
  }

  if (!pullRequestId) return null;

  // Show the merge affordance for an open PR GitHub reports as mergeable
  // (no conflicts, required checks/reviews satisfied). This includes
  // 'checks_failed_optional' — mergeable despite failing *non-required*
  // checks. Anything else routes the user to GitHub to resolve the blocker.
  const canMerge =
    !!view &&
    view.row.state === 'open' &&
    (view.row.summary.blockingReason === 'mergeable' ||
      view.row.summary.blockingReason === 'checks_failed_optional');

  // Owner vs reviewer view. The PR-modifying affordances (merge, merge queue,
  // auto-keep-mergeable) and the CI status pill only make sense on a PR you
  // own; on one you're only a requested reviewer, the relevant signal is
  // whether your review is required, so we show the review-decision pill and
  // drop every write action.
  const isOwnPr = !!view && view.row.authored;

  return (
    <div
      className={cn(
        'flex w-full max-w-2xl flex-col border-l bg-background',
        layout === 'inline'
          ? 'h-full shrink-0'
          : layout === 'contained'
            ? 'absolute inset-y-0 right-0 z-30 shadow-2xl'
            : 'fixed inset-y-0 right-0 z-40 shadow-2xl'
      )}
    >
      <header className="flex shrink-0 flex-col gap-3 border-b p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {!view ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h2
                  className="truncate text-base font-semibold leading-snug"
                  title={view.row.summary.title}
                >
                  {view.row.summary.title}
                </h2>
                {/* Minimal in-place refresh indicator while the fresh detail
                    loads — the cached summary is already shown. */}
                {detailPending && (
                  <Loader2
                    className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                    aria-label="Refreshing"
                  />
                )}
              </div>
            )}
          </div>
          {/* Compact window controls pinned top-right. */}
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={handleRefresh}
              disabled={loading || refreshing}
              title="Re-fetch from GitHub"
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </Button>
            {view && (
              <Button
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => window.open(view.row.summary.url, '_blank', 'noopener,noreferrer')}
                title="Open on GitHub"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            )}
            <Button variant="ghost" className="h-7 w-7 p-0" onClick={onClose} title="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {view && (
          <>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">
                {view.row.owner}/{view.row.repo}#{view.row.number} · by @
                {view.row.summary.author}
              </span>
            </div>
            <BranchRef
              head={view.row.summary.headBranch}
              base={view.row.summary.baseBranch}
            />
          </>
        )}
        {view && (
          <div className="flex items-center justify-between gap-2 border-t pt-3">
            {/* Left: the status (own PR) or review-decision (reviewer) pill.
                For an own PR, mirror the list — a review pill (approval) PLUS a
                status pill with `hideReviewState`, so the review verdict isn't
                double-counted as "Review" in the status pill when the row is
                already approved. */}
            {isOwnPr ? (
              <div className="flex items-center gap-2">
                <PRReviewPill
                  reviewDecision={
                    view.row.summary.effectiveReviewDecision ?? view.row.summary.reviewDecision
                  }
                  state={view.row.state}
                />
                <PRStatusPill
                  blockingReason={view.row.summary.blockingReason}
                  checks={view.row.summary.checks}
                  mergeStateStatus={view.row.summary.mergeStateStatus}
                  state={view.row.state}
                  hideReviewState
                  labels={view.row.summary.labels}
                />
              </div>
            ) : (
              <PRReviewPill
                reviewDecision={
                  view.row.summary.effectiveReviewDecision ?? view.row.summary.reviewDecision
                }
                state={view.row.state}
              />
            )}
            {/* Right: write actions — only for PRs you own. */}
            {isOwnPr && (view.row.state === 'open' || canMerge) && (
              <div className="flex flex-wrap items-center justify-end gap-1">
            {view.row.state === 'open' && posthogConnected && (
              <Button
                variant={view.row.autoKeepMergeable ? 'default' : 'outline'}
                className="h-7 px-2 text-xs"
                onClick={() => handleToggleAutoKeep(!view.row.autoKeepMergeable)}
                disabled={togglingAutoKeep}
                title={
                  view.row.autoKeepMergeable
                    ? view.row.autoMergeState?.paused
                      ? 'Auto-keep-mergeable paused after 3 attempts — click to turn off'
                      : 'Auto-keep-mergeable is on — click to turn off'
                    : 'Keep this PR mergeable: auto-fix conflicts / CI / review comments until merged, then keep watching'
                }
              >
                {togglingAutoKeep ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : view.row.autoKeepMergeable && view.row.autoMergeState?.paused ? (
                  <AlertTriangle className="mr-1 h-3.5 w-3.5" />
                ) : (
                  <Eye className="mr-1 h-3.5 w-3.5" />
                )}
                {view.row.autoKeepMergeable
                  ? view.row.autoMergeState?.paused
                    ? 'Auto-fix paused'
                    : 'Auto-keeping'
                  : 'Auto-keep mergeable'}
              </Button>
            )}
            {view.row.state === 'open' && (
              <Button
                variant={view.row.mergeQueued ? 'default' : 'outline'}
                className="h-7 px-2 text-xs"
                onClick={() => handleToggleQueue(!view.row.mergeQueued)}
                disabled={togglingQueue}
                title={
                  view.row.mergeQueued
                    ? coarseQueueStatus(view.row.mergeQueue?.status ?? 'queued') === 'blocked'
                      ? 'Merge queue paused after 3 attempts — click to remove'
                      : 'In the merge queue — click to remove'
                    : 'Add to the merge queue: merges automatically when clean, serialized per base branch, auto-fixing conflicts'
                }
              >
                {togglingQueue ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : view.row.mergeQueued &&
                  coarseQueueStatus(view.row.mergeQueue?.status ?? 'queued') === 'blocked' ? (
                  <AlertTriangle className="mr-1 h-3.5 w-3.5" />
                ) : (
                  <ListChecks className="mr-1 h-3.5 w-3.5" />
                )}
                {view.row.mergeQueued
                  ? (() => {
                      const coarse = coarseQueueStatus(view.row.mergeQueue?.status ?? 'queued');
                      if (coarse === 'blocked') return 'Queue blocked';
                      if (coarse === 'merging') return 'Merging…';
                      if (coarse === 'fixing') return 'Fixing…';
                      const pos = view.row.mergeQueue?.position;
                      return pos ? `Queued #${pos}` : 'Queued';
                    })()
                  : 'Add to merge queue'}
              </Button>
            )}
            {view.row.state === 'open' && stackTargets.length > 1 && (
              <Button
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => void handleQueueStack()}
                disabled={togglingQueue}
                title={
                  isStackRoot
                    ? `Queue all ${stackTargets.length} PRs in this stack and merge them into ${stackBase || 'the base branch'} one at a time, retargeting each as its parent lands`
                    : `Land this PR and the ${stackTargets.length - 1} below it — merges ${stackTargets.length} PRs into ${stackBase || 'the base branch'} one at a time. PRs stacked above this one are left alone.`
                }
              >
                <Layers className="mr-1 h-3.5 w-3.5" />
                Merge stack ({stackTargets.length})
              </Button>
            )}
            {canMerge &&
              (confirmMerge ? (
                <>
                  <Button
                    className="h-7 bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-700"
                    onClick={handleMerge}
                    disabled={merging}
                    title="Squash-merge this PR on GitHub"
                  >
                    {merging ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <GitMerge className="mr-1 h-3.5 w-3.5" />
                    )}
                    Confirm merge
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => setConfirmMerge(false)}
                    disabled={merging}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  className="h-7 bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-700"
                  onClick={() => setConfirmMerge(true)}
                  title="Merge this PR"
                >
                  <GitMerge className="mr-1 h-3.5 w-3.5" />
                  Merge
                </Button>
              ))}
              </div>
            )}
          </div>
        )}
      </header>

      {view && <DetailTabs data={view} error={error} detailPending={detailPending} />}
    </div>
  );
}

type TabKey = 'overview' | 'files' | 'checks' | 'reviews';

function DetailTabs({
  data,
  error,
  detailPending,
}: {
  data: { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };
  error: string | null;
  detailPending: boolean;
}) {
  const [tab, setTab] = useState<TabKey>('overview');

  return (
    <>
      <nav className="flex shrink-0 border-b text-xs">
        <TabButton
          active={tab === 'overview'}
          onClick={() => setTab('overview')}
          icon={<Layers className="h-3.5 w-3.5" />}
        >
          Overview
        </TabButton>
        <TabButton
          active={tab === 'checks'}
          onClick={() => setTab('checks')}
          icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          badge={
            data.row.summary.checks.total > 0
              ? `${data.row.summary.checks.passed}/${data.row.summary.checks.total}`
              : undefined
          }
        >
          Checks
        </TabButton>
        <TabButton
          active={tab === 'reviews'}
          onClick={() => setTab('reviews')}
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          badge={
            data.fresh?.recentReviews.length
              ? String(data.fresh.recentReviews.length)
              : undefined
          }
        >
          Reviews
        </TabButton>
        <TabButton
          active={tab === 'files'}
          onClick={() => setTab('files')}
          icon={<FileText className="h-3.5 w-3.5" />}
        >
          Files
        </TabButton>
      </nav>

      <ScrollArea className="flex-1">
        <div className="p-4">
          {error && (
            <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400">
              {error}
            </div>
          )}
          {!data.fresh && !detailPending && (
            <p className="mb-4 text-xs text-muted-foreground">
              Detail fetch unavailable (env offline?). Showing cached state only.
            </p>
          )}
          {tab === 'overview' && <OverviewTab data={data} detailPending={detailPending} />}
          {tab === 'checks' && <ChecksTab data={data} detailPending={detailPending} />}
          {tab === 'reviews' && <ReviewsTab data={data} />}
          {tab === 'files' && <FilesTab data={data} />}
        </div>
      </ScrollArea>
    </>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        '-mb-[1px] flex items-center gap-1.5 border-b-2 px-3 py-2 transition-colors',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      <span>{children}</span>
      {badge !== undefined && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {badge}
        </span>
      )}
    </button>
  );
}

function OverviewTab({
  data,
  detailPending,
}: {
  data: { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };
  detailPending: boolean;
}) {
  const body = data.fresh?.body ?? '';
  return (
    <div className="space-y-4 text-sm">
      {body ? (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Description
          </h3>
          <div className="text-xs leading-relaxed [overflow-wrap:anywhere]">
            {renderMarkdownish(body, 'surface')}
          </div>
        </section>
      ) : detailPending ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading description…
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">No description provided.</p>
      )}
      <MergeQueueSection row={data.row} />
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Status
        </h3>
        <ul className="space-y-1 text-xs">
          <li>
            <span className="text-muted-foreground">Mergeable:</span>{' '}
            {data.row.summary.mergeable.toLowerCase()}
          </li>
          <li>
            <span className="text-muted-foreground">Merge state:</span>{' '}
            {data.row.summary.mergeStateStatus.toLowerCase()}
          </li>
          <li>
            <span className="text-muted-foreground">Review decision:</span>{' '}
            {(() => {
              const decision =
                data.row.summary.effectiveReviewDecision ?? data.row.summary.reviewDecision;
              return decision ? decision.toLowerCase().replace('_', ' ') : 'pending';
            })()}
          </li>
          <li>
            <span className="text-muted-foreground">Head SHA:</span>{' '}
            <span className="font-mono">{data.row.summary.headSha.slice(0, 10)}</span>
          </li>
        </ul>
      </section>
    </div>
  );
}

/** Human labels for the merge-queue v2 status vocabulary. */
/**
 * Keyed by the status union rather than `string`, so adding a status to the
 * engine is a compile error here instead of a raw enum name rendering in the
 * sheet. That is not hypothetical: `awaiting_external`, `merged` and `removed`
 * were all missing under the looser type and showed as-is.
 */
const QUEUE_STATUS_LABEL: Record<NonNullable<PRRow['mergeQueue']>['status'], string> = {
  queued: 'Waiting in line',
  awaiting_ci: 'Waiting for CI',
  awaiting_review: 'Waiting for a required review',
  automerge_armed: 'Auto-merge armed — GitHub merges when checks pass',
  awaiting_external: 'Handed to the repo’s merge queue, which owns the merge now',
  awaiting_stack: 'Waiting for the PR below it in the stack to merge',
  fixing: 'A cloud fix run is working this PR',
  merging: 'Merging',
  blocked: 'Blocked — retries on the next push, or re-queue now',
  blocked_manual: 'Blocked — needs you (merge manually or re-queue)',
  merged: 'Merged',
  removed: 'Removed from the queue',
};

/**
 * The merge-queue panel of the Overview tab: live state + what it's waiting
 * on, the per-head retry budgets, auto-merge indicator, a requeue action for
 * blocked entries, and the entry's audit timeline (what the queue actually
 * did, with reasons). Hidden entirely for PRs that were never queued.
 */
function MergeQueueSection({ row }: { row: PRRow }) {
  const v2 = row.mergeQueue;
  const [events, setEvents] = useState<MergeQueueTimelineEvent[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [requeueing, setRequeueing] = useState(false);
  const queued = row.mergeQueued || Boolean(v2);

  useEffect(() => {
    if (!queued) return;
    let alive = true;
    api.pullRequests
      .mergeQueueTimeline(row.id)
      .then((r) => alive && setEvents(r.events))
      .catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
    // Re-fetch when the status changes so the timeline tracks live activity.
  }, [row.id, queued, v2?.status]);

  if (!queued) return null;

  // `awaiting_stack` is deliberately NOT blocked: it self-heals the moment the
  // PR below it lands, so offering Requeue would suggest an action that does
  // nothing. Don't "helpfully" add it here.
  const blocked = v2?.status === 'blocked' || v2?.status === 'blocked_manual';
  const statusLabel = v2
    ? v2.status === 'awaiting_stack' && v2.stackParentNumber != null
      ? `Waiting for #${v2.stackParentNumber} to merge — this PR is stacked on it`
      : // Retargeted off a stack and now waiting on review: bringing the new
        // base in pushes a merge commit, and a repo that dismisses stale
        // approvals drops the one this PR already had. Say so, or it reads as
        // though it was never approved.
        v2.status === 'awaiting_review' && v2.stackParentNumber != null
        ? `Waiting for a required review — this PR was retargeted after #${v2.stackParentNumber} merged, which may have dismissed an earlier approval`
        : QUEUE_STATUS_LABEL[v2.status]
    : 'Waiting';
  const budgets = v2?.budgets;
  const shown = events ? (showAll ? events : events.slice(0, 8)) : null;

  const handleRequeue = async () => {
    setRequeueing(true);
    try {
      await api.pullRequests.setMergeQueue(row.id, true);
    } finally {
      setRequeueing(false);
    }
  };

  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Merge queue
      </h3>
      <div className="space-y-2 rounded-md border p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className={blocked ? 'font-medium text-amber-700 dark:text-amber-400' : ''}>
            {v2?.position ? `#${v2.position} — ` : ''}
            {statusLabel}
            {v2?.autoMerge?.armed && v2.status !== 'automerge_armed' ? ' · auto-merge armed' : ''}
          </span>
          {blocked && (
            <Button
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={handleRequeue}
              disabled={requeueing}
              title="Reset the retry budgets and try again now"
            >
              {requeueing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Requeue
            </Button>
          )}
        </div>
        {blocked && v2?.reason && (
          <p className="text-muted-foreground [overflow-wrap:anywhere]">{v2.reason}</p>
        )}
        {budgets && (
          <p className="text-muted-foreground">
            Fix runs {budgets.fixRuns[0]}/{budgets.fixRuns[1]} · Check re-runs{' '}
            {budgets.checkReruns[0]}/{budgets.checkReruns[1]} · Re-signs {budgets.resigns[0]}/
            {budgets.resigns[1]}
            {v2?.headShaShort ? (
              <>
                {' '}
                — scoped to <span className="font-mono">{v2.headShaShort}</span> (a new push
                resets them)
              </>
            ) : null}
          </p>
        )}
        {shown === null ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading timeline…
          </p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground">No queue activity recorded yet.</p>
        ) : (
          <ul className="space-y-1 border-t pt-2">
            {shown.map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex gap-2">
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {new Date(e.at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="[overflow-wrap:anywhere]">
                  {e.message}
                  {e.fromStatus && e.fromStatus !== e.toStatus ? (
                    <span className="text-muted-foreground">
                      {' '}
                      ({e.fromStatus} → {e.toStatus})
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
            {events && events.length > 8 && !showAll && (
              <li>
                <button
                  className="text-[11px] text-muted-foreground underline hover:text-foreground"
                  onClick={() => setShowAll(true)}
                >
                  Show all {events.length} events
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

type CheckFilter = 'passed' | 'failed' | 'running' | 'skipped';

// Failed first, then in-flight, then passed, then skipped — so the
// rows that need attention sit at the top of the list.
const CHECK_STATE_ORDER: Record<PRCheckState, number> = {
  failure: 0,
  in_progress: 1,
  pending: 2,
  success: 3,
  skipped: 4,
};

const FILTER_STATES: Record<CheckFilter, PRCheckState[]> = {
  passed: ['success'],
  failed: ['failure'],
  running: ['in_progress', 'pending'],
  skipped: ['skipped'],
};

function ChecksTab({
  data,
  detailPending,
}: {
  data: { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };
  detailPending: boolean;
}) {
  // Counts come from the SAME fetch as the rows below whenever the live detail
  // has landed. Reading them off the cached row instead let the two disagree —
  // a tile saying "1 Failed" over a list with no failing check in it, because
  // the cached summary and the fresh contexts were fetched minutes apart. The
  // cached counts stay the fallback for when the detail fetch returns nothing.
  const checks = data.fresh?.checks ?? data.row.summary.checks;
  // Clicking a tile filters the list to that state (toggle off by
  // clicking again).
  const [filter, setFilter] = useState<CheckFilter | null>(null);
  if (checks.total === 0) {
    return <p className="text-xs text-muted-foreground">No checks have run yet.</p>;
  }
  // Per-check rows come from the live detail fetch (data.fresh). When
  // that's unavailable (env offline) we still show the rollup tiles +
  // a GitHub link.
  const contexts = data.fresh?.checkContexts ?? [];
  // When the PR is mergeable despite failing checks, none of those failures
  // are required — colour them amber ("not required") instead of a blocking
  // red. Prefer the authoritative per-check `required` flag from the live
  // fetch; fall back to the summary's blockingReason when it's absent.
  const failingContexts = contexts.filter((c) => c.state === 'failure');
  const allFailuresNonRequired =
    failingContexts.length > 0 && failingContexts.every((c) => c.required === false);
  const failuresOptional =
    (data.fresh ?? data.row.summary).blockingReason === 'checks_failed_optional' ||
    allFailuresNonRequired;
  const sorted = contexts
    .slice()
    .sort((a, b) => (CHECK_STATE_ORDER[a.state] ?? 99) - (CHECK_STATE_ORDER[b.state] ?? 99));
  const visible = filter
    ? sorted.filter((c) => FILTER_STATES[filter].includes(c.state))
    : sorted;

  function toggle(key: CheckFilter) {
    setFilter((cur) => (cur === key ? null : key));
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <CheckCountTile
          label="Passed"
          value={checks.passed}
          tone="green"
          active={filter === 'passed'}
          onClick={() => toggle('passed')}
        />
        <CheckCountTile
          label={failuresOptional ? 'Failed (optional)' : 'Failed'}
          value={checks.failed}
          tone={failuresOptional ? 'amber' : 'red'}
          active={filter === 'failed'}
          onClick={() => toggle('failed')}
        />
        <CheckCountTile
          label="Running"
          value={checks.inProgress}
          tone="blue"
          active={filter === 'running'}
          onClick={() => toggle('running')}
        />
        <CheckCountTile
          label="Skipped"
          value={checks.skipped}
          tone="grey"
          active={filter === 'skipped'}
          onClick={() => toggle('skipped')}
        />
      </div>
      {contexts.length > 0 ? (
        visible.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {visible.map((c) => (
              <CheckRow
                key={`${c.name}-${c.url ?? ''}`}
                check={c}
                failuresOptional={failuresOptional}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            No {filter} checks.{' '}
            <button
              type="button"
              onClick={() => setFilter(null)}
              className="text-primary underline"
            >
              Clear filter
            </button>
          </p>
        )
      ) : detailPending ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading checks…
        </p>
      ) : (
        <a
          href={`${data.row.summary.url}/checks`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary underline"
        >
          Open checks on GitHub
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

function CheckRow({
  check,
  failuresOptional = false,
}: {
  check: PRCheckContext;
  failuresOptional?: boolean;
}) {
  // A non-required failing check reads amber, not red, and carries a
  // "not required" tag so it's clear it isn't blocking the merge. Trust the
  // per-check `required` flag when present; otherwise fall back to the
  // tab-level verdict.
  const optionalFail =
    check.state === 'failure' &&
    (check.required === false || (check.required == null && failuresOptional));
  const { icon, color } = checkStateVisual(check.state, optionalFail);
  const row = (
    <div className="flex items-center gap-2 px-2.5 py-1.5">
      <span className={cn('shrink-0', color)}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-xs" title={check.name}>
        {check.name}
      </span>
      {optionalFail && (
        <span className="shrink-0 rounded bg-amber-500/10 px-1 py-px text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">
          not required
        </span>
      )}
      <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
        {check.state.replace('_', ' ')}
      </span>
      {check.url && <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />}
    </div>
  );
  if (!check.url) return <li>{row}</li>;
  return (
    <li>
      <a
        href={check.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block hover:bg-accent"
      >
        {row}
      </a>
    </li>
  );
}

function checkStateVisual(
  state: PRCheckContext['state'],
  optionalFail = false
): {
  icon: React.ReactNode;
  color: string;
} {
  switch (state) {
    case 'success':
      return {
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        color: 'text-emerald-600 dark:text-emerald-500',
      };
    case 'failure':
      return {
        icon: <X className="h-3.5 w-3.5" />,
        color: optionalFail
          ? 'text-amber-600 dark:text-amber-500'
          : 'text-red-600 dark:text-red-500',
      };
    case 'in_progress':
    case 'pending':
      return {
        icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
        color: 'text-blue-600 dark:text-blue-500',
      };
    default:
      return {
        icon: <CircleDot className="h-3.5 w-3.5" />,
        color: 'text-muted-foreground',
      };
  }
}

function CheckCountTile({
  label,
  value,
  tone,
  active = false,
  onClick,
}: {
  label: string;
  value: number;
  tone: 'green' | 'red' | 'amber' | 'blue' | 'grey';
  active?: boolean;
  onClick?: () => void;
}) {
  const toneClass = {
    green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    red: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    blue: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
    grey: 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  }[tone];
  const ringClass = {
    green: 'ring-emerald-500',
    red: 'ring-red-500',
    amber: 'ring-amber-500',
    blue: 'ring-blue-500',
    grey: 'ring-zinc-400',
  }[tone];
  // Tiles with no checks of that kind aren't useful to filter on.
  const disabled = value === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={
        disabled
          ? `No ${label.toLowerCase()} checks`
          : active
            ? `Showing only ${label.toLowerCase()} — click to clear`
            : `Show only ${label.toLowerCase()} checks`
      }
      className={cn(
        'rounded-md border p-3 text-left transition-all',
        toneClass,
        active && cn('ring-2 ring-offset-1 ring-offset-background', ringClass),
        disabled ? 'cursor-default opacity-50' : 'cursor-pointer hover:brightness-105'
      )}
    >
      <div className="text-2xl font-semibold leading-none">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide opacity-75">{label}</div>
    </button>
  );
}

function ReviewsTab({
  data,
}: {
  data: { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };
}) {
  const [detail, setDetail] = useState<PRReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.pullRequests
      .reviews(data.row.id)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data.row.id]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading reviews…
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">Couldn't load reviews: {error}</p>
        <a
          href={data.row.summary.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary underline"
        >
          View on GitHub
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    );
  }
  // GitHub-style timeline: interleave review submissions, inline-comment
  // threads, and conversation comments into one stream ordered by timestamp
  // (oldest first), rather than three stacked sections.
  const timeline: TimelineItem[] = detail
    ? [
        // Skip empty "commented" reviews — GitHub creates those purely as a
        // container for inline comments, which we already render as threads.
        ...detail.reviews
          .filter((r) => r.state !== 'COMMENTED' || r.body.trim())
          .map(
            (r): TimelineItem => ({
              kind: 'review',
              key: `r:${r.id}`,
              at: parseTime(r.submittedAt),
              review: r,
            })
          ),
        ...detail.threads.map(
          (t): TimelineItem => ({
            kind: 'thread',
            key: `t:${t.id}`,
            // Anchor a thread at its first comment so it sorts where the
            // conversation started.
            at: parseTime(t.comments[0]?.createdAt ?? null),
            thread: t,
          })
        ),
        ...detail.comments.map(
          (c): TimelineItem => ({
            kind: 'comment',
            key: `c:${c.id}`,
            at: parseTime(c.createdAt),
            comment: c,
          })
        ),
      ].sort((a, b) => a.at - b.at)
    : [];

  if (timeline.length === 0) {
    return <p className="text-xs text-muted-foreground">No reviews or comments yet.</p>;
  }

  const unresolvedCount = detail
    ? detail.threads.filter((t) => !t.isResolved).length
    : 0;

  return (
    <div className="space-y-3 text-sm">
      {unresolvedCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {unresolvedCount} unresolved inline {unresolvedCount === 1 ? 'comment' : 'comments'}
        </p>
      )}

      {timeline.map((item) =>
        item.kind === 'review' ? (
          <ReviewCard key={item.key} review={item.review} />
        ) : item.kind === 'thread' ? (
          <ThreadCard key={item.key} thread={item.thread} />
        ) : (
          <CommentCard
            key={item.key}
            author={item.comment.author}
            avatarUrl={item.comment.avatarUrl}
            body={item.comment.body}
            at={item.comment.createdAt}
            url={item.comment.url}
          />
        )
      )}

      <a
        href={data.row.summary.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-primary underline"
      >
        Open full conversation on GitHub
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

/** One entry in the merged Reviews-tab timeline. */
type TimelineItem =
  | { kind: 'review'; key: string; at: number; review: PRReviewDetail['reviews'][number] }
  | { kind: 'thread'; key: string; at: number; thread: PRReviewThread }
  | { kind: 'comment'; key: string; at: number; comment: PRReviewDetail['comments'][number] };

/** Parse an ISO timestamp to ms, treating missing/invalid as epoch 0 so it
 *  sorts to the top rather than throwing the order off. */
function parseTime(iso: string | null): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function Avatar({ url, login }: { url: string | null; login: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt={`@${login}`}
        className="h-6 w-6 shrink-0 rounded-full border bg-muted"
      />
    );
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-muted text-[10px] font-medium uppercase text-muted-foreground">
      {login.slice(0, 2)}
    </span>
  );
}

function ReviewStateBadge({ state }: { state: string }) {
  const map: Record<
    string,
    { label: string; cls: string; icon: React.ReactNode }
  > = {
    APPROVED: {
      label: 'approved',
      cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    CHANGES_REQUESTED: {
      label: 'requested changes',
      cls: 'bg-red-500/15 text-red-700 dark:text-red-400',
      icon: <XCircle className="h-3 w-3" />,
    },
    COMMENTED: {
      label: 'commented',
      cls: 'bg-muted text-muted-foreground',
      icon: <MessageSquare className="h-3 w-3" />,
    },
    DISMISSED: {
      label: 'dismissed',
      cls: 'bg-muted text-muted-foreground line-through',
      icon: <CircleDot className="h-3 w-3" />,
    },
  };
  const v = map[state] ?? map.COMMENTED;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        v.cls
      )}
    >
      {v.icon}
      {v.label}
    </span>
  );
}

function ReviewCard({
  review,
}: {
  review: PRReviewDetail['reviews'][number];
}) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <Avatar url={review.avatarUrl} login={review.author} />
        <span className="text-xs font-medium">@{review.author}</span>
        <ReviewStateBadge state={review.state} />
        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {fmtTime(review.submittedAt)}
          <a
            href={review.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        </span>
      </div>
      {review.body.trim() && (
        <div className="px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere]">
          {renderMarkdownish(review.body, 'surface')}
        </div>
      )}
    </div>
  );
}

function ThreadCard({ thread }: { thread: PRReviewThread }) {
  // Resolved threads collapse by default to keep the timeline focused on what
  // still needs attention; the header toggles them open. Unresolved threads
  // are always expanded (their header isn't a toggle).
  const collapsible = thread.isResolved;
  const [collapsed, setCollapsed] = useState(thread.isResolved);
  const isCollapsed = collapsible && collapsed;
  const count = thread.comments.length;

  const headerInner = (
    <>
      {collapsible &&
        (collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ))}
      <span className="min-w-0 flex-1 truncate text-left font-mono" title={thread.path ?? ''}>
        {thread.path ?? 'comment'}
        {thread.line != null && <span className="text-muted-foreground">:{thread.line}</span>}
      </span>
      {isCollapsed && count > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
          {count}
        </span>
      )}
      {thread.isOutdated && (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 uppercase tracking-wide text-muted-foreground">
          outdated
        </span>
      )}
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium',
          thread.isResolved
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
            : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
        )}
      >
        {thread.isResolved ? <Check className="h-3 w-3" /> : <CircleDot className="h-3 w-3" />}
        {thread.isResolved ? 'resolved' : 'unresolved'}
      </span>
    </>
  );

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border',
        thread.isResolved && isCollapsed && 'opacity-70'
      )}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex w-full items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] hover:bg-muted/60"
          aria-expanded={!collapsed}
        >
          {headerInner}
        </button>
      ) : (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px]">
          {headerInner}
        </div>
      )}
      {!isCollapsed && (
        <>
          {thread.diffHunk && (
            <pre className="overflow-x-auto border-b bg-card px-3 py-2 font-mono text-[11px] leading-snug text-muted-foreground">
              {lastHunkLines(thread.diffHunk)}
            </pre>
          )}
          <div className="divide-y">
            {thread.comments.map((c) => (
              <CommentCard
                key={c.id}
                author={c.author}
                avatarUrl={c.avatarUrl}
                body={c.body}
                at={c.createdAt}
                url={c.url}
                dense
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CommentCard({
  author,
  avatarUrl,
  body,
  at,
  url,
  dense = false,
}: {
  author: string;
  avatarUrl: string | null;
  body: string;
  at: string;
  url: string;
  dense?: boolean;
}) {
  return (
    <div className={cn(dense ? 'px-3 py-2' : 'rounded-md border px-3 py-2')}>
      <div className="mb-1 flex items-center gap-2">
        <Avatar url={avatarUrl} login={author} />
        <span className="text-xs font-medium">@{author}</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {fmtTime(at)}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        </span>
      </div>
      <div className="text-xs leading-relaxed [overflow-wrap:anywhere]">
        {body.trim() ? (
          renderMarkdownish(body, 'surface')
        ) : (
          <span className="text-muted-foreground">(no content)</span>
        )}
      </div>
    </div>
  );
}

/** Keep a diff hunk readable in a tight card — show only the last few
 *  lines (the ones the comment actually anchors to). */
function lastHunkLines(hunk: string, max = 6): string {
  const lines = hunk.split('\n');
  return lines.length <= max ? hunk : lines.slice(-max).join('\n');
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function FilesTab({
  data,
}: {
  data: { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };
}) {
  const [files, setFiles] = useState<PRFile[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.pullRequests
      .files(data.row.id)
      .then((res) => {
        if (cancelled) return;
        setFiles(res);
        // Auto-expand the first file so the tab isn't a wall of
        // collapsed rows on open.
        if (res.length > 0) setExpanded(res[0].filename);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data.row.id]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading files…
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">Couldn't load files: {error}</p>
        <GitHubFilesLink url={data.row.summary.url} />
      </div>
    );
  }
  if (!files || files.length === 0) {
    return <p className="text-xs text-muted-foreground">No file changes in this PR.</p>;
  }

  const totals = files.reduce(
    (acc, f) => ({ added: acc.added + f.additions, removed: acc.removed + f.deletions }),
    { added: 0, removed: 0 }
  );

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
          <span className="ml-2 tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-500">+{totals.added}</span>{' '}
            <span className="text-red-600 dark:text-red-500">−{totals.removed}</span>
          </span>
        </span>
        <GitHubFilesLink url={data.row.summary.url} compact />
      </div>
      <ul className="divide-y rounded-md border">
        {files.map((f) => (
          <PRFileRow
            key={f.filename}
            file={f}
            open={expanded === f.filename}
            onToggle={() =>
              setExpanded((cur) => (cur === f.filename ? null : f.filename))
            }
          />
        ))}
      </ul>
    </div>
  );
}

function PRFileRow({
  file,
  open,
  onToggle,
}: {
  file: PRFile;
  open: boolean;
  onToggle: () => void;
}) {
  const StatusIcon =
    file.status === 'added'
      ? FilePlus
      : file.status === 'removed'
        ? FileMinus
        : file.status === 'renamed'
          ? FileDiff
          : FileText;
  const statusColor =
    file.status === 'added'
      ? 'text-emerald-600 dark:text-emerald-500'
      : file.status === 'removed'
        ? 'text-red-600 dark:text-red-500'
        : 'text-muted-foreground';

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', statusColor)} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.filename}>
          {file.filename}
        </span>
        <span className="ml-2 shrink-0 text-[11px] tabular-nums">
          {file.additions > 0 && (
            <span className="text-emerald-600 dark:text-emerald-500">+{file.additions}</span>
          )}
          {file.additions > 0 && file.deletions > 0 && ' '}
          {file.deletions > 0 && (
            <span className="text-red-600 dark:text-red-500">−{file.deletions}</span>
          )}
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t bg-card max-w-full">
          {file.patch ? (
            <PatchDiff
              patch={toUnifiedDiff(file)}
              options={{ diffStyle: 'unified' }}
            />
          ) : (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              {file.status === 'renamed'
                ? 'Renamed with no content change.'
                : 'No textual diff available (binary file or diff too large — view on GitHub).'}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function GitHubFilesLink({ url, compact }: { url: string; compact?: boolean }) {
  return (
    <a
      href={`${url}/files`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-primary underline"
    >
      {compact ? 'On GitHub' : 'Open Files tab on GitHub'}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/**
 * GitHub's `/pulls/:n/files` `patch` field carries only the hunks
 * (`@@ … @@` onward) — no `diff --git` / `---` / `+++` header. PatchDiff
 * parses a full unified diff, so synthesise the missing header from the
 * filename + status. /dev/null on the appropriate side keeps added /
 * removed files rendering as pure inserts / deletes.
 */
function toUnifiedDiff(file: PRFile): string {
  const a = file.status === 'added' ? '/dev/null' : `a/${file.filename}`;
  const b = file.status === 'removed' ? '/dev/null' : `b/${file.filename}`;
  return [
    `diff --git a/${file.filename} b/${file.filename}`,
    `--- ${a}`,
    `+++ ${b}`,
    file.patch ?? '',
  ].join('\n');
}

function BranchRef({ head, base }: { head: string; base: string }) {
  // The chips truncate in the UI, so a click copies the full branch name to
  // the clipboard (with a toast) rather than relying on a manual select.
  const copyBranch = (branch: string, label: 'Source' | 'Target') => {
    navigator.clipboard
      .writeText(branch)
      .then(() => toast.success(`${label} branch copied`, branch))
      .catch(() => toast.error('Could not copy to clipboard'));
  };
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
      <GitBranch className="h-3.5 w-3.5 shrink-0" />
      {/* Each chip truncates so the row stays one line; clicking copies the
          full branch name, with the title showing it on hover. */}
      <span
        onClick={() => copyBranch(head, 'Source')}
        className="inline-block max-w-[55%] cursor-pointer truncate rounded bg-muted px-1 align-bottom hover:bg-accent"
        title={`Click to copy the branch name: ${head}`}
      >
        {head}
      </span>
      <span className="shrink-0 text-muted-foreground/70">→</span>
      <span
        onClick={() => copyBranch(base, 'Target')}
        className="inline-block max-w-[40%] cursor-pointer truncate rounded bg-muted px-1 align-bottom hover:bg-accent"
        title={`Click to copy the branch name: ${base}`}
      >
        {base}
      </span>
    </div>
  );
}


