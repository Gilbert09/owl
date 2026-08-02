import {
  cloudProviderConfigFromValues,
  cloudProviderFormComplete,
  cloudProviderOffered,
} from '../renderer/components/panels/SettingsPanel';

/**
 * The provider-card form rules.
 *
 * Every field was required until the self-hosted fleet arrived: its
 * `validateCredentials` needs an endpoint and a token but treats the Anthropic
 * key as optional, because a BYO-key fleet gets one per dispatch instead.
 * Getting that wrong in either direction is a real failure — a form that
 * refuses a configuration the backend would accept, or one that stores an
 * empty credential and then fails authenticating with it.
 *
 * This file is duplicated in the desktop and web clients on purpose:
 * `apps/web` is a deliberate fork of the renderer (see CLAUDE.md), so a UI rule
 * living in both is the convention, not an oversight.
 */

const FLEET_FIELDS = [
  { key: 'fleetEndpoint', label: 'Fleet API URL' },
  { key: 'fleetToken', label: 'Fleet API token', type: 'password' as const },
  { key: 'anthropicApiKey', label: 'Anthropic API key', type: 'password' as const, optional: true },
];

describe('cloudProviderFormComplete', () => {
  it('accepts a form whose only blank is optional', () => {
    expect(
      cloudProviderFormComplete(FLEET_FIELDS, {
        fleetEndpoint: 'http://10.0.0.2:8080',
        fleetToken: 'tok',
      }),
    ).toBe(true);
  });

  it('refuses a form missing a required field', () => {
    expect(
      cloudProviderFormComplete(FLEET_FIELDS, { fleetEndpoint: 'http://10.0.0.2:8080' }),
    ).toBe(false);
  });

  it('treats whitespace as blank', () => {
    expect(
      cloudProviderFormComplete(FLEET_FIELDS, { fleetEndpoint: '   ', fleetToken: 'tok' }),
    ).toBe(false);
  });

  it('still requires every field when none is optional', () => {
    const required = [{ key: 'anthropicApiKey', label: 'k' }];
    expect(cloudProviderFormComplete(required, {})).toBe(false);
    expect(cloudProviderFormComplete(required, { anthropicApiKey: 'sk-ant-x' })).toBe(true);
  });
});

describe('cloudProviderConfigFromValues', () => {
  it('omits a blank optional rather than sending an empty string', () => {
    const config = cloudProviderConfigFromValues(FLEET_FIELDS, {
      fleetEndpoint: 'http://10.0.0.2:8080',
      fleetToken: 'tok',
      anthropicApiKey: '   ',
    });
    // Storing "" would be a credential that exists and cannot authenticate,
    // which reads as a bad key rather than no key.
    expect(config).toEqual({ fleetEndpoint: 'http://10.0.0.2:8080', fleetToken: 'tok' });
    expect('anthropicApiKey' in config).toBe(false);
  });

  it('sends an optional field that was filled in', () => {
    const config = cloudProviderConfigFromValues(FLEET_FIELDS, {
      fleetEndpoint: 'http://x',
      fleetToken: 't',
      anthropicApiKey: 'sk-ant-abc',
    });
    expect(config.anthropicApiKey).toBe('sk-ant-abc');
  });

  it('trims what it does send', () => {
    const config = cloudProviderConfigFromValues(FLEET_FIELDS, {
      fleetEndpoint: '  http://x  ',
      fleetToken: ' t ',
    });
    expect(config.fleetEndpoint).toBe('http://x');
    expect(config.fleetToken).toBe('t');
  });
});

describe('cloudProviderOffered', () => {
  it('is false while the list is still loading', () => {
    // Not the same as "absent", even though both render nothing — conflating
    // them is how a card flashes in and out on every settings visit.
    expect(cloudProviderOffered(null, 'selfhosted')).toBe(false);
  });

  it('is false when the backend did not offer this provider', () => {
    // The fleet is filtered out of /cloud-providers for a workspace that is not
    // on FLEET_ALLOWED_EMAILS. Showing the card anyway would be a form that
    // always 403s on save.
    expect(cloudProviderOffered([{ type: 'posthog_code' }], 'selfhosted')).toBe(false);
  });

  it('is true once the backend lists it', () => {
    expect(
      cloudProviderOffered([{ type: 'posthog_code' }, { type: 'selfhosted' }], 'selfhosted'),
    ).toBe(true);
  });
});
