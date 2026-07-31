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
