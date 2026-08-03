import { desc, eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { getPoolDbClient } from '../db/client.js';
import { fleetHosts as fleetHostsTable } from '../db/schema.js';

/**
 * The self-hosted fleet's host registry.
 *
 * Hosts push a snapshot every ~15s (fleetd's `FLEET_REPORT_URL`); the backend
 * never dials them to ask. That direction is the design, not a convenience:
 * the fleet runs untrusted code on bare metal behind a private interface, and
 * a hosted PaaS with an inbound path to every such machine is the shape the
 * whole thing exists to avoid.
 *
 * The consequence worth stating plainly: **registration does not imply
 * reachability.** A host can report in perfectly happily and still be
 * undispatchable, because the report is outbound and dispatch is inbound. That
 * is why `apiEndpoint` is advertised by the host rather than inferred from the
 * request's source address — only the host knows which of its addresses the
 * backend can actually dial, and a NAT'd source IP is not it.
 *
 * EVERY QUERY HERE USES THE POOL CLIENT, NOT `getDbClient()`.
 *
 * `fleet_hosts` has no owner column because a host belongs to the deployment,
 * not to a user — so it is RLS-enabled with no policy and no `authenticated`
 * GRANT, which is the right posture for a table the user role must never touch.
 * The catch is that `pickFleetHost` is reached from REQUEST context (saving
 * fleet credentials, and every dispatch), where `withOwnerScope` has dropped the
 * transaction to `authenticated` — and `getDbClient()` returns that scoped
 * handle. The result was `permission denied for table fleet_hosts`, surfaced in
 * the settings card as a raw "Failed query: select ... from fleet_hosts". Prod,
 * 2026-08-03.
 *
 * The tempting fix is `GRANT SELECT ... TO authenticated` plus a `USING (true)`
 * policy. Do not: that publishes every host's tailnet address, capacity and
 * metrics to any account that can reach the API, to accommodate a call that had
 * no business being owner-scoped. `getPoolDbClient()` is documented for exactly
 * this — cross-owner work reached from a scoped request.
 *
 * Same CLASS of bug as migration 0033 (merge_queue_entries shipped RLS-enabled
 * with no GRANT, then read from request context), but not the same fix: that
 * table held genuinely user-scoped data and wanted the policy. The shared lesson
 * is narrower than either remedy — decide whether a table is user data or
 * infrastructure BEFORE choosing an RLS posture, then make every call site agree
 * with that choice.
 */

/**
 * How long after its last report a host is presumed gone.
 *
 * Four missed reports at the default 15s cadence. Long enough that a slow tick,
 * a redeploy or a brief network blip does not flap the host out of the
 * registry; short enough that dispatching to a dead box is a narrow window
 * rather than a routine outcome.
 */
export const HOST_STALE_AFTER_MS = 60_000;

export interface FleetHostReport {
  host: string;
  version?: string;
  reportedAt?: string;
  apiEndpoint?: string;
  draining?: boolean;
  runsLive?: number;
  runsMax?: number;
  memReservedMib?: number;
  memBudgetMib?: number;
  diskFreeMib?: number;
  maxIdleSeconds?: number;
  metrics?: unknown;
  activeRuns?: unknown;
}

export interface FleetHostView {
  name: string;
  apiEndpoint: string | null;
  version: string | null;
  reportedAt: Date;
  draining: boolean;
  runsLive: number;
  runsMax: number;
  memReservedMib: number;
  memBudgetMib: number;
  diskFreeMib: number;
  maxIdleSeconds: number;
  /** False once the host has stopped reporting for HOST_STALE_AFTER_MS. */
  online: boolean;
  /** Online, not draining, has capacity, and advertised somewhere to dial. */
  dispatchable: boolean;
  metrics: unknown;
  activeRuns: unknown;
}

/**
 * Authenticate a host report.
 *
 * A shared token rather than a user JWT: the caller is a daemon on a machine
 * with no user, and minting a service account for it would be a credential with
 * more grant than "may append to one table". Constant-time, because a report
 * endpoint is unauthenticated until this returns and is therefore reachable by
 * anything that can resolve the backend.
 *
 * Unset means the endpoint refuses everything. An open report endpoint lets
 * anyone invent a host — and an invented host with an `apiEndpoint` is a
 * dispatch target, so this is a route to sending customer work to a stranger's
 * server, not merely to bad telemetry.
 */
export function fleetReportTokenValid(presented: string | undefined): boolean {
  const expected = process.env.FLEET_REPORT_TOKEN ?? '';
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // length — compare against a padded copy so the work is constant either way.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Upsert a host's snapshot. Idempotent — a repeated report is a no-op write. */
export async function recordFleetHostReport(report: FleetHostReport): Promise<void> {
  const name = report.host?.trim();
  if (!name) throw new Error('report is missing `host`');

  // The host's own clock is not trusted for staleness: a box with a skewed
  // clock would otherwise look permanently stale or permanently fresh. Its
  // reportedAt is kept for display, ours decides whether it is online.
  const now = new Date();
  const values = {
    name,
    apiEndpoint: report.apiEndpoint?.trim() || null,
    version: report.version ?? null,
    reportedAt: now,
    draining: Boolean(report.draining),
    runsLive: report.runsLive ?? 0,
    runsMax: report.runsMax ?? 0,
    memReservedMib: report.memReservedMib ?? 0,
    memBudgetMib: report.memBudgetMib ?? 0,
    diskFreeMib: report.diskFreeMib ?? 0,
    maxIdleSeconds: report.maxIdleSeconds ?? 0,
    metrics: (report.metrics ?? null) as object | null,
    activeRuns: (report.activeRuns ?? null) as object | null,
    updatedAt: now,
  };

  await getPoolDbClient()
    .insert(fleetHostsTable)
    .values(values)
    .onConflictDoUpdate({ target: fleetHostsTable.name, set: values });
}

/** Whether a host's last report is recent enough to believe. */
export function hostIsOnline(reportedAt: Date, now: number = Date.now()): boolean {
  return now - reportedAt.getTime() < HOST_STALE_AFTER_MS;
}

/**
 * Whether a host could take a run right now.
 *
 * All four conditions, and the endpoint one is the easy one to forget: a host
 * that is online, idle and healthy but has advertised no address is not
 * dispatchable, because there is nowhere to send the run. Treating it as
 * available would mean the dispatch picks it and then fails on connect.
 */
export function hostIsDispatchable(host: {
  reportedAt: Date;
  draining: boolean;
  runsLive: number;
  runsMax: number;
  apiEndpoint: string | null;
}, now: number = Date.now()): boolean {
  if (!host.apiEndpoint) return false;
  if (!hostIsOnline(host.reportedAt, now)) return false;
  if (host.draining) return false;
  // runsMax of 0 means the host never told us its cap; treat that as unknown
  // rather than full, since a host reporting at all is a host that is running.
  return host.runsMax === 0 || host.runsLive < host.runsMax;
}

function toView(row: typeof fleetHostsTable.$inferSelect, now: number): FleetHostView {
  return {
    name: row.name,
    apiEndpoint: row.apiEndpoint,
    version: row.version,
    reportedAt: row.reportedAt,
    draining: row.draining,
    runsLive: row.runsLive,
    runsMax: row.runsMax,
    memReservedMib: row.memReservedMib,
    memBudgetMib: row.memBudgetMib,
    diskFreeMib: row.diskFreeMib,
    maxIdleSeconds: row.maxIdleSeconds,
    online: hostIsOnline(row.reportedAt, now),
    dispatchable: hostIsDispatchable(row, now),
    metrics: row.metrics,
    activeRuns: row.activeRuns,
  };
}

/** Every registered host, most recently seen first. */
export async function listFleetHosts(now: number = Date.now()): Promise<FleetHostView[]> {
  const rows = await getPoolDbClient()
    .select()
    .from(fleetHostsTable)
    .orderBy(desc(fleetHostsTable.reportedAt));
  return rows.map((r) => toView(r, now));
}

/** One host by name, or null. */
export async function getFleetHost(name: string, now: number = Date.now()): Promise<FleetHostView | null> {
  const rows = await getPoolDbClient()
    .select()
    .from(fleetHostsTable)
    .where(eq(fleetHostsTable.name, name))
    .limit(1);
  return rows[0] ? toView(rows[0], now) : null;
}

/**
 * The host a run should go to, or null if none can take one.
 *
 * Least-loaded-first, which is spec §14 Phase 3's "ask each host, pick
 * least-loaded" reduced to a query — the registry already holds what the ask
 * would have returned, and it is at most seconds old. A host reporting no cap
 * sorts last: without a denominator its load is unknown, and unknown should not
 * beat a host that has told us it is idle.
 */
export async function pickFleetHost(now: number = Date.now()): Promise<FleetHostView | null> {
  const candidates = (await listFleetHosts(now)).filter((h) => h.dispatchable);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const load = (h: FleetHostView) => (h.runsMax > 0 ? h.runsLive / h.runsMax : Number.POSITIVE_INFINITY);
    return load(a) - load(b);
  });
  return candidates[0] ?? null;
}
