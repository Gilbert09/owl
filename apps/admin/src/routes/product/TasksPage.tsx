import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AdminTaskSummary } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { absolute, relativeAge, usd } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';

/**
 * Task history, across every tenant.
 *
 * The provider/host/phase columns come from the SQL extraction in
 * services/admin/queries.ts, not from shipping each row's metadata blob — this
 * is the one list in the codebase that reads every tenant's rows at once.
 */
const STATUSES = ['pending', 'queued', 'in_progress', 'completed', 'failed', 'cancelled'] as const;

export function TasksPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const provider = params.get('provider') ?? '';
  const workspaceId = params.get('workspaceId') ?? '';
  const ownerId = params.get('ownerId') ?? '';
  const host = params.get('host') ?? '';

  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () =>
      api.admin.tasks.list({
        status: status || undefined,
        provider: provider || undefined,
        workspaceId: workspaceId || undefined,
        ownerId: ownerId || undefined,
        host: host || undefined,
      }),
    { deps: [status, provider, workspaceId, ownerId, host] }
  );

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const scoped = Boolean(workspaceId || ownerId || host);

  const columns: Column<AdminTaskSummary>[] = [
    {
      key: 'title',
      header: 'Task',
      cell: (t) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{t.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {t.workspaceName ?? t.workspaceId}
            {t.ownerEmail ? ` · ${t.ownerEmail}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'type', header: 'Type', cell: (t) => <span className="text-xs">{t.type}</span> },
    { key: 'status', header: 'Status', cell: (t) => <StatusPill status={t.status} /> },
    {
      key: 'provider',
      header: 'Provider',
      cell: (t) => (t.provider ? <Pill tone="muted">{t.provider}</Pill> : '—'),
    },
    {
      key: 'host',
      header: 'Host',
      cell: (t) => <span className="text-xs">{t.fleetHost ?? '—'}</span>,
    },
    { key: 'phase', header: 'Phase', cell: (t) => <span className="text-xs">{t.phase ?? '—'}</span> },
    { key: 'cost', header: 'Cost', cell: (t) => <span className="tabular-nums">{usd(t.costUsd)}</span> },
    {
      key: 'created',
      header: 'Created',
      cell: (t) => (
        <span className="tabular-nums" title={absolute(t.createdAt)}>
          {relativeAge(t.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Tasks"
      subtitle={`${data?.items.length ?? 0} shown${data?.nextCursor ? ' (more available)' : ''}`}
      onRefresh={refresh}
      refreshing={loading}
      actions={
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => setParam('status', e.target.value)}
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
          <input
            value={provider}
            onChange={(e) => setParam('provider', e.target.value)}
            placeholder="provider"
            aria-label="Filter by provider"
            className="w-28 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
        </div>
      }
    >
      {scoped && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
          <span className="text-muted-foreground">Scoped to</span>
          {workspaceId && <Pill tone="muted">workspace {workspaceId}</Pill>}
          {ownerId && <Pill tone="muted">owner {ownerId}</Pill>}
          {host && <Pill tone="muted">host {host}</Pill>}
          <button
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete('workspaceId');
              next.delete('ownerId');
              next.delete('host');
              setParams(next, { replace: true });
            }}
            className="ml-auto underline hover:no-underline"
          >
            Clear scope
          </button>
        </div>
      )}

      <DataTable
        rows={data?.items ?? null}
        columns={columns}
        rowKey={(t) => t.id}
        error={error}
        loading={loading}
        initialLoading={initialLoading}
        onRetry={refresh}
        emptyMessage={status || provider || scoped ? 'No tasks match' : 'No tasks yet'}
        onRowClick={(t) => navigate(routeTo(ROUTES.task, { taskId: t.id }))}
      />
    </Page>
  );
}

function StatusPill({ status }: { status: string }) {
  switch (status) {
    case 'in_progress':
      return <Pill tone="good">in progress</Pill>;
    case 'queued':
    case 'pending':
      return <Pill tone="muted">{status}</Pill>;
    case 'failed':
      return <Pill tone="critical">failed</Pill>;
    case 'cancelled':
      return <Pill tone="warn">cancelled</Pill>;
    default:
      return <Pill tone="muted">{status}</Pill>;
  }
}
