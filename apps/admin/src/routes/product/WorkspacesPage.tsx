import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AdminWorkspaceSummary } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, relativeAge } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';

/** Every workspace, across every tenant, with its owner. */
export function WorkspacesPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const ownerId = params.get('ownerId') ?? '';

  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () => api.admin.workspaces.list({ q: q || undefined, ownerId: ownerId || undefined }),
    { deps: [q, ownerId] }
  );

  const columns: Column<AdminWorkspaceSummary>[] = [
    { key: 'name', header: 'Workspace', cell: (w) => <span className="font-medium">{w.name}</span> },
    {
      key: 'owner',
      header: 'Owner',
      cell: (w) => <span className="truncate text-xs">{w.ownerEmail ?? '—'}</span>,
    },
    { key: 'id', header: 'ID', cell: (w) => <CopyableId value={w.id} /> },
    {
      key: 'created',
      header: 'Created',
      cell: (w) => (
        <span className="tabular-nums" title={absolute(w.createdAt)}>
          {relativeAge(w.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Workspaces"
      subtitle={`${data?.items.length ?? 0} shown${data?.nextCursor ? ' (more available)' : ''}`}
      onRefresh={refresh}
      refreshing={loading}
      actions={
        <input
          value={q}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set('q', e.target.value);
            else next.delete('q');
            setParams(next, { replace: true });
          }}
          placeholder="search name"
          aria-label="Search workspaces"
          className="w-44 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
        />
      }
    >
      {ownerId && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
          <span className="text-muted-foreground">Filtered to one owner.</span>
          <button
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete('ownerId');
              setParams(next, { replace: true });
            }}
            className="underline hover:no-underline"
          >
            Clear
          </button>
        </div>
      )}

      <DataTable
        rows={data?.items ?? null}
        columns={columns}
        rowKey={(w) => w.id}
        error={error}
        loading={loading}
        initialLoading={initialLoading}
        onRetry={refresh}
        emptyMessage={q || ownerId ? 'No workspaces match' : 'No workspaces yet'}
        onRowClick={(w) => navigate(routeTo(ROUTES.workspace, { workspaceId: w.id }))}
      />
    </Page>
  );
}
