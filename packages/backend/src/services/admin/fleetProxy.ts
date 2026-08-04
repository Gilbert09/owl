import {
  ADMIN_FLEET_NOT_CONFIGURED,
  ADMIN_FLEET_UNREACHABLE,
  ADMIN_HOST_NOT_DIALABLE,
  ADMIN_HOST_OFFLINE,
  type AdminFleetHost,
  type AdminFleetLiveErrorCode,
} from '@talyn/shared';
import { FleetClient } from '../selfHosted/client.js';
import { fleetApiToken } from '../selfHosted/credentials.js';
import { getFleetHost, listFleetHosts, type FleetHostView } from '../fleetHosts.js';

/**
 * How the operator console reaches fleetd.
 *
 * # The degradation contract
 *
 * The fleet page is the page you open BECAUSE a host is misbehaving. If one
 * dead box can fail the request, the console is unavailable exactly when it is
 * needed. So every READ goes through `probe()`, which never throws: an
 * unreachable host renders as a row with a reason attached.
 *
 * MUTATIONS do not degrade. A drain that could not reach fleetd is a 502 with
 * the upstream message, because the operator must know the box was not told.
 * Softening that into "probably fine" is how a host stays live through an
 * incident somebody believes they drained.
 *
 * # Timeouts
 *
 * Reads use 5s: a page fanning out over hosts cannot hang 20s on one dead box,
 * and a host that has not answered in five seconds over a private link is not
 * about to. Golden GC and rebake use 60s — those are genuinely slow, and their
 * failure mode is an operator staring at a spinner rather than a page-wide
 * stall.
 */

/** A console read. Short, because a fan-out is only as fast as its slowest leg. */
export const ADMIN_READ_TIMEOUT_MS = 5_000;
/** GC and rebake genuinely take this long. */
export const ADMIN_SLOW_MUTATION_TIMEOUT_MS = 60_000;

export class HostUnknownError extends Error {
  readonly status = 404;
  readonly code = 'host_unknown';
  constructor(name: string) {
    super(`No fleet host named "${name}" has ever reported in.`);
    this.name = 'HostUnknownError';
  }
}

export class HostNotDialableError extends Error {
  readonly status = 409;
  readonly code = ADMIN_HOST_NOT_DIALABLE;
  constructor(name: string) {
    super(`Host "${name}" has advertised no API endpoint, so there is nowhere to dial.`);
    this.name = 'HostNotDialableError';
  }
}

export class HostOfflineError extends Error {
  readonly status = 409;
  readonly code = ADMIN_HOST_OFFLINE;
  constructor(name: string, reportedAt: Date) {
    super(`Host "${name}" last reported at ${reportedAt.toISOString()} and is presumed gone.`);
    this.name = 'HostOfflineError';
  }
}

export class FleetNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = ADMIN_FLEET_NOT_CONFIGURED;
  constructor() {
    super('FLEET_API_TOKEN is not set on this deployment.');
    this.name = 'FleetNotConfiguredError';
  }
}

/** Map a proxy error onto its HTTP response, or return false. */
export function handleFleetProxyError(err: unknown, res: {
  status: (code: number) => { json: (body: unknown) => unknown };
}): boolean {
  if (
    err instanceof HostUnknownError ||
    err instanceof HostNotDialableError ||
    err instanceof HostOfflineError ||
    err instanceof FleetNotConfiguredError
  ) {
    res.status(err.status).json({ success: false, error: err.message, code: err.code });
    return true;
  }
  return false;
}

/**
 * A client aimed at one named host.
 *
 * Distinct from `resolveFleetTarget`, which is workspace-scoped and needs the
 * workspace's Claude token — the wrong shape entirely for an operator asking
 * about a specific box.
 *
 * A STALE HOST IS NEVER DIALLED unless `allowOffline`. Registration does not
 * imply reachability (see the header comment on services/fleetHosts.ts): the
 * report is outbound and dispatch is inbound. Dialling a host whose last
 * report is minutes old means waiting the full timeout to be told what the
 * registry already knew.
 */
export async function fleetClientForHost(
  name: string,
  opts: { timeoutMs?: number; allowOffline?: boolean } = {}
): Promise<{ client: FleetClient; host: FleetHostView }> {
  const token = fleetApiToken();
  if (!token) throw new FleetNotConfiguredError();

  const host = await getFleetHost(name);
  if (!host) throw new HostUnknownError(name);
  if (!host.apiEndpoint) throw new HostNotDialableError(name);
  if (!host.online && !opts.allowOffline) throw new HostOfflineError(name, host.reportedAt);

  return {
    client: new FleetClient(host.apiEndpoint, token, {
      timeoutMs: opts.timeoutMs ?? ADMIN_READ_TIMEOUT_MS,
    }),
    host,
  };
}

export type Probe<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: AdminFleetLiveErrorCode };

/**
 * Run a read against one host without ever throwing.
 *
 * This is the whole degradation contract in one function. `FleetCapacityError`
 * is what an unreachable host produces (the client maps network failures onto
 * it), so it becomes `unreachable` rather than propagating.
 */
export async function probe<T>(
  name: string,
  fn: (client: FleetClient) => Promise<T>,
  opts: { timeoutMs?: number; allowOffline?: boolean } = {}
): Promise<Probe<T>> {
  try {
    const { client } = await fleetClientForHost(name, opts);
    return { ok: true, value: await fn(client) };
  } catch (err) {
    return { ok: false, ...describe(err) };
  }
}

function describe(err: unknown): { error: string; code: AdminFleetLiveErrorCode } {
  if (err instanceof HostOfflineError) return { error: err.message, code: ADMIN_HOST_OFFLINE };
  if (err instanceof HostNotDialableError) {
    return { error: err.message, code: ADMIN_HOST_NOT_DIALABLE };
  }
  if (err instanceof FleetNotConfiguredError) {
    return { error: err.message, code: ADMIN_FLEET_NOT_CONFIGURED };
  }
  return {
    error: err instanceof Error ? err.message : String(err),
    code: ADMIN_FLEET_UNREACHABLE,
  };
}

/**
 * Run a read across every ONLINE host concurrently.
 *
 * Bounded by the registry, which is a handful of boxes — a semaphore is
 * premature, but everything fans out through here so adding one later is a
 * one-line change rather than an audit of call sites.
 *
 * Reads only. Mutations are always addressed to one named host: a fan-out
 * mutation with one shared `reason` produces N audit rows from a single click
 * with no way to tell which host actually accepted it.
 */
export async function fanOutHosts<T>(
  fn: (client: FleetClient, host: FleetHostView) => Promise<T>,
  opts: { timeoutMs?: number } = {}
): Promise<Array<{ host: FleetHostView; result: Probe<T> }>> {
  const hosts = await listFleetHosts();
  const online = hosts.filter((h) => h.online && h.apiEndpoint);
  const settled = await Promise.all(
    online.map(async (host) => ({
      host,
      result: await probe(host.name, (client) => fn(client, host), opts),
    }))
  );
  return settled;
}

/** The registry row, as the console's view type, with no live data attached. */
export function toAdminHost(host: FleetHostView): AdminFleetHost {
  return {
    name: host.name,
    apiEndpoint: host.apiEndpoint,
    version: host.version,
    reportedAt: host.reportedAt.toISOString(),
    draining: host.draining,
    runsLive: host.runsLive,
    runsMax: host.runsMax,
    memReservedMib: host.memReservedMib,
    memBudgetMib: host.memBudgetMib,
    diskFreeMib: host.diskFreeMib,
    maxIdleSeconds: host.maxIdleSeconds,
    online: host.online,
    dispatchable: host.dispatchable,
    live: null,
    liveError: null,
    liveErrorCode: null,
  };
}

/**
 * The host list, optionally enriched with a live capacity read.
 *
 * `live: false` answers from the registry alone and dials nothing — which is
 * what the console's first paint should use, because a page that waits on N
 * tailnet round trips before showing anything is unusable during the incident
 * it was opened for.
 *
 * With `live: true` this still returns 200 for every host. A box that cannot
 * be reached gets `live: null` plus a reason, never an exception.
 */
export async function listAdminFleetHosts(opts: { live?: boolean } = {}): Promise<AdminFleetHost[]> {
  const hosts = await listFleetHosts();
  if (!opts.live) return hosts.map(toAdminHost);

  return Promise.all(
    hosts.map(async (host) => {
      const base = toAdminHost(host);
      // Offline hosts are not dialled at all — probe() refuses them, and the
      // registry row already carries the last thing they said.
      const result = await probe(host.name, (client) => client.capacity());
      if (result.ok) return { ...base, live: result.value };
      return { ...base, liveError: result.error, liveErrorCode: result.code };
    })
  );
}
