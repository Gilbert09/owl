import type { AdminFleetHost, AdminIncidentSeverity, AdminRunRow } from '@talyn/shared';
import { parseTime, pct } from './format';

/**
 * Pure derivations for the fleet views.
 *
 * Kept out of components deliberately so they can be tested without a DOM —
 * every one of these is a judgement an operator acts on ("is this host gone?",
 * "is this run wedged?"), and a judgement worth acting on is worth pinning.
 *
 * The staleness constant is duplicated from the backend on purpose. The
 * backend already computes `online` and sends it, and that value is what the
 * UI trusts; this constant exists only so a client-side countdown can say "3s
 * until stale" without a round trip. If they ever disagree, the server is
 * right — see `hostStatus`, which prefers the server's answer.
 */

/** Mirrors HOST_STALE_AFTER_MS in services/fleetHosts.ts: four missed reports. */
export const HOST_STALE_AFTER_MS = 60_000;

export type HostState = 'offline' | 'draining' | 'full' | 'ready';

/**
 * What a host row should say, in one word.
 *
 * Order matters and encodes precedence: an offline host is offline whatever
 * else its last report claimed, and a draining host is draining even if it
 * still has slots. Getting that backwards would show "ready" for a box that
 * cannot take work.
 */
export function hostState(host: AdminFleetHost): HostState {
  if (!host.online) return 'offline';
  if (host.draining) return 'draining';
  if (host.runsMax > 0 && host.runsLive >= host.runsMax) return 'full';
  return 'ready';
}

export function hostSeverity(state: HostState): AdminIncidentSeverity {
  switch (state) {
    case 'offline':
      return 'critical';
    case 'draining':
    case 'full':
      return 'warn';
    default:
      return 'info';
  }
}

/**
 * Whether a host's last report is recent enough to believe, computed locally.
 *
 * The SERVER's `online` flag is authoritative — it uses its own clock, which
 * is the one that decides dispatch. This exists so a list can go stale between
 * polls without waiting for the next refresh to say so.
 */
export function looksStale(host: AdminFleetHost, now: number = Date.now()): boolean {
  const at = parseTime(host.reportedAt);
  if (at == null) return true;
  return now - at >= HOST_STALE_AFTER_MS;
}

/**
 * Memory pressure as a percentage, or null when the host reported no budget.
 *
 * A host with `memBudgetMib: 0` never told us its cap. That is unknown, not
 * full, and rendering it as 100% would have an operator draining a healthy
 * box. (The backend's `hostIsDispatchable` makes the same distinction for
 * `runsMax === 0`.)
 */
export function memoryPct(host: AdminFleetHost): number | null {
  return pct(host.memReservedMib, host.memBudgetMib);
}

export function slotsPct(host: AdminFleetHost): number | null {
  return pct(host.runsLive, host.runsMax);
}

/**
 * How long a run has been silent on the vsock.
 *
 * `lastActivity`, NOT `lastHeartbeat`. The distinction is load-bearing and the
 * fleet paid for it: wedge detection on heartbeats alone killed healthy runs
 * (HANDOFF failure #2), because a run busy enough not to heartbeat is still
 * plainly alive on any other frame. Falls back to the heartbeat only when the
 * fleet reported no activity at all.
 */
export function idleSeconds(run: AdminRunRow, now: number = Date.now()): number | null {
  const at = parseTime(run.lastActivity) ?? parseTime(run.lastHeartbeat);
  if (at == null) return null;
  return Math.max(0, Math.round((now - at) / 1000));
}

/** The fleet cancels a run silent for ~5 minutes. Warn before it does. */
export const WEDGE_WARN_SECONDS = 240;

/**
 * Whether a run looks stuck.
 *
 * Only meaningful for a non-terminal run: a completed run stops sending frames
 * by definition, and flagging every finished run as wedged would make the
 * signal useless.
 */
export function looksWedged(run: AdminRunRow, now: number = Date.now()): boolean {
  if (run.status !== 'running' && run.status !== 'queued') return false;
  const idle = idleSeconds(run, now);
  return idle != null && idle >= WEDGE_WARN_SECONDS;
}

export function isTerminal(status: AdminRunRow['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Rank runs for display: the ones needing attention first.
 *
 * Orphans lead — a microVM with no task behind it is burning memory for
 * nobody, and it is the thing this page exists to catch. Then wedged runs,
 * then live ones, then history.
 */
export function runRank(run: AdminRunRow, now: number = Date.now()): number {
  if (run.orphan) return 0;
  if (looksWedged(run, now)) return 1;
  if (!isTerminal(run.status)) return 2;
  return 3;
}

export function sortRuns(runs: AdminRunRow[], now: number = Date.now()): AdminRunRow[] {
  return [...runs].sort((a, b) => {
    const rank = runRank(a, now) - runRank(b, now);
    if (rank !== 0) return rank;
    return (parseTime(b.createdAt) ?? 0) - (parseTime(a.createdAt) ?? 0);
  });
}

/** Disk free as a percentage of the golden store, when the host reports it. */
export function goldenFreePct(freePct: number | null | undefined): number | null {
  if (freePct == null || !Number.isFinite(freePct)) return null;
  return Math.max(0, Math.min(100, freePct));
}

/**
 * The fleet's GC starts evicting under this much free space.
 *
 * Mirrors `-golden-gc-low-pct 15`. Shown so an operator can see GC pressure
 * coming rather than discovering it from an eviction counter afterwards.
 */
export const GOLDEN_GC_LOW_PCT = 15;
