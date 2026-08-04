import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { StatCard } from '../../components/ui/StatCard';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, relativeAge } from '../../lib/format';
import { ROUTES } from '../../lib/routes';

/**
 * One workspace.
 *
 * `providers` lists the integration TYPES configured, never their config —
 * that column holds encrypted credentials, and knowing a provider is set up is
 * the operator's whole question. Knowing its secret never is.
 */
export function WorkspaceDetailPage() {
  const { workspaceId = '' } = useParams();
  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () => api.admin.workspaces.get(workspaceId),
    { deps: [workspaceId], enabled: Boolean(workspaceId) }
  );

  if (!data) {
    return (
      <Page title="Workspace" backTo={ROUTES.workspaces} backLabel="Workspaces" onRefresh={refresh}>
        {initialLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error ?? 'Workspace not found.'}
          </div>
        )}
      </Page>
    );
  }

  return (
    <Page
      title={data.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-3 text-xs">
          <CopyableId value={data.id} />
          {data.ownerEmail && (
            <Link
              to={`${ROUTES.users}?q=${encodeURIComponent(data.ownerEmail)}`}
              className="underline-offset-2 hover:underline"
            >
              {data.ownerEmail}
            </Link>
          )}
          <span title={absolute(data.createdAt)}>created {relativeAge(data.createdAt)} ago</span>
        </span>
      }
      backTo={ROUTES.workspaces}
      backLabel="Workspaces"
      onRefresh={refresh}
      refreshing={loading}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Repositories" value={`${data.repositoryCount}`} />
        <StatCard label="Tasks" value={`${data.taskCount}`} />
        <StatCard label="Active tasks" value={`${data.activeTaskCount}`} />
        <StatCard label="Providers" value={`${data.providers.length}`} />
      </div>

      {data.description && (
        <p className="mt-4 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
          {data.description}
        </p>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Integrations
        </h2>
        {data.providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">None configured.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {data.providers.map((p) => (
              <Pill key={p} tone="muted">
                {p}
              </Pill>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6">
        <Link
          to={`${ROUTES.tasks}?workspaceId=${encodeURIComponent(data.id)}`}
          className="text-sm underline-offset-2 hover:underline"
        >
          View this workspace&apos;s tasks →
        </Link>
      </section>
    </Page>
  );
}
