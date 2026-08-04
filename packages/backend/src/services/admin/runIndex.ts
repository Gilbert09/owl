import type { AdminRunIndex, AdminRunRow, AdminRunStatus } from '@talyn/shared';
import type { FleetRun } from '../selfHosted/client.js';
import { listAdminTasks } from './queries.js';
import { fanOutHosts } from './fleetProxy.js';

/**
 * "What is happening on the fleet", joined from two sources that each know
 * something the other does not.
 *
 * The fleet's run store is IN-MEMORY (plus a per-run JSON ledger that exists
 * only so a crashed supervisor can adopt in-flight VMs), so run HISTORY dies
 * with the process. The durable record is the `tasks` row. Neither alone
 * answers the question:
 *
 *   - `orphan: true` — a run live on a host with no task behind it. A microVM
 *     burning memory for nobody. This is the single most valuable thing this
 *     page surfaces, and it is invisible from either side alone.
 *   - `live: null` on a non-terminal task — the task believes it is running
 *     and the host has never heard of it. Usually a fleetd restart that lost
 *     the run, which is precisely what the re-credentialing path exists for.
 *
 * The join key is the deterministic run id: `talyn-<taskId>`, set by
 * services/selfHosted/executor.ts, and echoed back in
 * `metadata.cloudTask.remoteRunId`.
 */

function toStatus(raw: string | null | undefined): AdminRunStatus | null {
  switch (raw) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return raw;
    default:
      return null;
  }
}

function iso(value: string | undefined): string | null {
  if (!value) return null;
  // fleetd zero-values a time.Time as year 1 rather than omitting it in some
  // paths; a date that old is "never", not a timestamp worth rendering.
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) return null;
  return date.toISOString();
}

/**
 * A live fleetd run, as the console's row shape.
 *
 * Exported so the single-run route returns the SAME shape the list does —
 * two run shapes would mean the detail page reimplementing every derivation
 * (idle time, wedge detection, status pill) against a different set of field
 * names.
 *
 * `orphan: true` by default because this builds from the live side alone; the
 * list overrides it when a task row claims the run.
 */
export function adminRunFromFleet(run: FleetRun, host: string): AdminRunRow {
  return {
    runId: run.id,
    host,
    taskId: null,
    workspaceId: run.workspaceId ?? null,
    ownerEmail: null,
    repo: null,
    status: toStatus(run.status),
    phase: run.phase ?? null,
    adopted: Boolean(run.adopted),
    slot: typeof run.slot === 'number' ? run.slot : null,
    goldenLayer: run.goldenLayer ?? null,
    createdAt: iso(run.createdAt),
    startedAt: iso(run.startedAt),
    endedAt: iso(run.endedAt),
    deadline: iso(run.deadline),
    lastHeartbeat: iso(run.lastHeartbeat),
    lastActivity: iso(run.lastActivity),
    costUsd: typeof run.costUsd === 'number' ? run.costUsd : null,
    prUrl: run.prUrl ?? null,
    error: run.error ?? null,
    orphan: true,
  };
}

export interface AdminRunFilters {
  host?: unknown;
  status?: unknown;
  limit?: unknown;
  before?: unknown;
}

/**
 * The durable page, left-joined with every online host's live run list.
 *
 * Ordering and pagination come from `tasks`, because that is the side with a
 * stable total order and an index. Live-only runs are ORPHANS and are
 * prepended rather than paginated — there are never many, and burying one on
 * page four would defeat the point of surfacing them.
 */
export async function listAdminRuns(filters: AdminRunFilters): Promise<AdminRunIndex> {
  const [page, live] = await Promise.all([
    listAdminTasks({
      host: filters.host,
      limit: filters.limit,
      before: filters.before,
      provider: 'selfhosted',
    }),
    fanOutHosts((client) => client.listRuns()),
  ]);

  const byRunId = new Map<string, { run: FleetRun; host: string }>();
  const degraded: Array<{ host: string; error: string }> = [];
  for (const { host, result } of live) {
    if (!result.ok) {
      degraded.push({ host: host.name, error: result.error });
      continue;
    }
    for (const run of result.value.runs ?? []) {
      byRunId.set(run.id, { run, host: host.name });
    }
  }

  const claimed = new Set<string>();
  const items: AdminRunRow[] = page.items.map((task) => {
    const runId = task.remoteRunId ?? `talyn-${task.id}`;
    const match = byRunId.get(runId);
    if (match) claimed.add(runId);
    const run = match?.run;
    return {
      runId,
      // The live host wins over the recorded one: a run adopted after a
      // restart is where the fleet says it is, not where dispatch put it.
      host: match?.host ?? task.fleetHost ?? null,
      taskId: task.id,
      workspaceId: task.workspaceId,
      ownerEmail: task.ownerEmail,
      repo: null,
      status: toStatus(run?.status ?? task.cloudStatus),
      phase: run?.phase ?? task.phase ?? null,
      adopted: Boolean(run?.adopted),
      slot: typeof run?.slot === 'number' ? run.slot : null,
      goldenLayer: run?.goldenLayer ?? null,
      createdAt: task.createdAt,
      startedAt: iso(run?.startedAt),
      endedAt: iso(run?.endedAt) ?? task.completedAt,
      deadline: iso(run?.deadline),
      lastHeartbeat: iso(run?.lastHeartbeat),
      lastActivity: iso(run?.lastActivity),
      costUsd: run?.costUsd ?? task.costUsd,
      prUrl: run?.prUrl ?? null,
      error: run?.error ?? null,
      orphan: false,
    };
  });

  const orphans = [...byRunId.entries()]
    .filter(([runId]) => !claimed.has(runId))
    .map(([, { run, host }]) => adminRunFromFleet(run, host));

  return { items: [...orphans, ...items], nextCursor: page.nextCursor, degraded };
}
