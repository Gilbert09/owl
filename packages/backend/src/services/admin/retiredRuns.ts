/**
 * The durable half of a run.
 *
 * A fleet host retires a terminal run's record two hours after it ends — the
 * ledger it reads at startup would otherwise become a scan of every run the box
 * has ever done (see the retention sweep in fleet's supervisor). After that the
 * host answers "no such run", which is how the console came to show that for
 * every run older than an afternoon, transcript included.
 *
 * The transcript is not lost: the provider's streamer persists it to
 * `tasks.transcript` as it arrives, and the task row outlives the host's copy by
 * design — "terminal ones are the backend's own record" is the reason the fleet
 * only reports ACTIVE runs upward. The console just never asked.
 *
 * The join key is the deterministic run id the executor assigns: `talyn-<taskId>`.
 */
import { eq } from 'drizzle-orm';
import type { AdminRunEvent, AdminRunEventPage, AdminRunRow } from '@talyn/shared';
import { tasks as tasksTable } from '../../db/schema.js';
import { getPoolDbClient } from '../../db/client.js';

/** The task id inside a fleet run id, or null when the id is not one of ours. */
export function taskIdFromRunId(runId: string): string | null {
  const m = /^talyn-(.+)$/.exec(runId);
  return m ? m[1] : null;
}

async function loadTask(runId: string) {
  const taskId = taskIdFromRunId(runId);
  if (!taskId) return null;
  const rows = await getPoolDbClient()
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A retired run's row, rebuilt from the task that owned it. Null when no task
 * claims this id — a genuinely unknown run, which must still 404.
 */
export async function retiredRun(runId: string, host: string): Promise<AdminRunRow | null> {
  const task = await loadTask(runId);
  if (!task) return null;
  const meta = (task.metadata ?? {}) as { cloudTask?: { costUsd?: number; prUrl?: string } };
  return {
    runId,
    host,
    taskId: task.id,
    workspaceId: task.workspaceId,
    ownerEmail: null,
    repo: null,
    status: toRunStatus(task.status),
    phase: null,
    adopted: false,
    slot: null,
    goldenLayer: null,
    createdAt: task.createdAt?.toISOString() ?? null,
    startedAt: null,
    endedAt: task.completedAt?.toISOString() ?? null,
    deadline: null,
    lastHeartbeat: null,
    lastActivity: null,
    costUsd: typeof meta.cloudTask?.costUsd === 'number' ? meta.cloudTask.costUsd : null,
    // The host's copy is gone, so there is nothing live to measure. Null, not
    // zero: see AdminRunRow.
    memUsedMib: null,
    memMib: null,
    prUrl: meta.cloudTask?.prUrl ?? null,
    error: null,
    orphan: false,
    selfTest: false,
  };
}

/** Task status → run status, for the statuses the two share. */
function toRunStatus(status: string | null): AdminRunRow['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      // A retired host record means the run is over whatever the task row
      // still says, so anything else is reported as completed rather than as
      // a run that is somehow still going.
      return 'completed';
  }
}

/**
 * A retired run's transcript, from `tasks.transcript`.
 *
 * The stored form is a bare AgentEvent list — the fleet's seq and arrival time
 * are host-side and go with the host's copy — so seq is the array index. That
 * keeps the cursor contract the live endpoint has (monotonic, resumable) while
 * being honest that these numbers are ours, not the host's.
 */
export async function retiredEvents(
  runId: string,
  after: number
): Promise<AdminRunEventPage | null> {
  const task = await loadTask(runId);
  if (!task) return null;
  const stored = Array.isArray(task.transcript) ? (task.transcript as unknown[]) : [];
  const at = (task.completedAt ?? task.updatedAt ?? task.createdAt ?? new Date()).toISOString();
  const events: AdminRunEvent[] = stored
    .map((event, i) => ({ seq: i + 1, at, event: (event ?? {}) as Record<string, unknown> }))
    .filter((e) => e.seq > after);
  return {
    events,
    cursor: stored.length,
    // A run whose host record is gone is finished by definition; saying
    // otherwise would leave the console polling a transcript that cannot grow.
    terminal: true,
  };
}
