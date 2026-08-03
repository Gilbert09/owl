import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * PostHog identity across the auth lifecycle, plus what this console must
 * NEVER capture.
 *
 * Two of these are inherited bugs — AuthProvider is copied verbatim from
 * apps/web, so both of its lessons apply unchanged:
 *
 * 1. The desktop detects a fresh login by watching userId go null → set. On
 *    web that in-memory transition is destroyed by the full-page OAuth
 *    redirect, so `logged_in` was never captured at all until takePendingLogin
 *    bridged it through sessionStorage.
 * 2. The identify effect also runs on first render, before auth resolves.
 *    Treating "not known yet" as "signed out" meant posthog.reset() on every
 *    page load, churning the anonymous distinct_id.
 *
 * The third is specific to this app and is the important one: session replay
 * of an admin console would ship every customer email, workspace name and
 * agent transcript it renders into PostHog — a more complete copy of the
 * production database than anything else we hold, in a tool with a different
 * access model.
 */

const identify = vi.fn();
const reset = vi.fn();
const track = vi.fn();

vi.mock('../lib/analytics', () => ({
  identifyAnalyticsUser: (...a: unknown[]) => identify(...a),
  resetAnalyticsUser: () => reset(),
  trackEvent: (...a: unknown[]) => track(...a),
}));
vi.mock('../lib/logoutReason', () => ({ consumeLogoutReason: () => 'manual' }));

let mockUser: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null = null;
vi.mock('../components/auth/AuthProvider', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../components/auth/AuthProvider');
  return { ...actual, useAuth: () => ({ user: mockUser }) };
});

const { Analytics } = await import('../components/Analytics');
const { takePendingLogin } = await import('../components/auth/AuthProvider');

const USER = { id: 'user-1', email: 'op@talyn.dev', user_metadata: { user_name: 'gilbert09' } };

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockUser = null;
});
afterEach(cleanup);

describe('identity', () => {
  it('identifies a signed-in operator with email and github login', () => {
    mockUser = USER;
    render(<Analytics />);
    expect(identify).toHaveBeenCalledWith('user-1', {
      email: 'op@talyn.dev',
      github_login: 'gilbert09',
    });
  });

  it('captures logged_in when returning from the OAuth redirect', () => {
    // The full-page redirect destroys the null → set transition the desktop
    // relies on; the sessionStorage marker is the bridge.
    sessionStorage.setItem('talyn:pending-login', '1');
    mockUser = USER;
    render(<Analytics />);
    expect(track).toHaveBeenCalledWith('logged_in');
    // Consumed exactly once — a marker that survives would report a login on
    // every subsequent mount.
    expect(takePendingLogin()).toBe(false);
  });

  it('does NOT capture logged_in for a restored session', () => {
    mockUser = USER;
    render(<Analytics />);
    expect(track).not.toHaveBeenCalledWith('logged_in');
  });

  it('does not reset on first render, when auth has not resolved', () => {
    // "Not known yet" is not "signed out". Resetting here churns the
    // anonymous distinct_id on every page load.
    mockUser = null;
    render(<Analytics />);
    expect(reset).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith('logged_out', expect.anything());
  });

  it('captures logged_out with a reason on a real sign-out', () => {
    mockUser = USER;
    const view = render(<Analytics />);
    mockUser = null;
    view.rerender(<Analytics />);
    expect(track).toHaveBeenCalledWith('logged_out', { reason: 'manual' });
    expect(reset).toHaveBeenCalled();
  });
});
