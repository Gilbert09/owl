import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The OAuth landing route.
 *
 * It exists as its own path for two reasons worth not losing: Supabase's
 * redirect allowlist takes exact URLs, and `detectSessionInUrl: true` fires on
 * ANY page load carrying `?code=` — so confining the exchange to one route
 * means no other page can accidentally trigger one.
 *
 * The explicit error handling is the part that rots. detectSessionInUrl
 * swallows failures into a console warning, so without it "GitHub said no" is
 * an indefinite spinner on a page with no way out.
 */

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

let mockSession: object | null = null;
let mockReturnPath: string | null = null;
vi.mock('../components/auth/AuthProvider', () => ({
  useAuth: () => ({ session: mockSession }),
  takeReturnPath: () => mockReturnPath,
}));

const { AuthCallback } = await import('../routes/AuthCallback');

function renderAt(search: string) {
  window.history.pushState({}, '', `/auth/callback${search}`);
  return render(
    <MemoryRouter>
      <AuthCallback />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSession = null;
  mockReturnPath = null;
});
afterEach(cleanup);

describe('AuthCallback', () => {
  it('sends a signed-in operator to the console default', async () => {
    mockSession = { user: { id: 'u1' } };
    renderAt('');
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/fleet/hosts', { replace: true })
    );
  });

  it('honours a stashed return path over the default', async () => {
    // The operator followed a deep link, got bounced to sign in, and should
    // land back where they were pointing — not at the host list.
    mockSession = { user: { id: 'u1' } };
    mockReturnPath = '/fleet/runs/talyn-abc';
    renderAt('');
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/fleet/runs/talyn-abc', { replace: true })
    );
  });

  it.each([
    ['error_description', '?error_description=access_denied%20by%20user'],
    ['error', '?error=server_error'],
  ])('surfaces a provider %s instead of spinning forever', (_l, search) => {
    renderAt(search);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Sign-in failed/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('offers a way back to sign in after a failure', () => {
    renderAt('?error=server_error');
    expect(document.body.textContent ?? '').toMatch(/Back to sign in/i);
  });

  it('shows the boot spinner while the exchange is in flight', () => {
    // Not a different-looking interstitial: the OAuth round trip should not
    // flash a screen the operator has never seen.
    renderAt('');
    expect(document.body.textContent ?? '').not.toMatch(/Sign-in failed/i);
  });
});
