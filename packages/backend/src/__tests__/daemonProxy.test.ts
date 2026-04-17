import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { requireAuth, internalProxyHeaders } from '../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';

/**
 * Exercise the internal-proxy auth path end-to-end without a daemon or
 * a WebSocket. We mount `requireAuth` on a minimal Express app, send
 * requests with the internal headers, and check that `req.user` is
 * populated with the matching user — this is the mechanism the
 * daemon-side proxy dispatcher relies on.
 */
describe('internal proxy auth', () => {
  let cleanup: (() => Promise<void>) | null = null;
  let db: Database;
  let serverUrl: string;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db);

    const app = express();
    app.use(express.json());
    app.get('/probe', requireAuth, (req, res) => {
      res.json({
        ok: true,
        userId: req.user?.id,
        email: req.user?.email,
      });
    });

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup?.();
    cleanup = null;
  });

  it('returns 401 with no auth headers', async () => {
    const res = await fetch(`${serverUrl}/probe`);
    expect(res.status).toBe(401);
  });

  it('authenticates with valid internal proxy headers', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: internalProxyHeaders(TEST_USER_ID),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; userId: string };
    expect(body.userId).toBe(TEST_USER_ID);
  });

  it('rejects when internal token is wrong', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: {
        'x-fastowl-internal-user': TEST_USER_ID,
        'x-fastowl-internal-token': 'nope',
      },
    });
    expect(res.status).toBe(401);
  });

  it('rejects when internal user does not exist', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: internalProxyHeaders('user-not-in-db'),
    });
    expect(res.status).toBe(401);
  });
});
