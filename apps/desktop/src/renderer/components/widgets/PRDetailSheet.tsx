import React, { useEffect, useState } from 'react';
import {
  ExternalLink,
  RefreshCw,
  X,
  Loader2,
  FileText,
  CheckCircle2,
  MessageSquare,
  Layers,
} from 'lucide-react';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import { api, type PRRow, type PRSummaryShape, type PRFreshDetail } from '../../lib/api';
import { PRStatusPill } from './PRStatusPill';

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
}

export function PRDetailSheet({ pullRequestId, onClose }: PRDetailSheetProps) {
  const [data, setData] = useState<{
    row: PRRow;
    fresh: (PRSummaryShape & PRFreshDetail) | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pullRequestId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.pullRequests
      .get(pullRequestId)
      .then((res) => {
        if (cancelled) return;
        setData(res);
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

  // Subscribe to pull_request:updated to keep the visible PR fresh
  // when the monitor refetches in the background.
  useEffect(() => {
    if (!pullRequestId) return;
    const unsubscribe = api.ws.on('pull_request:updated', (payload) => {
      const p = payload as { id: string; lastSummary: unknown };
      if (p.id !== pullRequestId) return;
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          row: { ...prev.row, summary: p.lastSummary as PRSummaryShape },
        };
      });
    });
    return unsubscribe;
  }, [pullRequestId]);

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

  if (!pullRequestId) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl flex-col border-l bg-background shadow-2xl">
      <header className="flex shrink-0 items-start gap-3 border-b p-4">
        <div className="min-w-0 flex-1">
          {loading && !data ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : data ? (
            <>
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold">
                  {data.row.summary.title}
                </h2>
                <span className="shrink-0 text-sm text-muted-foreground">
                  {data.row.owner}/{data.row.repo}#{data.row.number}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span>by @{data.row.summary.author}</span>
                <span>·</span>
                <BranchRef
                  head={data.row.summary.headBranch}
                  base={data.row.summary.baseBranch}
                />
              </div>
              <div className="mt-2">
                <PRStatusPill
                  blockingReason={data.row.summary.blockingReason}
                  checks={data.row.summary.checks}
                />
              </div>
            </>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={loading || refreshing}
            title="Re-fetch from GitHub"
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          </Button>
          {data && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(data.row.summary.url, '_blank', 'noopener,noreferrer')}
              title="Open on GitHub"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {data && <DetailTabs data={data} error={error} />}
    </div>
  );
}

type TabKey = 'overview' | 'files' | 'checks' | 'reviews';

function DetailTabs({
  data,
  error,
}: {
  data: { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };
  error: string | null;
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
          {!data.fresh && (
            <p className="mb-4 text-xs text-muted-foreground">
              Detail fetch unavailable (env offline?). Showing cached state only.
            </p>
          )}
          {tab === 'overview' && <OverviewTab data={data} />}
          {tab === 'checks' && <ChecksTab data={data} />}
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
}: {
  data: { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };
}) {
  const body = data.fresh?.body ?? '';
  return (
    <div className="space-y-4 text-sm">
      {body ? (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Description
          </h3>
          <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">
            {body}
          </pre>
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">No description provided.</p>
      )}
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
            {data.row.summary.reviewDecision
              ? data.row.summary.reviewDecision.toLowerCase().replace('_', ' ')
              : 'pending'}
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

function ChecksTab({
  data,
}: {
  data: { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };
}) {
  const checks = data.row.summary.checks;
  if (checks.total === 0) {
    return <p className="text-xs text-muted-foreground">No checks have run yet.</p>;
  }
  // Placeholder rendering — Phase 6/7 (or a follow-up) wires up a
  // dedicated GraphQL fetch that returns the per-check rows. For
  // now we surface the rolled-up counts and link to GitHub for the
  // detailed view.
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <CheckCountTile label="Passed" value={checks.passed} tone="green" />
        <CheckCountTile label="Failed" value={checks.failed} tone="red" />
        <CheckCountTile label="Running" value={checks.inProgress} tone="blue" />
        <CheckCountTile label="Skipped" value={checks.skipped} tone="grey" />
      </div>
      <p className="text-xs text-muted-foreground">
        Per-check breakdown is on GitHub (the desktop wraps the rollup; the
        per-check list is one round-trip away).
      </p>
      <a
        href={`${data.row.summary.url}/checks`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-primary underline"
      >
        Open checks on GitHub
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

function CheckCountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'green' | 'red' | 'blue' | 'grey';
}) {
  const toneClass = {
    green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    red: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
    blue: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
    grey: 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  }[tone];
  return (
    <div className={cn('rounded-md border p-3', toneClass)}>
      <div className="text-2xl font-semibold leading-none">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide opacity-75">{label}</div>
    </div>
  );
}

function ReviewsTab({
  data,
}: {
  data: { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };
}) {
  const fresh = data.fresh;
  if (!fresh) {
    return (
      <p className="text-xs text-muted-foreground">Fresh fetch unavailable.</p>
    );
  }
  if (fresh.recentReviews.length === 0 && fresh.recentReviewComments.length === 0) {
    return <p className="text-xs text-muted-foreground">No reviews yet.</p>;
  }
  return (
    <div className="space-y-4 text-sm">
      <ActivityList
        title="Recent reviews"
        items={fresh.recentReviews.map((r) => ({
          key: r.id,
          author: r.author,
          line: r.state.toLowerCase().replace('_', ' '),
          at: r.submittedAt ?? '',
          url: r.url,
        }))}
      />
      <ActivityList
        title="Inline comments"
        items={fresh.recentReviewComments.map((c) => ({
          key: c.id,
          author: c.author,
          line: 'commented on diff',
          at: c.createdAt,
          url: c.url,
        }))}
      />
      <ActivityList
        title="Top-level comments"
        items={fresh.recentComments.map((c) => ({
          key: c.id,
          author: c.author,
          line: 'commented',
          at: c.createdAt,
          url: c.url,
        }))}
      />
      <a
        href={`${data.row.summary.url}/files`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-primary underline"
      >
        View full review history on GitHub
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

function FilesTab({
  data,
}: {
  data: { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };
}) {
  // Files content lives behind a separate GraphQL query that's
  // worth its own follow-up commit (full diff fetch, paginated).
  // For now the tab links to GitHub.
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        File-by-file diffs are best viewed on GitHub for now — the desktop
        will inline them in a follow-up.
      </p>
      <a
        href={`${data.row.summary.url}/files`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-primary underline"
      >
        Open Files tab on GitHub
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

function BranchRef({ head, base }: { head: string; base: string }) {
  return (
    <span className="font-mono">
      <span className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">{head}</span>
      <span className="px-1 text-muted-foreground">→</span>
      <span className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">{base}</span>
    </span>
  );
}


interface ActivityItem {
  key: string;
  author: string;
  line: string;
  at: string;
  url: string;
}

function ActivityList({
  title,
  items,
}: {
  title: string;
  items: ActivityItem[];
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.key} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate">
              <span className="font-medium">@{item.author}</span>
              <span className="ml-2 text-muted-foreground">{item.line}</span>
            </span>
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
