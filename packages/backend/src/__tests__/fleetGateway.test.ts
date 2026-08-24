import { randomBytes } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { fleetHosts as fleetHostsTable, workspaces as workspacesTable } from '../db/schema.js';
import { selfHostedProvider } from '../services/cloudProviders/selfhosted/provider.js';
import {
  FLEET_HOST_HEADER,
  FleetClient,
  resetFleetDispatcherCache,
} from '../services/selfHosted/client.js';
import { fleetGatewayToken, fleetPinnedEndpoint } from '../services/selfHosted/credentials.js';
import { liveFleetSandboxes } from '../services/admin/fleetProxy.js';
import type { Database } from '../db/client.js';

/**
 * Dispatch through the sandbox GATEWAY rather than at a host.
 *
 * The two are not interchangeable and the differences are all silent ones:
 * a different credential, a different answer to "which box is this on", and a
 * different meaning for `GET /v1/sandboxes`. Every case here is one of those,
 * and each was reachable in production without any of them raising an error —
 * which is why they are tests and not comments.
 */

const GATEWAY = 'https://api.example.dev';

let db: Database;
let cleanup: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;

/** A fetch answer with real headers, so a header assertion means something. */
function reply(body: unknown, opts: { status?: number; headers?: Record<string, string> } = {}) {
  const status = opts.status ?? 200;
  const headers = new Headers(opts.headers ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({ id: 'ws-1', name: 'ws', ownerId: TEST_USER_ID });
  // storeSelfHostedCredentials encrypts the workspace's Claude token at rest,
  // so validateCredentials' happy path needs a key. Generated per run rather
  // than fixed: nothing here asserts on the ciphertext.
  process.env.TALYN_TOKEN_KEY ??= randomBytes(32).toString('base64');
  delete process.env.FLEET_HTTP_PROXY;
  resetFleetDispatcherCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  delete process.env.FLEET_PINNED_ENDPOINT;
  delete process.env.FLEET_GATEWAY_TOKEN;
  delete process.env.FLEET_API_TOKEN;
});

describe('the gateway names the host that took a dispatch', () => {
  // WHY THIS IS NOT COSMETIC.
  //
  // `resolveRunCredentials` answers a host's credential pull only for a run
  // dispatched TO THAT HOST — the bound that keeps a shared report token from
  // being "any host may collect any run's GitHub token and LLM key". Dialling a
  // host directly, the registry supplied the name. Through the gateway the
  // registry chose nothing, the record in the response body is fleetd's and
  // says nothing about which fleetd wrote it, and the ONLY carrier is the
  // response header.
  //
  // WATCHED FAIL: drop the `resp.headers.get(FLEET_HOST_HEADER)` read in
  // requestWithMeta and this returns undefined.
  it('is read off the create response and handed back', async () => {
    fetchMock.mockResolvedValue(
      reply({ id: 'talyn-1', status: 'starting' }, { headers: { [FLEET_HOST_HEADER]: 'hetzner-64' } }),
    );
    const client = new FleetClient(GATEWAY, 'yas_sk_key');
    const { sandbox, host } = await client.createSandbox({
      id: 'talyn-1',
      workspaceId: 'ws-1',
      ephemeral: true,
      task: { taskType: 'code_writing', prompt: 'go' },
    });
    expect(sandbox.id).toBe('talyn-1');
    expect(host).toBe('hetzner-64');
  });

  // A host answering directly does not send the header, and that is not a
  // failure — the caller already knows the name, because it chose the box.
  it('is absent, not empty, when a host answers directly', async () => {
    fetchMock.mockResolvedValue(reply({ id: 'talyn-1', status: 'starting' }));
    const { host } = await new FleetClient('http://10.0.0.1:8080', 'fleet-token').createSandbox({
      id: 'talyn-1',
      workspaceId: 'ws-1',
      ephemeral: true,
      task: { taskType: 'code_writing', prompt: 'go' },
    });
    expect(host).toBeUndefined();
  });
});

describe('the two fleet credentials are not interchangeable', () => {
  // They authenticate to different trust domains: FLEET_API_TOKEN is a
  // deployment secret every HOST shares, a gateway key is a per-tenant key the
  // gateway minted and can revoke. Sending either to the other simply 401s —
  // except against `/healthz`, which is the one gateway route that takes no
  // credential at all and therefore cannot tell them apart.
  it('resolves the gateway token for the gateway, and falls back when there is none', () => {
    process.env.FLEET_API_TOKEN = 'fleet-token';
    expect(fleetGatewayToken()).toBe('fleet-token');
    process.env.FLEET_GATEWAY_TOKEN = 'yas_sk_key';
    expect(fleetGatewayToken()).toBe('yas_sk_key');
  });

  it('strips a trailing slash off the gateway endpoint so paths do not double up', () => {
    process.env.FLEET_PINNED_ENDPOINT = `${GATEWAY}/`;
    expect(fleetPinnedEndpoint()).toBe(GATEWAY);
  });
});

describe("the console's live run list, once dispatch goes through the gateway", () => {
  // THE ONE THAT WOULD HAVE SHIPPED SILENTLY.
  //
  // The console used to ask each host for its own sandboxes, holding
  // FLEET_API_TOKEN. fleetd resolves that shared token to the EMPTY tenant on
  // purpose — an operator credential answers "may I see the host?" and never
  // "may I see the customers?" — while a gateway-dispatched sandbox belongs to
  // tenant `talyn`. So after the cutover that fan-out returns rows for nothing,
  // and the page falls back to each task's last-known status: a console that
  // looks entirely healthy and shows no live data at all.
  //
  // WATCHED FAIL: point liveFleetSandboxes back at fanOutHosts and the ids
  // below disappear from the result.
  it('comes from the gateway index, hydrated per id', async () => {
    process.env.FLEET_PINNED_ENDPOINT = GATEWAY;
    process.env.FLEET_GATEWAY_TOKEN = 'yas_sk_key';
    process.env.FLEET_API_TOKEN = 'fleet-token';
    // A host in the registry, so a fan-out WOULD have had somewhere to go —
    // otherwise this test would pass for the wrong reason.
    await db.insert(fleetHostsTable).values({
      name: 'hetzner-64',
      apiEndpoint: 'http://10.0.0.1:8080',
      version: '1.0.0',
      reportedAt: new Date(),
      draining: false,
      runsLive: 1,
      runsMax: 4,
      memReservedMib: 512,
      memBudgetMib: 2048,
      diskFreeMib: 40_000,
      maxIdleSeconds: 3,
    });

    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${GATEWAY}/v1/sandboxes`) {
        return reply({ sandboxes: [{ id: 'talyn-a', host: 'hetzner-64' }] });
      }
      if (url === `${GATEWAY}/v1/sandboxes/talyn-a`) {
        return reply({ sandbox: { id: 'talyn-a', status: 'busy', phase: 'agent' }, terminal: false });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { live, degraded } = await liveFleetSandboxes();
    expect(degraded).toEqual([]);
    expect(live).toHaveLength(1);
    expect(live[0].host).toBe('hetzner-64');
    // Hydrated, not the index row: the index cannot answer status, and a row
    // that reported `undefined` where it meant `busy` is worse than no row.
    expect(live[0].sandbox.status).toBe('busy');
    expect(live[0].sandbox.phase).toBe('agent');
    // Every call went to the gateway. A stray direct host dial here would be
    // the untenanted read this whole change exists to stop.
    for (const [url] of fetchMock.mock.calls) expect(String(url)).toContain(GATEWAY);
  });

  // A gateway that cannot be reached is reported against the GATEWAY, not
  // against every box in the registry. Blaming the hosts for one control plane
  // sends whoever is on call to the wrong machine.
  it('names the gateway when the gateway is the thing that is down', async () => {
    process.env.FLEET_PINNED_ENDPOINT = GATEWAY;
    process.env.FLEET_GATEWAY_TOKEN = 'yas_sk_key';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const { live, degraded } = await liveFleetSandboxes();
    expect(live).toEqual([]);
    expect(degraded).toHaveLength(1);
    expect(degraded[0].host).toBe(GATEWAY);
  });

  // One unreadable id is not a broken page, and it is attributed to the host
  // holding it — which is the only thing that says WHICH box went quiet.
  it('degrades one id without losing the rest', async () => {
    process.env.FLEET_PINNED_ENDPOINT = GATEWAY;
    process.env.FLEET_GATEWAY_TOKEN = 'yas_sk_key';
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${GATEWAY}/v1/sandboxes`) {
        return reply({
          sandboxes: [
            { id: 'talyn-a', host: 'hetzner-64' },
            { id: 'talyn-b', host: 'hetzner-65' },
          ],
        });
      }
      if (url.endsWith('/talyn-a')) {
        return reply({ sandbox: { id: 'talyn-a', status: 'busy' }, terminal: false });
      }
      throw new Error('boom');
    });

    const { live, degraded } = await liveFleetSandboxes();
    expect(live.map((l) => l.sandbox.id)).toEqual(['talyn-a']);
    expect(degraded).toHaveLength(1);
    expect(degraded[0].host).toBe('hetzner-65');
    expect(degraded[0].error).toContain('talyn-b');
  });

  // With no gateway configured nothing changes: the fan-out is still what a
  // deployment dialling its hosts directly uses, and this is the path every run
  // took before the cutover.
  it('still fans out over hosts when no gateway is configured', async () => {
    process.env.FLEET_API_TOKEN = 'fleet-token';
    await db.insert(fleetHostsTable).values({
      name: 'hetzner-64',
      apiEndpoint: 'http://10.0.0.1:8080',
      version: '1.0.0',
      reportedAt: new Date(),
      draining: false,
      runsLive: 1,
      runsMax: 4,
      memReservedMib: 512,
      memBudgetMib: 2048,
      diskFreeMib: 40_000,
      maxIdleSeconds: 3,
    });
    fetchMock.mockResolvedValue(reply({ sandboxes: [{ id: 'legacy-1', status: 'busy' }] }));

    const { live } = await liveFleetSandboxes();
    expect(live).toHaveLength(1);
    expect(live[0].host).toBe('hetzner-64');
    expect(String(fetchMock.mock.calls[0][0])).toContain('10.0.0.1:8080');
  });
});

describe('validating a workspace credential against a gateway', () => {
  // A CHECK THAT COULD NOT FAIL, until this.
  //
  // This pings whatever dispatch would actually use, so a bad setup surfaces in
  // the settings form rather than hours later on somebody else's task. It used
  // to present FLEET_API_TOKEN no matter what the endpoint was — and against a
  // gateway holding a key it has never seen, that still passed, because it
  // pinged `/healthz`, the one gateway route that takes no credential at all.
  // The form exercised a URL and never a key.
  //
  // WATCHED FAIL: send `fleetApiToken()` here instead, or call `ping()` instead
  // of a tenant route, and the assertions below break.
  it('presents the GATEWAY key, on a route that actually checks it', async () => {
    process.env.FLEET_PINNED_ENDPOINT = GATEWAY;
    process.env.FLEET_GATEWAY_TOKEN = 'yas_sk_key';
    process.env.FLEET_API_TOKEN = 'fleet-token';
    fetchMock.mockResolvedValue(reply({ sandboxes: [] }));

    const result = await selfHostedProvider.validateCredentials('ws-1', {
      claudeToken: 'sk-ant-oat01-abc',
    });
    expect(result).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${GATEWAY}/v1/sandboxes`);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer yas_sk_key',
    });
  });

  // A gateway key the gateway does not know must FAIL the form. This is the
  // case /healthz answered 200 for.
  it('rejects a gateway key the gateway refuses', async () => {
    process.env.FLEET_PINNED_ENDPOINT = GATEWAY;
    process.env.FLEET_GATEWAY_TOKEN = 'yas_sk_revoked';
    fetchMock.mockResolvedValue(
      reply({ error: 'unauthorized', message: 'bad, missing or revoked api key' }, { status: 401 }),
    );

    const result = await selfHostedProvider.validateCredentials('ws-1', {
      claudeToken: 'sk-ant-oat01-abc',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('revoked');
  });

  // And a deployment that has a gateway but no gateway key is a DEPLOYMENT
  // fault, named as one. It used to fail on FLEET_API_TOKEN — a variable a
  // gateway-only deployment has no reason to set.
  it('blames the deployment when neither fleet credential is set', async () => {
    process.env.FLEET_PINNED_ENDPOINT = GATEWAY;
    const result = await selfHostedProvider.validateCredentials('ws-1', {
      claudeToken: 'sk-ant-oat01-abc',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('FLEET_GATEWAY_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
