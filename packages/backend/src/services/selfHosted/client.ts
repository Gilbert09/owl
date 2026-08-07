/**
 * Client for the Talyn Fleet API — the `selfhosted` provider's remote.
 *
 * The contract is `openapi.yaml` in Gilbert09/talyn-fleet. This is hand-written
 * rather than generated for now; the generated-client-plus-drift-check flow in
 * SPEC §16.1 replaces it once the fleet publishes a tagged artifact.
 */

import { createSseJsonParser } from '@talyn/shared';
import { debugBus } from '../debugBus.js';

/** A run as the fleet reports it. Field names match internal/fleet/store.go. */
export interface FleetRun {
  id: string;
  workspaceId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase?: string;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  prUrl?: string;
  branch?: string;
  costUsd?: number;
  error?: string;
  adopted?: boolean;
  /**
   * When THIS supervisor took the run over. Changes on every adoption, which is
   * what makes it usable as the key for "have we re-credentialed this run since
   * it was last adopted" — `adopted` alone is a latch and cannot distinguish a
   * second restart from the first.
   */
  adoptedAt?: string;
  /** Per-run network slot + uid offset; unique among live runs. */
  slot?: number;
  deadline?: string;
  memMib?: number;
  vcpuCount?: number;
  golden?: string;
  /** 'base' | 'repo' — which layer selection landed on. */
  goldenLayer?: string;
  /** Last vsock heartbeat. */
  lastHeartbeat?: string;
  /**
   * Last vsock frame of ANY kind. Load-bearing and distinct from
   * lastHeartbeat: wedge detection on heartbeats alone killed healthy runs
   * (fleet HANDOFF failure #2), so this is the number that says "stuck".
   */
  lastActivity?: string;
  /**
   * The run's task, redacted by the fleet to the four fields it is willing to
   * fan out (`fvspTaskRedacted`) — never the prompt, which embeds customer
   * code.
   */
  task?: {
    taskType?: string;
    model?: string;
    repo?: string;
    /**
     * A guest self-test rather than an agent loop. `deploy.sh` fires one after
     * every deploy to prove the API contract, so these appear on the host with
     * no Talyn task behind them — expected, and NOT the orphan the console is
     * trying to warn about.
     */
    selfTest?: boolean;
  };
}

/** fleetd's `GET /v1/capacity`. */
export interface FleetCapacity {
  draining: boolean;
  runsLive: number;
  runsMax: number;
  memReservedMib: number;
  memBudgetMib: number;
  accepting: boolean;
}

/** fleetd's `GET /v1/stats` — the structured twin of /metrics. */
export interface FleetStats {
  host: {
    version?: string;
    draining: boolean;
    runsLive: number;
    runsMax: number;
    memReservedMib: number;
    memBudgetMib: number;
    diskFreeMib: number;
    maxIdleSeconds: number;
  };
  runsByStatus: Record<string, number>;
  /**
   * The fleet's own metrics snapshot, passed through whole. Deliberately
   * loose: the fleet ships on its own cadence and adding a counter there must
   * not need a release here.
   */
  metrics: Record<string, unknown>;
}

/** One baked image. `diskBytes` is reflink-aware and is the one that bills. */
export interface FleetGolden {
  key: string;
  path: string;
  contentSha: string;
  repoSlug: string;
  baseBranch: string;
  repoCommit: string;
  packageManager?: string;
  workdir?: string;
  builtAt: string;
  diskBytes: number;
  apparentBytes: number;
  inUse: boolean;
  operatorPinned: boolean;
  /** False once baked on a base image this host no longer ships. */
  selectable: boolean;
  warnings?: string[];
}

export interface FleetGoldensView {
  goldens: FleetGolden[];
  freePct: number;
  baseGolden: string;
  baseOsSha: string;
}

export interface FleetRebakeStatus {
  slug?: string;
  baseBranch?: string;
  actor?: string;
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/**
 * The attribution envelope every mutating fleetd action shares.
 *
 * fleetd 400s a body missing either field — spec §17.3, "an unattributed
 * drain is the one that nobody can explain the next morning".
 */
export interface FleetAttribution {
  actor: string;
  reason: string;
}

/** One transcript entry. `seq` is assigned by the fleet, not the guest. */
export interface FleetEvent {
  seq: number;
  at: string;
  event: Record<string, unknown>;
}

export interface CreateRunInput {
  runId: string;
  workspaceId: string;
  taskType: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  repo?: { slug: string; baseBranch: string; targetRef?: string };
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutSec?: number;
  githubToken?: string;
  anthropicKey?: string;
}

/**
 * A capacity refusal from the fleet — the host is full, draining, or out of
 * disk. Distinct from a terminal error on purpose: the task is fine and should
 * be retried or failed back to another provider, not failed (spec §10.7, §11.6).
 */
export class FleetCapacityError extends Error {
  readonly isCapacity = true;
  readonly status = 503;
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    /**
     * Which kind of "not now" this is.
     *
     * Both mean retry, so nothing in the dispatch path branches on it — but
     * they are different sentences to a user, and `message` cannot be shown to
     * one either way: it carries the host's private endpoint, which has no
     * business in a customer-facing banner.
     */
    readonly reason: 'no_capacity' | 'unreachable' = 'no_capacity',
  ) {
    super(message);
    this.name = 'FleetCapacityError';
  }
}

/**
 * The host is reachable and says the run does not exist.
 *
 * Unlike every other fleet error, this one is TERMINAL: capacity, throttle and
 * unreachable all mean "ask again later, the run is still going on the metal",
 * but a healthy host is authoritative about its own runs. A run disappears when
 * fleetd restarts without adopting it, or the microVM is reclaimed — and the task
 * can never progress again, so retrying is a loop with no exit. Two of them ran
 * for 21 hours on 2026-08-06, reconciling every tick and failing identically.
 *
 * Matched on the status AND the message on purpose: fleetd's source is not in
 * this repo, so which status it pairs with "no such run" is unverified here, and
 * the message is the only part actually observed in production. Either signal is
 * enough; neither alone is trustworthy.
 */
export class FleetRunNotFoundError extends Error {
  readonly isRunNotFound = true;
  constructor(message: string) {
    super(message);
    this.name = 'FleetRunNotFoundError';
  }
}

/** Whether a fleet error response means "no such run". Exported for the poller,
 *  which must distinguish terminal from retryable without string-matching at the
 *  call site. */
export function isRunNotFoundResponse(status: number, message: string): boolean {
  return status === 404 || /no such run|run not found|unknown run/i.test(message);
}

/** A rate-limit response. Shaped for the generic poller's ThrottleBackoff,
 *  which duck-types on `status === 429` and an optional `retryAfterMs`. */
export class FleetThrottleError extends Error {
  readonly status = 429;
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'FleetThrottleError';
  }
}


/**
 * The dispatcher fleet requests go out through.
 *
 * A fleet host binds loopback and is reachable only over the deployment's
 * private link (a tailnet). On a PaaS the backend joins that tailnet in
 * userspace mode — there is no NET_ADMIN and therefore no TUN device — so the
 * route is not transparent: traffic has to be dialled through the local HTTP
 * proxy tailscaled exposes.
 *
 * Scoped to THIS client on purpose. A global proxy agent would send GitHub,
 * Supabase and Anthropic through the tailnet daemon too, which is both slower
 * and a much larger blast radius for a component whose only job is reaching one
 * private host.
 *
 * Unset means direct, which is what a deployment with no self-hosted fleet — or
 * one whose backend shares a network with its hosts — should do.
 */
let cachedProxy: { url: string; dispatcher: unknown } | null = null;

/** Exported for tests: proving this CONSTRUCTS is the only check that catches
 *  a missing `undici` before production does. */
export function fleetDispatcher(): unknown | undefined {
  const url = process.env.FLEET_HTTP_PROXY ?? '';
  if (!url) return undefined;
  if (cachedProxy?.url === url) return cachedProxy.dispatcher;
  // `undici` is a DECLARED DEPENDENCY of this package, not something Node
  // provides. Node bundles undici to implement global `fetch`, but only as an
  // internal module — `require('undici')` resolves nothing unless the package
  // is installed. This comment used to claim the opposite, and the belief cost
  // a production deploy: the dev tree happened to have it transitively, the
  // runtime image prunes dev dependencies, and the miss was invisible locally
  // because FLEET_HTTP_PROXY is unset there so this line never ran.
  //
  // Still required lazily rather than imported at module scope: a deployment
  // with no private link never needs a proxy agent, and this file is imported
  // by the provider registry that every workspace touches.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ProxyAgent } = require('undici') as { ProxyAgent: new (u: string) => unknown };
  cachedProxy = { url, dispatcher: new ProxyAgent(url) };
  return cachedProxy.dispatcher;
}

/** Exposed for tests, which change the env between cases. */
export function resetFleetDispatcherCache(): void {
  cachedProxy = null;
}

/**
 * The default request timeout.
 *
 * Right for dispatch and the poller, which can afford to wait on a busy host.
 * The admin surface overrides it — a console page fanning out over hosts
 * cannot hang 20s on one dead box, and a golden GC genuinely takes longer than
 * either.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

export class FleetClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private url(path: string): string {
    return `${this.endpoint.replace(/\/+$/, '')}${path}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const started = Date.now();
    const method = init.method ?? 'GET';
    let resp: Response;
    try {
      resp = await fetch(this.url(path), {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(),
      });
    } catch (err) {
      this.recordHttp(method, path, 0, started, false, err);
      // Network-level failure. Treated as capacity rather than terminal: an
      // unreachable host is an availability problem, and failing the user's
      // task because one box is down is exactly what fail-back exists to avoid.
      throw new FleetCapacityError(
        `Fleet unreachable at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        'unreachable',
      );
    }

    this.recordHttp(method, path, resp.status, started, resp.ok);

    if (resp.status === 503) {
      throw new FleetCapacityError(
        await errorMessage(resp, 'the fleet has no capacity'),
        parseRetryAfterMs(resp),
      );
    }
    if (resp.status === 429) {
      throw new FleetThrottleError(await errorMessage(resp, 'rate limited'), parseRetryAfterMs(resp));
    }
    if (!resp.ok) {
      const message = await errorMessage(resp, `fleet returned ${resp.status}`);
      // Terminal, not retryable — see FleetRunNotFoundError.
      if (isRunNotFoundResponse(resp.status, message)) {
        throw new FleetRunNotFoundError(message);
      }
      throw new Error(message);
    }
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
  }

  /**
   * Feed the debug bus, per CLAUDE.md's rule that every outbound HTTP funnel
   * records here.
   *
   * This client recorded nothing until the operator console started making
   * fleet calls per pageview — a pre-existing gap that only became visible
   * once there was traffic worth watching. The URL is the PATH, already free
   * of query strings and of the host's tailnet address; recording the full URL
   * would put a private endpoint in a panel that is screenshared.
   */
  private recordHttp(
    method: string,
    path: string,
    status: number,
    started: number,
    ok: boolean,
    err?: unknown,
  ): void {
    if (!debugBus.isRecording()) return;
    debugBus.recordHttp({
      service: 'fleet',
      method,
      url: path.split('?')[0] ?? path,
      status,
      durationMs: Date.now() - started,
      ok,
      error: err ? (err instanceof Error ? err.message : String(err)) : undefined,
    });
  }

  /** Liveness + version. Used by validateCredentials and testConnection. */
  async ping(): Promise<{ status: string; version: string }> {
    return this.request('/healthz');
  }

  // --------------------------------------------------------------------
  // Operator surface
  //
  // Read-side methods the admin console proxies. One method per fleetd
  // route, no reshaping — the console's own view types live in
  // @talyn/shared and the mapping happens in services/admin/fleetProxy.ts,
  // so this file stays a faithful description of the fleet's API.
  // --------------------------------------------------------------------

  async capacity(): Promise<FleetCapacity> {
    return this.request('/v1/capacity');
  }

  async stats(): Promise<FleetStats> {
    return this.request('/v1/stats');
  }

  /**
   * The Prometheus scrape, as text.
   *
   * Not routed through `request()`, which parses JSON. Size-capped because
   * this is proxied straight to a browser and a runaway registry should not
   * be able to hand the console a hundred megabytes.
   */
  async metricsText(maxBytes = 1_048_576): Promise<string> {
    const started = Date.now();
    let resp: Response;
    try {
      resp = await fetch(this.url('/metrics'), {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/plain' },
        signal: AbortSignal.timeout(this.timeoutMs),
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(),
      });
    } catch (err) {
      this.recordHttp('GET', '/metrics', 0, started, false, err);
      throw new FleetCapacityError(
        `Fleet unreachable at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.recordHttp('GET', '/metrics', resp.status, started, resp.ok);
    if (!resp.ok) throw new Error(`fleet returned ${resp.status} for /metrics`);
    const text = await resp.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }

  async listRuns(): Promise<{ runs: FleetRun[] }> {
    return this.request('/v1/runs');
  }

  async listGoldens(): Promise<FleetGoldensView> {
    return this.request('/v1/goldens');
  }

  async getRebake(): Promise<FleetRebakeStatus> {
    return this.request('/v1/goldens/rebake');
  }

  // --------------------------------------------------------------------
  // Mutations
  //
  // Every one takes the actor/reason envelope. fleetd 400s a body missing
  // either, so the types make them non-optional rather than letting a call
  // site discover it at runtime.
  // --------------------------------------------------------------------

  async setDrain(input: FleetAttribution & { draining: boolean }): Promise<void> {
    await this.request('/v1/drain', { method: 'POST', body: JSON.stringify(input) });
  }

  async goldensGc(
    input: FleetAttribution & { force?: boolean; dryRun?: boolean; minAge?: string },
  ): Promise<Record<string, unknown>> {
    return this.request('/v1/goldens/gc', { method: 'POST', body: JSON.stringify(input) });
  }

  async goldensPin(
    input: FleetAttribution & { path: string; pinned: boolean },
  ): Promise<Record<string, unknown>> {
    return this.request('/v1/goldens/pin', { method: 'POST', body: JSON.stringify(input) });
  }

  async goldensDelete(
    input: FleetAttribution & { path: string },
  ): Promise<{ path: string; key: string; freedBytes: number }> {
    return this.request('/v1/goldens/delete', { method: 'POST', body: JSON.stringify(input) });
  }

  async goldensRebake(
    input: FleetAttribution & { repo: string; baseBranch?: string },
  ): Promise<Record<string, unknown>> {
    return this.request('/v1/goldens/rebake', { method: 'POST', body: JSON.stringify(input) });
  }

  async createRun(input: CreateRunInput): Promise<FleetRun> {
    return this.request('/v1/runs', { method: 'POST', body: JSON.stringify(input) });
  }

  async getRun(runId: string): Promise<{ run: FleetRun; terminal: boolean }> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  async getEvents(
    runId: string,
    after: number,
    limit?: number,
  ): Promise<{ events: FleetEvent[]; cursor: number; terminal: boolean }> {
    const suffix = limit ? `&limit=${limit}` : '';
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/events?after=${after}${suffix}`);
  }

  /**
   * Follow a run's transcript as server-sent events.
   *
   * The cursor poll above is correct but its latency is the caller's poll
   * interval — 10s here, which is what an agent's output arriving in
   * ten-second bursts looks like to somebody watching a task. The fleet's
   * follow endpoint pushes instead, and each frame carries the identical
   * {events, cursor, terminal} object `getEvents` returns, so this and the
   * poll share one shape and a dropped stream resumes from the same cursor.
   *
   * Yields frames until the run is terminal, the caller aborts, or the stream
   * breaks. A broken stream is NOT an error worth surfacing: the poll is still
   * running underneath and will finish the job a little less promptly.
   */
  async *followEvents(
    runId: string,
    after: number,
    signal: AbortSignal,
  ): AsyncGenerator<{ events: FleetEvent[]; cursor: number; terminal: boolean }> {
    const resp = await fetch(
      this.url(`/v1/runs/${encodeURIComponent(runId)}/events?follow=1&after=${after}`),
      {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
        signal,
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(),
      },
    );
    if (!resp.ok || !resp.body) {
      throw new Error(`follow ${runId}: ${resp.status} ${resp.statusText}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    // Framing lives in @talyn/shared so this, the admin SSE proxy, and the
    // browser that reads the proxied stream cannot disagree about what a frame
    // is — a disagreement there shows up as "the transcript stops halfway",
    // not as an exception.
    const parser = createSseJsonParser<{
      events: FleetEvent[];
      cursor: number;
      terminal: boolean;
    }>();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          yield frame;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async cancelRun(runId: string): Promise<void> {
    await this.request(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
  }

  /**
   * Hand a run's credentials back after the fleet restarted under it.
   *
   * The fleet never writes credentials to disk, so a `fleetd` restart loses
   * them and the surviving microVM cannot authenticate anything — its next call
   * returns `502 no Anthropic credential was supplied for this run`, and it then
   * burns the rest of its deadline before being reported as "deadline exceeded".
   *
   * We are the only party that still has them. Re-supplying is what makes a
   * fleet deploy survivable for a task that is already running, which is what
   * lets deploys happen at all rather than waiting for an idle host.
   */
  async setRunCredentials(
    runId: string,
    creds: { githubToken: string; anthropicKey?: string; repo?: string },
  ): Promise<void> {
    await this.request(`/v1/runs/${encodeURIComponent(runId)}/credentials`, {
      method: 'POST',
      body: JSON.stringify(creds),
    });
  }
}

async function errorMessage(resp: Response, fallback: string): Promise<string> {
  try {
    const body = (await resp.json()) as { message?: string; error?: string };
    return body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}

function parseRetryAfterMs(resp: Response): number | undefined {
  const header = resp.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
