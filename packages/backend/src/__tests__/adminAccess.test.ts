/**
 * The gate on the operator console's API.
 *
 * Written in the discipline fleetAccess.test.ts sets: the question is never
 * "does it let the right person through", it is "can it be SEEN to stop the
 * wrong one". Every case here asserts a refusal alongside its acceptance,
 * because the failure mode this file exists to prevent is a cross-tenant
 * console that quietly serves people it should not — the exact shape of the
 * billing clientGate bug this codebase already paid for.
 *
 * The console can drain a fleet host, cancel someone's run, comp an account and
 * grant admin. `is_admin` is the whole permission model, so this gate and the
 * guards beside it are the whole defence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { NextFunction, Request, Response } from 'express';
import { adminRoutes } from '../routes/admin/index.js';
import { requireAuth, internalProxyHeaders } from '../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { users as usersTable } from '../db/schema.js';

/**
 * A stub auth middleware driven by a header, so a case can be "an admin" or
 * "a signed-in non-admin" without minting JWTs. The REAL requireAuth is
 * exercised separately below, where the point is what it refuses.
 */
function stubAuth(req: Request, _res: Response, next: NextFunction): void {
  const who = req.headers['x-test-user'];
  if (who === 'admin') {
    req.user = { id: 'user-admin', email: 'op@talyn.dev', isAdmin: true };
  } else if (who === 'member') {
    req.user = { id: 'user-member', email: 'customer@example.test', isAdmin: false };
  }
  next();
}

async function makeServer(auth: express.RequestHandler): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', auth, adminRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Every admin route that is NOT /me. If one of these ever answers a non-admin,
 * the console's whole model is broken — so the list is exhaustive by
 * construction rather than a sample.
 */
const GATED_ROUTES: ReadonlyArray<[method: string, path: string]> = [
  ['GET', '/api/v1/admin/debug/events'],
  ['GET', '/api/v1/admin/debug/snapshot'],
  ['DELETE', '/api/v1/admin/debug/events'],
];

describe('admin API gate', () => {
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const s = await makeServer(stubAuth);
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    delete process.env.TALYN_ADMIN_GRANT_ENABLED;
  });

  describe('GET /admin/me', () => {
    it('answers {admin:false} for a signed-in non-admin, NOT 403', async () => {
      // This is load-bearing for the console: a 403 here is indistinguishable
      // from "the backend is broken", and the browser would render an error
      // page instead of "this console is for Talyn operators".
      const res = await fetch(`${serverUrl}/api/v1/admin/me`, {
        headers: { 'x-test-user': 'member' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.admin).toBe(false);
    });

    it('tells a non-admin nothing about what the deploy permits', async () => {
      // Capabilities are free reconnaissance for someone probing the surface.
      const res = await fetch(`${serverUrl}/api/v1/admin/me`, {
        headers: { 'x-test-user': 'member' },
      });
      const body = await res.json();
      expect(body.data.capabilities).toEqual([]);
      expect(body.data.email).toBe('customer@example.test');
    });

    it('reports admin + capabilities for an operator', async () => {
      const res = await fetch(`${serverUrl}/api/v1/admin/me`, {
        headers: { 'x-test-user': 'admin' },
      });
      const body = await res.json();
      expect(body.data.admin).toBe(true);
      expect(body.data.email).toBe('op@talyn.dev');
      expect(body.data.capabilities).toContain('fleet.mutate');
      expect(body.data.capabilities).toContain('product.comp');
    });

    it('answers {admin:false} when there is no user at all', async () => {
      const res = await fetch(`${serverUrl}/api/v1/admin/me`);
      expect(res.status).toBe(200);
      expect((await res.json()).data.admin).toBe(false);
    });
  });

  describe('admin-grant capability', () => {
    it('omits product.grant_admin unless the deploy opts in', async () => {
      // Default OFF: granting admin is the one mutation that permanently
      // widens the blast radius of every other one.
      delete process.env.TALYN_ADMIN_GRANT_ENABLED;
      const res = await fetch(`${serverUrl}/api/v1/admin/me`, {
        headers: { 'x-test-user': 'admin' },
      });
      expect((await res.json()).data.capabilities).not.toContain('product.grant_admin');
    });

    it('reports it once TALYN_ADMIN_GRANT_ENABLED=1', async () => {
      process.env.TALYN_ADMIN_GRANT_ENABLED = '1';
      const res = await fetch(`${serverUrl}/api/v1/admin/me`, {
        headers: { 'x-test-user': 'admin' },
      });
      expect((await res.json()).data.capabilities).toContain('product.grant_admin');
    });

    it.each([['0'], ['true'], ['yes'], ['']])(
      'treats TALYN_ADMIN_GRANT_ENABLED=%j as off',
      async (value) => {
        // Only the exact string '1' enables it. A truthy-ish value being
        // accepted is how a flag meant to stay off gets turned on by a typo.
        process.env.TALYN_ADMIN_GRANT_ENABLED = value;
        const res = await fetch(`${serverUrl}/api/v1/admin/me`, {
          headers: { 'x-test-user': 'admin' },
        });
        expect((await res.json()).data.capabilities).not.toContain('product.grant_admin');
      }
    );
  });

  describe('every other route', () => {
    it.each(GATED_ROUTES)('403s a signed-in non-admin on %s %s', async (method, path) => {
      const res = await fetch(`${serverUrl}${path}`, {
        method,
        headers: { 'x-test-user': 'member' },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('Admin access required');
    });

    it.each(GATED_ROUTES)('403s an unauthenticated caller on %s %s', async (method, path) => {
      const res = await fetch(`${serverUrl}${path}`, { method });
      expect(res.status).toBe(403);
    });

    it.each(GATED_ROUTES)('serves an operator on %s %s', async (method, path) => {
      const res = await fetch(`${serverUrl}${path}`, {
        method,
        headers: { 'x-test-user': 'admin' },
      });
      expect(res.status).toBe(200);
    });
  });
});

describe('admin API gate — the internal proxy can never reach it', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    // Promote the user in the DB. The point is that it does NOT matter.
    const s = await makeServer(requireAuth as express.RequestHandler);
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
  });

  /**
   * `checkInternalAuth` hardcodes `isAdmin: false` — the daemon HTTP proxy
   * impersonates a user for data access but must never inherit the operator
   * surface. That is an invariant of the auth middleware, not of this router,
   * so assert it from here rather than change it: a future edit that "fixes"
   * the hardcode by reading the DB row would hand cross-tenant mutations to
   * anything holding the internal token.
   */
  it('403s a request carrying valid internal-proxy headers, even for an admin user', async () => {
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, TEST_USER_ID));
    const res = await fetch(`${serverUrl}/api/v1/admin/debug/snapshot`, {
      headers: internalProxyHeaders(TEST_USER_ID),
    });
    expect(res.status).toBe(403);
  });

  it('reports admin:false on /me for an internal-proxy caller', async () => {
    const res = await fetch(`${serverUrl}/api/v1/admin/me`, {
      headers: internalProxyHeaders(TEST_USER_ID),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.admin).toBe(false);
  });

  it('401s a caller with no credentials at all', async () => {
    const res = await fetch(`${serverUrl}/api/v1/admin/me`);
    expect(res.status).toBe(401);
  });
});
