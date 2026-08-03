/**
 * Client for the Talyn Fleet API — the `selfhosted` provider's remote.
 *
 * The contract is `openapi.yaml` in Gilbert09/talyn-fleet. This is hand-written
 * rather than generated for now; the generated-client-plus-drift-check flow in
 * SPEC §16.1 replaces it once the fleet publishes a tagged artifact.
 */

/** A run as the fleet reports it. */
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
  ) {
    super(message);
    this.name = 'FleetCapacityError';
  }
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

export class FleetClient {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  private url(path: string): string {
    return `${this.endpoint.replace(/\/+$/, '')}${path}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(this.url(path), {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(20_000),
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(),
      });
    } catch (err) {
      // Network-level failure. Treated as capacity rather than terminal: an
      // unreachable host is an availability problem, and failing the user's
      // task because one box is down is exactly what fail-back exists to avoid.
      throw new FleetCapacityError(
        `Fleet unreachable at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

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
      throw new Error(await errorMessage(resp, `fleet returned ${resp.status}`));
    }
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
  }

  /** Liveness + version. Used by validateCredentials and testConnection. */
  async ping(): Promise<{ status: string; version: string }> {
    return this.request('/healthz');
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
  ): Promise<{ events: FleetEvent[]; cursor: number; terminal: boolean }> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/events?after=${after}`);
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
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. Anything that is not a
        // `data:` line is a comment — the server sends `: ping` through idle
        // gaps so a proxy does not reap the connection.
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              yield JSON.parse(line.slice(6));
            } catch {
              // A malformed frame is not worth killing the stream over; the
              // poll holds the same cursor and will re-fetch what was missed.
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async cancelRun(runId: string): Promise<void> {
    await this.request(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
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
