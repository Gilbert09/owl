import { useNavigate } from 'react-router-dom';
import type { AdminFleetHost } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { StatCard } from '../../components/ui/StatCard';
import { mib, pctLabel, relativeAge, absolute } from '../../lib/format';
import { hostState, memoryPct, slotsPct } from '../../lib/fleetView';
import { ROUTES, routeTo } from '../../lib/routes';

/**
 * The fleet's front page.
 *
 * Two reads, deliberately staged: the registry list paints immediately (it
 * dials nothing), then the same endpoint with `?live=1` enriches it. A page
 * that waits on N tailnet round trips before showing anything is unusable
 * during the incident it was opened for — and the registry row already carries
 * the host's last self-report, which is the thing you actually want when a box
 * has gone quiet.
 */
const POLL_MS = 10_000;

export function HostsPage() {
  const navigate = useNavigate();

  const { data, error, loading, initialLoading, refresh } = useAdminQuery<AdminFleetHost[]>(
    () => api.admin.fleet.hosts({ live: true }),
    { intervalMs: POLL_MS }
  );

  const hosts = data ?? [];
  const online = hosts.filter((h) => h.online);
  const offline = hosts.length - online.length;
  const draining = online.filter((h) => h.draining).length;
  const runsLive = online.reduce((n, h) => n + h.runsLive, 0);
  const runsMax = online.reduce((n, h) => n + h.runsMax, 0);
  const memReserved = online.reduce((n, h) => n + h.memReservedMib, 0);
  const memBudget = online.reduce((n, h) => n + h.memBudgetMib, 0);

  const columns: Column<AdminFleetHost>[] = [
    {
      key: 'name',
      header: 'Host',
      cell: (h) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{h.name}</span>
          <StatePill host={h} />
        </div>
      ),
    },
    {
      key: 'slots',
      header: 'Runs',
      cell: (h) => (
        <span className="tabular-nums">
          {h.runsLive}
          <span className="text-muted-foreground"> / {h.runsMax || '?'}</span>
        </span>
      ),
    },
    {
      key: 'mem',
      header: 'Memory',
      cell: (h) => (
        <span className="tabular-nums" title={`${h.memReservedMib} / ${h.memBudgetMib} MiB`}>
          {mib(h.memReservedMib)}
          <span className="text-muted-foreground"> / {mib(h.memBudgetMib)}</span>
        </span>
      ),
    },
    { key: 'disk', header: 'Disk free', cell: (h) => <span className="tabular-nums">{mib(h.diskFreeMib)}</span> },
    {
      key: 'idle',
      header: 'Max idle',
      cell: (h) => (
        // The oldest silence across in-flight runs — the number that says
        // "something may be stuck" before the reaper acts on it.
        <span className="tabular-nums">
          {h.maxIdleSeconds > 0 ? `${Math.round(h.maxIdleSeconds)}s` : '—'}
        </span>
      ),
    },
    {
      key: 'seen',
      header: 'Last report',
      cell: (h) => (
        <span className="tabular-nums" title={absolute(h.reportedAt)}>
          {relativeAge(h.reportedAt)}
        </span>
      ),
    },
    {
      key: 'version',
      header: 'Version',
      cell: (h) => <span className="font-mono text-xs">{h.version ?? '—'}</span>,
    },
    {
      key: 'live',
      header: 'Live',
      cell: (h) =>
        h.live ? (
          <Pill tone={h.live.accepting ? 'good' : 'warn'}>
            {h.live.accepting ? 'accepting' : 'not accepting'}
          </Pill>
        ) : (
          // The degradation contract, made visible: we could not reach the
          // box, and saying which is more useful than an empty cell.
          <Pill tone="critical" title={h.liveError ?? undefined}>
            unreachable
          </Pill>
        ),
    },
  ];

  return (
    <Page
      title="Hosts"
      subtitle={`${hosts.length} registered · ${online.length} online`}
      onRefresh={refresh}
      refreshing={loading}
    >
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Online"
          value={`${online.length}`}
          tone={offline > 0 ? 'warn' : 'good'}
          hint={offline > 0 ? `${offline} not reporting` : 'all reporting'}
        />
        <StatCard label="Draining" value={`${draining}`} tone={draining > 0 ? 'warn' : 'default'} />
        <StatCard
          label="Runs in flight"
          value={`${runsLive}`}
          hint={runsMax > 0 ? `of ${runsMax} slots` : undefined}
          barPct={slotsPct({ runsLive, runsMax } as AdminFleetHost)}
        />
        <StatCard
          label="Memory reserved"
          value={mib(memReserved)}
          hint={memBudget > 0 ? `of ${mib(memBudget)} · ${pctLabel(memReserved, memBudget)}` : undefined}
          barPct={memoryPct({ memReservedMib: memReserved, memBudgetMib: memBudget } as AdminFleetHost)}
        />
      </div>

      <DataTable
        rows={data}
        columns={columns}
        rowKey={(h) => h.name}
        error={error}
        loading={loading}
        initialLoading={initialLoading}
        onRetry={refresh}
        emptyMessage="No fleet hosts have reported in"
        emptyHint="A host appears here once fleetd posts its first snapshot — check FLEET_REPORT_URL and FLEET_REPORT_TOKEN on the box."
        onRowClick={(h) => navigate(routeTo(ROUTES.fleetHost, { host: h.name }))}
        rowClassName={(h) => (h.online ? undefined : 'opacity-60')}
      />
    </Page>
  );
}

function StatePill({ host }: { host: AdminFleetHost }) {
  const state = hostState(host);
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
