import { useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { StatCard } from '../../components/ui/StatCard';
import { mib, pctLabel, relativeAge } from '../../lib/format';
import { hostState, memoryPct, slotsPct } from '../../lib/fleetView';
import { ROUTES } from '../../lib/routes';

/**
 * One host in detail.
 *
 * Renders even when the host is unreachable — that is the case an operator
 * opens this page FOR. The registry's stored snapshot is always shown; live
 * data is layered on when we can get it, and its absence is stated rather than
 * left as blank cells.
 */
const POLL_MS = 10_000;

export function HostDetailPage() {
  const { host = '' } = useParams();
  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () => api.admin.fleet.host(host),
    { intervalMs: POLL_MS, deps: [host], enabled: Boolean(host) }
  );

  if (initialLoading && !data) {
    return <Page title={host} backTo={ROUTES.fleetHosts} backLabel="Hosts">Loading…</Page>;
  }

  if (!data) {
    return (
      <Page title={host} backTo={ROUTES.fleetHosts} backLabel="Hosts" onRefresh={refresh}>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error ?? 'Host not found.'}
        </div>
      </Page>
    );
  }

  const state = hostState(data);
  const metrics = data.liveMetrics ?? data.metrics ?? null;

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          {data.name}
          <StatePill state={state} />
        </span>
      }
      subtitle={
        <span className="flex flex-wrap items-center gap-3 text-xs">
          <span>last report {relativeAge(data.reportedAt)} ago</span>
          <span title={data.apiEndpoint ?? undefined} className="font-mono">
            {data.apiEndpoint ?? 'no endpoint advertised'}
          </span>
          {data.version && <span className="font-mono">v{data.version}</span>}
        </span>
      }
      backTo={ROUTES.fleetHosts}
      backLabel="Hosts"
      onRefresh={refresh}
      refreshing={loading}
      actions={
        <Link
          to={`${ROUTES.fleetGoldens}?host=${encodeURIComponent(data.name)}`}
          className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
        >
          Goldens
        </Link>
      }
    >
      {/* Said plainly rather than implied by empty cells: the numbers below are
          the host's last self-report, not current truth. */}
      {data.liveError && (
        <div className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          Couldn&apos;t reach this host ({data.liveError}). Everything below is from its last
          report, {relativeAge(data.reportedAt)} ago.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Runs"
          value={`${data.live?.runsLive ?? data.runsLive} / ${(data.live?.runsMax ?? data.runsMax) || '?'}`}
          barPct={slotsPct(data)}
        />
        <StatCard
          label="Memory"
          value={mib(data.live?.memReservedMib ?? data.memReservedMib)}
          hint={`of ${mib(data.live?.memBudgetMib ?? data.memBudgetMib)} · ${pctLabel(
            data.memReservedMib,
            data.memBudgetMib
          )}`}
          barPct={memoryPct(data)}
        />
        <StatCard label="Disk free" value={mib(data.diskFreeMib)} />
        <StatCard
          label="Max idle"
          value={data.maxIdleSeconds > 0 ? `${Math.round(data.maxIdleSeconds)}s` : '—'}
          hint="oldest silence across in-flight runs"
          tone={data.maxIdleSeconds > 240 ? 'warn' : 'default'}
        />
      </div>

      {data.runsByStatus && (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Runs by status
          </h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(data.runsByStatus).map(([status, n]) => (
              <Link key={status} to={`${ROUTES.fleetRuns}?host=${encodeURIComponent(data.name)}&status=${status}`}>
                <Pill tone={status === 'running' ? 'good' : status === 'failed' ? 'critical' : 'muted'}>
                  {status} {n}
                </Pill>
              </Link>
            ))}
          </div>
        </section>
      )}

      {metrics && (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Metrics {data.liveMetrics ? '(live)' : '(last report)'}
          </h2>
          <MetricsGrid metrics={metrics} />
        </section>
      )}
    </Page>
  );
}

/**
 * The fleet's metrics snapshot, rendered generically.
 *
 * Deliberately not a hand-written list of known keys: the fleet ships on its
 * own cadence and adding a counter there must not need a release here. Scalars
 * become tiles; the `{reason: n}` maps become grouped rows.
 */
function MetricsGrid({ metrics }: { metrics: Record<string, unknown> }) {
  const scalars: Array<[string, number]> = [];
  const maps: Array<[string, Record<string, number>]> = [];

  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === 'number') scalars.push([key, value]);
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>).filter(
        ([, n]) => typeof n === 'number'
      ) as Array<[string, number]>;
      if (entries.length) maps.push([key, Object.fromEntries(entries)]);
    }
  }

  return (
    <div className="space-y-4">
      {scalars.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {scalars.map(([key, value]) => (
            <div key={key} className="rounded-md border border-border bg-card px-2.5 py-2">
              <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground" title={key}>
                {humanize(key)}
              </div>
              <div className="font-display text-sm font-semibold tabular-nums">
                {formatMetric(key, value)}
              </div>
            </div>
          ))}
        </div>
      )}
      {maps.map(([key, entries]) => (
        <div key={key}>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">{humanize(key)}</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(entries).map(([reason, n]) => (
              <Pill key={reason} tone={n > 0 ? 'warn' : 'muted'}>
                {reason} {n}
              </Pill>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function humanize(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function formatMetric(key: string, value: number): string {
  if (/Usd$/i.test(key)) return `$${value.toFixed(2)}`;
  if (/Seconds$/i.test(key)) return `${value.toFixed(1)}s`;
  return String(value);
}

function StatePill({ state }: { state: ReturnType<typeof hostState> }) {
  switch (state) {
    case 'offline':
      return <Pill tone="critical">offline</Pill>;
    case 'draining':
      return <Pill tone="warn">draining</Pill>;
    case 'full':
      return <Pill tone="warn">full</Pill>;
    default:
      return <Pill tone="good">ready</Pill>;
  }
}
