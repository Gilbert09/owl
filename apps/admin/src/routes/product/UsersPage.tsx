import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AdminUserSummary } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { StatCard } from '../../components/ui/StatCard';
import { absolute, relativeAge } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';

/**
 * Every account, across every tenant.
 *
 * Search and filters live in the URL for the same reason the fleet ones do:
 * "the comped accounts" should be a link, not a sequence of clicks to
 * reproduce.
 *
 * `plan` and `effectivePlan` are both shown when they disagree, because that
 * disagreement IS the comp — an account on `free` that behaves as unlimited is
 * exactly what an operator is looking for when auditing who has been given
 * what.
 */
export function UsersPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const plan = params.get('plan') ?? '';
  const adminOnly = params.get('admin') === 'true';

  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () =>
      api.admin.users.list({
        q: q || undefined,
        plan: plan || undefined,
        admin: adminOnly || undefined,
      }),
    { deps: [q, plan, adminOnly] }
  );

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const users = data?.items ?? [];
  const unlimited = users.filter((u) => u.effectivePlan === 'unlimited').length;
  const comped = users.filter((u) => u.planOverride === 'unlimited').length;
  const admins = users.filter((u) => u.isAdmin).length;

  const columns: Column<AdminUserSummary>[] = [
    {
      key: 'email',
      header: 'Email',
      cell: (u) => (
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{u.email}</span>
          {u.isAdmin && <Pill tone="warn">admin</Pill>}
        </div>
      ),
    },
    {
      key: 'github',
      header: 'GitHub',
      cell: (u) => <span className="font-mono text-xs">{u.githubUsername ?? '—'}</span>,
    },
    {
      key: 'plan',
      header: 'Plan',
      cell: (u) => (
        <div className="flex items-center gap-1.5">
          <Pill tone={u.effectivePlan === 'unlimited' ? 'good' : 'muted'}>{u.effectivePlan}</Pill>
          {u.planOverride && (
            <Pill tone="warn" title={`Manual override; the subscription column says "${u.plan}"`}>
              comped
            </Pill>
          )}
        </div>
      ),
    },
    {
      key: 'sub',
      header: 'Subscription',
      cell: (u) => (
        <span className="text-xs">
          {u.subscriptionStatus ?? '—'}
          {u.cancelAtPeriodEnd && <span className="ml-1 text-amber-600">(cancelling)</span>}
        </span>
      ),
    },
    {
      key: 'workspaces',
      header: 'Workspaces',
      cell: (u) => <span className="tabular-nums">{u.workspaceCount}</span>,
    },
    {
      key: 'created',
      header: 'Joined',
      cell: (u) => (
        <span className="tabular-nums" title={absolute(u.createdAt)}>
          {relativeAge(u.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Users"
      subtitle={`${users.length} shown${data?.nextCursor ? ' (more available)' : ''}`}
      onRefresh={refresh}
      refreshing={loading}
      actions={
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setParam('q', e.target.value)}
            placeholder="search email"
            aria-label="Search users"
            className="w-40 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
          <select
            value={plan}
            onChange={(e) => setParam('plan', e.target.value)}
            aria-label="Filter by plan"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">All plans</option>
            <option value="free">Free</option>
            <option value="unlimited">Unlimited</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={adminOnly}
              onChange={(e) => setParam('admin', e.target.checked ? 'true' : '')}
            />
            Admins
          </label>
        </div>
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Shown" value={`${users.length}`} />
        <StatCard label="Unlimited" value={`${unlimited}`} />
        <StatCard label="Comped" value={`${comped}`} hint="manual plan_override" />
        <StatCard label="Operators" value={`${admins}`} tone={admins > 1 ? 'warn' : 'default'} />
      </div>

      <DataTable
        rows={data?.items ?? null}
        columns={columns}
        rowKey={(u) => u.id}
        error={error}
        loading={loading}
        initialLoading={initialLoading}
        onRetry={refresh}
        emptyMessage={q || plan || adminOnly ? 'No users match' : 'No users yet'}
        emptyHint={
          q && q.length < 2 ? 'Search needs at least two characters.' : 'Clear the filters to see everything.'
        }
        onRowClick={(u) => navigate(routeTo(ROUTES.user, { userId: u.id }))}
      />
    </Page>
  );
}
