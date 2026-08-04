import { Link } from 'react-router-dom';
import type { AdminIncident } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { StatCard } from '../../components/ui/StatCard';
import { absolute, relativeAge } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';

/**
 * What the fleet is unhappy about.
 *
 * Spec §17.2 wants queue depth and admission rejections because they are "the
 * signal that says buy another box". These are DERIVED from the counters hosts
 * already push — there is no incidents table, deliberately, because a second
 * store can disagree with the host it describes.
 *
 * The consequence to keep visible: these are CUMULATIVE SINCE EACH HOST'S LAST
 * fleetd START, not a rate. "12 admission rejections" means twelve since that
 * process booted, which could be this morning or three weeks ago. The page
 * says so rather than letting an operator read a big number as an emergency.
 */
const POLL_MS = 15_000;

const KIND_LABELS: Record<AdminIncident['kind'], string> = {
  admission_rejection: 'Admission rejected',
  run_failure: 'Run failure',
  reaper_orphan: 'Reaper orphan',
  wedged_run: 'Wedged run',
  egress_denied: 'Egress denied',
  golden_stale: 'Stale golden',
  rebake_failure: 'Rebake failed',
  host_offline: 'Host offline',
  host_draining: 'Host draining',
};

/** Why each kind matters, in the words an operator needs to decide what to do. */
const KIND_HINTS: Partial<Record<AdminIncident['kind'], string>> = {
  admission_rejection: 'The fleet turned work away. Sustained, this is the buy-another-box signal.',
  reaper_orphan: 'A namespace, chroot or VMM with no owning run. These leak and compound.',
  wedged_run: 'A run went silent on the vsock and was cancelled.',
  egress_denied: 'A guest tried to reach something outside the egress allowlist.',
  golden_stale: 'Baked on a superseded base, so runs on that repo fall back to cloning.',
  host_offline: 'Stopped reporting. Its counters below are from its last snapshot.',
};

export function IncidentsPage() {
  const { data, error, loading, initialLoading, refresh } = useAdminQuery<AdminIncident[]>(
    () => api.admin.fleet.incidents(),
    { intervalMs: POLL_MS }
  );

  const incidents = data ?? [];
  const critical = incidents.filter((i) => i.severity === 'critical').length;
  const warn = incidents.filter((i) => i.severity === 'warn').length;

  const columns: Column<AdminIncident>[] = [
    {
      key: 'severity',
      header: '',
      cell: (i) => <SeverityPill severity={i.severity} />,
      className: 'w-20',
    },
    {
      key: 'kind',
      header: 'Signal',
      cell: (i) => (
        <div>
          <div className="font-medium">{KIND_LABELS[i.kind] ?? i.kind}</div>
          {KIND_HINTS[i.kind] && (
            <div className="mt-0.5 text-xs text-muted-foreground">{KIND_HINTS[i.kind]}</div>
          )}
        </div>
      ),
    },
    {
      key: 'detail',
      header: 'Reason',
      cell: (i) => (i.detail ? <span className="font-mono text-xs">{i.detail}</span> : '—'),
    },
    {
      key: 'count',
      header: 'Count',
      cell: (i) => <span className="font-medium tabular-nums">{i.count}</span>,
    },
    {
      key: 'host',
      header: 'Host',
      cell: (i) =>
        i.host ? (
          <Link
            to={routeTo(ROUTES.fleetHost, { host: i.host })}
            className="underline-offset-2 hover:underline"
          >
            {i.host}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'observed',
      header: 'As of',
      cell: (i) => (
        <span className="tabular-nums" title={absolute(i.observedAt)}>
          {relativeAge(i.observedAt)}
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Incidents"
      subtitle="Derived from each host's own counters — no incident store"
      onRefresh={refresh}
      refreshing={loading}
    >
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Critical" value={`${critical}`} tone={critical > 0 ? 'critical' : 'good'} />
        <StatCard label="Warnings" value={`${warn}`} tone={warn > 0 ? 'warn' : 'good'} />
        <StatCard label="Signals" value={`${incidents.length}`} />
      </div>

      <div className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        Counts are cumulative since each host&apos;s last <code className="font-mono">fleetd</code>{' '}
        start, not a rate — a large number may be weeks old. The registry keeps one snapshot per
        host, not a time series.
      </div>

      <DataTable
        rows={data}
        columns={columns}
        rowKey={(i) => `${i.host ?? 'fleet'}:${i.kind}:${i.detail ?? ''}`}
        error={error}
        loading={loading}
        initialLoading={initialLoading}
        onRetry={refresh}
        emptyMessage="Nothing to report"
        emptyHint="Every host is online, accepting work, and has no failure counters set."
      />
    </Page>
  );
}

function SeverityPill({ severity }: { severity: AdminIncident['severity'] }) {
  if (severity === 'critical') return <Pill tone="critical">critical</Pill>;
  if (severity === 'warn') return <Pill tone="warn">warning</Pill>;
  return <Pill tone="muted">info</Pill>;
}
