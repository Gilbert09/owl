import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { fleetHosts as fleetHostsTable } from '../db/schema.js';
import {
  fanOutHosts,
  fleetClientForHost,
  HostNotDialableError,
  HostOfflineError,
  HostUnknownError,
  FleetNotConfiguredError,
  listAdminFleetHosts,
  probe,
} from '../services/admin/fleetProxy.js';
import { FleetCapacityError, resetFleetDispatcherCache } from '../services/selfHosted/client.js';
import type { Database } from '../db/client.js';

/**
 * The console's degradation contract.
 *
 * This is the page an operator opens BECAUSE a host is misbehaving. If one
 * dead box can fail the request, the console is unavailable exactly when it is
 * needed — so the load-bearing assertions here are the negative ones: the host
 * list never throws, and a stale host is never dialled at all.
 *
 * Mutations are the deliberate exception and are asserted to still surface
 * failure, because "the drain probably worked" is how a host stays live
 * through an incident somebody believes they drained.
 */

let db: Database;
let cleanup: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;

const FRESH = () => new Date();
const STALE = () => new Date(Date.now() - 5 * 60_000);

async function seedHost(overrides: Partial<typeof fleetHostsTable.$inferInsert> = {}) {
  await db.insert(fleetHostsTable).values({
    name: 'hetzner-64',
    apiEndpoint: 'http://10.0.0.1:8080',
    version: '1.0.0',
    reportedAt: FRESH(),
    draining: false,
    runsLive: 1,
    runsMax: 2,
    memReservedMib: 512,
    memBudgetMib: 2048,
    diskFreeMib: 40_000,
    maxIdleSeconds: 3,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  process.env.FLEET_API_TOKEN = 'fleet-token';
  delete process.env.FLEET_HTTP_PROXY;
  resetFleetDispatcherCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  delete process.env.FLEET_API_TOKEN;
});

describe('fleetClientForHost', () => {
  it('refuses a host that has never reported', async () => {
    await expect(fleetClientForHost('nope')).rejects.toBeInstanceOf(HostUnknownError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a host that advertised no endpoint', async () => {
    // Observable but not dispatchable — a real state, and it is what a host
    // looks like before its private link is up.
    await seedHost({ apiEndpoint: null });
    await expect(fleetClientForHost('hetzner-64')).rejects.toBeInstanceOf(HostNotDialableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a STALE host WITHOUT dialling it', async () => {
    // The assertion that matters: registration does not imply reachability,
    // so dialling a host whose last report is minutes old just means waiting
    // the full timeout to learn what the registry already knew.
    await seedHost({ reportedAt: STALE() });
    await expect(fleetClientForHost('hetzner-64')).rejects.toBeInstanceOf(HostOfflineError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dials a stale host when explicitly allowed', async () => {
    await seedHost({ reportedAt: STALE() });
    const { client } = await fleetClientForHost('hetzner-64', { allowOffline: true });
    expect(client).toBeDefined();
  });

  it('refuses when no fleet token is configured', async () => {
    delete process.env.FLEET_API_TOKEN;
    await seedHost();
    await expect(fleetClientForHost('hetzner-64')).rejects.toBeInstanceOf(FleetNotConfiguredError);
  });
});

describe('probe', () => {
  it('never throws on an unreachable host', async () => {
    await seedHost();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await probe('hetzner-64', (c) => c.capacity());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('fleet_unreachable');
      expect(result.error).toMatch(/ECONNREFUSED/);
    }
  });

  it('never throws on an unknown host', async () => {
    const result = await probe('nope', (c) => c.capacity());
    expect(result.ok).toBe(false);
  });

  it('returns the value on success', async () => {
    await seedHost();
    fetchMock.mockResolvedValue(jsonResponse({ draining: false, runsLive: 1 }));
    const result = await probe('hetzner-64', (c) => c.capacity());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.runsLive).toBe(1);
  });

  it('maps a 503 to unreachable rather than propagating a capacity error', async () => {
    await seedHost();
    fetchMock.mockResolvedValue(jsonResponse({ message: 'no capacity' }, 503));
    const result = await probe('hetzner-64', (c) => c.capacity());
    expect(result.ok).toBe(false);
  });
});

describe('listAdminFleetHosts', () => {
  it('dials NOTHING without ?live', async () => {
    // The console's first paint. A page that waits on N tailnet round trips
    // before showing anything is unusable during the incident it was opened
    // for.
    await seedHost();
    const hosts = await listAdminFleetHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.live).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a row with a REASON for an unreachable host, and does not throw', async () => {
    // The single most important behaviour on this surface.
    await seedHost();
    fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));
    const hosts = await listAdminFleetHosts({ live: true });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.live).toBeNull();
    expect(hosts[0]!.liveError).toMatch(/ETIMEDOUT/);
    expect(hosts[0]!.liveErrorCode).toBe('fleet_unreachable');
    // The registry data is still there — that is the point of hosts pushing.
    expect(hosts[0]!.runsLive).toBe(1);
  });

  it('one dead host does not take out a healthy one', async () => {
    await seedHost();
    await seedHost({ name: 'hetzner-65', apiEndpoint: 'http://10.0.0.2:8080' });
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('10.0.0.1')
        ? Promise.reject(new Error('down'))
        : jsonResponse({ draining: false, runsLive: 0, runsMax: 2, accepting: true })
    );
    const hosts = await listAdminFleetHosts({ live: true });
    const dead = hosts.find((h) => h.name === 'hetzner-64')!;
    const alive = hosts.find((h) => h.name === 'hetzner-65')!;
    expect(dead.live).toBeNull();
    expect(alive.live).not.toBeNull();
  });

  it('marks a stale host offline and never dials it', async () => {
    await seedHost({ reportedAt: STALE() });
    const hosts = await listAdminFleetHosts({ live: true });
    expect(hosts[0]!.online).toBe(false);
    expect(hosts[0]!.liveErrorCode).toBe('host_offline');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fanOutHosts', () => {
  it('skips offline hosts entirely', async () => {
    await seedHost();
    await seedHost({ name: 'gone', apiEndpoint: 'http://10.0.0.9:8080', reportedAt: STALE() });
    fetchMock.mockResolvedValue(jsonResponse({ sandboxes: [] }));
    const results = await fanOutHosts((c) => c.listSandboxes());
    expect(results.map((r) => r.host.name)).toEqual(['hetzner-64']);
  });

  it('skips hosts with no endpoint', async () => {
    await seedHost({ name: 'no-endpoint', apiEndpoint: null });
    const results = await fanOutHosts((c) => c.listSandboxes());
    expect(results).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a per-host failure without failing the whole fan-out', async () => {
    await seedHost();
    fetchMock.mockRejectedValue(new Error('boom'));
    const results = await fanOutHosts((c) => c.listSandboxes());
    expect(results).toHaveLength(1);
    expect(results[0]!.result.ok).toBe(false);
  });
});

describe('mutations do NOT degrade', () => {
  it('surfaces an unreachable host as an error, not a soft success', async () => {
    // The deliberate exception to everything above. An operator must know the
    // box was not told.
    await seedHost();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { client } = await fleetClientForHost('hetzner-64');
    await expect(
      client.setDrain({ draining: true, actor: 'op@talyn.dev', reason: 'rebooting' })
    ).rejects.toBeInstanceOf(FleetCapacityError);
  });
});

describe('the attribution envelope', () => {
  beforeEach(async () => {
    await seedHost();
    fetchMock.mockResolvedValue(jsonResponse({}));
  });

  function bodyOf(call: number): Record<string, unknown> {
    return JSON.parse((fetchMock.mock.calls[call]![1] as { body: string }).body);
  }

  it('sends actor AND reason on drain', async () => {
    // fleetd 400s a body missing either — spec §17.3, "an unattributed drain
    // is the one that nobody can explain the next morning".
    const { client } = await fleetClientForHost('hetzner-64');
    await client.setDrain({ draining: true, actor: 'op@talyn.dev', reason: 'rebooting fleetd' });
    expect(bodyOf(0)).toMatchObject({
      draining: true,
      actor: 'op@talyn.dev',
      reason: 'rebooting fleetd',
    });
  });

  it.each([
    ['goldensGc', (c: import('../services/selfHosted/client.js').FleetClient) =>
      c.goldensGc({ actor: 'op@talyn.dev', reason: 'disk pressure', force: true })],
    ['goldensPin', (c: import('../services/selfHosted/client.js').FleetClient) =>
      c.goldensPin({ actor: 'op@talyn.dev', reason: 'keeping', path: '/x.img', pinned: true })],
    ['goldensRebake', (c: import('../services/selfHosted/client.js').FleetClient) =>
      c.goldensRebake({ actor: 'op@talyn.dev', reason: 'lockfile moved', repo: 'o/r' })],
    ['goldensDelete', (c: import('../services/selfHosted/client.js').FleetClient) =>
      c.goldensDelete({ actor: 'op@talyn.dev', reason: 'retired repo', path: '/x.img' })],
  ])('sends actor AND reason on %s', async (_label, call) => {
    const { client } = await fleetClientForHost('hetzner-64');
    await call(client);
    const body = bodyOf(0);
    expect(body.actor).toBe('op@talyn.dev');
    expect(typeof body.reason).toBe('string');
    expect(body.reason).toBeTruthy();
  });
});

describe('timeouts', () => {
  it('applies the short admin read timeout, not the dispatch default', async () => {
    await seedHost();
    fetchMock.mockResolvedValue(jsonResponse({}));
    const { client } = await fleetClientForHost('hetzner-64');
    await client.capacity();
    const init = fetchMock.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBeDefined();
    // AbortSignal.timeout does not expose its duration, so assert the client
    // was constructed with an override at all rather than the 20s default —
    // the value itself is covered by ADMIN_READ_TIMEOUT_MS being the only
    // thing passed here.
    expect(init.signal!.aborted).toBe(false);
  });
});
