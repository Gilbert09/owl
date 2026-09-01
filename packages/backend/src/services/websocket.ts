import { WebSocketServer, WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import type {
  AgentEvent,
  BillingStatus,
  DebugEvent,
  Environment,
  MergeQueueBlockedEvent,
  Task,
  TaskStatus,
  WSEvent,
} from '@talyn/shared';
import { domainEvents } from './events.js';
import { debugBus, matchesOwnerFilter, type DebugOwnerFilter } from './debugBus.js';
import { setLocalDelivery, publishBroadcast, publishToWorkspace, publishToUser } from './wsBus.js';
import { verifyTokenAndGetUser, AuthError, type AuthUser } from '../middleware/auth.js';
import { getDbClient } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

// Store connected clients
const clients = new Set<WebSocket>();

// Store subscriptions (client -> workspaceIds) and identities.
const subscriptions = new Map<WebSocket, Set<string>>();
const connectionUsers = new Map<WebSocket, AuthUser>();
// Per-client owner filter for the admin Debug stream. Absent = all owners.
const debugFilters = new Map<WebSocket, DebugOwnerFilter>();

/**
 * Fan a debug event out only to ADMIN clients, and only to those whose current
 * owner filter matches — so a non-admin never receives debug data and an admin
 * watching a single user isn't fed everyone else's traffic over the wire.
 * Bypasses `broadcast()` (which would hit every client) for exactly this reason.
 */
function fanOutDebugEvent(event: DebugEvent): void {
  let message: string | null = null;
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!connectionUsers.get(client)?.isAdmin) continue;
    if (!matchesOwnerFilter(event.ownerId, debugFilters.get(client))) continue;
    if (message === null) {
      message = JSON.stringify({
        type: 'debug:event',
        payload: event,
        timestamp: event.timestamp,
      });
    }
    client.send(message);
  }
}

/** How long a freshly-upgraded socket has to send its `auth` frame before we
 *  close it. Generous so a backend under DB-connection pressure (the webhook
 *  worker once starved WS auth) doesn't drop legitimate clients mid-handshake.
 *  Injectable so tests can use a short window instead of waiting the full 10s. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export function setupWebSocket(
  wss: WebSocketServer,
  handshakeTimeoutMs: number = DEFAULT_HANDSHAKE_TIMEOUT_MS
): void {
  // Wire the debug bus to the live client fan-out + connection count. Kept
  // here (not in debugBus) so debugBus stays dependency-free.
  debugBus.setClientCounter(() => clients.size);
  debugBus.setLiveSink(fanOutDebugEvent);

  // Let wsBus deliver events that arrive from OTHER replicas to our local
  // clients. We hand it the local-only delivery functions (not the public
  // broadcasters) so a remote event isn't re-published into a loop.
  setLocalDelivery({
    all: deliverBroadcastLocal,
    workspace: deliverToWorkspaceLocal,
    user: deliverToUserLocal,
  });

  wss.on('connection', async (ws: WebSocket) => {
    // Accept the upgrade anonymously. The client must send an
    // `{type:'auth', token}` message within the handshake window
    // or the socket is closed. Keeping the token out of the URL
    // stops it leaking into access logs, Railway edge logs, and
    // monitoring tool URL captures.
    let authenticated = false;
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) {
        console.warn('WebSocket auth timeout; closing');
        ws.close(4401, 'auth timeout');
      }
    }, handshakeTimeoutMs);

    ws.on('message', async (data: Buffer) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch (err) {
        console.error('Invalid WebSocket message:', err);
        return;
      }

      if (!authenticated) {
        const m = message as { type?: unknown; token?: unknown };
        if (m.type !== 'auth' || typeof m.token !== 'string') {
          ws.close(4401, 'expected auth');
          return;
        }
        let user: AuthUser | null = null;
        let unavailable = false;
        try {
          user = await verifyTokenAndGetUser(m.token);
        } catch (err) {
          // 'unavailable' = we couldn't CHECK the token (Supabase/JWKS down),
          // not that it's bad — close with 1013 (try again later) so the
          // client's backoff loop retries instead of reading it as an auth
          // rejection. Everything else stays 4401.
          unavailable = err instanceof AuthError && err.code === 'unavailable';
          if (unavailable) console.error('WebSocket auth check unavailable:', err);
        }
        if (!user) {
          ws.close(unavailable ? 1013 : 4401, unavailable ? 'auth unavailable' : 'invalid token');
          return;
        }
        authenticated = true;
        clearTimeout(handshakeTimer);
        clients.add(ws);
        subscriptions.set(ws, new Set());
        connectionUsers.set(ws, user);
        debugBus.recordWs({
          action: 'connect',
          summary: `client connected (${clients.size} total)`,
          meta: { userId: user.id, clients: clients.size },
        });
        console.log(`WebSocket client connected (user=${user.id})`);
        sendToClient(ws, {
          type: 'connection:status',
          payload: { connected: true },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      void handleMessage(ws, message);
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      if (authenticated) {
        console.log('WebSocket client disconnected');
        debugBus.recordWs({
          action: 'disconnect',
          summary: `client disconnected (${Math.max(0, clients.size - 1)} left)`,
        });
      }
      clients.delete(ws);
      subscriptions.delete(ws);
      connectionUsers.delete(ws);
      debugFilters.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      clearTimeout(handshakeTimer);
      clients.delete(ws);
      subscriptions.delete(ws);
      connectionUsers.delete(ws);
      debugFilters.delete(ws);
    });
  });
}

async function handleMessage(ws: WebSocket, message: any): Promise<void> {
  // Inbound message trace. Skip `ping` — it fires every 25s per client and
  // would drown out the signal.
  if (message?.type && message.type !== 'ping') {
    debugBus.recordWs({
      action: 'recv',
      summary: `recv ${message.type}${message.workspaceId ? ` ${String(message.workspaceId).slice(0, 8)}` : ''}`,
      meta: { type: message.type },
    });
  }
  switch (message.type) {
    case 'subscribe': {
      // Only allow subscribing to a workspace the connected user owns.
      if (!message.workspaceId) break;
      const user = connectionUsers.get(ws);
      if (!user) break;
      const allowed = await userOwnsWorkspace(user.id, message.workspaceId);
      if (allowed) {
        subscriptions.get(ws)?.add(message.workspaceId);
      }
      break;
    }

    case 'unsubscribe':
      if (message.workspaceId) {
        subscriptions.get(ws)?.delete(message.workspaceId);
      }
      break;

    case 'debug:filter': {
      // Admin-only: set which owner's debug events this client receives live.
      // `owner` is an account id, 'system', 'all', or null. Non-admins are
      // ignored (they never receive debug events regardless).
      if (!connectionUsers.get(ws)?.isAdmin) break;
      const owner = message.owner;
      debugFilters.set(ws, typeof owner === 'string' ? (owner as DebugOwnerFilter) : undefined);
      break;
    }

    case 'ping':
      sendToClient(ws, {
        type: 'connection:status',
        payload: { pong: true },
        timestamp: new Date().toISOString(),
      });
      break;

    default:
      console.log('Unknown WebSocket message type:', message.type);
  }
}

async function userOwnsWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const db = getDbClient();
  const rows = await db
    .select({ ownerId: workspacesTable.ownerId })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return rows[0]?.ownerId === userId;
}

function sendToClient(ws: WebSocket, event: WSEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

// Deliver to this replica's local clients only. Shared by the public
// broadcasters and by wsBus when re-delivering an event from another replica.
function deliverBroadcastLocal(event: WSEvent): void {
  const message = JSON.stringify(event);
  let sent = 0;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      sent++;
    }
  }
  // CRITICAL loop-guard: recording a debug:event broadcast would feed the
  // live sink, which broadcasts another debug:event → infinite recursion.
  if (event.type !== 'debug:event') {
    debugBus.recordWs({
      action: 'broadcast',
      summary: `broadcast ${event.type} → ${sent} client${sent === 1 ? '' : 's'}`,
      meta: { type: event.type, recipients: sent },
    });
  }
}

function deliverToWorkspaceLocal(workspaceId: string, event: WSEvent): void {
  const message = JSON.stringify(event);
  let sent = 0;
  for (const [client, workspaces] of subscriptions) {
    if (workspaces.has(workspaceId) && client.readyState === WebSocket.OPEN) {
      client.send(message);
      sent++;
    }
  }
  if (event.type !== 'debug:event') {
    debugBus.recordWs({
      action: 'broadcast',
      summary: `broadcast ${event.type} → ws:${workspaceId.slice(0, 8)} (${sent})`,
      meta: { type: event.type, workspaceId, recipients: sent },
    });
  }
}

function deliverToUserLocal(userId: string, event: WSEvent): void {
  const message = JSON.stringify(event);
  let sent = 0;
  for (const [client, user] of connectionUsers) {
    if (user.id === userId && client.readyState === WebSocket.OPEN) {
      client.send(message);
      sent++;
    }
  }
  if (event.type !== 'debug:event') {
    debugBus.recordWs({
      action: 'broadcast',
      summary: `broadcast ${event.type} → user:${userId.slice(0, 8)} (${sent})`,
      meta: { type: event.type, userId, recipients: sent },
    });
  }
}

// Broadcast to all clients — local, then fan out to the other replicas.
export function broadcast(event: WSEvent): void {
  deliverBroadcastLocal(event);
  publishBroadcast(event);
}

// Broadcast to clients subscribed to a specific workspace — local, then fan out.
export function broadcastToWorkspace(workspaceId: string, event: WSEvent): void {
  deliverToWorkspaceLocal(workspaceId, event);
  publishToWorkspace(workspaceId, event);
}

// Broadcast to every connection authenticated as `userId` — local, then fan
// out. For owner-level (not workspace-level) resources like environment
// markers, where a global broadcast would leak rows across tenants.
export function broadcastToUser(userId: string, event: WSEvent): void {
  deliverToUserLocal(userId, event);
  publishToUser(userId, event);
}

// Helper functions for common events
export function emitTaskStatus(workspaceId: string, taskId: string, status: string, result?: any): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:status',
    payload: { taskId, status, result },
    timestamp: new Date().toISOString(),
  });
  domainEvents.emit('task:status', {
    workspaceId,
    taskId,
    status: status as TaskStatus,
  });
}

export function emitTaskUpdate(
  workspaceId: string,
  taskId: string,
  updates: Partial<Task>
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:update',
    payload: { taskId, updates },
    timestamp: new Date().toISOString(),
  });
}

export function emitTaskDeleted(workspaceId: string, taskId: string): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:deleted',
    payload: { taskId },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Fired when a task is created. The desktop adds it to the task list live
 * (deduped by id), so backend-created tasks — merge-queue / auto-keep fix runs
 * — show up in the Tasks screen and the PR task badge resolves to a real task.
 */
export function emitTaskCreated(workspaceId: string, task: Task): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:created',
    payload: { task },
    timestamp: new Date().toISOString(),
  });
}

export function emitTaskEvent(
  workspaceId: string,
  taskId: string,
  event: AgentEvent
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:event',
    payload: { taskId, event },
    timestamp: new Date().toISOString(),
  });
}

export interface ChangedFileEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  added: number;
  removed: number;
  binary: boolean;
}

export function emitTaskFilesChanged(
  workspaceId: string,
  taskId: string,
  files: ChangedFileEntry[]
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:files_changed',
    payload: { taskId, files },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Fired after every prCache upsert. The payload carries enough for the
 * GitHub page table + the task screen pill to patch in place without a
 * round-trip:
 *
 *   - id (pull_requests.id)
 *   - taskId (nullable)
 *   - the full lastSummary jsonb shape
 *   - state (open/closed/merged)
 *
 * Recent reviews/comments arrays are NOT included — those are
 * delta-detection inputs and the detail panel paginates on demand.
 */
export function emitPullRequestUpdated(
  workspaceId: string,
  payload: {
    id: string;
    taskId: string | null;
    repositoryId: string;
    owner: string;
    repo: string;
    number: number;
    state: string;
    lastSummary: Record<string, unknown>;
    // Relationship flags — present so the GitHub page can re-bucket a row
    // (Mine / Review) live, e.g. when a PR drops off Review after the user
    // reviews it. Optional: emitters that don't change them omit them.
    reviewRequested?: boolean;
    authored?: boolean;
    // Manual-watch flag. Optional for the SAME reason as the two above, but the
    // consequence is sharper: prCache's upsert and the monitor's flag reconcile
    // both emit this event and neither knows about `watching`, so a REQUIRED
    // field would cost a read-back on the hottest write path. Only the two
    // /watch routes ever set it — every other emitter omits it, and the client
    // preserves its current value with `??` (never `||`: the un-watch emit
    // sends `false` and it must not be swallowed).
    watching?: boolean;
    // Auto-keep-mergeable watcher state, so the toggle + row badge update live.
    // Optional: emitters that don't change them omit them.
    autoKeepMergeable?: boolean;
    autoMergeState?: { attempts: number; paused: boolean } | null;
    // Merge queue state, so the queue toggle + row badge update live.
    // Optional: emitters that don't change them omit them.
    mergeQueued?: boolean;
    // The merge queue's payload — full status vocabulary, per-head budgets and
    // auto-merge state (services/mergeQueue/legacy.ts toPublicMergeQueue). Was
    // emitted alongside a four-status `mergeQueueState` for builds predating
    // it; that shim was retired on 2026-09-01.
    mergeQueue?: Record<string, unknown> | null;
  }
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'pull_request:updated',
    payload,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Fired once when a merge-queue PR transitions into `blocked` (gave up after
 * its retry budget). The desktop surfaces it as an OS notification + toast.
 */
export function emitMergeQueueBlocked(
  workspaceId: string,
  payload: MergeQueueBlockedEvent
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'merge_queue:blocked',
    payload,
    timestamp: new Date().toISOString(),
  });
}

// Environments are owner-level rows, so these emits are scoped to the owning
// user — a global broadcast() here sent user A's environment rows to user B.
export function emitEnvironmentStatus(
  ownerId: string,
  environmentId: string,
  status: string,
  error?: string
): void {
  broadcastToUser(ownerId, {
    type: 'environment:status',
    payload: { environmentId, status, error },
    timestamp: new Date().toISOString(),
  });
}

export function emitEnvironmentCreated(ownerId: string, environment: Environment): void {
  broadcastToUser(ownerId, {
    type: 'environment:created',
    payload: { environment },
    timestamp: new Date().toISOString(),
  });
}

// Billing is a per-user fact — fired by the Polar webhook handler after a
// plan change so every open desktop updates without polling.
export function emitSubscriptionUpdated(ownerId: string, status: BillingStatus): void {
  broadcastToUser(ownerId, {
    type: 'subscription:updated',
    payload: status,
    timestamp: new Date().toISOString(),
  });
}
