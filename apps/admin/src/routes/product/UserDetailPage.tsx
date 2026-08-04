import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { StatCard } from '../../components/ui/StatCard';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, relativeAge } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';
import { useAdminMutation } from '../../hooks/useAdminMutation';
import { ConfirmMutationDialog } from '../../components/admin/ConfirmMutationDialog';
import { useAccess, useCapability } from '../../components/auth/AdminGate';

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

  const access = useAccess();
  const canComp = useCapability('product.comp');
  const canGrant = useCapability('product.grant_admin');
  const comp = useAdminMutation<{ email: string; to: 'free' | 'unlimited' | null }>(refresh);
  const grant = useAdminMutation<{ email: string; to: boolean }>(refresh);

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

  const isSelf = access.email != null && access.email.toLowerCase() === data.email.toLowerCase();

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
      actions={
        <div className="flex items-center gap-2">
          {canComp && !isSelf && (
            <button
              onClick={() =>
                comp.start(
                  { email: data.email, to: data.planOverride ? null : 'unlimited' },
                  ({ reason, confirm }) =>
                    api.admin.users.setPlanOverride(data.id, {
                      planOverride: data.planOverride ? null : 'unlimited',
                      reason,
                      confirm: confirm ?? '',
                    })
                )
              }
              className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
            >
              {data.planOverride ? 'Remove comp' : 'Comp account'}
            </button>
          )}
          {canGrant && !isSelf && (
            <button
              onClick={() =>
                grant.start({ email: data.email, to: !data.isAdmin }, ({ reason, confirm }) =>
                  api.admin.users.setAdmin(data.id, {
                    isAdmin: !data.isAdmin,
                    reason,
                    confirm: confirm ?? '',
                  })
                )
              }
              className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
            >
              {data.isAdmin ? 'Revoke operator' : 'Make operator'}
            </button>
          )}
        </div>
      }
    >
      {/* The self-mutation guard lives on the server. Saying so here — and
          hiding the buttons — saves an operator the confusing 403 they would
          otherwise get on their own account. */}
      {isSelf && (
        <div className="mb-4 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          This is your own account. Comping yourself and changing your own operator flag are
          refused by the server — use <code className="font-mono">psql</code> if you genuinely
          need to, so it leaves a trace somewhere other than here.
        </div>
      )}

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

      <ConfirmMutationDialog
        open={Boolean(comp.pending)}
        onClose={comp.close}
        title={comp.pending?.target.to ? 'Comp this account?' : 'Remove this comp?'}
        description={
          comp.pending?.target.to ? (
            <>
              <strong>{comp.pending.target.email}</strong> gets unlimited tasks and merge-queue
              PRs, regardless of their subscription. This sets{' '}
              <code className="font-mono text-xs">plan_override</code> — Polar never touches it,
              so it stays until removed here.
            </>
          ) : (
            <>
              <strong>{comp.pending?.target.email}</strong> falls back to whatever their Polar
              subscription says. If they have none, they go back to the free limits immediately.
            </>
          )
        }
        actionLabel={comp.pending?.target.to ? 'Comp account' : 'Remove comp'}
        confirmText={comp.pending?.target.email}
        confirmLabel="their email"
        destructive={!comp.pending?.target.to}
        analyticsAction="user.plan_override"
        analyticsTargetType="user"
        onConfirm={async (input) => {
          await comp.pending!.run(input);
          comp.succeeded(comp.pending!.target.to ? 'Account comped' : 'Comp removed');
        }}
      />

      <ConfirmMutationDialog
        open={Boolean(grant.pending)}
        onClose={grant.close}
        title={grant.pending?.target.to ? 'Make this person an operator?' : 'Revoke operator access?'}
        description={
          grant.pending?.target.to ? (
            <>
              <strong>{grant.pending.target.email}</strong> gets everything you can see and do here
              — every account&apos;s data, the fleet, and the ability to grant this to others.
            </>
          ) : (
            <>
              <strong>{grant.pending?.target.email}</strong> loses access to this console. If they
              are the last operator this will be refused.
            </>
          )
        }
        actionLabel={grant.pending?.target.to ? 'Make operator' : 'Revoke operator'}
        confirmText={grant.pending?.target.email}
        confirmLabel="their email"
        destructive
        analyticsAction="user.admin"
        analyticsTargetType="user"
        onConfirm={async (input) => {
          await grant.pending!.run(input);
          grant.succeeded(grant.pending!.target.to ? 'Operator granted' : 'Operator revoked');
        }}
      />
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
