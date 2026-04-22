import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { WebSocketServer, WebSocket as WSClient } from 'ws';
import {
  setupWebSocket,
  broadcastToWorkspace,
  emitTaskStatus,
} from '../services/websocket.js';
import * as authModule from '../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

const OTHER_USER_ID = 'user-other';

async function makeWsServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}/ws`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
      }),
  };
}

interface AuthedClient {
  ws: WSClient;
  messages: unknown[];
  waitFor: (type: string, timeoutMs?: number) => Promise<unknown>;
}

async function authed(url: string, token: string): Promise<AuthedClient> {
  const ws = new WSClient(url);
  const messages: unknown[] = [];
  const listeners: Array<(msg: unknown) => void> = [];

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      for (const l of listeners) l(msg);
    } catch {
      // ignore
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token }));

  function waitFor(type: string, timeoutMs = 1000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const existing = messages.find((m) => (m as { type?: string }).type === type);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      const listener = (msg: unknown) => {
        if ((msg as { type?: string }).type === type) {
          clearTimeout(timer);
          listeners.splice(listeners.indexOf(listener), 1);
          resolve(msg);
        }
      };
      listeners.push(listener);
    });
  }

  return { ws, messages, waitFor };
}

async function closeClient(c: AuthedClient): Promise<void> {
  c.ws.close();
  await new Promise((r) => setTimeout(r, 50));
}

describe('websocket service', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
    await db.insert(workspacesTable).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws-theirs', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
    ]);

    // Stub token verification — return the user matching the token
    // string itself so tests can drive which user they connect as.
    vi.spyOn(authModule, 'verifyTokenAndGetUser').mockImplementation(async (token) => {
      if (token === 'token-mine') {
        return { id: TEST_USER_ID, email: 'mine@test' };
      }
      if (token === 'token-theirs') {
        return { id: OTHER_USER_ID, email: 'theirs@test' };
      }
      return null;
    });

    const s = await makeWsServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
    vi.restoreAllMocks();
  });

  it('closes the socket when no auth arrives within the handshake window', async () => {
    const ws = new WSClient(serverUrl);
    let closeCode = 0;
    ws.on('close', (code) => {
      closeCode = code;
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // Don't send auth. Wait past the 5s timeout.
    await new Promise((r) => setTimeout(r, 5200));
    expect(closeCode).toBe(4401);
  }, 10_000);

  it('closes the socket when the first frame is not an auth message', async () => {
    const ws = new WSClient(serverUrl);
    let closeCode = 0;
    ws.on('close', (code) => {
      closeCode = code;
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'subscribe', workspaceId: 'ws-mine' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(closeCode).toBe(4401);
  });

  it('closes the socket when the auth token is invalid', async () => {
    const ws = new WSClient(serverUrl);
    let closeCode = 0;
    ws.on('close', (code) => {
      closeCode = code;
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'auth', token: 'bogus' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(closeCode).toBe(4401);
  });

  it('emits connection:status {connected: true} after successful auth', async () => {
    const client = await authed(serverUrl, 'token-mine');
    const status = (await client.waitFor('connection:status')) as {
      payload: { connected: boolean };
    };
    expect(status.payload.connected).toBe(true);
    await closeClient(client);
  });

  it('only broadcasts workspace-scoped events to subscribers of that workspace', async () => {
    const a = await authed(serverUrl, 'token-mine');
    const b = await authed(serverUrl, 'token-mine');
    // A subscribes to ws-mine, B does not.
    await a.waitFor('connection:status');
    await b.waitFor('connection:status');
    a.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: 'ws-mine' }));
    await new Promise((r) => setTimeout(r, 100));

    broadcastToWorkspace('ws-mine', {
      type: 'task:update',
      payload: { taskId: 't1', updates: {} },
      timestamp: new Date().toISOString(),
    });

    await a.waitFor('task:update');
    // Give B a moment; it shouldn't get the broadcast.
    await new Promise((r) => setTimeout(r, 100));
    expect(
      b.messages.filter((m) => (m as { type?: string }).type === 'task:update')
    ).toHaveLength(0);

    await closeClient(a);
    await closeClient(b);
  });

  it('refuses to subscribe to a workspace the connected user does not own', async () => {
    const client = await authed(serverUrl, 'token-mine');
    await client.waitFor('connection:status');
    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: 'ws-theirs' }));
    await new Promise((r) => setTimeout(r, 100));

    broadcastToWorkspace('ws-theirs', {
      type: 'task:update',
      payload: { taskId: 't2', updates: {} },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));

    // The subscribe was dropped silently; no task:update relayed.
    expect(
      client.messages.filter((m) => (m as { type?: string }).type === 'task:update')
    ).toHaveLength(0);

    await closeClient(client);
  });

  it('allows unsubscribe to stop the flow', async () => {
    const client = await authed(serverUrl, 'token-mine');
    await client.waitFor('connection:status');
    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: 'ws-mine' }));
    await new Promise((r) => setTimeout(r, 100));

    // First broadcast gets through.
    broadcastToWorkspace('ws-mine', {
      type: 'task:update',
      payload: { taskId: 't1', updates: {} },
      timestamp: new Date().toISOString(),
    });
    await client.waitFor('task:update');

    client.ws.send(JSON.stringify({ type: 'unsubscribe', workspaceId: 'ws-mine' }));
    await new Promise((r) => setTimeout(r, 100));

    const beforeCount = client.messages.filter(
      (m) => (m as { type?: string }).type === 'task:update'
    ).length;
    broadcastToWorkspace('ws-mine', {
      type: 'task:update',
      payload: { taskId: 't2', updates: {} },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 150));
    const afterCount = client.messages.filter(
      (m) => (m as { type?: string }).type === 'task:update'
    ).length;
    expect(afterCount).toBe(beforeCount);

    await closeClient(client);
  });

  it('replies to a ping with a pong connection:status message', async () => {
    const client = await authed(serverUrl, 'token-mine');
    await client.waitFor('connection:status');
    // Clear the captured initial connection:status so our poll
    // below doesn't match that one.
    const baseline = client.messages.length;
    client.ws.send(JSON.stringify({ type: 'ping' }));

    await new Promise((r) => setTimeout(r, 200));
    const newMessages = client.messages.slice(baseline);
    const pongMsg = newMessages.find(
      (m) => (m as { payload?: { pong?: boolean } }).payload?.pong === true
    );
    expect(pongMsg).toBeTruthy();
    await closeClient(client);
  });

  it('emitTaskStatus also fires a domain event (internal wiring)', async () => {
    const client = await authed(serverUrl, 'token-mine');
    await client.waitFor('connection:status');
    client.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: 'ws-mine' }));
    await new Promise((r) => setTimeout(r, 100));

    emitTaskStatus('ws-mine', 't1', 'completed');
    const msg = (await client.waitFor('task:status')) as {
      payload: { taskId: string; status: string };
    };
    expect(msg.payload.taskId).toBe('t1');
    expect(msg.payload.status).toBe('completed');

    await closeClient(client);
  });
});
