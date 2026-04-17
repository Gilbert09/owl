import { WebSocketServer, WebSocket } from 'ws';
import type { TaskStatus, WSEvent } from '@fastowl/shared';
import { domainEvents } from './events.js';

// Store connected clients
const clients = new Set<WebSocket>();

// Store subscriptions (client -> workspaceIds)
const subscriptions = new Map<WebSocket, Set<string>>();

export function setupWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket) => {
    console.log('WebSocket client connected');
    clients.add(ws);
    subscriptions.set(ws, new Set());

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        handleMessage(ws, message);
      } catch (err) {
        console.error('Invalid WebSocket message:', err);
      }
    });

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      clients.delete(ws);
      subscriptions.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      clients.delete(ws);
      subscriptions.delete(ws);
    });

    // Send connection confirmation
    sendToClient(ws, {
      type: 'connection:status',
      payload: { connected: true },
      timestamp: new Date().toISOString(),
    });
  });
}

function handleMessage(ws: WebSocket, message: any): void {
  switch (message.type) {
    case 'subscribe':
      // Subscribe to workspace events
      if (message.workspaceId) {
        subscriptions.get(ws)?.add(message.workspaceId);
      }
      break;

    case 'unsubscribe':
      // Unsubscribe from workspace events
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
