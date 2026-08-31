import { DEFAULT_POSTHOG_CODE_MODEL_ID, type PostHogCodeRuntimeAdapter } from '@talyn/shared';
import type { AcpLogEntry } from './acpConverter.js';
import { debugBus } from '../debugBus.js';
import { fetchWithTimeout, type TimedFetchResponse } from '../httpTimeout.js';

/** Headers-in deadline for opening the SSE stream (the body then streams
 *  unbounded — idle detection lives in streamer.ts). */
const STREAM_OPEN_TIMEOUT_MS = 30_000;

/**
 * Default model for PostHog Code runs. The API requires a model on every
 * cloud run (the `run/` endpoint 400s with `model is required when selecting
 * a cloud runtime` otherwise), so this is the fallback whenever the task /
 * env / UI didn't pin one.
 *
 * Derived from `@talyn/shared` rather than restated, so the backend fallback and
 * the two pickers cannot disagree about what the current model is.
 */
export const DEFAULT_POSTHOG_CODE_MODEL: string = DEFAULT_POSTHOG_CODE_MODEL_ID;

/**
 * A non-2xx response from the PostHog Code API, carrying the HTTP `status`
 * so callers can branch (notably the cloud poller backing a workspace off on
 * a 429) without string-matching the message. `retryAfterMs` is the parsed
 * `Retry-After` for a 429, else null. The message is unchanged from the old
 * plain-Error format, so any existing text matching still holds.
 */
export class PostHogCodeApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'PostHogCodeApiError';
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms, or null. */
function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Resolves the bearer token for a request.
 *
 * A function rather than a string because an OAuth access token lives one hour:
 * the token has to be fetched per request (cheap — usually a memoised read) and
 * re-fetched with `forceRefresh` when the API says 401, which is what a token
 * revoked or rotated out from under us looks like.
 */
export type PostHogTokenSource = (opts?: { forceRefresh?: boolean }) => Promise<string>;

/**
 * Thin typed wrapper over the PostHog Code (tasks) REST API.
 *
 * Auth is a bearer token — either a personal API key (`phx_`) or an OAuth access
 * token (`pha_`); the API treats them identically, including scope and per-project
 * enforcement. Every call is scoped to a project (team) id and a host (us/eu cloud
 * or a self-hosted instance). See https://posthog.com/docs/api/tasks and
 * .../task-runs for the underlying endpoints.
 *
 * This client is intentionally stateless — credentials are passed in by
 * the caller (resolved per-workspace) rather than held on a singleton.
 */
export class PostHogCodeClient {
  private readonly getToken: PostHogTokenSource;
  /** Whether a 401 is worth one retry. A fixed personal API key that 401s will
   *  401 again; only a refreshable token source can turn it around. */
  private readonly canRefresh: boolean;

  constructor(
    token: string | PostHogTokenSource,
    private readonly projectId: string,
    private readonly host: string,
  ) {
    this.canRefresh = typeof token === 'function';
    this.getToken = typeof token === 'function' ? token : async () => token;
  }

  /** Create a task. Returns the new task's id. */
  async createTask(input: {
    title: string;
    description: string;
    repository: string;
  }): Promise<PostHogTask> {
    return this.request<PostHogTask>('POST', `/tasks/`, {
      title: input.title,
      description: input.description,
      origin_product: 'user_created',
      repository: input.repository,
    });
  }

  /**
   * Kick off a background run for a task. The endpoint returns the parent
   * *task* (not the run) — the new run is on `task.latest_run`, and its
   * `latest_run.id` is the run id used by the logs/stream endpoints.
   */
  async startRun(
    taskId: string,
    input: { runtimeAdapter: PostHogCodeRuntimeAdapter; model: string },
  ): Promise<PostHogTask> {
    // `model` is required by the API for a cloud runtime — always send it.
    return this.request<PostHogTask>('POST', `/tasks/${taskId}/run/`, {
      mode: 'background',
      runtime_adapter: input.runtimeAdapter,
      model: input.model,
    });
  }

  /** Fetch a task, including its `latest_run` (status, branch, output, …). */
  async getTask(taskId: string): Promise<PostHogTask> {
    return this.request<PostHogTask>('GET', `/tasks/${taskId}/`);
  }

  /** Fetch a single run by id. */
  async getRun(taskId: string, runId: string): Promise<PostHogRun> {
    return this.request<PostHogRun>('GET', `/tasks/${taskId}/runs/${runId}/`);
  }

  /** Fetch a run's log text. Best-effort — shape varies, returned raw. */
  async getRunLogs(taskId: string, runId: string): Promise<unknown> {
    return this.request<unknown>('GET', `/tasks/${taskId}/runs/${runId}/logs/`);
  }

  /**
   * Cancel a run through PostHog's dedicated action: it interrupts the agent's
   * current turn, tears down the sandbox and marks the run cancelled, and it
   * still cleans up when the run's workflow is already gone. A PATCH to
   * `status: cancelled` only flips the row. Idempotent on a finished run
   * (200 with the run unchanged); 202 when the cancellation was accepted.
   */
  async cancelRun(taskId: string, runId: string): Promise<PostHogRun> {
    return this.request<PostHogRun>('POST', `/tasks/${taskId}/runs/${runId}/cancel/`, {
      reason: 'Stopped from Talyn',
    });
  }

  /**
   * One page of a run's durable (S3) log, resume chain included, oldest first.
   * Pages are capped by bytes as well as `limit` (max 5000), so `hasMore` is
   * the only end-of-log signal; page with `offset`, not `after`.
   */
  async getSessionLogs(
    taskId: string,
    runId: string,
    opts: { after?: string; limit?: number; offset?: number } = {},
  ): Promise<SessionLogsPage> {
    const qs = new URLSearchParams();
    if (opts.after) qs.set('after', opts.after);
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.offset) qs.set('offset', String(opts.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const { data, headers } = await this.requestWithHeaders<unknown>(
      'GET',
      `/tasks/${taskId}/runs/${runId}/session_logs/${suffix}`,
    );
    const matching = Number(headers.get('x-matching-count'));
    return {
      entries: Array.isArray(data) ? (data as AcpLogEntry[]) : [],
      hasMore: headers.get('x-has-more') === 'true',
      matchingCount: headers.has('x-matching-count') && Number.isFinite(matching) ? matching : null,
    };
  }

  /**
   * Open the live SSE stream for a run. Returns the raw `fetch` Response
   * whose body is the `text/event-stream`; the caller parses frames.
   * `lastEventId` resumes from a Redis stream id; without it the server
   * replays only the newest 5,000 entries. `startLatest` skips that replay
   * for a caller that seeded from `getSessionLogs`, and is ignored once a
   * `lastEventId` exists, since "latest" would skip what arrived meanwhile.
   */
  async openRunStream(
    taskId: string,
    runId: string,
    opts: { lastEventId?: string; startLatest?: boolean; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const start = opts.startLatest && !opts.lastEventId ? '?start=latest' : '';
    const url = `${this.baseUrl}/tasks/${taskId}/runs/${runId}/stream/${start}`;
    // The stream authenticates once, at connect: an access token expiring
    // mid-body doesn't drop the connection, and the streamer's own reconnect
    // (Last-Event-ID) picks up a fresh token here.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.getToken()}`,
      Accept: 'text/event-stream',
    };
    if (opts.lastEventId) headers['Last-Event-ID'] = opts.lastEventId;
    // Bound only the connect (headers-in): a stalled handshake must not hang
    // the streamer forever, but the SSE body itself is long-lived. The
    // caller's signal is bridged onto our controller so `stop()` still
    // aborts mid-body after the connect timer is disarmed.
    const controller = new AbortController();
    if (opts.signal?.aborted) controller.abort();
    opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const connectTimer = setTimeout(() => controller.abort(), STREAM_OPEN_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted && !opts.signal?.aborted) {
        throw new Error(
          `PostHog Code stream open timed out after ${STREAM_OPEN_TIMEOUT_MS}ms: ${url}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(connectTimer);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `PostHog Code stream open failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
    return res;
  }

  /** Cheap auth/connectivity probe. Throws on bad creds / unreachable host. */
  async ping(): Promise<void> {
    await this.request<unknown>('GET', `/tasks/?limit=1`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { data } = await this.requestWithHeaders<T>(method, path, body);
    return data;
  }

  private async requestWithHeaders<T>(
    method: string,
    path: string,
    body?: unknown,
    /** Internal: set on the one retry after a 401, so it can't loop. */
    forceRefresh = false,
  ): Promise<{ data: T; headers: Headers }> {
    const url = `${this.baseUrl}${path}`;
    const startedAt = Date.now();
    let res: TimedFetchResponse;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${await this.getToken({ forceRefresh })}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        { label: 'PostHog Code' },
      );
    } catch (err) {
      debugBus.recordHttp({
        service: 'posthog_code',
        method,
        url,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const text = res.bodyText;
    debugBus.recordHttp({
      service: 'posthog_code',
      method,
      url,
      status: res.status,
      durationMs: Date.now() - startedAt,
      ok: res.ok,
      bytes: text.length,
      ...(res.ok ? {} : { error: text.slice(0, 500) }),
    });
    // A 401 on a refreshable token means our copy is stale in a way expiry
    // bookkeeping missed — the token was revoked, or a clock drifted. Force one
    // refresh and retry; if that 401s too, it's a real auth failure and the
    // error below is what the caller (and the reconnect UI) needs to see.
    if (res.status === 401 && this.canRefresh && !forceRefresh) {
      return this.requestWithHeaders<T>(method, path, body, true);
    }
    if (!res.ok) {
      throw new PostHogCodeApiError(
        res.status,
        res.status === 429 ? parseRetryAfterMs(res.headers) : null,
        `PostHog Code ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    return { data: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
  }

  private get baseUrl(): string {
    const host = this.host.replace(/\/+$/, '');
    return `${host}/api/projects/${this.projectId}`;
  }
}

export interface SessionLogsPage {
  entries: AcpLogEntry[];
  hasMore: boolean;
  matchingCount: number | null;
}

/**
 * Partial PostHog task shape — only the fields we read. The API returns
 * more; we stay permissive and ignore the rest.
 */
export interface PostHogTask {
  id: string;
  title?: string;
  repository?: string | null;
  latest_run?: PostHogRun | null;
  [k: string]: unknown;
}

export type PostHogRunStatus =
  | 'not_started'
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PostHogRun {
  id: string;
  status?: PostHogRunStatus;
  branch?: string | null;
  /** Free-form output the agent left behind (may contain the PR URL). */
  output?: unknown;
  state?: unknown;
  error_message?: string | null;
  log_url?: string | null;
  runtime_adapter?: string;
  model?: string;
  /** Bumps on real run-state progress; goes stale when the agent is idle. */
  updated_at?: string | null;
  completed_at?: string | null;
  [k: string]: unknown;
}
