/**
 * Client for the Talyn Fleet API — the `selfhosted` provider's remote.
 *
 * The contract is `openapi.yaml` in Gilbert09/talyn-fleet. This is hand-written
 * rather than generated for now; the generated-client-plus-drift-check flow in
 * SPEC §16.1 replaces it once the fleet publishes a tagged artifact.
 */

import { createSseJsonParser } from '@talyn/shared';
import { debugBus } from '../debugBus.js';

/**
 * A sandbox's lifecycle states. Terminal = stopped | failed | cancelled.
 *
 * The fleet merged runs and sandboxes into one kind (fleet docs/MERGE.md): a
 * sandbox is the microVM, and each prompt on it is a TASK with its own
 * terminal outcome. Talyn dispatches `ephemeral: true` sandboxes, which the
 * host stops as soon as the initial task ends — the old run behaviour.
 */
export type FleetSandboxStatus =
  | 'queued'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'suspended'
  | 'stopped'
  | 'failed'
  | 'cancelled';

/** One entry in a sandbox's task history. Talyn's outcome for a dispatched
 *  task is the INITIAL entry's terminal status — an ephemeral sandbox stops
 *  right after it, so `stopped` alone says nothing about how the work went. */
export interface FleetSandboxTask {
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt?: string;
  endedAt?: string;
  error?: string;
  prUrl?: string;
}

/** A sandbox as the fleet reports it. Field names match internal/fleet/store.go. */
export interface FleetSandbox {
  id: string;
  workspaceId?: string;
  status: FleetSandboxStatus;
  /** Keeps its run meaning while a task is live; `agent` when idle. */
  phase?: string;
  /** The prompt history — see FleetSandboxTask. Talyn's dispatch creates the
   *  initial entry; a host older than the merge may omit the field. */
  tasks?: FleetSandboxTask[];
  /** True on Talyn's dispatches: the host stops and retires the sandbox as
   *  soon as its initial task reaches a terminal state. */
  ephemeral?: boolean;
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
  /**
   * What the guest was BOOTED at. Under the fleet's elastic admission this is a
   * CEILING, not a cost: the balloon holds the guest well below it and lets it
   * grow only as it proves it needs to. Fifteen runs on a 4096 ceiling read as
   * 60 GiB while actually costing 23.
   */
  memMib?: number;
  /**
   * What the run is spending right now — the VMM's resident size, so guest
   * pages actually touched plus the VMM's own overhead.
   *
   * Absent on a terminal run (its VMM is gone) and on any host still running a
   * fleetd that predates the field, so treat missing as "unknown" rather than
   * as zero.
   */
  memUsedMib?: number;
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
   * The sandbox's initial task, redacted by the fleet to the four fields it is
   * willing to fan out (`fvspTaskRedacted`) — never the prompt, which embeds
   * customer code.
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

/**
 * The response header the sandbox gateway sets to name the host that took a
 * create. Hosts answering directly do not send it.
 *
 * Named here rather than inlined because two places have to agree on it and one
 * of them is in another repository (yas `internal/control.HostHeader`).
 */
export const FLEET_HOST_HEADER = 'X-Fleet-Host';

/**
 * One row of the GATEWAY's placement index — not a sandbox record.
 *
 * Deliberately a separate type from FleetSandbox with no optional overlap: the
 * gateway cannot answer status, phase or cost (they live on the host and change
 * every second), and a shared type would let a caller read `status` off one of
 * these and get `undefined` where it meant `stopped`.
 */
export interface GatewaySandboxRef {
  id: string;
  host: string;
  createdAt?: string;
  placed?: boolean;
  agentic?: boolean;
  templateId?: string;
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

/** The initial task on a dispatched sandbox — the old dispatch body, nested
 *  under `task`. No `harness` field: pi is the only in-guest agent loop. */
export interface CreateSandboxTaskInput {
  taskType: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  repo?: { slug: string; baseBranch: string; targetRef?: string };
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutSec?: number;
  /**
   * Which LLM API the model belongs to. Omitted means anthropic, which is what
   * every dispatch predating the field meant — but it is sent explicitly so the
   * route table the host builds is the one this dispatch chose, not a default
   * it inherited.
   */
  provider?: string;
}

export interface CreateSandboxInput {
  /** Caller-chosen and idempotent: the fleet returns the existing sandbox for
   *  a repeated id rather than booting a second microVM. */
  id: string;
  workspaceId: string;
  /** Talyn always dispatches ephemeral sandboxes — stop after the initial
   *  task, exactly what a run was. */
  ephemeral: boolean;
  task: CreateSandboxTaskInput;
  githubToken?: string;
  /**
   * The credential for THIS sandbox's provider, and only that one. The fleet
   * holds no key of its own and refuses a dispatch that arrives without the
   * one its provider needs, so an omitted key is a 400 rather than a guest
   * that boots and then fails on its first call.
   */
  anthropicKey?: string;
  openaiKey?: string;
  /**
   * The sandbox's privacy posture. Talyn sets exactly one thing on it:
   * `credentials.<the other vendor> = 'none'`.
   *
   * That is not decoration. The gateway fills an absent credential from its
   * tenant's sealed custody, and the fleet applies this policy at every door a
   * credential can enter the run's proxy — including the adoption re-pull after
   * a fleetd restart, which happens with nobody watching. Suppressing the
   * vendor this run is not using makes "spend somebody else's subscription"
   * impossible rather than merely unlikely.
   *
   * Never suppress `github`, and never suppress both LLM vendors: the fleet
   * nulls its whole refresh hook when everything is suppressed, which would
   * strip the key this dispatch supplied.
   */
  policy?: { credentials?: { github?: 'none'; anthropic?: 'none'; openai?: 'none' } };
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
 * The host is reachable and says the sandbox does not exist.
 *
 * Unlike every other fleet error, this one is TERMINAL: capacity, throttle and
 * unreachable all mean "ask again later, the work is still going on the metal",
 * but a healthy host is authoritative about its own sandboxes. One disappears
 * when fleetd restarts without adopting it, or the microVM is reclaimed — and
 * the task can never progress again, so retrying is a loop with no exit. Two of
 * them ran for 21 hours on 2026-08-06, reconciling every tick and failing
 * identically.
 *
 * Matched on the status AND the message on purpose: fleetd's source is not in
 * this repo, so which status it pairs with the message is unverified here, and
 * the message is the only part actually observed in production. Either signal
 * is enough; neither alone is trustworthy.
 *
 * The name keeps "run" because the id this matches on is still the run id of
 * the credential wire (`talyn-<taskId>`), and every caller branches on the
 * class rather than the noun.
 */
export class FleetRunNotFoundError extends Error {
  readonly isRunNotFound = true;
  constructor(message: string) {
    super(message);
    this.name = 'FleetRunNotFoundError';
  }
}

/** Whether a fleet error response means "no such sandbox". Exported for the
 *  poller, which must distinguish terminal from retryable without
 *  string-matching at the call site. Accepts both the pre-merge "run" phrasings
 *  and the sandbox ones: a host mid-rollout can answer with either. */
export function isRunNotFoundResponse(status: number, message: string): boolean {
  return (
    status === 404 ||
    /no such run|run not found|unknown run|no such sandbox|sandbox not found|unknown sandbox/i.test(
      message,
    )
  );
}

/**
 * The control plane lost the host's answer to a dispatch (504
 * `dispatch_uncertain`). The sandbox MAY exist: the caller must retry with the
 * SAME id — the create is idempotent on it — and never fail back to another
 * provider, which could run the task twice.
 */
export class FleetDispatchUncertainError extends Error {
  readonly isDispatchUncertain = true;
  readonly status = 504;
  constructor(message: string) {
    super(message);
    this.name = 'FleetDispatchUncertainError';
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
export function fleetDispatcher(target?: string): unknown | undefined {
  const url = process.env.FLEET_HTTP_PROXY ?? '';
  if (!url) return undefined;
  // FLEET_HTTP_PROXY reaches the TAILNET. A fleet host is a tailnet name with no
  // route from here, which is the whole reason it exists — but the sandbox
  // GATEWAY is on the public internet, and sending its requests into a tailscale
  // SOCKS proxy is a guaranteed timeout.
  //
  // That took Talyn's dispatch down on 2026-08-18: every task queued behind
  // "Fleet unreachable at https://yasctl-...: The operation was aborted due to
  // timeout", while the same URL answered in half a second from a shell. The
  // proxy was applied to every fleet request unconditionally, and nothing about
  // a public URL made it opt out.
  if (target && targetBypassesProxy(target)) return undefined;
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

/**
 * Whether this target must NOT go through FLEET_HTTP_PROXY.
 *
 * Decided by comparing hosts with the configured pin rather than by guessing
 * from the shape of the name: "is it a tailnet address" is a heuristic that
 * would be wrong the first time a host is reached some other way, and this is
 * the one decision that silently converts into a total dispatch outage.
 */
export function targetBypassesProxy(target: string): boolean {
  const pinned = (process.env.FLEET_PINNED_ENDPOINT ?? '').trim();
  if (!pinned) return false;
  try {
    return new URL(target).host === new URL(pinned).host;
  } catch {
    return false;
  }
}

/**
 * Unwrap an Error's cause chain into something loggable.
 *
 * undici reports the interesting part here — ECONNREFUSED, EAI_AGAIN, a TLS
 * failure, a proxy refusal — while the outer message stays generic. Dropping it
 * is what made an unreachable gateway indistinguishable from a slow one.
 */
export function describeCause(err: unknown, depth = 0): string | undefined {
  if (depth > 4 || !(err instanceof Error)) return undefined;
  const cause = (err as { cause?: unknown }).cause;
  if (cause === undefined) return undefined;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    const inner = describeCause(cause, depth + 1);
    return `${cause.name}${code ? `(${code})` : ''}: ${cause.message}${inner ? ` <- ${inner}` : ''}`;
  }
  return String(cause);
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

  /**
   * The ordinary call: the decoded body and nothing else.
   *
   * Almost everything wants this. `requestWithMeta` exists for the one caller
   * that needs a response HEADER — see `createSandbox` and FLEET_HOST_HEADER —
   * and routing every other method through a two-field object to serve it would
   * put an unwrap at forty call sites to inform one.
   */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.requestWithMeta<T>(path, init)).data;
  }

  private async requestWithMeta<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<{ data: T; host?: string }> {
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
        dispatcher: fleetDispatcher(this.endpoint),
      });
    } catch (err) {
      this.recordHttp(method, path, 0, started, false, err);
      // Network-level failure. Treated as capacity rather than terminal: an
      // unreachable host is an availability problem, and failing the user's
      // task because one box is down is exactly what fail-back exists to avoid.
      //
      // Logged with the CAUSE and the elapsed time, because the message alone
      // is not diagnosable. "The operation was aborted due to timeout" is what
      // AbortSignal says about any request that ran out of time, and it names
      // neither what failed nor how long it really took — so a DNS failure, a
      // refused connection, a proxy that cannot route, and a server that is
      // simply slow all read identically. That ambiguity cost a whole afternoon
      // on 2026-08-18: the same URL answered in 0.2s from a shell in the same
      // container while every dispatch reported it unreachable.
      const tookMs = Date.now() - started;
      console.warn(
        `[fleet] ${method} ${path} failed after ${tookMs}ms:`,
        JSON.stringify({
          url: this.url(path),
          timeoutMs: this.timeoutMs,
          proxied: fleetDispatcher(this.endpoint) !== undefined,
          name: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
          cause: describeCause(err),
        }),
      );
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
    if (resp.status === 504) {
      // The control plane started the create and never heard how it ended.
      // Retry the SAME id (idempotent), never another provider.
      throw new FleetDispatchUncertainError(
        await errorMessage(resp, 'the fleet lost the answer to this request'),
      );
    }
    if (!resp.ok) {
      const message = await errorMessage(resp, `fleet returned ${resp.status}`);
      // Terminal, not retryable — see FleetRunNotFoundError.
      if (isRunNotFoundResponse(resp.status, message)) {
        throw new FleetRunNotFoundError(message);
      }
      throw new Error(message);
    }
    // The gateway names the host that took a create, because Talyn has to bound
    // a later credential pull BY HOST and cannot read that off a registry it no
    // longer consults. A host answering directly does not send it, and its
    // absence is not an error — the registry supplied the name on that path.
    const host = resp.headers.get(FLEET_HOST_HEADER) ?? undefined;
    if (resp.status === 204) return { data: undefined as T, host };
    return { data: (await resp.json()) as T, host };
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
        dispatcher: fleetDispatcher(this.endpoint),
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

  async listSandboxes(): Promise<{ sandboxes: FleetSandbox[] }> {
    return this.request('/v1/sandboxes');
  }

  /**
   * The same path against the GATEWAY, which answers a different thing.
   *
   * A host serves its own full records here. The gateway serves its placement
   * INDEX — id, host, and little else — because it holds no live state and a
   * list that fanned out to every host would go blank whenever one was down.
   * So the two share a route and not a shape, and giving them one method would
   * hand the console `status: undefined` for every row and call it live data.
   *
   * The ids come back live-only (the gateway drops rows it has marked gone), so
   * a caller wanting real status hydrates each one with `getSandbox`.
   */
  async listGatewaySandboxes(): Promise<{ sandboxes: GatewaySandboxRef[] }> {
    return this.request('/v1/sandboxes');
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

  /**
   * Dispatch: 202 with the sandbox record, idempotent on `input.id`.
   *
   * Returns the host alongside it when the endpoint named one. Through the
   * gateway that is the only way to learn it — the record in the body is
   * fleetd's and says nothing about which fleetd wrote it — and it is not
   * cosmetic: `resolveRunCredentials` answers a host's credential pull only for
   * a run dispatched to THAT host, and a dispatch that recorded no host refuses
   * every pull. Dialling a host directly the answer is already known, so `host`
   * is absent there and the caller keeps what the registry told it.
   */
  async createSandbox(
    input: CreateSandboxInput,
  ): Promise<{ sandbox: FleetSandbox; host?: string }> {
    const { data, host } = await this.requestWithMeta<FleetSandbox>('/v1/sandboxes', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return { sandbox: data, host };
  }

  /**
   * One sandbox. A terminal one keeps answering from a tombstone with
   * `retired: true` rather than 404ing straight away.
   */
  async getSandbox(
    id: string,
  ): Promise<{ sandbox: FleetSandbox; terminal: boolean; retired?: boolean }> {
    return this.request(`/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  async getEvents(
    id: string,
    after: number,
    limit?: number,
  ): Promise<{ events: FleetEvent[]; cursor: number; terminal: boolean }> {
    const suffix = limit ? `&limit=${limit}` : '';
    return this.request(`/v1/sandboxes/${encodeURIComponent(id)}/events?after=${after}${suffix}`);
  }

  /**
   * Follow a sandbox's transcript as server-sent events.
   *
   * The cursor poll above is correct but its latency is the caller's poll
   * interval — 10s here, which is what an agent's output arriving in
   * ten-second bursts looks like to somebody watching a task. The fleet's
   * follow endpoint pushes instead, and each frame carries the identical
   * {events, cursor, terminal} object `getEvents` returns, so this and the
   * poll share one shape and a dropped stream resumes from the same cursor.
   *
   * Yields frames until the sandbox is terminal, the caller aborts, or the
   * stream breaks. A broken stream is NOT an error worth surfacing: the poll is
   * still running underneath and will finish the job a little less promptly.
   */
  async *followEvents(
    id: string,
    after: number,
    signal: AbortSignal,
  ): AsyncGenerator<{ events: FleetEvent[]; cursor: number; terminal: boolean }> {
    const resp = await fetch(
      this.url(`/v1/sandboxes/${encodeURIComponent(id)}/events?follow=1&after=${after}`),
      {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
        signal,
        // @ts-expect-error `dispatcher` is undici's, not in the DOM fetch types
        dispatcher: fleetDispatcher(this.endpoint),
      },
    );
    if (!resp.ok || !resp.body) {
      throw new Error(`follow ${id}: ${resp.status} ${resp.statusText}`);
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

  /** Cancel the running task. On Talyn's ephemeral sandboxes the host then
   *  stops the sandbox too. */
  async cancelSandbox(id: string): Promise<void> {
    await this.request(`/v1/sandboxes/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  /**
   * Hand a sandbox's credentials back after the fleet restarted under it.
   *
   * The fleet never writes credentials to disk, so a `fleetd` restart loses
   * them and the surviving microVM cannot authenticate anything — its next call
   * returns `502 no Anthropic credential was supplied`, and it then burns the
   * rest of its deadline before being reported as "deadline exceeded".
   *
   * We are the only party that still has them. Re-supplying is what makes a
   * fleet deploy survivable for a task that is already running, which is what
   * lets deploys happen at all rather than waiting for an idle host.
   */
  async setSandboxCredentials(
    id: string,
    creds: { githubToken: string; anthropicKey?: string; openaiKey?: string; repo?: string },
  ): Promise<void> {
    await this.request(`/v1/sandboxes/${encodeURIComponent(id)}/credentials`, {
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
