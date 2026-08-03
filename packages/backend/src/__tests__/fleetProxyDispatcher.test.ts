import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fleetDispatcher, resetFleetDispatcherCache } from '../services/selfHosted/client.js';

/**
 * The proxy dispatcher fleet requests go out through.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * `fleetDispatcher()` constructs an undici `ProxyAgent`, and until 2026-08-03
 * `undici` was not a declared dependency of this package. The code comment
 * asserted "undici ships with Node", which is half true in the way that matters
 * most: Node bundles undici to implement global `fetch`, but only as an
 * INTERNAL module. `require('undici')` resolves nothing unless the package is
 * actually installed.
 *
 * It went to production because every layer hid it:
 *   - the dev tree happened to carry undici transitively, so local installs
 *     resolved it;
 *   - the runtime image prunes dev dependencies, so the deploy did not;
 *   - and `FLEET_HTTP_PROXY` is only ever set in production, so the `require`
 *     line never executed locally regardless.
 *
 * The result was `Cannot find module 'undici'`, surfaced to the user as
 * "Could not reach hetzner-64" — a network error for a packaging fault.
 *
 * So the load-bearing assertion here is the unglamorous one: with the proxy
 * configured, this function RETURNS SOMETHING. That is the check that fails the
 * moment undici stops being installed, and no amount of mocking would have
 * caught it — a mocked ProxyAgent proves the dependency is unnecessary, which
 * is the opposite of what needs proving.
 */
describe('fleetDispatcher', () => {
  const saved = process.env.FLEET_HTTP_PROXY;

  beforeEach(() => {
    resetFleetDispatcherCache();
    delete process.env.FLEET_HTTP_PROXY;
  });

  afterEach(() => {
    resetFleetDispatcherCache();
    if (saved === undefined) delete process.env.FLEET_HTTP_PROXY;
    else process.env.FLEET_HTTP_PROXY = saved;
  });

  // Unset means dial direct, which is what a deployment with no private link —
  // or one whose backend shares a network with its hosts — should do. Returning
  // a dispatcher here would route every fleet call through a proxy that is not
  // there.
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('returns no dispatcher when FLEET_HTTP_PROXY is %s', (_label, value) => {
    if (value !== undefined) process.env.FLEET_HTTP_PROXY = value;
    expect(fleetDispatcher()).toBeUndefined();
  });

  // THE REGRESSION TEST. Real undici, no mock: this constructs a genuine
  // ProxyAgent, so it throws MODULE_NOT_FOUND if the dependency is missing.
  it('constructs a real dispatcher when the proxy is configured', () => {
    process.env.FLEET_HTTP_PROXY = 'http://localhost:1055';
    const dispatcher = fleetDispatcher();
    expect(dispatcher).toBeDefined();
    // ProxyAgent is a Dispatcher; `dispatch` is the method undici's fetch calls.
    expect(typeof (dispatcher as { dispatch?: unknown }).dispatch).toBe('function');
  });

  // Building a ProxyAgent per request would leak a connection pool per call.
  it('reuses one dispatcher across calls for the same proxy', () => {
    process.env.FLEET_HTTP_PROXY = 'http://localhost:1055';
    expect(fleetDispatcher()).toBe(fleetDispatcher());
  });

  // Cached on the URL, not on "have I built one" — otherwise a deployment that
  // changed its proxy would keep dialling the old one until restart.
  it('rebuilds when the proxy URL changes', () => {
    process.env.FLEET_HTTP_PROXY = 'http://localhost:1055';
    const first = fleetDispatcher();
    process.env.FLEET_HTTP_PROXY = 'http://localhost:2055';
    expect(fleetDispatcher()).not.toBe(first);
  });

  it('stops using a dispatcher once the proxy is removed', () => {
    process.env.FLEET_HTTP_PROXY = 'http://localhost:1055';
    expect(fleetDispatcher()).toBeDefined();
    delete process.env.FLEET_HTTP_PROXY;
    expect(fleetDispatcher()).toBeUndefined();
  });
});
