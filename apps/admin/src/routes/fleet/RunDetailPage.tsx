import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { AdminRunEvent } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, relativeAge } from '../../lib/format';
import { ROUTES } from '../../lib/routes';

/**
 * One run's transcript.
 *
 * A route rather than a modal because pasting a run id into Slack is the
 * single most common thing an operator does with this page, and a modal has no
 * URL.
 *
 * Rendered as `<pre>`, not markdown. The fleet's transcript is a stream of
 * JSON frames, and this console holds cross-tenant data — re-introducing an
 * HTML-rendering path it does not need would undo one of the two mitigations
 * apps/web relies on for its localStorage session. See apps/admin/README.md.
 */
const POLL_MS = 5_000;
/** The fleet buffers 20k events per run; render the tail, which is what matters. */
const MAX_RENDERED = 1_000;

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const [params] = useSearchParams();
  const host = params.get('host') ?? '';

  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () => api.admin.fleet.run(host, runId),
    { intervalMs: POLL_MS, deps: [host, runId], enabled: Boolean(host && runId) }
  );

  const events = useEventCursor(host, runId, Boolean(host && runId));

  if (!host) {
    // The run list always links with ?host=. Landing here without it means a
    // hand-typed URL, so say what is missing rather than showing an empty page.
    return (
      <Page title={runId} backTo={ROUTES.fleetRuns} backLabel="Runs">
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          This URL needs a <code className="font-mono">?host=</code> — a run only exists on the
          fleet host that is running it. Open it from the Runs list instead.
        </div>
      </Page>
    );
  }

  const run = data?.run;

  return (
    <Page
      title={<CopyableId value={runId} />}
      subtitle={
        <span className="flex flex-wrap items-center gap-3 text-xs">
          <span>on {host}</span>
          {run?.status && <Pill tone={run.status === 'failed' ? 'critical' : 'muted'}>{run.status}</Pill>}
          {run?.phase && <Pill tone="muted">{run.phase}</Pill>}
          {run?.startedAt && <span title={absolute(run.startedAt)}>started {relativeAge(run.startedAt)} ago</span>}
        </span>
      }
      backTo={ROUTES.fleetRuns}
      backLabel="Runs"
      onRefresh={() => {
        refresh();
        events.refresh();
      }}
      refreshing={loading || events.loading}
    >
      {error && !run && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {run?.error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="font-medium">Run error: </span>
          {run.error}
        </div>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Transcript
          </h2>
          <span className="text-xs text-muted-foreground">
            {events.items.length} event{events.items.length === 1 ? '' : 's'}
            {events.truncated && ` · showing the last ${MAX_RENDERED}`}
            {events.terminal && ' · run finished'}
          </span>
        </div>

        {events.error && !events.items.length ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {events.error}
          </div>
        ) : events.items.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            {initialLoading || events.loading
              ? 'Loading transcript…'
              : 'No events yet. The guest has not sent anything on the vsock.'}
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-card">
            {events.items.map((event) => (
              <EventRow key={event.seq} event={event} />
            ))}
          </div>
        )}
      </section>
    </Page>
  );
}

function EventRow({ event }: { event: AdminRunEvent }) {
  const [open, setOpen] = useState(false);
  const type = typeof event.event?.type === 'string' ? (event.event.type as string) : 'event';
  const summary = summarise(event.event);

  return (
    <div className="border-b border-border/60 last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-accent/40"
      >
        <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
          {event.seq}
        </span>
        <span
          className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground"
          title={absolute(event.at)}
        >
          {new Date(event.at).toLocaleTimeString()}
        </span>
        <span className="w-28 shrink-0 truncate text-xs font-medium">{type}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
      </button>
      {open && (
        // <pre>, not markdown — see the module docblock.
        <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-border/60 bg-muted/40 px-3 py-2 font-mono text-[11px]">
          {JSON.stringify(event.event, null, 2)}
        </pre>
      )}
    </div>
  );
}

function summarise(event: Record<string, unknown>): string {
  for (const key of ['text', 'message', 'summary', 'subtype', 'name', 'command']) {
    const value = event[key];
    if (typeof value === 'string' && value.trim()) return value.slice(0, 300);
  }
  return Object.keys(event).join(', ');
}

/**
 * Cursor-based transcript accumulation.
 *
 * Polls `?after=<cursor>` and appends, rather than refetching the whole
 * transcript each tick — a run can buffer 20k events, and re-shipping them
 * every five seconds would be pointless egress for data the browser already
 * has. Stops polling once the run is terminal.
 *
 * The live SSE stream lands with the mutation work; this is the fallback it
 * will fall back TO, so it has to work on its own first.
 */
function useEventCursor(host: string, runId: string, enabled: boolean) {
  const [items, setItems] = useState<AdminRunEvent[]>([]);
  const [terminal, setTerminal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const cursorRef = useRef(0);

  // A different run must not inherit the previous one's events or cursor.
  useEffect(() => {
    cursorRef.current = 0;
    setItems([]);
    setTerminal(false);
    setError(null);
  }, [host, runId]);

  useEffect(() => {
    if (!enabled || terminal) return;
    let cancelled = false;

    async function pull() {
      setLoading(true);
      try {
        const page = await api.admin.fleet.events(host, runId, { after: cursorRef.current });
        if (cancelled) return;
        if (page.events?.length) {
          cursorRef.current = page.cursor;
          setItems((prev) => {
            const next = [...prev, ...page.events];
            return next.length > MAX_RENDERED ? next.slice(next.length - MAX_RENDERED) : next;
          });
        } else if (typeof page.cursor === 'number') {
          cursorRef.current = page.cursor;
        }
        setTerminal(Boolean(page.terminal));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void pull();
    return () => {
      cancelled = true;
    };
  }, [host, runId, enabled, terminal, tick]);

  useEffect(() => {
    if (!enabled || terminal) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, terminal]);

  const truncated = useMemo(() => items.length >= MAX_RENDERED, [items.length]);

  return {
    items,
    terminal,
    error,
    loading,
    truncated,
    refresh: () => setTick((n) => n + 1),
  };
}
