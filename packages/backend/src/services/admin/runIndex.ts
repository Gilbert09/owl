import type { AdminRunIndex, AdminRunRow, AdminRunStatus } from '@talyn/shared';
import type { FleetSandbox } from '../selfHosted/client.js';
import { cloudStatusForSandbox } from '../selfHosted/poller.js';
import { listAdminTasks } from './queries.js';
import { liveFleetSandboxes } from './fleetProxy.js';

/**
 * "What is happening on the fleet", joined from two sources that each know
 * something the other does not.
 *
 * The fleet's record store is IN-MEMORY (plus a per-record JSON ledger that
 * exists only so a crashed supervisor can adopt in-flight VMs), so history
 * dies with the process. The durable record is the `tasks` row. Neither alone
 * answers the question:
 *
 *   - `orphan: true` — a sandbox live on a host with no task behind it. A
 *     microVM burning memory for nobody. This is the single most valuable
 *     thing this page surfaces, and it is invisible from either side alone.
 *   - `live: null` on a non-terminal task — the task believes it is running
 *     and the host has never heard of it. Usually a fleetd restart that lost
 *     the record, which is precisely what the re-credentialing path exists for.
 *
 * The live side is `GET /v1/sandboxes` per host — the merged fleet has no run
 * list any more, so the "runs" this page shows ARE the hosts' sandboxes,
 * translated back into the run-status vocabulary the console has always
 * spoken (see cloudStatusForSandbox).
 *
 * The join key is the deterministic id: `talyn-<taskId>`, set by
 * services/selfHosted/executor.ts, and echoed back in
 * `metadata.cloudTask.remoteRunId`.
 */

/** The METADATA fallback: `cloudTask.status` is written by the poller in the
 *  legacy run vocabulary, so this only filters, never translates. */
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
 * A live fleetd sandbox, as the console's row shape.
 *
 * Exported so the single-run route returns the SAME shape the list does —
 * two run shapes would mean the detail page reimplementing every derivation
 * (idle time, wedge detection, status pill) against a different set of field
 * names.
 *
 * `orphan: true` by default because this builds from the live side alone; the
 * list overrides it when a task row claims the sandbox.
 */
export function adminRunFromFleet(sandbox: FleetSandbox, host: string): AdminRunRow {
  return {
    runId: sandbox.id,
    host,
    taskId: null,
    workspaceId: sandbox.workspaceId ?? null,
    ownerEmail: null,
    repo: null,
    status: cloudStatusForSandbox(sandbox),
    phase: sandbox.phase ?? null,
    adopted: Boolean(sandbox.adopted),
    slot: typeof sandbox.slot === 'number' ? sandbox.slot : null,
    goldenLayer: sandbox.goldenLayer ?? null,
    createdAt: iso(sandbox.createdAt),
    startedAt: iso(sandbox.startedAt),
    endedAt: iso(sandbox.endedAt),
    deadline: iso(sandbox.deadline),
    lastHeartbeat: iso(sandbox.lastHeartbeat),
    lastActivity: iso(sandbox.lastActivity),
    costUsd: typeof sandbox.costUsd === 'number' ? sandbox.costUsd : null,
    memUsedMib: typeof sandbox.memUsedMib === 'number' ? sandbox.memUsedMib : null,
    memMib: typeof sandbox.memMib === 'number' ? sandbox.memMib : null,
    prUrl: sandbox.prUrl ?? initialTaskPrUrl(sandbox),
    error: sandbox.error ?? null,
    orphan: true,
    selfTest: Boolean(sandbox.task?.selfTest),
  };
}

/** The PR the initial task opened, when the record reports it there rather
 *  than on the sandbox itself. */
function initialTaskPrUrl(sandbox: FleetSandbox): string | null {
  return sandbox.tasks?.[0]?.prUrl ?? null;
}

/**
 * Newest first, on the timestamp the row actually has.
 *
 * `startedAt` is the one an operator reads as "when did this run", but a queued
 * run has none — falling back to `createdAt` keeps it beside its neighbours
 * instead of at the bottom, which is where a bare `startedAt ?? 0` would put
 * the run most likely to need attention.
 */
function byRecency(a: AdminRunRow, b: AdminRunRow): number {
  const at = Date.parse(a.startedAt ?? a.createdAt ?? '') || 0;
  const bt = Date.parse(b.startedAt ?? b.createdAt ?? '') || 0;
  if (at !== bt) return bt - at;
  // Stable for equal timestamps so the list does not shuffle between polls.
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
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
  const [page, { live, degraded }] = await Promise.all([
    listAdminTasks({
      host: filters.host,
      limit: filters.limit,
      before: filters.before,
      provider: 'selfhosted',
    }),
    // Not a host fan-out any more. Through the gateway a sandbox belongs to a
    // TENANT, and this backend's own FLEET_API_TOKEN resolves to the empty one
    // — so asking each box directly returns nothing for every run the gateway
    // placed. See liveFleetSandboxes.
    liveFleetSandboxes(),
  ]);

  const byRunId = new Map<string, { sandbox: FleetSandbox; host: string }>();
  for (const entry of live) {
    byRunId.set(entry.sandbox.id, entry);
  }

  const claimed = new Set<string>();
  const claimedItems: AdminRunRow[] = page.items.map((task) => {
    const runId = task.remoteRunId ?? `talyn-${task.id}`;
    const match = byRunId.get(runId);
    if (match) claimed.add(runId);
    const sandbox = match?.sandbox;
    return {
      runId,
      // The live host wins over the recorded one: a sandbox adopted after a
      // restart is where the fleet says it is, not where dispatch put it.
      host: match?.host ?? task.fleetHost ?? null,
      taskId: task.id,
      workspaceId: task.workspaceId,
      ownerEmail: task.ownerEmail,
      repo: null,
      status: sandbox ? cloudStatusForSandbox(sandbox) : toStatus(task.cloudStatus),
      phase: sandbox?.phase ?? task.phase ?? null,
      adopted: Boolean(sandbox?.adopted),
      slot: typeof sandbox?.slot === 'number' ? sandbox.slot : null,
      goldenLayer: sandbox?.goldenLayer ?? null,
      createdAt: task.createdAt,
      startedAt: iso(sandbox?.startedAt),
      endedAt: iso(sandbox?.endedAt) ?? task.completedAt,
      deadline: iso(sandbox?.deadline),
      lastHeartbeat: iso(sandbox?.lastHeartbeat),
      lastActivity: iso(sandbox?.lastActivity),
      costUsd: sandbox?.costUsd ?? task.costUsd,
      // No task-side fallback: only the live host knows what a sandbox is
      // using right now, and a stale figure would be worse than an honest
      // blank.
      memUsedMib: typeof sandbox?.memUsedMib === 'number' ? sandbox.memUsedMib : null,
      memMib: typeof sandbox?.memMib === 'number' ? sandbox.memMib : null,
      prUrl: sandbox ? (sandbox.prUrl ?? initialTaskPrUrl(sandbox)) : null,
      error: sandbox?.error ?? null,
      orphan: false,
      selfTest: Boolean(sandbox?.task?.selfTest),
    };
  });

  const orphans = [...byRunId.entries()]
    .filter(([runId]) => !claimed.has(runId))
    .map(([, { sandbox, host }]) => adminRunFromFleet(sandbox, host));

  // Merged by time, not concatenated.
  //
  // Orphans used to be prepended wholesale, on the reasoning that they are the
  // most valuable thing here. The effect was the opposite: a run that started
  // 58 seconds ago sorted BELOW four deploy self-tests from an hour ago, so the
  // one row an operator opened the page to find was the one they had to hunt
  // for. Orphans keep their tinted row and their count in the header — that is
  // what makes them findable, and it costs the list nothing to stay in order.
  const items = [...orphans, ...claimedItems].sort(byRecency);

  return { items, nextCursor: page.nextCursor, degraded };
}
