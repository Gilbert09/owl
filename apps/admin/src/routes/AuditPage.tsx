import { useSearchParams } from 'react-router-dom';
import type { AdminAuditEntry } from '@talyn/shared';
import { api } from '../lib/api';
import { useAdminQuery } from '../hooks/useAdminQuery';
import { Page, Pill } from '../components/layout/Page';
import { DataTable, type Column } from '../components/ui/DataTable';
import { absolute, relativeAge } from '../lib/format';

/**
 * Who did what, when, and why.
 *
 * Read-only, and there is no delete anywhere in the API — from outside the
 * database this log is append-only, which is most of what makes it worth
 * having. An operator who can erase the record of their own action has an
 * audit log in name only.
 *
 * The `reason` column is the widest on purpose. "Who drained prod at 2am" is
 * answerable from timestamps; "why" is only answerable because the gate
 * refuses a mutation without one.
 */
export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const action = params.get('action') ?? '';
  const actorId = params.get('actorId') ?? '';
  const targetId = params.get('targetId') ?? '';

  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () =>
      api.admin.audit.list({
        action: action || undefined,
        actorId: actorId || undefined,
        targetId: targetId || undefined,
      }),
    { deps: [action, actorId, targetId] }
  );

  const columns: Column<AdminAuditEntry>[] = [
    {
      key: 'at',
      header: 'When',
      cell: (e) => (
        <span className="tabular-nums" title={absolute(e.at)}>
          {relativeAge(e.at)}
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Operator',
      cell: (e) => <span className="truncate text-xs">{e.actorEmail}</span>,
    },
    {
      key: 'action',
      header: 'Action',
      cell: (e) => (
        <button
          onClick={() => setParam('action', e.action)}
          className="font-mono text-xs underline-offset-2 hover:underline"
        >
          {e.action}
        </button>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      cell: (e) => (
        <button
          onClick={() => setParam('targetId', e.targetId)}
          className="truncate text-xs underline-offset-2 hover:underline"
          title={`${e.targetKind}: ${e.targetId}`}
        >
          <span className="text-muted-foreground">{e.targetKind}/</span>
          {e.targetId}
        </button>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (e) => <span className="text-xs">{e.reason}</span>,
      className: 'max-w-md',
    },
    { key: 'outcome', header: 'Outcome', cell: (e) => <OutcomePill entry={e} /> },
  ];

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const pending = data?.items.filter((e) => e.outcome === 'pending').length ?? 0;
  const filtered = Boolean(action || actorId || targetId);

  return (
    <Page
      title="Audit log"
      subtitle={`${data?.items.length ?? 0} entries${data?.nextCursor ? ' (more available)' : ''}`}
      onRefresh={refresh}
      refreshing={loading}
      actions={
        filtered && (
          <button
            onClick={() => setParams(new URLSearchParams(), { replace: true })}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
          >
            Clear filters
          </button>
        )
      }
    >
      {pending > 0 && (
        // A row stuck on `pending` means we wrote the intent, dialled out, and
        // never learned how it ended — usually a backend restart mid-call.
        // Worth surfacing: the action may or may not have taken effect.
        <div className="mb-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          {pending} action{pending === 1 ? '' : 's'} never reported an outcome — we dialled out and
          did not hear back. They may or may not have taken effect.
        </div>
      )}

      <DataTable
        rows={data?.items ?? null}
        columns={columns}
        rowKey={(e) => e.id}
        error={error}
        loading={loading}
        initialLoading={initialLoading}
        onRetry={refresh}
        emptyMessage={filtered ? 'No entries match' : 'Nothing has been changed yet'}
        emptyHint={
          filtered
            ? 'Clear the filters to see everything.'
            : 'Every mutation from this console lands here, with the reason the operator gave.'
        }
      />
    </Page>
  );
}

function OutcomePill({ entry }: { entry: AdminAuditEntry }) {
  if (entry.outcome === 'ok') return <Pill tone="good">ok</Pill>;
  if (entry.outcome === 'error') {
    return (
      <Pill tone="critical" title={entry.error ?? undefined}>
        failed
      </Pill>
    );
  }
  return (
    <Pill tone="warn" title="We dialled out and never heard back.">
      pending
    </Pill>
  );
}
