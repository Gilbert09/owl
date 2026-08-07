import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { runInScopedDb, type Database } from '../db/client.js';
import { fleetHosts as fleetHostsTable } from '../db/schema.js';
import {
  HOST_STALE_AFTER_MS,
  fleetReportTokenValid,
  getFleetHost,
  hostIsDispatchable,
  hostIsOnline,
  listFleetHosts,
  pickFleetHost,
  recordFleetHostReport,
} from '../services/fleetHosts.js';

/**
 * These queries must never run on the owner-scoped handle.
 *
 * `fleet_hosts` is deployment infrastructure with no owner column: RLS on, no
 * policy, no `authenticated` GRANT. But `pickFleetHost` is reached from request
 * context, where `withOwnerScope` has dropped the transaction to
 * `authenticated` — so a `getDbClient()` in this module picks up that handle
 * and Postgres answers `permission denied for table fleet_hosts`. Prod,
 * 2026-08-03: it surfaced in the settings card as a raw "Failed query".
 *
 * A privileges test cannot catch this. The suite runs on pglite as a superuser
 * with no `authenticated` role at all, so the GRANT that is missing in
 * production is irrelevant here and the query succeeds either way — the check
 * would pass no matter which client the module used, which is worse than no
 * check because it reads like coverage.
 *
 * So test the thing that IS observable: install a scoped handle that throws if
 * anything touches it, and assert the registry works anyway. That fails
 * immediately if `getPoolDbClient()` ever goes back to `getDbClient()`, which is
 * the actual regression.
 */
describe('fleet host registry ignores the owner scope', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ cleanup } = await createTestDb());
  });
  afterEach(async () => {
    await cleanup();
  });

  /** A handle whose every use is a test failure. */
  const poisoned = new Proxy({} as Database, {
    get(_t, prop) {
      throw new Error(
        `fleet_hosts query used the owner-scoped DB handle (.${String(prop)}). ` +
          'It must use getPoolDbClient() — the authenticated role has no grant on that table.',
      );
    },
  });

  it('reads the registry from inside an owner scope', async () => {
    await recordFleetHostReport({ host: 'h1', apiEndpoint: 'http://h1:8080', runsMax: 4 });

    await runInScopedDb(poisoned, async () => {
      expect((await listFleetHosts()).map((h) => h.name)).toEqual(['h1']);
      expect((await getFleetHost('h1'))?.apiEndpoint).toBe('http://h1:8080');
      expect((await pickFleetHost())?.name).toBe('h1');
    });
  });

  // The write path is pre-auth today (the report route is token-gated, not
  // JWT-gated) so it never met a scope — which is exactly why it would be the
  // one to break silently if that route ever moved behind auth.
  it('writes to the registry from inside an owner scope', async () => {
    await runInScopedDb(poisoned, async () => {
      await recordFleetHostReport({ host: 'h2', apiEndpoint: 'http://h2:8080', runsMax: 2 });
    });
    expect((await getFleetHost('h2'))?.runsMax).toBe(2);
  });
});

/**
 * The fleet host registry.
 *
 * The property worth holding onto while reading these: **registration does not
 * imply reachability**. Hosts push their state outbound because the backend
 * must never hold an inbound path to a machine running untrusted code — which
 * means a host can report in perfectly happily and still be undispatchable.
 * Most of what follows is about not conflating the two.
 */
describe('fleet host registry', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    process.env.FLEET_REPORT_TOKEN = 'shared-secret';
  });

  afterEach(async () => {
    await cleanup();
    delete process.env.FLEET_REPORT_TOKEN;
  });

  describe('fleetReportTokenValid', () => {
    it('refuses everything when no token is configured', () => {
      delete process.env.FLEET_REPORT_TOKEN;
      // An open report endpoint lets anyone invent a host — and an invented
      // host with an apiEndpoint is a DISPATCH TARGET. That is a route to
      // sending customer work to a stranger's server, not merely bad telemetry.
      expect(fleetReportTokenValid('anything')).toBe(false);
      expect(fleetReportTokenValid(undefined)).toBe(false);
    });

    it('accepts the configured token and refuses anything else', () => {
      expect(fleetReportTokenValid('shared-secret')).toBe(true);
      expect(fleetReportTokenValid('shared-secre')).toBe(false);
      expect(fleetReportTokenValid('shared-secrets')).toBe(false);
      expect(fleetReportTokenValid('')).toBe(false);
      expect(fleetReportTokenValid(undefined)).toBe(false);
    });
  });

  describe('recordFleetHostReport', () => {
    it('registers a host and is idempotent on repeat', async () => {
      await recordFleetHostReport({ host: 'hetzner-64', version: 'v1', runsLive: 1, runsMax: 2 });
      await recordFleetHostReport({ host: 'hetzner-64', version: 'v2', runsLive: 2, runsMax: 2 });

      const rows = await db.select().from(fleetHostsTable);
      // Keyed on the host's own name: a host that restarts, redeploys or
      // changes address is the same host, and a surrogate id would let it
      // register twice and be dispatched to twice.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.version).toBe('v2');
      expect(rows[0]!.runsLive).toBe(2);
    });

    it('refuses a report with no host name', async () => {
      await expect(recordFleetHostReport({ host: '' })).rejects.toThrow();
      await expect(recordFleetHostReport({ host: '   ' })).rejects.toThrow();
    });

    it('stores a blank advertised endpoint as null, not as an empty string', async () => {
      await recordFleetHostReport({ host: 'h1', apiEndpoint: '   ' });
      const host = await getFleetHost('h1');
      // `dispatchable` keys off this being absent. An empty string is truthy
      // enough to slip past a careless check and then fail on connect.
      expect(host?.apiEndpoint).toBeNull();
      expect(host?.dispatchable).toBe(false);
    });

    it('timestamps with OUR clock, not the reporting host’s', async () => {
      await recordFleetHostReport({
        host: 'h1',
        // A box with a skewed clock would otherwise look permanently stale or
        // permanently fresh, and staleness is what gates dispatch.
        reportedAt: new Date('2000-01-01').toISOString(),
      });
      const host = await getFleetHost('h1');
      expect(host!.reportedAt.getFullYear()).toBeGreaterThan(2020);
      expect(host!.online).toBe(true);
    });
  });

  describe('hostIsOnline', () => {
    it('goes offline once reports stop', () => {
      const now = Date.now();
      expect(hostIsOnline(new Date(now - 1_000), now)).toBe(true);
      expect(hostIsOnline(new Date(now - HOST_STALE_AFTER_MS + 1), now)).toBe(true);
      expect(hostIsOnline(new Date(now - HOST_STALE_AFTER_MS), now)).toBe(false);
    });
  });

  describe('hostIsDispatchable', () => {
    /**
     * Built per case, NOT once at describe time.
     *
     * `reportedAt` was a single `new Date()` evaluated when the suite was
     * collected, so in a slow full-suite run (each pglite file spins up its own
     * Postgres) it aged past HOST_STALE_AFTER_MS before the later cases ran —
     * and every one of them then failed for staleness rather than the thing it
     * was testing. It looked exactly like a broken dispatch predicate, and cost
     * a real investigation on 2026-08-06 while a fleet host was genuinely down.
     */
    const freshHost = () => ({
      reportedAt: new Date(),
      draining: false,
      runsLive: 0,
      runsMax: 4,
      apiEndpoint: 'http://10.9.0.2:8080',
    });

    it('is true for a live host with room and an address', () => {
      expect(hostIsDispatchable(freshHost())).toBe(true);
    });

    it('is FALSE for a healthy, idle host that advertised no address', () => {
      // The easy one to forget, and the whole reason registration and
      // reachability are separate: there is nowhere to send the run, so
      // treating it as available means picking it and failing on connect.
      expect(hostIsDispatchable({ ...freshHost(), apiEndpoint: null })).toBe(false);
    });

    it('is false while draining', () => {
      expect(hostIsDispatchable({ ...freshHost(), draining: true })).toBe(false);
    });

    it('is false once the host has stopped reporting', () => {
      expect(hostIsDispatchable({ ...freshHost(), reportedAt: new Date(Date.now() - HOST_STALE_AFTER_MS - 1) })).toBe(false);
    });

    it('is false at capacity and true below it', () => {
      expect(hostIsDispatchable({ ...freshHost(), runsLive: 4, runsMax: 4 })).toBe(false);
      expect(hostIsDispatchable({ ...freshHost(), runsLive: 3, runsMax: 4 })).toBe(true);
    });

    it('treats an unknown cap as unknown rather than full', () => {
      // A host reporting at all is a host that is running. Reading "no cap
      // declared" as "full" would make a host that never sends runsMax
      // permanently undispatchable and give no clue why.
      expect(hostIsDispatchable({ ...freshHost(), runsLive: 99, runsMax: 0 })).toBe(true);
    });
  });

  describe('pickFleetHost', () => {
    it('returns null when nothing can take work', async () => {
      await recordFleetHostReport({ host: 'no-address', runsMax: 4 });
      await recordFleetHostReport({ host: 'draining', apiEndpoint: 'http://a', draining: true, runsMax: 4 });
      expect(await pickFleetHost()).toBeNull();
    });

    it('picks the least loaded of the dispatchable hosts', async () => {
      await recordFleetHostReport({ host: 'busy', apiEndpoint: 'http://busy', runsLive: 3, runsMax: 4 });
      await recordFleetHostReport({ host: 'idle', apiEndpoint: 'http://idle', runsLive: 1, runsMax: 4 });
      await recordFleetHostReport({ host: 'unreachable', runsLive: 0, runsMax: 4 });

      const picked = await pickFleetHost();
      expect(picked?.name).toBe('idle');
    });

    it('prefers a host that declared a cap over one that did not', async () => {
      await recordFleetHostReport({ host: 'known', apiEndpoint: 'http://known', runsLive: 3, runsMax: 4 });
      await recordFleetHostReport({ host: 'unknown-cap', apiEndpoint: 'http://unknown', runsLive: 0, runsMax: 0 });

      // Without a denominator its load is unknown, and unknown should not beat
      // a host that has told us how loaded it is.
      expect((await pickFleetHost())?.name).toBe('known');
    });

    it('ignores a host that has gone quiet', async () => {
      await recordFleetHostReport({ host: 'gone', apiEndpoint: 'http://gone', runsLive: 0, runsMax: 4 });
      const later = Date.now() + HOST_STALE_AFTER_MS + 1;
      expect(await pickFleetHost(later)).toBeNull();
    });
  });

  describe('listFleetHosts', () => {
    it('reports a host that has gone quiet rather than hiding it', async () => {
      await recordFleetHostReport({ host: 'gone', apiEndpoint: 'http://gone', runsMax: 4 });
      const hosts = await listFleetHosts(Date.now() + HOST_STALE_AFTER_MS + 1);
      // A host that goes dark keeps its last snapshot with a timestamp, so an
      // operator sees "last seen 4 minutes ago" instead of an empty list — the
      // thing push-based reporting buys over scraping.
      expect(hosts).toHaveLength(1);
      expect(hosts[0]!.online).toBe(false);
      expect(hosts[0]!.dispatchable).toBe(false);
    });
  });
});

/**
 * Dispatch routing: the credential says WHETHER a workspace may use the fleet,
 * the registry says WHERE.
 *
 * Splitting them is what makes more than one host possible — a token stored per
 * workspace does not know which box is least loaded, which is draining, or
 * which has stopped reporting. These tests pin that split, and in particular
 * that "not configured" and "configured but nothing is up" stay distinguishable:
 * collapsing them into one silent null answers neither.
 */
describe('resolveFleetTarget', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    process.env.FLEET_REPORT_TOKEN = 'shared-secret';
    // The bearer the backend presents to a host. Deployment config, not a
    // workspace secret — the workspace supplies only its Claude token.
    process.env.FLEET_API_TOKEN = 'fleet-token';
    // The credential store encrypts at rest, so these tests need a key.
    process.env.TALYN_TOKEN_KEY ||= Buffer.alloc(32, 7).toString('base64');
  });

  afterEach(async () => {
    await cleanup();
    delete process.env.FLEET_REPORT_TOKEN;
    delete process.env.FLEET_API_TOKEN;
    delete process.env.FLEET_PINNED_ENDPOINT;
  });

  async function seedWorkspaceWithFleetCreds(): Promise<void> {
    const { seedUser, TEST_USER_ID } = await import('./helpers/testDb.js');
    const { workspaces } = await import('../db/schema.js');
    const { storeSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspaces).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws' });
    await storeSelfHostedCredentials('ws1', { claudeToken: 'sk-ant-oat01-test' });
  }

  it('returns null when the workspace has no fleet credential at all', async () => {
    const { resolveFleetTarget } = await import('../services/selfHosted/credentials.js');
    // "Not configured" — distinct from "configured and nothing is up", which
    // throws. One is a setup step the user has not done; the other is an
    // outage, and they need different answers.
    expect(await resolveFleetTarget('ws-unknown')).toBeNull();
  });

  it('uses FLEET_PINNED_ENDPOINT when the operator set one, ignoring the registry', async () => {
    await seedWorkspaceWithFleetCreds();
    await recordFleetHostReport({ host: 'other', apiEndpoint: 'http://other:8080', runsMax: 4 });
    process.env.FLEET_PINNED_ENDPOINT = 'http://pinned.example:8080/';

    const { resolveFleetTarget } = await import('../services/selfHosted/credentials.js');
    const target = await resolveFleetTarget('ws1');
    // A debugging override: it forces every run onto one box regardless of load
    // or health, which is what you want while bisecting a host and what you do
    // not want otherwise. Trailing slash normalised, or every dialled path
    // doubles its separator.
    expect(target?.endpoint).toBe('http://pinned.example:8080');
    expect(target?.host).toBeUndefined();
  });

  it('falls back to the least-loaded registered host when nothing is pinned', async () => {
    await seedWorkspaceWithFleetCreds();
    await recordFleetHostReport({ host: 'busy', apiEndpoint: 'http://busy:8080', runsLive: 3, runsMax: 4 });
    await recordFleetHostReport({ host: 'idle', apiEndpoint: 'http://idle:8080', runsLive: 0, runsMax: 4 });

    const { resolveFleetTarget } = await import('../services/selfHosted/credentials.js');
    const target = await resolveFleetTarget('ws1');
    expect(target?.host).toBe('idle');
    expect(target?.endpoint).toBe('http://idle:8080');
    // The registry supplies an ADDRESS, never a secret. A host that could
    // publish its own API token in a report would be publishing it to anything
    // that can POST there — the bearer comes from deployment config instead.
    expect(target?.token).toBe('fleet-token');
  });

  it('throws when the deployment has no FLEET_API_TOKEN, rather than dispatching unauthenticated', async () => {
    await seedWorkspaceWithFleetCreds();
    await recordFleetHostReport({ host: 'idle', apiEndpoint: 'http://idle:8080', runsMax: 4 });
    delete process.env.FLEET_API_TOKEN;

    const { resolveFleetTarget, FleetNotDeployedError } = await import(
      '../services/selfHosted/credentials.js'
    );
    // Not a capacity error and not a null: the hosts are fine and the workspace
    // is configured. Reporting either would send someone to look in the wrong
    // place — this is an operator's missing env var.
    await expect(resolveFleetTarget('ws1')).rejects.toBeInstanceOf(FleetNotDeployedError);
  });

  it('raises a CAPACITY error, not a terminal one, when nothing is dispatchable', async () => {
    await seedWorkspaceWithFleetCreds();
    await recordFleetHostReport({ host: 'draining', apiEndpoint: 'http://d:8080', draining: true, runsMax: 4 });

    const { resolveFleetTarget } = await import('../services/selfHosted/credentials.js');
    const { FleetCapacityError } = await import('../services/selfHosted/client.js');
    // Every box being busy or offline is exactly what fail-back exists for
    // (§11.6). Failing the user's task over it would be the wrong shape —
    // another provider can still run the work.
    await expect(resolveFleetTarget('ws1')).rejects.toBeInstanceOf(FleetCapacityError);
  });
});
