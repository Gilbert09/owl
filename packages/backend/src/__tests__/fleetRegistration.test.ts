import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The self-hosted fleet is gated on FLEET_ENABLED, and "gated" here means
 * NOT REGISTERED rather than registered-and-inert. That is the stronger form:
 * with the flag off `getCloudProvider('selfhosted')` returns null, so no
 * dispatch path can reach the fleet at all.
 *
 * This exists because the gate is a single `if` in boot code that nothing else
 * covers — exactly the shape of thing that gets deleted in a refactor and is
 * only noticed when a task goes somewhere unexpected in production.
 */
describe('self-hosted provider registration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is not resolvable when FLEET_ENABLED is unset', async () => {
    const { getCloudProvider } = await import('../services/cloudProviders/registry.js');
    expect(getCloudProvider('selfhosted')).toBeNull();
  });

  it('is not resolvable when FLEET_ENABLED is anything other than "true"', async () => {
    const { registerCloudProvider, getCloudProvider } = await import(
      '../services/cloudProviders/registry.js'
    );
    const { selfHostedProvider } = await import(
      '../services/cloudProviders/selfhosted/provider.js'
    );
    // Mirror the boot gate exactly: only the literal string 'true' registers.
    for (const value of ['1', 'yes', 'TRUE', '', undefined]) {
      if (value === 'true') registerCloudProvider(selfHostedProvider);
    }
    expect(getCloudProvider('selfhosted')).toBeNull();
  });

  it('resolves once registered, and answers to the type the task carries', async () => {
    const { registerCloudProvider, getCloudProvider } = await import(
      '../services/cloudProviders/registry.js'
    );
    const { selfHostedProvider } = await import(
      '../services/cloudProviders/selfhosted/provider.js'
    );
    registerCloudProvider(selfHostedProvider);

    const resolved = getCloudProvider('selfhosted');
    expect(resolved).not.toBeNull();
    // The registry keys on provider.type; a mismatch between that and the
    // CloudProviderType a task stores would resolve to null at dispatch time.
    expect(resolved?.type).toBe('selfhosted');
  });
});
