import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { adminRoutes } from '../../routes/admin/index.js';
import { createTestDb } from '../helpers/testDb.js';
import { adminAuditLog, fleetHosts as fleetHostsTable } from '../../db/schema.js';
import { resetFleetDispatcherCache } from '../../services/selfHosted/client.js';
import type { Database } from '../../db/client.js';

/**
 * Fleet mutations.
 *
 * The property that separates these from every read on the surface: they do
 * NOT degrade. An unreachable host is an error, because "the drain probably
 * worked" is how a box stays live through an incident somebody believes they
 * drained — and the audit row records the attempt either way, so the trail
 * says what was tried even when it failed.
 *
 * The other one is attribution. fleetd 400s a body missing `actor` or
 * `reason`, and it writes both into its own ledger; an operator reading that
 * ledger at 2am needs an email, not a UUID.
 */

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let closeServer: () => Promise<void>;
let upstream: ReturnType<typeof vi.fn>;
let realFetch: typeof fetch;

const REASON = 'rebooting fleetd to clear a wedged run';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

async function post(path: string, body: unknown) {
  const res = await realFetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function upstreamBody(call = 0): Record<string, unknown> {
  const init = upstream.mock.calls[call]?.[1] as { body?: string } | undefined;
  return init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
}

async function auditRows() {
  return db.select().from(adminAuditLog);
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  process.env.FLEET_API_TOKEN = 'tok';
  delete process.env.FLEET_HTTP_PROXY;
  resetFleetDispatcherCache();
  await db.insert(fleetHostsTable).values({
    name: 'hetzner-64',
    apiEndpoint: 'http://10.0.0.1:8080',
    reportedAt: new Date(),
    runsLive: 1,
    runsMax: 2,
  });

  realFetch = globalThis.fetch;
  upstream = vi.fn().mockResolvedValue(jsonResponse({}));
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === 'string' ? input : String(input);
    if (target.includes('10.0.0.')) return upstream(target, init);
    return realFetch(input, init);
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin',
    (req, _res, next) => {
      req.user = { id: 'user-op', email: 'op@talyn.dev', isAdmin: true };
      next();
    },
    adminRoutes()
  );
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  url = `http://127.0.0.1:${addr.port}`;
  closeServer = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
});

afterEach(async () => {
  await closeServer();
  await cleanup();
  vi.unstubAllGlobals();
  delete process.env.FLEET_API_TOKEN;
});

const MUTATIONS: Array<[label: string, path: string, body: Record<string, unknown>]> = [
  ['drain', '/api/v1/admin/fleet/hosts/hetzner-64/drain', { draining: true }],
  ['cancel run', '/api/v1/admin/fleet/hosts/hetzner-64/runs/talyn-1/cancel', {}],
  ['golden gc', '/api/v1/admin/fleet/hosts/hetzner-64/goldens/gc', { force: true }],
  ['golden pin', '/api/v1/admin/fleet/hosts/hetzner-64/goldens/pin', { path: '/x.img', pinned: true }],
  ['golden rebake', '/api/v1/admin/fleet/hosts/hetzner-64/goldens/rebake', { repo: 'o/r' }],
];

describe('every fleet mutation', () => {
  it.each(MUTATIONS)('%s refuses without a reason and dials nothing', async (_l, path, body) => {
    const res = await post(path, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('reason_required');
    expect(upstream).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it.each(MUTATIONS)('%s writes an audit row that settles to ok', async (_l, path, body) => {
    const res = await post(path, { ...body, reason: REASON });
    expect(res.status).toBe(200);
    const [row] = await auditRows();
    expect(row!.outcome).toBe('ok');
    expect(row!.reason).toBe(REASON);
    expect(row!.actorEmail).toBe('op@talyn.dev');
    expect(row!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it.each(MUTATIONS)('%s SURFACES an unreachable host rather than degrading', async (_l, path, body) => {
    // The deliberate exception to the read-side contract.
    upstream.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await post(path, { ...body, reason: REASON });
    // 502, not 500: "the box did not answer" and "Talyn is broken" lead an
    // operator to do completely different things.
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('fleet_unreachable');

    const [row] = await auditRows();
    expect(row!.outcome).toBe('error');
    expect(row!.error).toMatch(/ECONNREFUSED|unreachable/i);
  });

  it.each(MUTATIONS)('%s refuses a stale host without dialling', async (_l, path, body) => {
    await db.delete(fleetHostsTable);
    await db.insert(fleetHostsTable).values({
      name: 'hetzner-64',
      apiEndpoint: 'http://10.0.0.1:8080',
      reportedAt: new Date(Date.now() - 10 * 60_000),
    });
    const res = await post(path, { ...body, reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('host_offline');
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('attribution reaches fleetd', () => {
  it.each(MUTATIONS.filter(([label]) => label !== 'cancel run'))(
    '%s sends actor AND reason upstream',
    async (_l, path, body) => {
      // fleetd 400s a body missing either — spec §17.3, "an unattributed drain
      // is the one that nobody can explain the next morning".
      await post(path, { ...body, reason: REASON });
      const sent = upstreamBody();
      expect(sent.actor).toBe('op@talyn.dev');
      expect(sent.reason).toBe(REASON);
    }
  );

  it('sends the operator EMAIL, not their id', async () => {
    // fleetd writes this into its own per-run ledger. An email is actionable
    // at 2am; a UUID is not.
    await post('/api/v1/admin/fleet/hosts/hetzner-64/drain', { draining: true, reason: REASON });
    expect(upstreamBody().actor).toBe('op@talyn.dev');
    expect(upstreamBody().actor).not.toBe('user-op');
  });
});

describe('validation', () => {
  it.each([
    ['drain without a boolean', '/api/v1/admin/fleet/hosts/hetzner-64/drain', { draining: 'yes' }],
    ['pin without a path', '/api/v1/admin/fleet/hosts/hetzner-64/goldens/pin', { pinned: true }],
    ['pin without a boolean', '/api/v1/admin/fleet/hosts/hetzner-64/goldens/pin', { path: '/x', pinned: 1 }],
    ['rebake without a repo', '/api/v1/admin/fleet/hosts/hetzner-64/goldens/rebake', {}],
  ])('refuses %s', async (_l, path, body) => {
    const res = await post(path, { ...body, reason: REASON });
    expect(res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('records what was asked for', () => {
  it('captures the GC options in params, and never the reason twice', async () => {
    await post('/api/v1/admin/fleet/hosts/hetzner-64/goldens/gc', {
      force: true,
      dryRun: false,
      reason: REASON,
    });
    const [row] = await auditRows();
    expect(row!.params).toMatchObject({ force: true, dryRun: false });
    expect(row!.params).not.toHaveProperty('reason');
  });

  it('targets the golden PATH for a pin, not the host', async () => {
    // So "who has touched this image" is answerable from the target index.
    await post('/api/v1/admin/fleet/hosts/hetzner-64/goldens/pin', {
      path: '/var/lib/fleet/goldens/repo/x.img',
      pinned: true,
      reason: REASON,
    });
    const [row] = await auditRows();
    expect(row!.targetKind).toBe('golden');
    expect(row!.targetId).toBe('/var/lib/fleet/goldens/repo/x.img');
    expect(row!.params).toMatchObject({ host: 'hetzner-64' });
  });

  it('targets the RUN id for a cancel', async () => {
    await post('/api/v1/admin/fleet/hosts/hetzner-64/runs/talyn-99/cancel', { reason: REASON });
    const [row] = await auditRows();
    expect(row!.targetKind).toBe('run');
    expect(row!.targetId).toBe('talyn-99');
  });
});

describe('the gate still applies', () => {
  it.each(MUTATIONS)('403s a non-admin on %s', async (_l, path, body) => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/admin',
      (req, _res, next) => {
        req.user = { id: 'member', email: 'c@example.test', isAdmin: false };
        next();
      },
      adminRoutes()
    );
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as AddressInfo;
    const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, reason: REASON }),
    });
    expect(res.status).toBe(403);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    expect(upstream).not.toHaveBeenCalled();
  });
});
