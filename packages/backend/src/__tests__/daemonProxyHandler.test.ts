import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { handleProxyHttpRequest } from '../services/daemonProxyHandler.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';

const OTHER_USER_ID = 'user-other';

interface ReceivedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Stand up a tiny echo server on the `PORT` the proxy handler dials.
 * Records every inbound request so tests can assert the proxy forwarded
 * the right headers + method + body.
 */
async function makeEchoServer(): Promise<{
  port: number;
  received: ReceivedRequest[];
  reply: { status: number; body: unknown; headers?: Record<string, string> };
  close: () => Promise<void>;
}> {
  const received: ReceivedRequest[] = [];
  const reply = { status: 200, body: { ok: true } as unknown, headers: undefined as Record<string, string> | undefined };

  const app = express();
  app.use(express.raw({ type: '*/*' }));
  app.use((req, res) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
    }
    received.push({
      method: req.method,
      path: req.originalUrl,
      headers,
      body: Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : '',
    });
    if (reply.headers) {
      for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
    }
    res.status(reply.status).json(reply.body);
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    received,
    reply,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('handleProxyHttpRequest', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let echo: Awaited<ReturnType<typeof makeEchoServer>>;
  const originalPort = process.env.PORT;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
    await db.insert(environmentsTable).values([
      {
        id: 'env-mine',
        ownerId: TEST_USER_ID,
        name: 'mine',
        type: 'remote',
        status: 'connected',
        config: {},
      },
    ]);
    echo = await makeEchoServer();
    process.env.PORT = String(echo.port);
  });

  afterEach(async () => {
    await echo.close();
    await cleanup();
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it('returns 404 envelope when the environment id is unknown', async () => {
    const res = await handleProxyHttpRequest('missing-env', {
      op: 'proxy_http_request',
      method: 'GET',
      path: '/api/v1/probe',
      headers: {},
      bodyBase64: '',
    });
    expect(res.status).toBe(404);
    const body = JSON.parse(Buffer.from(res.bodyBase64, 'base64').toString('utf-8'));
    expect(body).toEqual({ success: false, error: 'environment not found' });
  });

  it('forwards GET to the backend on localhost with internal auth headers', async () => {
    echo.reply.body = { ok: true, from: 'echo' };

    const res = await handleProxyHttpRequest('env-mine', {
      op: 'proxy_http_request',
      method: 'GET',
      path: '/api/v1/probe',
      headers: { accept: 'application/json' },
      bodyBase64: '',
    });

    expect(res.status).toBe(200);
    expect(echo.received).toHaveLength(1);
    const forwarded = echo.received[0];
    expect(forwarded.method).toBe('GET');
    expect(forwarded.path).toBe('/api/v1/probe');
    // Internal headers injected with the env's owner.
    expect(forwarded.headers['x-fastowl-internal-user']).toBe(TEST_USER_ID);
    expect(forwarded.headers['x-fastowl-internal-token']).toBeTruthy();
    // Forwarded accept header survived.
    expect(forwarded.headers['accept']).toBe('application/json');
  });

  it('drops Authorization + cookie/host headers from the VM request', async () => {
    await handleProxyHttpRequest('env-mine', {
      op: 'proxy_http_request',
      method: 'GET',
      path: '/api/v1/probe',
      headers: {
        authorization: 'Bearer stolen-jwt',
        cookie: 'sess=secret',
        host: 'spoofed.example.com',
        // Attempt to spoof the internal token — should also be dropped.
        'x-fastowl-internal-token': 'attacker-supplied',
        'x-fastowl-internal-user': OTHER_USER_ID,
        accept: 'application/json',
      },
      bodyBase64: '',
    });

    const forwarded = echo.received[0];
    // Attacker-supplied / hop-by-hop headers are stripped before
    // dispatch. Node's fetch re-sets host to the localhost target.
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(forwarded.headers.cookie).toBeUndefined();
    // And the internal auth header is ours, not the attacker's.
    expect(forwarded.headers['x-fastowl-internal-user']).toBe(TEST_USER_ID);
    expect(forwarded.headers['x-fastowl-internal-token']).not.toBe('attacker-supplied');
  });

  it('forwards POST + body for methods that carry one', async () => {
    echo.reply.body = { ok: true };
    const payload = { hello: 'from-daemon' };
    const bodyBase64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');

    await handleProxyHttpRequest('env-mine', {
      op: 'proxy_http_request',
      method: 'POST',
      path: '/api/v1/tasks',
      headers: { 'content-type': 'application/json' },
      bodyBase64,
    });

    const forwarded = echo.received[0];
    expect(forwarded.method).toBe('POST');
    expect(forwarded.body).toBe(JSON.stringify(payload));
  });

  it('does not forward a body for GET even if provided', async () => {
    await handleProxyHttpRequest('env-mine', {
      op: 'proxy_http_request',
      method: 'GET',
      path: '/api/v1/probe',
      headers: {},
      bodyBase64: Buffer.from('ignored', 'utf-8').toString('base64'),
    });
    expect(echo.received[0].body).toBe('');
  });

  it('returns the upstream status + body back to the daemon', async () => {
    echo.reply.status = 418;
    echo.reply.body = { teapot: true };

    const res = await handleProxyHttpRequest('env-mine', {
      op: 'proxy_http_request',
      method: 'GET',
      path: '/api/v1/brew',
      headers: {},
      bodyBase64: '',
    });
    expect(res.status).toBe(418);
    const body = JSON.parse(Buffer.from(res.bodyBase64, 'base64').toString('utf-8'));
    expect(body.teapot).toBe(true);
  });

  it('strips content-length + transfer-encoding from the response headers', async () => {
    echo.reply.headers = {
      'x-custom': 'keep-me',
    };

    const res = await handleProxyHttpRequest('env-mine', {
      op: 'proxy_http_request',
      method: 'GET',
      path: '/api/v1/probe',
      headers: {},
      bodyBase64: '',
    });

    expect(res.headers['x-custom']).toBe('keep-me');
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['transfer-encoding']).toBeUndefined();
  });

  it('returns a 502 envelope when the localhost fetch throws (backend down)', async () => {
    // Point at a nonexistent port to force the fetch to fail.
    await echo.close();
    process.env.PORT = '1'; // port 1 is never listening in a sandbox

    const res = await handleProxyHttpRequest('env-mine', {
      op: 'proxy_http_request',
      method: 'GET',
      path: '/api/v1/probe',
      headers: {},
      bodyBase64: '',
    });
    expect(res.status).toBe(502);
    const body = JSON.parse(Buffer.from(res.bodyBase64, 'base64').toString('utf-8'));
    expect(body).toEqual({ success: false, error: 'proxy fetch failed' });
  });
});
