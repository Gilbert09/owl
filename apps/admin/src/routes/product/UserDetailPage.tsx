import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { StatCard } from '../../components/ui/StatCard';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, relativeAge } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';

/**
 * One account.
 *
 * This is where the Polar ids live — deliberately not in the list. An operator
 * on this page is chasing a specific billing problem, which is the one context
 * where a customer id is the thing that resolves it rather than a liability
 * sitting in a screenshot of a table.
 */
export function UserDetailPage() {
  const { userId = '' } = useParams();
  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () => api.admin.users.get(userId),
    { deps: [userId], enabled: Boolean(userId) }
  );

  if (!data) {
    return (
      <Page title="User" backTo={ROUTES.users} backLabel="Users" onRefresh={refresh}>
        {initialLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error ?? 'User not found.'}
          </div>
        )}
      </Page>
    );
  }

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          {data.email}
          {data.isAdmin && <Pill tone="warn">operator</Pill>}
        </span>
      }
      subtitle={
        <span className="flex flex-wrap items-center gap-3 text-xs">
          <CopyableId value={data.id} />
          {data.githubUsername && <span className="font-mono">@{data.githubUsername}</span>}
          <span title={absolute(data.createdAt)}>joined {relativeAge(data.createdAt)} ago</span>
        </span>
      }
      backTo={ROUTES.users}
      backLabel="Users"
      onRefresh={refresh}
      refreshing={loading}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Effective plan"
          value={data.effectivePlan}
          tone={data.effectivePlan === 'unlimited' ? 'good' : 'default'}
          hint={
            data.planOverride
              ? `comped — subscription says "${data.plan}"`
              : 'from the subscription'
          }
        />
        <StatCard label="Workspaces" value={`${data.workspaceCount}`} />
        <StatCard
          label="Active tasks"
          value={`${data.activeTaskCount}`}
          hint="pending, queued or in progress"
        />
        <StatCard
          label="Subscription"
          value={data.subscriptionStatus ?? '—'}
          tone={data.cancelAtPeriodEnd ? 'warn' : 'default'}
          hint={
            data.currentPeriodEnd
              ? `${data.cancelAtPeriodEnd ? 'ends' : 'renews'} ${absolute(data.currentPeriodEnd)}`
              : undefined
          }
        />
      </div>

      <section className="mt-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Billing
        </h2>
        <dl className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-card p-3 text-sm sm:grid-cols-2">
          <Field label="plan (Polar-written)" value={data.plan} />
          <Field label="plan_override (manual comp)" value={data.planOverride ?? '—'} />
          <Field label="Polar customer" value={data.polarCustomerId} copyable />
          <Field label="Polar subscription" value={data.polarSubscriptionId} copyable />
          <Field
            label="Last subscription event"
            value={data.subscriptionEventAt ? absolute(data.subscriptionEventAt) : '—'}
          />
          <Field label="Updated" value={absolute(data.updatedAt)} />
        </dl>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Workspaces
        </h2>
        {data.workspaces.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
            No workspaces.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {data.workspaces.map((ws) => (
              <li key={ws.id}>
                <Link
                  to={routeTo(ROUTES.workspace, { workspaceId: ws.id })}
                  className="flex items-center justify-between px-3 py-2 hover:bg-accent/40"
                >
                  <span className="truncate text-sm font-medium">{ws.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    created {relativeAge(ws.createdAt)} ago
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <Link
          to={`${ROUTES.tasks}?ownerId=${encodeURIComponent(data.id)}`}
          className="text-sm underline-offset-2 hover:underline"
        >
          View this account&apos;s tasks →
        </Link>
      </section>
    </Page>
  );
}

function Field({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string | null;
  copyable?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">
        {copyable ? (
          <CopyableId value={value} />
        ) : (
          <span className="font-mono text-xs">{value ?? '—'}</span>
        )}
      </dd>
    </div>
  );
}
