import { EventEmitter } from 'events';
import { randomBytes, createHash } from 'crypto';
import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import {
  encodeDaemonMessage,
  type DaemonEventPayload,
  type DaemonRequestPayload,
  type DaemonMessage,
} from '@fastowl/shared';
import { getDbClient } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';
import { emitEnvironmentStatus } from './websocket.js';

/**
 * Per-process state of every daemon currently connected over WebSocket.
 * The registry is the backend's view of the world; `environmentService`
 * calls into it whenever the env's type is `daemon`.
 *
 * Pairing tokens are in-memory + short-lived (10 min). Device tokens
 * are hashed and stored in `environments.device_token_hash`.
 *
 * Connection is keyed by environmentId. If a second daemon tries to
 * pair for an env that already has one connected, the old one is
 * evicted — useful when a service restarts and the TCP half-close
 * hasn't propagated yet.
 */

interface Pairing {
  environmentId: string;
  ownerId: string;
  expiresAt: number;
}

interface ActiveDaemon {
  environmentId: string;
  ws: WebSocket;
  meta: {
    os: string;
    arch: string;
    hostname: string;
    daemonVersion: string;
  };
  /**
   * Session IDs the daemon claimed in its most recent hello. Used by
   * agent.cleanupStaleAgents to tell "backend restarted, child still
   * running" from "agent really died." Empty until a daemon sends
   * activeSessions in hello.
   */
  liveSessionIds: Set<string>;
}

class DaemonRegistry extends EventEmitter {
  private pairings = new Map<string, Pairing>(); // pairing token → env
  private active = new Map<string, ActiveDaemon>(); // environmentId → connection
  private pending = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  // Serialise DB writes for env status flips so a register()/unregister()
  // pair can't race two concurrent UPDATEs at the same row. Also lets
  // `flushPending()` (used by tests + shutdown) wait for them to settle.
  private dbTail: Promise<void> = Promise.resolve();

  init(): void {
    // No background timers today. Pairing tokens are swept inline on
    // every `authenticate` call — it's cheap (the map is tiny) and it
    // avoids a long-running setInterval that complicates test teardown.
  }

  async shutdown(): Promise<void> {
    for (const [, active] of this.active) {
      try {
        active.ws.close();
      } catch {
        // ignore
      }
    }
    this.active.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('daemon registry shutting down'));
      this.pending.delete(id);
    }
    // Drain any in-flight env-status writes before returning so tests
    // that call shutdown() + close pglite don't race with a pending UPDATE.
    await this.flushPending();
  }

  /**
   * Resolves when all fire-and-forget env-status writes queued so far
   * have settled. Useful for tests and graceful shutdown.
   */
  async flushPending(): Promise<void> {
    await this.dbTail;
  }

  private sweepExpiredPairings(now: number): void {
    for (const [token, pairing] of this.pairings) {
      if (pairing.expiresAt < now) this.pairings.delete(token);
    }
  }

  /**
   * Mint a one-shot pairing token for an existing daemon env. The
   * daemon presents this token on its very first connect; backend
   * swaps it for a long-lived device token on hello.
   */
  createPairingToken(environmentId: string, ownerId: string): string {
    const token = randomBytes(32).toString('hex');
    this.pairings.set(token, {
      environmentId,
      ownerId,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return token;
  }

  /** Called by the WS endpoint once it's parsed a hello message. */
  async authenticate(args: {
    pairingToken?: string;
    deviceToken?: string;
  }): Promise<{ environmentId: string; newDeviceToken?: string } | null> {
    const now = Date.now();
    this.sweepExpiredPairings(now);

    if (args.pairingToken) {
      const pairing = this.pairings.get(args.pairingToken);
      if (!pairing || pairing.expiresAt < now) return null;
      this.pairings.delete(args.pairingToken);

      // Pairing succeeded. Mint a long-lived device token, hash it,
      // store on the env row, return the raw value exactly once.
      const deviceToken = randomBytes(32).toString('hex');
      const hash = hashToken(deviceToken);
      await getDbClient()
        .update(environmentsTable)
        .set({ deviceTokenHash: hash, updatedAt: new Date() })
        .where(eq(environmentsTable.id, pairing.environmentId));

      return { environmentId: pairing.environmentId, newDeviceToken: deviceToken };
    }

    if (args.deviceToken) {
      const hash = hashToken(args.deviceToken);
      const rows = await getDbClient()
        .select({ id: environmentsTable.id })
        .from(environmentsTable)
        .where(eq(environmentsTable.deviceTokenHash, hash))
        .limit(1);
      if (!rows[0]) return null;
      return { environmentId: rows[0].id };
    }

    return null;
  }

  /**
   * Register a live daemon connection. Evicts any prior connection
   * for the same environment id — duplicate connects usually mean a
   * stale socket that hasn't timed out yet.
   */
  register(active: ActiveDaemon): void {
    const prior = this.active.get(active.environmentId);
    if (prior) {
      try {
        prior.ws.close(4409, 'replaced by new connection');
      } catch {
        // ignore
      }
    }
    this.active.set(active.environmentId, active);
    // Flip the env row to `connected` so the scheduler + desktop see
    // the daemon as live. touchLastSeen also bumps last_seen_at.
    this.markEnvConnected(active.environmentId);
    // Let agent-cleanup (and any other interested subscriber) know a
    // daemon reconnected so they can reconcile session state.
    this.emit('daemon:connected', active.environmentId);
  }

  /**
   * True if any connected daemon has advertised this sessionId as
   * still running. Used by agent cleanup to avoid killing in-progress
   * tasks after a backend restart.
   */
  isSessionLive(sessionId: string): boolean {
    for (const daemon of this.active.values()) {
      if (daemon.liveSessionIds.has(sessionId)) return true;
    }
    return false;
  }

  /**
   * Set of environments whose daemon is currently connected. Used by
   * agent cleanup to decide which env's agents might still be live.
   */
  connectedEnvironmentIds(): Set<string> {
    return new Set(this.active.keys());
  }

  /** Called when the WS closes. */
  unregister(environmentId: string): void {
    this.active.delete(environmentId);
    this.markEnvDisconnected(environmentId);
    // Reject anything still waiting — the backend-side caller will
    // bubble up a "daemon disconnected" error.
    for (const [id, pending] of this.pending) {
      if (id.startsWith(`${environmentId}:`)) {
        clearTimeout(pending.timer);
        pending.reject(new Error('daemon disconnected'));
        this.pending.delete(id);
      }
    }
  }

  /**
   * Queue an env-status flip on the shared dbTail. Serialising means two
   * register()/unregister() calls in quick succession can't issue two
   * UPDATEs concurrently — which under pglite (test harness) races at
   * the WASM layer and has been seen to hang the worker entirely.
   */
  private queueEnvStatus(
    environmentId: string,
    apply: () => Promise<void>,
    label: string
  ): void {
    this.dbTail = this.dbTail
      .then(apply)
      .catch((err) => console.error(`daemonRegistry: ${label} failed:`, err));
  }

  private markEnvConnected(environmentId: string): void {
    const active = this.active.get(environmentId);
    const daemonVersion = active?.meta.daemonVersion;
    this.queueEnvStatus(
      environmentId,
      async () => {
        const now = new Date();
        const patch: Record<string, unknown> = {
          status: 'connected',
          lastSeenAt: now,
          lastConnected: now,
          error: null,
        };
        // Persist the daemon's version string so the desktop can show
        // it in Settings even when the env is momentarily disconnected.
        if (daemonVersion) patch.daemonVersion = daemonVersion;
        await getDbClient()
          .update(environmentsTable)
          .set(patch)
          .where(eq(environmentsTable.id, environmentId));
        emitEnvironmentStatus(environmentId, 'connected');
      },
      'mark connected'
    );
  }

  private markEnvDisconnected(environmentId: string): void {
    this.queueEnvStatus(
      environmentId,
      async () => {
        await getDbClient()
          .update(environmentsTable)
          .set({ status: 'disconnected' })
          .where(eq(environmentsTable.id, environmentId));
        emitEnvironmentStatus(environmentId, 'disconnected');
      },
      'mark disconnected'
    );
  }

  /** Is the daemon for this env currently connected? */
  isConnected(environmentId: string): boolean {
    return this.active.has(environmentId);
  }

  listConnected(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Send a request to a daemon and await its response. Rejects if the
   * daemon disconnects before replying or the 30s timeout fires.
   */
  async request<TResult = unknown>(
    environmentId: string,
    payload: DaemonRequestPayload,
    timeoutMs = 30_000
  ): Promise<TResult> {
    const active = this.active.get(environmentId);
    if (!active) throw new Error(`daemon not connected for env ${environmentId}`);

    const id = `${environmentId}:${randomBytes(8).toString('hex')}`;
    const message: DaemonMessage = { kind: 'request', id, payload };

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (data) => resolve(data as TResult),
        reject,
        timer,
      });
      try {
        active.ws.send(encodeDaemonMessage(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Resolve a pending request when the matching response arrives. */
  resolveResponse(id: string, ok: boolean, data: unknown, error?: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (ok) pending.resolve(data);
    else pending.reject(new Error(error ?? 'daemon request failed'));
  }

  /** Handle an event (unsolicited message) from a daemon. */
  handleEvent(environmentId: string, event: DaemonEventPayload): void {
    // We intentionally don't touch `last_seen_at` on every event —
    // session.data can fire hundreds of times per second. The liveness
    // signal lives on register() plus a future heartbeat loop.
    this.emit(event.type, environmentId, event);
  }

}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const daemonRegistry = new DaemonRegistry();
