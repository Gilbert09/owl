import React, { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, X, Loader2 } from 'lucide-react';
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

      <ScrollArea className="flex-1">
        <div className="p-4">
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400">
              {error}
            </div>
          )}
          {data?.fresh && (
            <SkeletonBody fresh={data.fresh} />
          )}
          {data && !data.fresh && (
            <p className="text-xs text-muted-foreground">
              Detail fetch unavailable (env offline?). Showing cached state only.
            </p>
          )}
        </div>
      </ScrollArea>
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

/**
 * Phase 4 placeholder for the body. Phase 5 replaces this with proper
 * tabs (Overview / Files / Checks / Reviews). For now we just dump the
 * recent activity lists from the fresh GraphQL fetch.
 */
function SkeletonBody({ fresh }: { fresh: PRSummaryShape & PRFreshDetail }) {
  return (
    <div className="space-y-6 text-sm">
      {fresh.body && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Description
          </h3>
          <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">
            {fresh.body}
          </pre>
        </section>
      )}
      <ActivityList
        title="Recent reviews"
        items={fresh.recentReviews.map((r) => ({
          key: r.id,
          author: r.author,
          line: r.state,
          at: r.submittedAt ?? '',
          url: r.url,
        }))}
      />
      <ActivityList
        title="Recent review comments"
        items={fresh.recentReviewComments.map((c) => ({
          key: c.id,
          author: c.author,
          line: 'commented inline',
          at: c.createdAt,
          url: c.url,
        }))}
      />
      <ActivityList
        title="Recent comments"
        items={fresh.recentComments.map((c) => ({
          key: c.id,
          author: c.author,
          line: 'commented',
          at: c.createdAt,
          url: c.url,
        }))}
      />
    </div>
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
