import { describe, it, expect } from 'vitest';
import { CLIENT_VERSION } from '../lib/env';

/**
 * Two lines that pin a security contract otherwise held together by a comment.
 *
 * CLIENT_VERSION becomes `X-Talyn-Client-Version`, which the backend's paywall
 * gate parses (services/billing/clientGate.ts). That gate is FAIL-CLOSED and
 * exempts only a value matching a bare `X.Y.Z` below its floor — so a
 * namespaced version is always enforced, and a bare-semver one silently would
 * not be.
 *
 * The gate used to be the other way round, which made the paywall opt-in: the
 * CLI, the MCP server and plain curl all bypassed it with no error, no log and
 * no metric. This console is cross-tenant, so the same class of mistake here
 * would be considerably worse than a free subscription.
 */
describe('CLIENT_VERSION', () => {
  it('is namespaced to this client', () => {
    expect(CLIENT_VERSION).toMatch(/^admin\//);
  });

  it('can never parse as a desktop semver', () => {
    // The exact regex clientGate uses. If this ever matches, the console is
    // exempt from the free-plan limits and nobody finds out.
    expect(CLIENT_VERSION).not.toMatch(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  });

  it('stays namespaced even on a build with no SHA', () => {
    // vite.config.ts falls back to 'dev'; `admin/dev` is still unparseable.
    expect(CLIENT_VERSION.split('/')[0]).toBe('admin');
    expect(CLIENT_VERSION.length).toBeGreaterThan('admin/'.length);
  });
});
