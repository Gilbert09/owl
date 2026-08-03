import { describe, it, expect, vi } from 'vitest';

/**
 * What this console is configured NOT to capture.
 *
 * Session-replaying an admin console would ship every customer email,
 * workspace name, task prompt and agent transcript it renders into PostHog —
 * a more complete copy of the production database than anything else we hold,
 * sitting in a third-party tool with a different access model. Autocapture is
 * the same problem at lower volume: element text on a cross-tenant table is
 * customer data.
 *
 * Both are single-flag decisions in a file forked from apps/web, where both
 * flags point the other way. That is exactly the kind of difference a future
 * "sync the fork" pass silently reverts, so it is asserted rather than
 * commented.
 */

const init = vi.fn();
const register = vi.fn();
const capture = vi.fn();
const startSessionRecording = vi.fn();

vi.mock('posthog-js/dist/module.full.no-external', () => ({
  default: {
    init: (...a: unknown[]) => init(...a),
    register: (...a: unknown[]) => register(...a),
    capture: (...a: unknown[]) => capture(...a),
    startSessionRecording: () => startSessionRecording(),
    identify: vi.fn(),
    reset: vi.fn(),
    captureException: vi.fn(),
  },
}));
vi.mock('posthog-js/dist/posthog-recorder', () => ({}));
vi.mock('../lib/env', () => ({
  POSTHOG_KEY: 'phc_test',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  IS_DEV_BUILD: false,
  APP_VERSION: 'admin/abc1234',
}));

const { initAnalytics } = await import('../lib/analytics');

// `initAnalytics` is idempotent by module-level flag, so it can only ever be
// observed once per test file — calling it per-test (and clearing mocks
// between) leaves every case after the first with no recorded call.
initAnalytics();
const CONFIG = init.mock.calls[0]?.[1] as Record<string, unknown>;

function config(): Record<string, unknown> {
  return CONFIG;
}

describe('PostHog configuration', () => {
  it('disables session recording', () => {
    expect(config().disable_session_recording).toBe(true);
  });

  it('disables autocapture', () => {
    expect(config().autocapture).toBe(false);
  });

  it('never starts a recording, even from the loaded callback', () => {
    // apps/web calls startSessionRecording() inside `loaded`. Dropping that
    // call is half the fix; the flag above is the other half, and a fork sync
    // could restore either one independently.
    startSessionRecording.mockClear();
    const loaded = config().loaded as (ph: unknown) => void;
    loaded({ register, capture });
    expect(startSessionRecording).not.toHaveBeenCalled();
  });

  it('captures pageviews natively — this app is a real multi-page router', () => {
    // The product apps set this false and track panels as events instead.
    expect(config().capture_pageview).toBe(true);
  });

  it('registers client:"admin" from the loaded callback', () => {
    // Registered in `loaded`, not straight after init(): posthog-js only has
    // its persistence layer ready by then, and props registered earlier are
    // silently dropped. Three front ends now report into one project, so
    // without `client` every funnel merges them.
    register.mockClear();
    const loaded = config().loaded as (ph: { register: typeof register }) => void;
    loaded({ register });
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ client: 'admin', app_version: 'admin/abc1234' })
    );
  });

  it('only materialises person profiles for identified users', () => {
    expect(config().person_profiles).toBe('identified_only');
  });
});
