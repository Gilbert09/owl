import {
  SELFHOSTED_FIELDS,
  cloudProviderConfigFromValues,
  cloudProviderFormComplete,
  cloudProviderOffered,
} from '../renderer/components/panels/SettingsPanel';

/**
 * The provider-card form rules.
 *
 * Every field was required until Talyn Fleet arrived, whose only required
 * credential is the user's Claude token. Getting that wrong in either direction
 * is a real failure — a form that refuses a configuration the backend would
 * accept, or one that stores an empty credential and then fails authenticating
 * with it.
 *
 * This file is duplicated in the desktop and web clients on purpose:
 * `apps/web` is a deliberate fork of the renderer (see CLAUDE.md), so a UI rule
 * living in both is the convention, not an oversight.
 */

/** A synthetic descriptor, for exercising the helpers independently of any
 *  real provider's current shape. */
const MIXED_FIELDS = [
  { key: 'endpoint', label: 'Endpoint' },
  { key: 'token', label: 'Token', type: 'password' as const },
  { key: 'extra', label: 'Extra', type: 'password' as const, optional: true },
];

describe('the Talyn Fleet descriptor', () => {
  // The point of the card's redesign: a workspace supplies its Claude
  // credential and nothing else at all.
  it('asks for exactly one thing, the Claude token', () => {
    expect(SELFHOSTED_FIELDS.map((f) => f.key)).toEqual(['claudeToken']);
    expect(SELFHOSTED_FIELDS.every((f) => !f.optional)).toBe(true);
  });

  // Both of these were fields once and neither was the workspace's to give.
  // `fleetToken` authenticates the BACKEND to a host — identical for every
  // workspace, so it is deployment config. `fleetEndpoint` chose WHICH host,
  // which nobody using the product can answer: they cannot see which box is
  // least loaded or which stopped reporting, and a stale pin silently routed
  // every task to a dead machine. Named explicitly so re-adding either is a
  // deliberate act with a failing test, not a plausible-looking edit.
  it.each(['fleetToken', 'fleetEndpoint'])('never asks the user for %s', (key) => {
    expect(SELFHOSTED_FIELDS.some((f) => f.key === key)).toBe(false);
  });

  // A credential rendered as plain text is one that gets read over a shoulder
  // or captured in a screen recording of a settings page.
  it('masks the Claude token', () => {
    expect(SELFHOSTED_FIELDS.find((f) => f.key === 'claudeToken')?.type).toBe('password');
  });

  it('is submittable with only the Claude token filled in, and not without it', () => {
    expect(cloudProviderFormComplete(SELFHOSTED_FIELDS, { claudeToken: 'sk-ant-oat01-x' })).toBe(
      true,
    );
    expect(cloudProviderFormComplete(SELFHOSTED_FIELDS, {})).toBe(false);
  });

  // Anything else the form state happens to be carrying is dropped: the config
  // request is built from the DESCRIPTOR, not from the values object, so a
  // removed field cannot keep being submitted by a stale bit of state.
  it('sends only the Claude token, ignoring values for fields it no longer has', () => {
    const config = cloudProviderConfigFromValues(SELFHOSTED_FIELDS, {
      claudeToken: 'sk-ant-oat01-x',
      fleetEndpoint: 'http://stale:8080',
      fleetToken: 'stale-bearer',
    });
    expect(config).toEqual({ claudeToken: 'sk-ant-oat01-x' });
  });
});

describe('cloudProviderFormComplete', () => {
  it('accepts a form whose only blank is optional', () => {
    expect(cloudProviderFormComplete(MIXED_FIELDS, { endpoint: 'http://x', token: 'tok' })).toBe(
      true,
    );
  });

  it('refuses a form missing a required field', () => {
    expect(cloudProviderFormComplete(MIXED_FIELDS, { endpoint: 'http://x' })).toBe(false);
  });

  it('treats whitespace as blank', () => {
    expect(cloudProviderFormComplete(MIXED_FIELDS, { endpoint: '   ', token: 'tok' })).toBe(false);
  });

  it('still requires every field when none is optional', () => {
    const required = [{ key: 'claudeToken', label: 'k' }];
    expect(cloudProviderFormComplete(required, {})).toBe(false);
    expect(cloudProviderFormComplete(required, { claudeToken: 'sk-ant-x' })).toBe(true);
  });
});

describe('cloudProviderConfigFromValues', () => {
  it('omits a blank optional rather than sending an empty string', () => {
    const config = cloudProviderConfigFromValues(MIXED_FIELDS, {
      endpoint: 'http://x',
      token: 'tok',
      extra: '   ',
    });
    // Storing "" would be a credential that exists and cannot authenticate,
    // which reads as a bad key rather than no key.
    expect(config).toEqual({ endpoint: 'http://x', token: 'tok' });
    expect('extra' in config).toBe(false);
  });

  it('sends an optional field that was filled in', () => {
    const config = cloudProviderConfigFromValues(MIXED_FIELDS, {
      endpoint: 'http://x',
      token: 't',
      extra: 'sk-ant-abc',
    });
    expect(config.extra).toBe('sk-ant-abc');
  });

  it('trims what it does send', () => {
    const config = cloudProviderConfigFromValues(MIXED_FIELDS, {
      endpoint: '  http://x  ',
      token: ' t ',
    });
    expect(config.endpoint).toBe('http://x');
    expect(config.token).toBe('t');
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

  // The wire value stays `selfhosted` even though the product calls it Talyn
  // Fleet: it is persisted in environments.type and integrations.type, so
  // renaming it would orphan every configured workspace.
  it('is true once the backend lists it', () => {
    expect(
      cloudProviderOffered([{ type: 'posthog_code' }, { type: 'selfhosted' }], 'selfhosted'),
    ).toBe(true);
  });
});
