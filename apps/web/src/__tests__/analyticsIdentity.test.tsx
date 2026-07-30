import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

/**
 * PostHog identity across the auth lifecycle.
 *
 * Two things here are web-specific and were both wrong in the first port:
 *
 * 1. The desktop detects a fresh login by watching userId go null → set,
 *    because its OAuth runs in the system browser and the app never reloads.
 *    On web the redirect is a full page navigation, so that in-memory
 *    transition is destroyed and `logged_in` was never captured at all.
 *
 * 2. The identify effect also runs on first render, before auth resolves.
 *    Treating "not known yet" the same as "signed out" meant posthog.reset()
 *    on every page load — churning the anonymous distinct_id and starting a
 *    fresh session-replay session each time.
 */

const identify = vi.fn();
const reset = vi.fn();
const track = vi.fn();
const registerSuper = vi.fn();

vi.mock('../lib/analytics', () => ({
  identifyAnalyticsUser: (...a: unknown[]) => identify(...a),
  resetAnalyticsUser: () => reset(),
  trackEvent: (...a: unknown[]) => track(...a),
  registerSuperProperties: (...a: unknown[]) => registerSuper(...a),
}));
vi.mock('../lib/logoutReason', () => ({ consumeLogoutReason: () => 'manual' }));

let mockUser: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null = null;
vi.mock('../components/auth/AuthProvider', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../components/auth/AuthProvider'
  );
  return { ...actual, useAuth: () => ({ user: mockUser }) };
});

const { Analytics } = await import('../components/Analytics');
const { takePendingLogin } = await import('../components/auth/AuthProvider');

const USER = { id: 'user-1', email: 'a@b.c', user_metadata: { user_name: 'gilbert09' } };

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockUser = null;
});

describe('identify', () => {
  it('identifies with the user id, email and github login', () => {
    mockUser = USER;
    render(<Analytics />);
    expect(identify).toHaveBeenCalledWith('user-1', {
      email: 'a@b.c',
      github_login: 'gilbert09',
    });
  });
});

describe('logged_in across the OAuth redirect', () => {
  it('fires when a sign-in this tab started completes', () => {
    // What signInWithGitHub leaves behind before navigating to GitHub.
    sessionStorage.setItem('talyn:pending-login', '1');
    mockUser = USER;
    render(<Analytics />);
    expect(track).toHaveBeenCalledWith('logged_in');
  });

  it('does NOT fire for a restored session', () => {
    // Fresh page load, already signed in, no sign-in was started here.
    mockUser = USER;
    render(<Analytics />);
    expect(track).not.toHaveBeenCalledWith('logged_in');
  });

  it('consumes the marker so a reload does not double-count', () => {
    sessionStorage.setItem('talyn:pending-login', '1');
    mockUser = USER;
    render(<Analytics />);
    expect(track).toHaveBeenCalledWith('logged_in');

    vi.clearAllMocks();
    render(<Analytics />); // simulates a subsequent load
    expect(track).not.toHaveBeenCalledWith('logged_in');
    expect(takePendingLogin()).toBe(false);
  });
});

describe('reset', () => {
  it('does NOT reset on first render while auth is still resolving', () => {
    // THE REGRESSION: userId is undefined here because auth has not resolved,
    // not because the user signed out. Resetting churns the anonymous id and
    // starts a new replay session on every page load.
    mockUser = null;
    render(<Analytics />);
    expect(reset).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith('logged_out', expect.anything());
  });

  it('resets and tracks logged_out on a real sign-out', () => {
    mockUser = USER;
    const view = render(<Analytics />);
    vi.clearAllMocks();

    mockUser = null; // signed out
    view.rerender(<Analytics />);
    expect(track).toHaveBeenCalledWith('logged_out', { reason: 'manual' });
    expect(reset).toHaveBeenCalled();
  });
});
