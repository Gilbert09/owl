import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Eye } from 'lucide-react';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, relativeAge, usd } from '../../lib/format';
import { ROUTES, routeTo } from '../../lib/routes';

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
