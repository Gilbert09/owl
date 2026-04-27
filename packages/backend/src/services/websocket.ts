import { WebSocketServer, WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import type {
  AgentEvent,
  InboxItem,
  PermissionRequest,
  PermissionResponse,
  Task,
  TaskStatus,
  WSEvent,
} from '@fastowl/shared';
import { domainEvents } from './events.js';
import { verifyTokenAndGetUser, type AuthUser } from '../middleware/auth.js';
import { getDbClient } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

// Store connected clients
const clients = new Set<WebSocket>();

// Store subscriptions (client -> workspaceIds) and identities.
const subscriptions = new Map<WebSocket, Set<string>>();
const connectionUsers = new Map<WebSocket, AuthUser>();

export function setupWebSocket(wss: WebSocketServer): void {
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
    }, 5_000);

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
        const user = await verifyTokenAndGetUser(m.token).catch(() => null);
        if (!user) {
          ws.close(4401, 'invalid token');
          return;
        }
        authenticated = true;
        clearTimeout(handshakeTimer);
        clients.add(ws);
        subscriptions.set(ws, new Set());
        connectionUsers.set(ws, user);
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
      }
      clients.delete(ws);
      subscriptions.delete(ws);
      connectionUsers.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      clearTimeout(handshakeTimer);
      clients.delete(ws);
      subscriptions.delete(ws);
      connectionUsers.delete(ws);
    });
  });
}

async function handleMessage(ws: WebSocket, message: any): Promise<void> {
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

// Broadcast to all clients
export function broadcast(event: WSEvent): void {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Broadcast to clients subscribed to a specific workspace
export function broadcastToWorkspace(workspaceId: string, event: WSEvent): void {
  const message = JSON.stringify(event);
  for (const [client, workspaces] of subscriptions) {
    if (workspaces.has(workspaceId) && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Helper functions for common events
export function emitAgentStatus(workspaceId: string, agentId: string, status: string, attention: string): void {
  broadcastToWorkspace(workspaceId, {
    type: 'agent:status',
    payload: { agentId, status, attention },
    timestamp: new Date().toISOString(),
  });
}

export function emitAgentOutput(workspaceId: string, agentId: string, output: string, append: boolean): void {
  broadcastToWorkspace(workspaceId, {
    type: 'agent:output',
    payload: { agentId, output, append },
    timestamp: new Date().toISOString(),
  });
}

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

export function emitTaskOutput(workspaceId: string, taskId: string, output: string, append: boolean): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:output',
    payload: { taskId, output, append },
    timestamp: new Date().toISOString(),
  });
}

export function emitTaskAgentStatus(workspaceId: string, taskId: string, status: string, attention: string): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:agent_status',
    payload: { taskId, status, attention },
    timestamp: new Date().toISOString(),
  });
}

export function emitAgentEvent(
  workspaceId: string,
  agentId: string,
  taskId: string | undefined,
  event: AgentEvent
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'agent:event',
    payload: { agentId, taskId, event },
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

export interface GitLogEntryEvent {
  ts: string;
  command: string;
  cwd?: string;
  exitCode: number;
  stdoutPreview: string;
  stderrPreview: string;
  durationMs: number;
}

export function emitTaskGitLog(
  workspaceId: string,
  taskId: string,
  entry: GitLogEntryEvent
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'task:git_log',
    payload: { taskId, entry },
    timestamp: new Date().toISOString(),
  });
}

export function emitAgentPermissionRequest(
  workspaceId: string,
  req: PermissionRequest
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'agent:permission_request',
    payload: req,
    timestamp: new Date().toISOString(),
  });
}

export function emitAgentPermissionResponse(
  workspaceId: string,
  res: PermissionResponse & { agentId: string; taskId?: string }
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'agent:permission_response',
    payload: res,
    timestamp: new Date().toISOString(),
  });
}

export function emitInboxNew(workspaceId: string, item: any): void {
  broadcastToWorkspace(workspaceId, {
    type: 'inbox:new',
    payload: { item },
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
  }
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'pull_request:updated',
    payload,
    timestamp: new Date().toISOString(),
  });
}

export function emitInboxUpdate(
  workspaceId: string,
  itemId: string,
  updates: Partial<InboxItem>
): void {
  broadcastToWorkspace(workspaceId, {
    type: 'inbox:update',
    payload: { itemId, updates },
    timestamp: new Date().toISOString(),
  });
}

export function emitEnvironmentStatus(environmentId: string, status: string, error?: string): void {
  broadcast({
    type: 'environment:status',
    payload: { environmentId, status, error },
    timestamp: new Date().toISOString(),
  });
}
