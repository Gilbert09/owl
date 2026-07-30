import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bug, Trash2, Pause, Play, Wifi, Info, Gauge, Database } from 'lucide-react';
import type {
  DebugCategory,
  DebugEvent,
  DebugGraphqlBudget,
  DebugSnapshot,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

// Keep the rendered list bounded — the backend ring buffer caps at 1000, and
// the DOM stays cheap if we render the most recent slice.
const MAX_RENDERED = 500;
// How often we re-pull the snapshot (poller "last tick" ages, client count).
const SNAPSHOT_INTERVAL_MS = 3_000;

type CategoryFilter = 'all' | DebugCategory;

const CATEGORY_LABEL: Record<DebugCategory, string> = {
  http: 'HTTP',
  db: 'Database',
  polling: 'Polling',
  websocket: 'WebSocket',
  event: 'Events',
  webhook: 'Webhooks',
  error: 'Errors',
};

const FILTERS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'http', label: 'HTTP' },
  { id: 'db', label: 'Database' },
  { id: 'polling', label: 'Polling' },
  { id: 'websocket', label: 'WebSocket' },
  { id: 'event', label: 'Events' },
  { id: 'webhook', label: 'Webhooks' },
  { id: 'error', label: 'Errors' },
];

// What each event category means. Surfaced as tooltips on the counter chips
// and the legend. Keep this in sync when adding a new DebugCategory.
const CATEGORY_INFO: Record<DebugCategory, string> = {
  http: 'Outbound HTTP to external services (GitHub REST/GraphQL, PostHog Code). Metadata only — method, URL with the query stripped, status, and duration.',
  db: 'Postgres queries and the estimated bytes each result pulled back from the database. The size is the serialized result rows — an estimate of egress, not exact wire bytes — but enough to spot which queries dominate database egress.',
  polling: 'Background poll-loop ticks. Each loop wakes on its own interval to reconcile state — see the cards above for what each does.',
  websocket: 'The realtime channel to the desktop app: client connect/disconnect, inbound messages, and outbound broadcasts.',
  event: 'In-process domain events (e.g. a task changing status) that other backend services react to.',
  webhook:
    'Inbound GitHub webhook deliveries: receipt (signature check, ownership filter, enqueue) and processing (fan-out to PR refreshes, enqueue→process lag). Metadata only — event type, delivery id, fan-out count.',
  error: 'A request or poll tick that failed — expand the row for the error message.',
};

// What each non-poller service is. Pollers carry their own description from
// the backend registry; these cover the services that show up in HTTP/event
// rows. Keep this in sync when a new outbound integration or emitter lands.
const SERVICE_INFO: Record<string, string> = {
  github: 'GitHub REST + GraphQL API — PR data, checks, reviews, merges, and OAuth.',
  postgres: 'The Supabase Postgres database — every query funnels through here. Rows show the operation, target table, and estimated result size.',
  posthog_code: 'PostHog Code cloud-task API — creates and runs cloud agent tasks and streams their transcripts.',
  claude_managed_agents:
    'Claude Managed Agents API — creates agents/sessions in Anthropic’s sandbox, polls the event transcript, and opens PRs via the GitHub MCP.',
  posthog_analytics:
    'PostHog product-analytics capture — server-side task lifecycle events (dispatched/completed/failed).',
  ws: 'The WebSocket server fanning realtime updates out to connected desktop clients.',
  tasks: 'Task lifecycle domain events (queued → in_progress → completed/failed).',
  github_webhooks:
    'Inbound GitHub App webhooks — verified, filtered, and pushed onto the Redis ingest stream, then drained by the worker into PR refreshes.',
  redis: 'Redis — the cross-replica backbone: WebSocket fan-out (Pub/Sub) and the webhook ingest queue (Stream).',
  polar:
    'Polar billing API — hosted checkout + customer-portal sessions for the Unlimited plan.',
  billing:
    'Billing domain events — inbound Polar subscription webhooks and the plan changes they apply.',
};

const TIP_WIDTH = 256; // matches w-64
const TIP_MARGIN = 8; // min gap from the viewport edge

/**
 * Dependency-free hover tooltip. Renders into a body portal with fixed
 * positioning clamped to the viewport, so it can't be clipped by the panel's
 * overflow container or slide under the sidebar (which a plain absolutely-
 * positioned tooltip does for left-edge triggers).
 */
function Tip({
  content,
  children,
  className,
  side = 'top',
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  side?: 'top' | 'bottom';
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Centre on the trigger, then clamp so the box stays fully on-screen.
    const left = Math.max(
      TIP_MARGIN,
      Math.min(
        r.left + r.width / 2 - TIP_WIDTH / 2,
        window.innerWidth - TIP_WIDTH - TIP_MARGIN
      )
    );
    const top = side === 'top' ? r.top : r.bottom;
    setCoords({ top, left });
  }, [side]);

  const hide = useCallback(() => setCoords(null), []);

  return (
    <span
      ref={triggerRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {coords &&
        createPortal(
          <span
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              transform:
                side === 'top'
                  ? 'translateY(calc(-100% - 6px))'
                  : 'translateY(6px)',
            }}
            className="pointer-events-none z-[100] block w-64 max-w-[80vw] whitespace-normal rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-left text-[11px] font-normal normal-case leading-relaxed text-zinc-300 shadow-lg"
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  );
}

/** Tailwind classes for the per-category badge in the stream. */
function categoryClasses(category: DebugCategory): string {
  switch (category) {
    case 'http':
      return 'bg-sky-500/15 text-sky-300';
    case 'db':
      return 'bg-indigo-500/15 text-indigo-300';
    case 'polling':
      return 'bg-violet-500/15 text-violet-300';
    case 'websocket':
      return 'bg-emerald-500/15 text-emerald-300';
    case 'event':
      return 'bg-amber-500/15 text-amber-300';
    case 'webhook':
      return 'bg-teal-500/15 text-teal-300';
    case 'error':
      return 'bg-red-500/15 text-red-300';
  }
}

function timeOf(ts: string): string {
  // HH:MM:SS.mmm — precise enough to read interleaving without a date.
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Human-readable byte size for the DB egress tile (e.g. "4.2 MB"). */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Human-friendly latency: 320ms · 8.4s · 14m. */
function formatLag(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 0) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

/** "in 42m" until a future reset timestamp, or "now" once it's elapsed. */
function resetIn(iso: string): string {
  const sec = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (sec <= 0) return 'now';
  if (sec < 60) return `in ${sec}s`;
  if (sec < 3600) return `in ${Math.round(sec / 60)}m`;
  return `in ${Math.round(sec / 3600)}h`;
}

/** A GraphQL points-budget card for one rate-limit account. Bar reddens as the
 *  budget runs low; an amber "deferring" state means non-urgent loops are being
 *  held back to protect the reserve. Compact — there are only a few accounts. */
function GraphqlBudgetCard({ b }: { b: DebugGraphqlBudget }) {
  const pct = b.limit > 0 ? Math.max(0, Math.min(1, b.remaining / b.limit)) : 0;
  const bar = b.deferring
    ? 'bg-amber-500'
    : pct > 0.5
      ? 'bg-emerald-500'
      : pct > 0.15
        ? 'bg-amber-500'
        : 'bg-red-500';
  return (
    <div
      className={cn(
        'rounded-md border bg-zinc-900/40 p-2',
        b.deferring ? 'border-amber-500/50 bg-amber-500/5' : 'border-zinc-800'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Tip
          side="bottom"
          className="min-w-0"
          content={
            <span className="block">
              <span className="font-mono font-medium text-zinc-100">{b.accountKey}</span>
              <span className="mt-1 block">
                GitHub GraphQL points budget for this account — {b.remaining.toLocaleString()} of{' '}
                {b.limit.toLocaleString()} left, resets {resetIn(b.resetAt)}. Last query cost{' '}
                {b.lastCost.toLocaleString()} point{b.lastCost === 1 ? '' : 's'}.
              </span>
              {b.deferring && (
                <span className="mt-1 block text-amber-400">
                  Budget in reserve — the reconcile sweep is deferring this account until the
                  window resets.
                </span>
              )}
              <span className="mt-1 block text-zinc-500">Last seen {ago(b.observedAt)}.</span>
            </span>
          }
        >
          <span className="flex items-center gap-1 truncate font-mono text-xs text-zinc-200">
            {b.accountKey}
            <Info className="h-3 w-3 shrink-0 text-zinc-600" />
          </span>
        </Tip>
        {b.deferring && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 font-mono text-[10px] font-medium text-amber-400">
            deferring
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between text-[11px] text-zinc-400">
        <span>
          <span className="font-medium text-zinc-200">{b.remaining.toLocaleString()}</span> /{' '}
          {b.limit.toLocaleString()}
        </span>
        <span className="text-zinc-500">{Math.round(pct * 100)}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={cn('h-full rounded-full', bar)} style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
        <span>resets {resetIn(b.resetAt)}</span>
        <span>cost {b.lastCost.toLocaleString()}</span>
      </div>
    </div>
  );
}

export function DebugPanel() {
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [serviceFilter, setServiceFilter] = useState<string>('');
  const [paused, setPaused] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // Admin gate (null = checking) and per-user owner filter ('' = all accounts).
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<string>('');

  // Incoming live events are buffered in a ref and flushed once per animation
  // frame, so a burst of activity can't trigger a render per event.
  const pendingRef = useRef<DebugEvent[]>([]);
  const rafRef = useRef<number | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const flush = useCallback(() => {
    rafRef.current = null;
    if (pendingRef.current.length === 0) return;
    const incoming = pendingRef.current;
    pendingRef.current = [];
    setEvents((prev) => {
      // Newest first; cap the list. Incoming arrives in chronological order.
      const next = [...incoming.reverse(), ...prev];
      return next.length > MAX_RENDERED ? next.slice(0, MAX_RENDERED) : next;
    });
  }, []);

  const owner = ownerFilter || undefined;

  const refreshSnapshot = useCallback(() => {
    api.debug.getSnapshot(owner).then(setSnapshot).catch(() => {});
  }, [owner]);

  // Is this user allowed to see the debug surface? (Admin-gated server-side.)
  useEffect(() => {
    api.debug
      .getAccess()
      .then((r) => setAdmin(r.admin))
      .catch(() => setAdmin(false));
  }, []);

  // Backfill + periodic snapshot, re-fetched whenever the owner filter changes
  // so the buffer + rate-limit cards reflect the selected account.
  useEffect(() => {
    if (admin !== true) return;
    let cancelled = false;
    api.debug
      .getEvents({ limit: MAX_RENDERED, owner })
      .then((backfill) => {
        if (cancelled) return;
        // getEvents returns chronological order — show newest first.
        setEvents([...backfill].reverse());
        pendingRef.current = [];
      })
      .catch(() => {});
    refreshSnapshot();
    const snapTimer = window.setInterval(refreshSnapshot, SNAPSHOT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(snapTimer);
    };
  }, [admin, owner, refreshSnapshot]);

  // Push the owner filter to the server so it only streams matching events to
  // us — a single-user filter never pulls everyone's traffic over the wire.
  useEffect(() => {
    if (admin !== true) return;
    api.ws.setDebugFilter(owner);
    return () => {
      // Reset to "all" when the panel unmounts so we don't pin a stale filter.
      api.ws.setDebugFilter(undefined);
    };
  }, [admin, owner]);

  // Live subscription. The backend pushes matching debug events as `debug:event`.
  useEffect(() => {
    if (admin !== true) return;
    const off = api.ws.on<DebugEvent>('debug:event', (event) => {
      if (pausedRef.current) return;
      pendingRef.current.push(event);
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flush);
      }
    });
    return () => {
      off();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [admin, flush]);

  const handleClear = useCallback(() => {
    api.debug.clearEvents().catch(() => {});
    setEvents([]);
    pendingRef.current = [];
    refreshSnapshot();
  }, [refreshSnapshot]);

  const visible = useMemo(() => {
    const svc = serviceFilter.trim().toLowerCase();
    return events.filter((e) => {
      if (filter !== 'all' && e.category !== filter) return false;
      if (svc && !e.service.toLowerCase().includes(svc)) return false;
      // Defensive: the server already filters by owner, but a straggler from a
      // just-changed filter shouldn't leak into the rendered list.
      if (ownerFilter === 'system' && e.ownerId) return false;
      if (ownerFilter && ownerFilter !== 'system' && e.ownerId !== ownerFilter) return false;
      return true;
    });
  }, [events, filter, serviceFilter, ownerFilter]);

  if (admin === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-[#0f0f10] text-center text-zinc-300">
        <Bug className="h-8 w-8 text-zinc-600" />
        <p className="text-sm">Debug tools are admin-only.</p>
        <p className="max-w-sm text-xs text-zinc-500">
          This view exposes backend internals across every account, so it's limited to
          operators.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#0f0f10] text-zinc-100">
      {/* Header */}
      <div className="app-region-drag flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Bug className="h-5 w-5 text-zinc-400" />
          <h2 className="text-base font-semibold">Debug</h2>
          <span className="text-xs text-zinc-500">app internals, live</span>
          <Tip
            side="bottom"
            content={
              <span className="block space-y-1.5">
                {(Object.keys(CATEGORY_INFO) as DebugCategory[]).map((c) => (
                  <span key={c} className="block">
                    <span className="font-medium text-zinc-100">{CATEGORY_LABEL[c]}</span>
                    {' — '}
                    {CATEGORY_INFO[c]}
                  </span>
                ))}
              </span>
            }
          >
            <Info className="app-region-no-drag h-3.5 w-3.5 text-zinc-600 hover:text-zinc-400" />
          </Tip>
        </div>
        <div className="app-region-no-drag flex items-center gap-2">
          <select
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            title="Filter debug activity by user"
            className="h-8 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-500"
          >
            <option value="">All users</option>
            <option value="system">System (untagged)</option>
            {(snapshot?.owners ?? []).map((o) => (
              <option key={o.ownerId} value={o.ownerId}>
                {o.label}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-zinc-300 hover:text-zinc-100"
            onClick={() => setPaused((p) => !p)}
            title={paused ? 'Resume live stream' : 'Pause live stream'}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-zinc-300 hover:text-zinc-100"
            onClick={handleClear}
            title="Clear the buffer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      </div>

      {/* Snapshot bar */}
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Tip
            side="bottom"
            content="Desktop clients currently connected to the backend's WebSocket. The debug stream you're watching is one of them."
          >
            <span className="flex items-center gap-1.5 rounded-md bg-zinc-800/60 px-2.5 py-1 text-xs text-zinc-300">
              <Wifi className="h-3.5 w-3.5 text-emerald-400" />
              {snapshot?.wsClients ?? 0} WS client{snapshot?.wsClients === 1 ? '' : 's'}
            </span>
          </Tip>
          <Tip
            side="bottom"
            content="Estimated total bytes returned by Postgres queries since the last clear — the serialized result size, not exact wire bytes, but directionally accurate for spotting database egress."
          >
            <span className="flex items-center gap-1.5 rounded-md bg-zinc-800/60 px-2.5 py-1 text-xs text-zinc-300">
              <Database className="h-3.5 w-3.5 text-indigo-400" />
              {formatBytes(snapshot?.dbStats?.egressBytes ?? 0)} DB egress
            </span>
          </Tip>
          <Tip
            side="bottom"
            content="Total Postgres queries issued since the last clear."
          >
            <span className="flex items-center gap-1.5 rounded-md bg-zinc-800/60 px-2.5 py-1 text-xs text-zinc-300">
              <Database className="h-3.5 w-3.5 text-indigo-400" />
              {(snapshot?.dbStats?.requests ?? 0).toLocaleString()} DB quer
              {snapshot?.dbStats?.requests === 1 ? 'y' : 'ies'}
            </span>
          </Tip>
          <Tip
            side="bottom"
            content={
              (snapshot?.webhookLag?.samples ?? 0) === 0
                ? 'Webhook consumer lag: how long a delivery waits between the receiver enqueuing it and the worker picking it up. No deliveries processed yet.'
                : `Webhook consumer lag (enqueue→pickup) over the last ${snapshot?.webhookLag?.samples} deliveries — median ${formatLag(snapshot?.webhookLag?.medianMs ?? 0)}, worst ${formatLag(snapshot?.webhookLag?.maxMs ?? 0)}, last processed ${ago(snapshot?.webhookLag?.observedAt ?? null)}. Near zero is healthy; a rising figure means the worker can't keep up with the ingest stream.`
            }
          >
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs',
                (snapshot?.webhookLag?.maxMs ?? 0) >= 60_000
                  ? 'bg-red-500/15 text-red-300'
                  : (snapshot?.webhookLag?.maxMs ?? 0) >= 10_000
                    ? 'bg-amber-500/15 text-amber-300'
                    : 'bg-zinc-800/60 text-zinc-300'
              )}
            >
              <Gauge className="h-3.5 w-3.5 text-sky-400" />
              {formatLag(snapshot?.webhookLag?.medianMs ?? 0)} webhook lag
              {(snapshot?.webhookLag?.maxMs ?? 0) > (snapshot?.webhookLag?.medianMs ?? 0)
                ? ` (max ${formatLag(snapshot?.webhookLag?.maxMs ?? 0)})`
                : ''}
            </span>
          </Tip>
          <Tip
            side="bottom"
            content={
              (snapshot?.webhookLagSlow?.samples ?? 0) === 0
                ? 'PR-lane lag: enqueue→pickup for pull_request / review / comment deliveries, which run a bounded-concurrency refreshPr. No such deliveries processed yet.'
                : `PR-lane lag (pull_request/review/comment → refreshPr) over the last ${snapshot?.webhookLagSlow?.samples} deliveries — median ${formatLag(snapshot?.webhookLagSlow?.medianMs ?? 0)}, worst ${formatLag(snapshot?.webhookLagSlow?.maxMs ?? 0)}, last processed ${ago(snapshot?.webhookLagSlow?.observedAt ?? null)}. This lane is capped (6 concurrent refreshes) so it never gates the check firehose; a rising figure here means the refresh pool is backed up under a PR/review burst.`
            }
          >
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs',
                (snapshot?.webhookLagSlow?.maxMs ?? 0) >= 60_000
                  ? 'bg-red-500/15 text-red-300'
                  : (snapshot?.webhookLagSlow?.maxMs ?? 0) >= 10_000
                    ? 'bg-amber-500/15 text-amber-300'
                    : 'bg-zinc-800/60 text-zinc-300'
              )}
            >
              <Gauge className="h-3.5 w-3.5 text-violet-400" />
              {formatLag(snapshot?.webhookLagSlow?.medianMs ?? 0)} PR lag
              {(snapshot?.webhookLagSlow?.maxMs ?? 0) > (snapshot?.webhookLagSlow?.medianMs ?? 0)
                ? ` (max ${formatLag(snapshot?.webhookLagSlow?.maxMs ?? 0)})`
                : ''}
            </span>
          </Tip>
          {snapshot &&
            Object.entries(snapshot.counters).map(([cat, n]) => (
              <Tip
                key={cat}
                side="bottom"
                content={CATEGORY_INFO[cat as DebugCategory] ?? 'Recorded events in this category since the last clear.'}
              >
                <span
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs',
                    categoryClasses(cat as DebugCategory)
                  )}
                >
                  {CATEGORY_LABEL[cat as DebugCategory] ?? cat}: {n}
                </span>
              </Tip>
            ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {(snapshot?.pollers ?? []).map((p) => {
            // The adaptive loops re-register a stretched interval to protect the
            // GitHub rate-limit budget; flag it when the live cadence has been
            // slowed past its base (small epsilon to ignore rounding).
            const throttled = p.baseIntervalMs > 0 && p.intervalMs > p.baseIntervalMs * 1.05;
            const factor = throttled ? p.intervalMs / p.baseIntervalMs : 1;
            return (
            <div
              key={p.name}
              className={cn(
                'rounded-md border bg-zinc-900/40 p-2',
                throttled ? 'border-amber-500/50 bg-amber-500/5' : 'border-zinc-800'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <Tip
                  side="bottom"
                  className="min-w-0"
                  content={
                    <span className="block">
                      <span className="font-mono font-medium text-zinc-100">{p.name}</span>
                      <span className="mt-1 block">
                        {p.description || SERVICE_INFO[p.name] || 'A background poll loop.'}
                      </span>
                      <span className="mt-1 block text-zinc-500">
                        {throttled
                          ? `Throttled ${factor.toFixed(1)}× — every ${Math.round(
                              p.intervalMs / 1000
                            )}s (base ${Math.round(
                              p.baseIntervalMs / 1000
                            )}s) to stay under the GitHub rate limit.`
                          : `Runs every ${Math.round(p.intervalMs / 1000)}s.`}
                      </span>
                    </span>
                  }
                >
                  <span className="flex items-center gap-1 truncate font-mono text-xs text-zinc-200">
                    {p.name}
                    <Info className="h-3 w-3 shrink-0 text-zinc-600" />
                  </span>
                </Tip>
                <div className="flex shrink-0 items-center gap-1.5">
                  {throttled && (
                    <span className="rounded bg-amber-500/15 px-1 py-0.5 font-mono text-[10px] font-medium text-amber-400">
                      throttled {factor.toFixed(1)}×
                    </span>
                  )}
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      p.lastOk === false
                        ? 'bg-red-500'
                        : p.lastTickAt
                          ? 'bg-emerald-500'
                          : 'bg-zinc-600'
                    )}
                    title={p.lastError ?? (p.lastOk === false ? 'last tick failed' : 'ok')}
                  />
                </div>
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
                <span className={throttled ? 'text-amber-400' : undefined}>
                  every {Math.round(p.intervalMs / 1000)}s
                  {throttled && (
                    <span className="text-zinc-600"> (base {Math.round(p.baseIntervalMs / 1000)}s)</span>
                  )}
                </span>
                <span>{ago(p.lastTickAt)}</span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[11px] text-zinc-500">
                <span>{p.tickCount} ticks</span>
                {p.lastDurationMs != null && <span>{p.lastDurationMs}ms</span>}
              </div>
              {p.lastError && (
                <p className="mt-1 truncate text-[11px] text-red-400" title={p.lastError}>
                  {p.lastError}
                </p>
              )}
            </div>
            );
          })}
        </div>

        {(snapshot?.graphqlBudgets?.length ?? 0) > 0 && (
          <>
            <div className="mt-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              <Gauge className="h-3.5 w-3.5" />
              GraphQL budget
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {(snapshot?.graphqlBudgets ?? []).map((b) => (
                <GraphqlBudgetCard key={b.accountKey} b={b} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs transition-colors',
                filter === f.id
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={serviceFilter}
          onChange={(e) => setServiceFilter(e.target.value)}
          placeholder="filter by service…"
          className="ml-auto w-44 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
        />
        <span className="text-xs text-zinc-600">{visible.length}</span>
      </div>

      {/* Event stream */}
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-600">
            {paused ? 'Paused — no new events captured.' : 'Waiting for activity…'}
          </div>
        ) : (
          visible.map((e) => {
            const expanded = expandedId === e.id;
            const hasMeta = e.meta && Object.keys(e.meta).length > 0;
            return (
              <div key={e.id} className="border-b border-zinc-900">
                <button
                  onClick={() => setExpandedId(expanded ? null : e.id)}
                  className="flex w-full items-start gap-2 px-4 py-1.5 text-left hover:bg-zinc-900/60"
                >
                  <span className="shrink-0 text-zinc-600">{timeOf(e.timestamp)}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 text-[10px] uppercase leading-5',
                      categoryClasses(e.category)
                    )}
                  >
                    {CATEGORY_LABEL[e.category]}
                  </span>
                  <span className="shrink-0 text-zinc-500" title={SERVICE_INFO[e.service]}>
                    {e.service}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      e.ok ? 'text-zinc-200' : 'text-red-400'
                    )}
                  >
                    {e.summary}
                  </span>
                  {e.durationMs != null && (
                    <span className="shrink-0 text-zinc-600">{Math.round(e.durationMs)}ms</span>
                  )}
                </button>
                {expanded && hasMeta && (
                  <pre className="overflow-x-auto bg-zinc-950 px-4 py-2 text-[11px] text-zinc-400">
                    {JSON.stringify(e.meta, null, 2)}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
