import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Eye } from 'lucide-react';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, relativeAge, usd } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';
import { useAdminMutation } from '../../hooks/useAdminMutation';
import { ConfirmMutationDialog } from '../../components/admin/ConfirmMutationDialog';
import { useCapability } from '../../components/auth/AdminGate';

/**
 * One task.
 *
 * The transcript is BEHIND A CLICK, not fetched with the page. It is another
 * tenant's agent conversation — the most sensitive thing this console can show
 * — and the backend writes an audit row every time it is served. Loading it
 * automatically would fill the log with accesses nobody chose to make, which
 * would bury the ones somebody did.
 *
 * Rendered as <pre>, not markdown: see apps/admin/README.md.
 */
export function TaskDetailPage() {
  const { taskId = '' } = useParams();
  const [showTranscript, setShowTranscript] = useState(false);

  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () => api.admin.tasks.get(taskId, { transcript: showTranscript }),
    { deps: [taskId, showTranscript], enabled: Boolean(taskId) }
  );

  const canMutate = useCapability('product.task_mutate');
  const retry = useAdminMutation<{ id: string; title: string | null }>(refresh);
  const kill = useAdminMutation<{ id: string; title: string | null; owner: string | null }>(refresh);

  if (!data) {
    return (
      <Page title="Task" backTo={ROUTES.tasks} backLabel="Tasks" onRefresh={refresh}>
        {initialLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error ?? 'Task not found.'}
          </div>
        )}
      </Page>
    );
  }

  const transcript = Array.isArray(data.transcript) ? data.transcript : null;

  return (
    <Page
      title={data.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-3 text-xs">
          <CopyableId value={data.id} />
          <Pill tone={data.status === 'failed' ? 'critical' : 'muted'}>{data.status}</Pill>
          <span>{data.type}</span>
          {data.ownerEmail && <span>{data.ownerEmail}</span>}
          <span title={absolute(data.createdAt)}>created {relativeAge(data.createdAt)} ago</span>
        </span>
      }
      backTo={ROUTES.tasks}
      backLabel="Tasks"
      onRefresh={refresh}
      refreshing={loading}
      actions={
        canMutate && (
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                retry.start({ id: data.id, title: data.title }, ({ reason }) =>
                  api.admin.tasks.retry(data.id, { reason })
                )
              }
              className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
            >
              Retry
            </button>
            {!['completed', 'failed', 'cancelled'].includes(data.status) && (
              <button
                onClick={() =>
                  kill.start(
                    { id: data.id, title: data.title, owner: data.ownerEmail },
                    ({ reason }) => api.admin.tasks.kill(data.id, { reason })
                  )
                }
                className="rounded-md border border-destructive/50 px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10"
              >
                Kill
              </button>
            )}
          </div>
        )
      }
    >
      {data.error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="font-medium">Error: </span>
          {data.error}
        </div>
      )}

      <dl className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-card p-3 text-sm sm:grid-cols-3">
        <Field
          label="Workspace"
          value={
            <Link
              to={routeTo(ROUTES.workspace, { workspaceId: data.workspaceId })}
              className="underline-offset-2 hover:underline"
            >
              {data.workspaceName ?? data.workspaceId}
            </Link>
          }
        />
        <Field label="Provider" value={data.provider ?? '—'} />
        <Field label="Cloud status" value={data.cloudStatus ?? '—'} />
        <Field
          label="Fleet host"
          value={
            data.fleetHost ? (
              <Link
                to={routeTo(ROUTES.fleetHost, { host: data.fleetHost })}
                className="underline-offset-2 hover:underline"
              >
                {data.fleetHost}
              </Link>
            ) : (
              '—'
            )
          }
        />
        <Field label="Phase" value={data.phase ?? '—'} />
        <Field label="Cost" value={usd(data.costUsd)} />
        <Field
          label="Run"
          value={
            data.remoteRunId && data.fleetHost ? (
              <Link
                to={`${routeTo(ROUTES.fleetRun, { runId: data.remoteRunId })}?host=${encodeURIComponent(data.fleetHost)}`}
                className="underline-offset-2 hover:underline"
              >
                {data.remoteRunId}
              </Link>
            ) : (
              (data.remoteRunId ?? '—')
            )
          }
        />
        <Field label="Branch" value={data.branch ?? '—'} />
        <Field
          label="PR"
          value={
            data.prUrl ? (
              <a
                href={data.prUrl}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                open
              </a>
            ) : (
              '—'
            )
          }
        />
      </dl>

      {data.prompt && (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Prompt
          </h2>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-3 text-xs">
            {data.prompt}
          </pre>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Transcript
        </h2>
        {!showTranscript ? (
          <div className="rounded-lg border border-border bg-card px-4 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              This is the customer&apos;s agent conversation. Opening it is recorded in the audit
              log.
            </p>
            <button
              onClick={() => setShowTranscript(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            >
              <Eye className="h-3.5 w-3.5" />
              Show transcript
            </button>
          </div>
        ) : transcript && transcript.length > 0 ? (
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-3 font-mono text-[11px]">
            {JSON.stringify(transcript, null, 2)}
          </pre>
        ) : (
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
            {loading ? 'Loading transcript…' : 'This task has no transcript.'}
          </p>
        )}
      </section>

      <ConfirmMutationDialog
        open={Boolean(retry.pending)}
        onClose={retry.close}
        title="Retry this task?"
        description={
          <>
            <strong>{retry.pending?.target.title ?? retry.pending?.target.id}</strong> goes back in the queue and gets a FRESH
            cloud run — the previous run&apos;s record is cleared, so nothing re-adopts it. If the
            old run is still alive on a host, kill it first or you will have two.
          </>
        }
        actionLabel="Retry task"
        analyticsAction="task.retry"
        analyticsTargetType="task"
        onConfirm={async (input) => {
          await retry.pending!.run(input);
          retry.succeeded('Task requeued');
        }}
      />

      <ConfirmMutationDialog
        open={Boolean(kill.pending)}
        onClose={kill.close}
        title="Kill this task?"
        description={
          <>
            <strong>{kill.pending?.target.title ?? kill.pending?.target.id}</strong> is marked cancelled and the remote run is
            asked to stop. That ask is best-effort — if the provider refuses, the run may still
            finish and open a PR, and the result will say so.
            {kill.pending?.target.owner && <> This belongs to {kill.pending.target.owner}.</>}
          </>
        }
        actionLabel="Kill task"
        confirmText={kill.pending?.target.id}
        confirmLabel="the task id"
        destructive
        analyticsAction="task.kill"
        analyticsTargetType="task"
        onConfirm={async (input) => {
          await kill.pending!.run(input);
          kill.succeeded('Task cancelled');
        }}
      />
    </Page>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm">{value}</dd>
    </div>
  );
}
