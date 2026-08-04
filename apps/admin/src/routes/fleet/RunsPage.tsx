import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AdminRunRow } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, countdown, relativeAge, usd } from '../../lib/format';
import { idleSeconds, isTerminal, looksWedged, sortRuns } from '../../lib/fleetView';
import { ROUTES, routeTo } from '../../lib/routes';
import { useAdminMutation } from '../../hooks/useAdminMutation';
import { ConfirmMutationDialog } from '../../components/admin/ConfirmMutationDialog';
import { useCapability } from '../../components/auth/AdminGate';

/**
 * Every run the fleet is or was running.
 *
 * Filter state lives in the URL (`useSearchParams`), not component state, so a
 * filtered view is a link an operator can paste into Slack. That is the same
 * reason drill-ins are routes rather than modals.
 *
 * Rows are in time order, newest first, orphans included. They used to be
 * ranked — orphans hoisted to the top — which sounds right and read terribly:
 * a run that started 58 seconds ago sorted BELOW four deploy self-tests from an
 * hour ago, so the row an operator opened the page to find was the one they had
 * to hunt for. Orphans keep a tinted row and a count in the header, which is
 * what makes them findable without reordering the list around them.
 */
const POLL_MS = 8_000;

const STATUSES = ['running', 'queued', 'completed', 'failed', 'cancelled'] as const;

export function RunsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const host = params.get('host') ?? '';
  const status = params.get('status') ?? '';

  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () => api.admin.fleet.runs({ host: host || undefined, status: status || undefined }),
    { intervalMs: POLL_MS, deps: [host, status] }
  );

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const canMutate = useCapability('fleet.mutate');
  const cancel = useAdminMutation<AdminRunRow>(refresh);

  const rows = data ? sortRuns(data.items) : null;
  // Self-tests are orphans by the strict definition — no task row behind them —
  // but they are exactly what is supposed to happen after a fleet deploy.
  // Counting them made the header read "4 orphaned" after four merges, which is
  // how a warning stops being read.
  const orphans = rows?.filter((r) => r.orphan && !r.selfTest).length ?? 0;
  const wedged = rows?.filter((r) => looksWedged(r)).length ?? 0;

  const columns: Column<AdminRunRow>[] = [
    {
      key: 'run',
      header: 'Run',
      cell: (r) => (
        <div className="flex items-center gap-2">
          <CopyableId value={r.runId} />
          {r.orphan &&
            (r.selfTest ? (
              <Pill
                tone="muted"
                title="A guest self-test fired by the fleet's deploy script, not a Talyn task"
              >
                self-test
              </Pill>
            ) : (
              <Pill tone="critical" title="Live on a host with no task behind it">
                orphan
              </Pill>
            ))}
          {r.adopted && (
            <Pill tone="muted" title="Re-attached after a fleetd restart">
              adopted
            </Pill>
          )}
        </div>
      ),
    },
    { key: 'host', header: 'Host', cell: (r) => r.host ?? <Muted /> },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <StatusPill run={r} />,
    },
    { key: 'phase', header: 'Phase', cell: (r) => r.phase ?? <Muted /> },
    {
      key: 'idle',
      header: 'Idle',
      cell: (r) => {
        const idle = idleSeconds(r);
        if (idle == null) return <Muted />;
        return (
          <span
            className={looksWedged(r) ? 'font-medium text-destructive tabular-nums' : 'tabular-nums'}
            title="Time since the last vsock frame of any kind"
          >
            {idle}s
          </span>
        );
      },
    },
    {
      key: 'deadline',
      header: 'Deadline',
      cell: (r) => (
        <span className="tabular-nums" title={absolute(r.deadline)}>
          {countdown(r.deadline)}
        </span>
      ),
    },
    { key: 'cost', header: 'Cost', cell: (r) => <span className="tabular-nums">{usd(r.costUsd)}</span> },
    {
      key: 'owner',
      header: 'Owner',
      cell: (r) => <span className="truncate text-xs">{r.ownerEmail ?? <Muted />}</span>,
    },
    ...(canMutate
      ? [
          {
            key: 'actions',
            header: '',
            cell: (r: AdminRunRow) =>
              r.host && !isTerminal(r.status) ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    cancel.start(r, ({ reason }) =>
                      api.admin.fleet.cancelRun(r.host!, r.runId, { reason })
                    );
                  }}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                >
                  Cancel
                </button>
              ) : null,
          } satisfies Column<AdminRunRow>,
        ]
      : []),
    {
      key: 'age',
      header: 'Started',
      cell: (r) => (
        <span className="tabular-nums" title={absolute(r.startedAt ?? r.createdAt)}>
          {relativeAge(r.startedAt ?? r.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Runs"
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span>{rows?.length ?? 0} shown</span>
          {orphans > 0 && <Pill tone="critical">{orphans} orphaned</Pill>}
          {wedged > 0 && <Pill tone="warn">{wedged} possibly wedged</Pill>}
        </span>
      }
      onRefresh={refresh}
      refreshing={loading}
      actions={
        <div className="flex items-center gap-2">
          <input
            value={host}
            onChange={(e) => setFilter('host', e.target.value)}
            placeholder="host"
            aria-label="Filter by host"
            className="w-28 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
          <select
            value={status}
            onChange={(e) => setFilter('status', e.target.value)}
            aria-label="Filter by status"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {/* Hosts we could not reach. Without this the list silently under-reports
          and an operator reads "no runs" as "the fleet is idle". */}
      {data?.degraded?.length ? (
        <div className="mb-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          Couldn&apos;t reach {data.degraded.map((d) => d.host).join(', ')} — live run state for
          {data.degraded.length > 1 ? ' those hosts' : ' that host'} is missing from this list.
        </div>
      ) : null}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.runId}
        error={error}
        loading={loading}
        initialLoading={initialLoading}
        onRetry={refresh}
        emptyMessage={host || status ? 'No runs match these filters' : 'No fleet runs yet'}
        emptyHint={
          host || status
            ? 'Clear the filters to see everything.'
            : 'Runs appear here once a task is dispatched to the self-hosted fleet.'
        }
        onRowClick={(r) => navigate(routeTo(ROUTES.fleetRun, { runId: r.runId }) + hostQuery(r))}
        rowClassName={(r) => (r.orphan && !r.selfTest ? 'bg-destructive/5' : undefined)}
      />

      <ConfirmMutationDialog
        open={Boolean(cancel.pending)}
        onClose={cancel.close}
        title="Cancel this run?"
        description={
          <>
            The microVM running <strong>{cancel.pending?.target.runId}</strong> on{' '}
            <strong>{cancel.pending?.target.host}</strong> will be torn down. Any work it has not
            already pushed is lost.
            {cancel.pending?.target.ownerEmail && (
              <> This belongs to {cancel.pending.target.ownerEmail}.</>
            )}
          </>
        }
        actionLabel="Cancel run"
        confirmText={cancel.pending?.target.runId}
        confirmLabel="the run id"
        destructive
        analyticsAction="fleet.run.cancel"
        analyticsTargetType="run"
        onConfirm={async (input) => {
          await cancel.pending!.run(input);
          cancel.succeeded('Run cancelled');
        }}
      />
    </Page>
  );
}

/** The detail page needs the host to know which fleetd to ask. */
function hostQuery(run: AdminRunRow): string {
  return run.host ? `?host=${encodeURIComponent(run.host)}` : '';
}

function StatusPill({ run }: { run: AdminRunRow }) {
  if (looksWedged(run)) return <Pill tone="critical">wedged?</Pill>;
  switch (run.status) {
    case 'running':
      // Blue, not green: green is the "this finished and it was fine" colour,
      // and a run still in flight has not earned it. It also makes the one row
      // an operator can still act on scannable in a list of finished ones.
      return <Pill tone="info">running</Pill>;
    case 'queued':
      return <Pill tone="muted">queued</Pill>;
    case 'completed':
      return <Pill tone="good">completed</Pill>;
    case 'failed':
      return <Pill tone="critical">failed</Pill>;
    case 'cancelled':
      return <Pill tone="warn">cancelled</Pill>;
    default:
      return <Pill tone="muted">unknown</Pill>;
  }
}

function Muted() {
  return <span className="text-muted-foreground">—</span>;
}
