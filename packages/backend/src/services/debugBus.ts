import type {
  DebugCategory,
  DebugEvent,
  DebugOwner,
  DebugPollerState,
  DebugSnapshot,
  DebugWebhookLag,
} from '@talyn/shared';
import { graphqlBudget } from './graphqlBudget.js';
import { mergeableSettleStats } from './mergeableSettle.js';

/**
 * Owner filter for the admin Debug panel. A FastOwl account id shows only that
 * account's attributed activity; 'system' shows backend-internal activity not
 * tied to one account; undefined / 'all' shows everything.
 */
export type DebugOwnerFilter = string | 'all' | 'system' | undefined;

/** Does an event/card with `ownerId` match the given filter? */
export function matchesOwnerFilter(
  ownerId: string | null | undefined,
  filter: DebugOwnerFilter,
): boolean {
  if (!filter || filter === 'all') return true;
  if (filter === 'system') return !ownerId;
  return ownerId === filter;
}

/**
 * In-process observability bus for the developer Debug panel.
 *
 * Every interesting internal activity — outbound HTTP, poll ticks, WebSocket
 * traffic, domain events — is recorded here as a {@link DebugEvent}. Events
 * are held in a bounded ring buffer (backfill for a panel that opens late) and
 * pushed live to a registered sink (the WebSocket broadcast).
 *
 * This module deliberately imports nothing from the services it observes — the
 * live sink and the WS client count are injected as callbacks — so it can be
 * imported from anywhere (github, websocket, the pollers, …) with no risk of a
 * circular dependency.
 *
 * Recording captures METADATA ONLY. Never pass request/response bodies, auth
 * headers, or tokens; URLs are stripped of their query string by
 * {@link redactUrl} at the call site.
 */

const MAX_EVENTS = 1000;
const MAX_ERROR_LEN = 500;

type LiveSink = (event: DebugEvent) => void;
type ClientCounter = () => number;

/** Strip the query string (and any credentials) from a URL for safe display. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

function truncate(s: string): string {
  return s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN)}…` : s;
}

/** Human-readable byte size for event summaries (e.g. "4.2 KB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

class DebugBus {
  private buffer: DebugEvent[] = [];
  private seq = 0;
  private enabled = true;
  private sink: LiveSink | null = null;
  private clientCounter: ClientCounter | null = null;
  private counters: Record<string, number> = {};
  // Cumulative Postgres traffic since the last clear, surfaced as panel tiles.
  private dbRequestCount = 0;
  private dbEgressBytes = 0;
  // Rolling window of recent webhook enqueue→pickup latencies (ms), for the
  // consumer-lag tile. Bounded ring — only the tail matters. The worker runs two
  // lanes (fast check_run/check_suite firehose vs the bounded refreshPr lane for
  // pull_request/review/comment), so we keep a window per lane: `webhookLatencies`
  // is the fast firehose; `webhookSlowLatencies` is how far behind the slow lane
  // is once the firehose itself is caught up.
  private webhookLatencies: number[] = [];
  private webhookSlowLatencies: number[] = [];
  private lastWebhookProcessedAt: string | null = null;
  private lastWebhookSlowProcessedAt: string | null = null;
  private static readonly WEBHOOK_LAG_WINDOW = 50;
  private pollers = new Map<string, DebugPollerState>();
  // Attribution: which FastOwl account owns a workspace's activity, so events
  // can be filtered by user in the admin panel. Populated by the github service
  // as it loads/connects tokens.
  private workspaceOwners = new Map<string, { ownerId: string; label: string }>();
  // Distinct accounts seen, for the panel's user-filter dropdown.
  private owners = new Map<string, string>();

  /** Global kill-switch. Recording is a cheap no-op while disabled. */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /**
   * Whether recording is on. Lets a hot call site (e.g. the DB egress meter)
   * skip expensive measurement work — serializing a multi-MB result row — when
   * the panel isn't watching.
   */
  isRecording(): boolean {
    return this.enabled;
  }

  /** Registered by websocket.ts to fan each event out to connected clients. */
  setLiveSink(fn: LiveSink | null): void {
    this.sink = fn;
  }

  /** Registered by websocket.ts so the snapshot can report live client count. */
  setClientCounter(fn: ClientCounter | null): void {
    this.clientCounter = fn;
  }

  /**
   * Map a workspace to the FastOwl account that owns it, so activity tagged
   * with that workspace can be attributed to (and filtered by) the account.
   * `label` is a human-readable handle (email or GitHub username).
   */
  registerOwner(workspaceId: string, ownerId: string, label: string): void {
    this.workspaceOwners.set(workspaceId, { ownerId, label });
    this.owners.set(ownerId, label);
  }

  private resolveOwner(workspaceId?: string): {
    ownerId: string | null;
    ownerLabel: string | null;
  } {
    if (!workspaceId) return { ownerId: null, ownerLabel: null };
    const o = this.workspaceOwners.get(workspaceId);
    return o ? { ownerId: o.ownerId, ownerLabel: o.label } : { ownerId: null, ownerLabel: null };
  }

  record(input: Omit<DebugEvent, 'id' | 'timestamp'>): void {
    if (!this.enabled) return;
    const event: DebugEvent = {
      ...input,
      summary: truncate(input.summary),
      id: ++this.seq,
      timestamp: new Date().toISOString(),
    };
    this.buffer.push(event);
    if (this.buffer.length > MAX_EVENTS) this.buffer.shift();
    this.counters[event.category] = (this.counters[event.category] ?? 0) + 1;
    if (this.sink) {
      try {
        this.sink(event);
      } catch {
        // The sink (a WS broadcast) must never break recording.
      }
    }
  }

  // ---- Typed convenience recorders ---------------------------------------

  recordHttp(input: {
    service: string;
    method: string;
    url: string;
    status?: number;
    durationMs: number;
    ok: boolean;
    bytes?: number;
    error?: string;
    /** Workspace the call was made for, so it can be attributed to an owner. */
    workspaceId?: string;
  }): void {
    const path = redactUrl(input.url);
    const status = input.status ?? (input.ok ? 200 : 'ERR');
    this.record({
      category: 'http',
      service: input.service,
      action: 'request',
      ok: input.ok,
      summary: `${input.method} ${path} → ${status} ${Math.round(input.durationMs)}ms`,
      durationMs: input.durationMs,
      ...this.resolveOwner(input.workspaceId),
      meta: {
        status: input.status,
        ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
        ...(input.error ? { error: truncate(input.error) } : {}),
      },
    });
  }

  /**
   * Record one Postgres query and the (estimated) bytes its result pulled
   * back. Feeds both the `db` event stream and the cumulative egress / request
   * tiles. `bytes` is the serialized size of the result rows — an estimate of
   * wire egress, not exact, but enough to spot which queries dominate.
   */
  recordDbQuery(input: {
    operation: string;
    table?: string | null;
    durationMs: number;
    ok: boolean;
    bytes: number;
    rows?: number;
    error?: string;
  }): void {
    if (!this.enabled) return;
    const bytes = Number.isFinite(input.bytes) ? Math.max(0, Math.round(input.bytes)) : 0;
    this.dbRequestCount += 1;
    this.dbEgressBytes += bytes;
    const label = input.table ? `${input.operation} ${input.table}` : input.operation;
    const rowsPart =
      input.rows !== undefined ? ` · ${input.rows} row${input.rows === 1 ? '' : 's'}` : '';
    this.record({
      category: 'db',
      service: 'postgres',
      action: input.operation.toLowerCase(),
      ok: input.ok,
      summary: input.ok
        ? `${label} → ${formatBytes(bytes)}${rowsPart} ${Math.round(input.durationMs)}ms`
        : `${label} failed`,
      durationMs: input.durationMs,
      meta: {
        bytes,
        ...(input.rows !== undefined ? { rows: input.rows } : {}),
        ...(input.table ? { table: input.table } : {}),
        ...(input.error ? { error: truncate(input.error) } : {}),
      },
    });
  }

  recordWs(input: {
    action: string;
    summary: string;
    ok?: boolean;
    meta?: Record<string, unknown>;
  }): void {
    this.record({
      category: 'websocket',
      service: 'ws',
      action: input.action,
      ok: input.ok ?? true,
      summary: input.summary,
      meta: input.meta,
    });
  }

  recordEvent(input: {
    service: string;
    action: string;
    summary: string;
    ok?: boolean;
    meta?: Record<string, unknown>;
    workspaceId?: string;
  }): void {
    this.record({
      category: 'event',
      service: input.service,
      action: input.action,
      ok: input.ok ?? true,
      summary: input.summary,
      ...this.resolveOwner(input.workspaceId),
      meta: input.meta,
    });
  }

  /**
   * Record one inbound GitHub webhook delivery, at one of its lifecycle points:
   *   - 'received'  — signature verified + enqueued (or dropped at the filter)
   *   - 'processed' — a worker drained it and fanned it out
   * Drives the Debug panel's webhook tiles (throughput, signature failures,
   * drops-by-reason, enqueue→process latency, fan-out factor). Metadata only.
   */
  recordWebhook(input: {
    action: 'received' | 'processed';
    eventType: string;
    /** The GitHub event's action sub-type (`opened`, `synchronize`, `submitted`, …). */
    ghAction?: string;
    /** The repo the delivery is about (`owner/repo`). */
    repo?: string;
    /** PR number(s) the delivery touches. */
    prNumbers?: number[];
    delivery?: string;
    signature?: 'valid' | 'invalid' | 'missing';
    ok: boolean;
    durationMs?: number;
    queued?: boolean;
    dropReason?: string;
    /** How many (workspace, PR) targets this delivery fanned out to. */
    fanout?: number;
    /** enqueue→pickup latency for a processed delivery. */
    latencyMs?: number;
    /** Which worker lane processed it — splits the lag gauge by lane. */
    lane?: 'fast' | 'slow';
    workspaceId?: string;
    error?: string;
  }): void {
    // Feed the consumer-lag gauge: how long this delivery waited between the
    // receiver enqueuing it and the worker picking it up. The fast firehose feeds
    // the overall gauge; the slow (refreshPr) lane also feeds its own so a
    // backed-up refresh pool is visible even when the firehose is at zero.
    if (input.action === 'processed' && input.latencyMs !== undefined) {
      const ms = Math.max(0, Math.round(input.latencyMs));
      this.webhookLatencies.push(ms);
      if (this.webhookLatencies.length > DebugBus.WEBHOOK_LAG_WINDOW) {
        this.webhookLatencies.shift();
      }
      this.lastWebhookProcessedAt = new Date().toISOString();
      if (input.lane === 'slow') {
        this.webhookSlowLatencies.push(ms);
        if (this.webhookSlowLatencies.length > DebugBus.WEBHOOK_LAG_WINDOW) {
          this.webhookSlowLatencies.shift();
        }
        this.lastWebhookSlowProcessedAt = new Date().toISOString();
      }
    }
    const verb = input.action === 'received' ? 'recv' : 'proc';
    // "pull_request.synchronize acme/widgets #7" — what the delivery was *for*.
    const subject =
      `${input.eventType}${input.ghAction ? `.${input.ghAction}` : ''}` +
      (input.repo ? ` ${input.repo}` : '') +
      (input.prNumbers && input.prNumbers.length
        ? ` ${input.prNumbers.map((n) => `#${n}`).join(',')}`
        : '');
    const detail =
      input.action === 'received'
        ? input.dropReason
          ? `dropped (${input.dropReason})`
          : input.queued
            ? 'queued'
            : input.signature === 'invalid'
              ? 'bad signature'
              : 'ok'
        : `${input.fanout ?? 0} refresh${input.fanout === 1 ? '' : 'es'}${input.latencyMs !== undefined ? ` · ${Math.round(input.latencyMs)}ms lag` : ''}`;
    this.record({
      category: input.ok ? 'webhook' : 'error',
      service: 'github_webhooks',
      action: input.action,
      ok: input.ok,
      summary: `${verb} ${subject} → ${detail}`,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...this.resolveOwner(input.workspaceId),
      meta: {
        eventType: input.eventType,
        ...(input.ghAction ? { ghAction: input.ghAction } : {}),
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.prNumbers && input.prNumbers.length ? { prNumbers: input.prNumbers } : {}),
        ...(input.delivery ? { delivery: input.delivery } : {}),
        ...(input.signature ? { signature: input.signature } : {}),
        ...(input.dropReason ? { dropReason: input.dropReason } : {}),
        ...(input.fanout !== undefined ? { fanout: input.fanout } : {}),
        ...(input.latencyMs !== undefined ? { latencyMs: Math.round(input.latencyMs) } : {}),
        ...(input.error ? { error: truncate(input.error) } : {}),
      },
    });
  }

  // ---- Poller registry ----------------------------------------------------

  /**
   * Register or update a poll loop's reported cadence. `baseIntervalMs` is the
   * un-throttled cadence; pass it for an adaptive loop (one that re-registers a
   * stretched `intervalMs` each tick) so the panel can show it's been slowed.
   * Omitted, the base tracks `intervalMs` (a fixed-cadence loop is never
   * "throttled").
   */
  registerPoller(
    name: string,
    intervalMs: number,
    description: string,
    baseIntervalMs?: number,
  ): void {
    const existing = this.pollers.get(name);
    if (existing) {
      existing.intervalMs = intervalMs;
      existing.description = description;
      if (baseIntervalMs !== undefined) existing.baseIntervalMs = baseIntervalMs;
      return;
    }
    this.pollers.set(name, {
      name,
      description,
      intervalMs,
      baseIntervalMs: baseIntervalMs ?? intervalMs,
      tickCount: 0,
      lastTickAt: null,
      lastDurationMs: null,
      lastOk: null,
      lastError: null,
    });
  }

  pollerTick(
    name: string,
    input: { durationMs: number; ok: boolean; summary?: string; error?: string },
  ): void {
    let p = this.pollers.get(name);
    if (!p) {
      this.registerPoller(name, 0, '');
      p = this.pollers.get(name)!;
    }
    p.tickCount += 1;
    p.lastTickAt = new Date().toISOString();
    p.lastDurationMs = Math.round(input.durationMs);
    p.lastOk = input.ok;
    p.lastError = input.error ? truncate(input.error) : null;

    this.record({
      category: input.ok ? 'polling' : 'error',
      service: name,
      action: 'tick',
      ok: input.ok,
      summary: input.summary ?? `${name} tick ${Math.round(input.durationMs)}ms`,
      durationMs: input.durationMs,
      meta: input.error ? { error: truncate(input.error) } : undefined,
    });
  }

  // ---- Read side ----------------------------------------------------------

  getEvents(filter?: {
    category?: DebugCategory;
    service?: string;
    limit?: number;
    owner?: DebugOwnerFilter;
  }): DebugEvent[] {
    let events = this.buffer;
    if (filter?.category) events = events.filter((e) => e.category === filter.category);
    if (filter?.service) events = events.filter((e) => e.service === filter.service);
    if (filter?.owner) {
      events = events.filter((e) => matchesOwnerFilter(e.ownerId, filter.owner));
    }
    if (filter?.limit && filter.limit > 0 && events.length > filter.limit) {
      events = events.slice(events.length - filter.limit);
    }
    return events;
  }

  snapshot(): DebugSnapshot {
    const owners: DebugOwner[] = [...this.owners.entries()].map(([ownerId, label]) => ({
      ownerId,
      label,
    }));
    return {
      pollers: [...this.pollers.values()],
      counters: { ...this.counters },
      bufferSize: this.buffer.length,
      wsClients: this.clientCounter?.() ?? 0,
      graphqlBudgets: graphqlBudget.snapshot(),
      mergeableSettle: mergeableSettleStats(),
      owners,
      dbStats: { requests: this.dbRequestCount, egressBytes: this.dbEgressBytes },
      webhookLag: this.computeWebhookLag(this.webhookLatencies, this.lastWebhookProcessedAt),
      webhookLagSlow: this.computeWebhookLag(
        this.webhookSlowLatencies,
        this.lastWebhookSlowProcessedAt,
      ),
    };
  }

  /** Last / median / max enqueue→pickup lag over a lane's recent sample window. */
  private computeWebhookLag(latencies: number[], observedAt: string | null): DebugWebhookLag {
    const samples = latencies.length;
    if (samples === 0) {
      return { lastMs: 0, medianMs: 0, maxMs: 0, samples: 0, observedAt: null };
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      lastMs: latencies[latencies.length - 1],
      medianMs: sorted[Math.floor(sorted.length / 2)],
      maxMs: sorted[sorted.length - 1],
      samples,
      observedAt,
    };
  }

  clear(): void {
    this.buffer = [];
    this.counters = {};
    this.dbRequestCount = 0;
    this.dbEgressBytes = 0;
    this.webhookLatencies = [];
    this.webhookSlowLatencies = [];
    this.lastWebhookProcessedAt = null;
    this.lastWebhookSlowProcessedAt = null;
  }

  /** Test helper — drop all state including the poller registry. */
  _reset(): void {
    this.clear();
    this.pollers.clear();
    this.workspaceOwners.clear();
    this.owners.clear();
    this.seq = 0;
  }
}

export const debugBus = new DebugBus();
