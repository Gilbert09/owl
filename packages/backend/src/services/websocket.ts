import { WebSocketServer, WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import type {
  AgentEvent,
  PermissionRequest,
  PermissionResponse,
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
  wss.on('connection', async (ws: WebSocket, req) => {
    const token = extractTokenFromUpgrade(req.url);
    if (!token) {
      ws.close(4401, 'missing token');
      return;
    }

    const user = await verifyTokenAndGetUser(token).catch(() => null);
    if (!user) {
      ws.close(4401, 'invalid token');
      return;
    }

    console.log(`WebSocket client connected (user=${user.id})`);
    clients.add(ws);
    subscriptions.set(ws, new Set());
    connectionUsers.set(ws, user);

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        void handleMessage(ws, message);
      } catch (err) {
        console.error('Invalid WebSocket message:', err);
      }
    });

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      clients.delete(ws);
      subscriptions.delete(ws);
      connectionUsers.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      clients.delete(ws);
      subscriptions.delete(ws);
      connectionUsers.delete(ws);
    });

    sendToClient(ws, {
      type: 'connection:status',
      payload: { connected: true },
      timestamp: new Date().toISOString(),
    });
  });
}

/** Parse the `?token=<jwt>` query param off the upgrade URL. */
function extractTokenFromUpgrade(url: string | undefined): string | null {
  if (!url) return null;
  try {
    // Provide a dummy base; the ws URL is path-relative.
    const parsed = new URL(url, 'http://localhost');
    return parsed.searchParams.get('token');
  } catch {
    return null;
  }
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

export function emitEnvironmentStatus(environmentId: string, status: string, error?: string): void {
  broadcast({
    type: 'environment:status',
    payload: { environmentId, status, error },
    timestamp: new Date().toISOString(),
  });
}
