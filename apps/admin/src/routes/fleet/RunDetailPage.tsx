import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { AdminRunEvent } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, duration, relativeAge } from '../../lib/format';
import { durationSeconds, idlePct, idleSeconds, isTerminal, looksWedged } from '../../lib/fleetView';
import { ROUTES } from '../../lib/routes';
import { Transcript, type TranscriptMode } from '../../components/fleet/Transcript';

/**
 * One run's transcript.
 *
 * A route rather than a modal because pasting a run id into Slack is the
 * single most common thing an operator does with this page, and a modal has no
 * URL.
 *
 * Two views of the same stream: readable blocks by default, raw frames on
 * demand, and the raw JSON of any single block one click away. Both render as
 * TEXT — this console holds cross-tenant data, and an HTML-rendering path it
 * does not need would undo one of the two mitigations apps/web relies on for
 * its localStorage session. See apps/admin/README.md and Transcript.tsx.
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
  const [mode, setMode] = useState<TranscriptMode>('readable');

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
          {run && durationSeconds(run) != null && (
            <span
              title={
                isTerminal(run.status)
                  ? `${absolute(run.startedAt ?? run.createdAt)} → ${absolute(run.endedAt)}`
                  : 'Still running'
              }
            >
              took {duration(durationSeconds(run))}
              {!isTerminal(run.status) && '…'}
            </span>
          )}
          {run && idleSeconds(run) != null && (
            <span
              className={looksWedged(run) ? 'font-medium text-destructive' : undefined}
              title={
                isTerminal(run.status)
                  ? 'Silent on the vsock for this long before the run ended'
                  : 'Time since the last vsock frame of any kind'
              }
            >
              {duration(idleSeconds(run))} idle
              {idlePct(run) != null && ` (${idlePct(run)}%)`}
            </span>
          )}
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
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {events.items.length} event{events.items.length === 1 ? '' : 's'}
              {events.truncated && ` · showing the last ${MAX_RENDERED}`}
              {events.terminal && ' · run finished'}
            </span>
            <div className="flex rounded-md border border-border text-xs">
              {(['readable', 'raw'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={
                    m === mode
                      ? 'bg-accent px-2 py-0.5 font-medium'
                      : 'px-2 py-0.5 text-muted-foreground hover:text-foreground'
                  }
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
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
          <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-card">
            <Transcript events={events.items} mode={mode} />
          </div>
        )}
      </section>
    </Page>
  );
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
