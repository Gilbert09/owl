import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ApiNetworkError } from '@talyn/client';

/**
 * The console's three-way access outcome.
 *
 * `{admin:false}` and "the request never completed" are DIFFERENT ANSWERS. The
 * direct ancestor of this test is apps/web's offlineBanner.test.tsx, written
 * because that distinction was collapsed elsewhere: a transport failure got
 * recorded as an authoritative negative and rendered as an alarming,
 * actionable-looking, wrong message. Here the same mistake would tell an
 * operator they had been de-admined, during the outage they opened the console
 * to investigate.
 *
 * The second thing pinned here is that NOTHING MOUNTS behind the gate. A
 * non-operator's browser must make exactly one authenticated request — the
 * access check — and must not open a WebSocket. The server refuses them
 * anyway, but "one request" is the property that makes that claim checkable.
 */

const me = vi.fn();
const wsConnect = vi.fn();
const wsDisconnect = vi.fn();
const otherCall = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    admin: {
      me: () => me(),
      // Any admin read a page might make. If the gate leaks, one of these
      // fires and the assertion below catches it.
      fleet: { hosts: () => otherCall() },
      users: { list: () => otherCall() },
    },
    ws: { connect: () => wsConnect(), disconnect: () => wsDisconnect() },
  },
}));

const signOut = vi.fn();
vi.mock('../components/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { email: 'someone@example.test' }, signOut }),
}));

const { AdminGate } = await import('../components/auth/AdminGate');

const text = () => document.body.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
});

// vitest runs with `globals: false`, so testing-library's automatic cleanup
// never registers — without this every render stacks in the same document and
// a "not to contain" assertion reads the PREVIOUS test's output.
afterEach(cleanup);

describe('AdminGate', () => {
  it('renders the console for an operator', async () => {
    me.mockResolvedValue({ admin: true, email: 'op@talyn.dev', capabilities: ['fleet.read'] });
    render(
      <AdminGate>
        <div>CONSOLE</div>
      </AdminGate>
    );
    await waitFor(() => expect(text()).toContain('CONSOLE'));
  });

  describe('when the server says no', () => {
    beforeEach(() => {
      me.mockResolvedValue({ admin: false, email: 'someone@example.test', capabilities: [] });
    });

    it('shows the operators-only screen instead of the console', async () => {
      render(
        <AdminGate>
          <div>CONSOLE</div>
        </AdminGate>
      );
      await waitFor(() => expect(text()).toMatch(/Operators only/i));
      expect(text()).not.toContain('CONSOLE');
    });

    it('points at the product rather than reading as an error', async () => {
      // A signed-in customer who lands here has done nothing wrong.
      render(
        <AdminGate>
          <div>CONSOLE</div>
        </AdminGate>
      );
      await waitFor(() => expect(text()).toMatch(/Operators only/i));
      expect(screen.getByText(/Go to Talyn/i)).toHaveProperty('href', 'https://app.talyn.dev/');
      expect(text()).not.toMatch(/error|failed|couldn't/i);
    });

    it('makes no other API call and opens no WebSocket', async () => {
      // The property that makes "a non-operator's browser makes exactly one
      // authenticated request" true rather than merely intended.
      render(
        <AdminGate>
          <div>CONSOLE</div>
        </AdminGate>
      );
      await waitFor(() => expect(text()).toMatch(/Operators only/i));
      expect(otherCall).not.toHaveBeenCalled();
      expect(wsConnect).not.toHaveBeenCalled();
    });
  });

  describe('when the check never completes', () => {
    it.each([
      ['a transport failure', new ApiNetworkError('GET', '/admin/me', new Error('offline'))],
      ['a 503 from the edge', new Error('Backend unreachable (HTTP 503)')],
      ['a timeout', new Error('The operation was aborted')],
    ])('shows "couldn\'t verify" for %s, NOT the operators-only screen', async (_l, err) => {
      me.mockRejectedValue(err);
      render(
        <AdminGate>
          <div>CONSOLE</div>
        </AdminGate>
      );
      await waitFor(() => expect(text()).toMatch(/Couldn't verify your access/i));
      // The assertion this whole file exists for.
      expect(text()).not.toMatch(/Operators only/i);
      expect(text()).not.toContain('CONSOLE');
    });

    it('says explicitly that access has not changed', async () => {
      me.mockRejectedValue(new Error('boom'));
      render(
        <AdminGate>
          <div>CONSOLE</div>
        </AdminGate>
      );
      await waitFor(() => expect(text()).toMatch(/not a sign that your access changed/i));
    });

    it('offers a retry that re-asks and can succeed', async () => {
      me.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({
        admin: true,
        email: 'op@talyn.dev',
        capabilities: [],
      });
      render(
        <AdminGate>
          <div>CONSOLE</div>
        </AdminGate>
      );
      await waitFor(() => expect(text()).toMatch(/Couldn't verify/i));
      screen.getByText(/Try again/i).click();
      await waitFor(() => expect(text()).toContain('CONSOLE'));
      expect(me).toHaveBeenCalledTimes(2);
    });

    it('does not sign the operator out', async () => {
      // A failed check is not a rejected session. Signing out here would turn
      // a backend blip into "log in again", mid-incident.
      me.mockRejectedValue(new Error('boom'));
      render(
        <AdminGate>
          <div>CONSOLE</div>
        </AdminGate>
      );
      await waitFor(() => expect(text()).toMatch(/Couldn't verify/i));
      expect(signOut).not.toHaveBeenCalled();
    });
  });
});
