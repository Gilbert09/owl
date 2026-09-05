import { describe, it, expect } from '@jest/globals';
import { cloudProviderOffered } from '../renderer/components/panels/SettingsPanel';

/**
 * Whether a provider card renders at all.
 *
 * This file used to also cover a generic, descriptor-driven `CloudProviderCard`
 * and its two form helpers. That card is gone: both remaining cards (PostHog
 * Code, Talyn Fleet) are bespoke, because each has more than one way to connect
 * and one field list behind one Connect/Disconnect pair cannot express that.
 *
 * What survives is the rule that outlived it — and it is the one that actually
 * caused a visible bug.
 */
describe('cloudProviderOffered', () => {
  /**
   * `null` is "the list has not loaded", NOT "the provider is absent". Both
   * render nothing, and conflating them is how a card flashes in and out on
   * every settings visit.
   */
  it('renders nothing while the list is still loading', () => {
    expect(cloudProviderOffered(null, 'selfhosted')).toBe(false);
  });

  it('renders nothing when the backend did not offer the provider', () => {
    // Talyn Fleet is filtered out server-side for a workspace that is not on
    // FLEET_ALLOWED_EMAILS. Showing the card anyway would be a form that always
    // 403s on save, which reads as a broken integration rather than one you do
    // not have.
    expect(cloudProviderOffered([{ type: 'posthog_code' }], 'selfhosted')).toBe(false);
  });

  it('renders the card when the backend offered it', () => {
    expect(
      cloudProviderOffered([{ type: 'posthog_code' }, { type: 'selfhosted' }], 'selfhosted')
    ).toBe(true);
  });

  it('offers a provider that is listed but not yet connected', () => {
    // "Offered" is about visibility, not credentials — the card is where you go
    // to supply them.
    expect(cloudProviderOffered([{ type: 'selfhosted' }], 'selfhosted')).toBe(true);
  });
});
