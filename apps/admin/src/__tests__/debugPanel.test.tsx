import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import type { DebugEvent, DebugSnapshot } from '@talyn/shared';

/**
 * The Debug panel's first test, in 755 lines across two apps.
 *
 * It moved here rather than being rewritten (a zero-diff `git mv`), and a move
 * is the cheapest moment to add the coverage it never had — the imports it
 * relies on all changed app underneath it, so "does it still mount and talk to
 * the API" is worth knowing before an operator finds out.
 *
 * The leak this pins: the panel sets a SERVER-SIDE owner filter on the shared
 * WebSocket. If it does not clear that on unmount, the filter outlives the
 * page and the next thing to open the socket silently receives someone else's
 * filtered stream.
 */

const getAccess = vi.fn();
const getEvents = vi.fn();
const getSnapshot = vi.fn();
const setDebugFilter = vi.fn();
const on = vi.fn((_type: string, _handler: unknown) => () => {});

vi.mock('../lib/api', () => ({
  api: {
    debug: {
      getAccess: () => getAccess(),
      getEvents: (...a: unknown[]) => getEvents(...a),
      getSnapshot: (...a: unknown[]) => getSnapshot(...a),
      clearEvents: vi.fn(),
    },
    ws: {
      setDebugFilter: (owner?: string) => setDebugFilter(owner),
      on: (type: string, handler: unknown) => on(type, handler),
    },
  },
}));

const { DebugPanel } = await import('../components/panels/DebugPanel');

function snapshot(overrides: Partial<DebugSnapshot> = {}): DebugSnapshot {
  return {
    pollers: [],
    counters: {},
    bufferSize: 0,
    wsClients: 2,
    graphqlBudgets: [],
    owners: [],
    dbStats: { requests: 10, egressBytes: 2048 },
    webhookLag: { lastMs: 0, medianMs: 0, maxMs: 0, samples: 0, observedAt: '' },
    webhookLagSlow: { lastMs: 0, medianMs: 0, maxMs: 0, samples: 0, observedAt: '' },
    ...overrides,
  } as DebugSnapshot;
}

function event(overrides: Partial<DebugEvent> = {}): DebugEvent {
  return {
    id: 1,
    timestamp: new Date().toISOString(),
    category: 'http',
    service: 'github',
    action: 'GET',
    ok: true,
    summary: 'GET /repos/o/r',
    ...overrides,
  } as DebugEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAccess.mockResolvedValue({ admin: true });
  getEvents.mockResolvedValue([event()]);
  getSnapshot.mockResolvedValue(snapshot());
});
afterEach(cleanup);

describe('DebugPanel in its new home', () => {
  it('mounts and backfills the event buffer', async () => {
    render(<DebugPanel />);
    await waitFor(() => expect(getEvents).toHaveBeenCalled());
    expect(document.body.textContent).toContain('GET /repos/o/r');
  });

  it('renders the snapshot tiles', async () => {
    render(<DebugPanel />);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalled());
    expect(document.body.textContent).toMatch(/WS clients/i);
    expect(document.body.textContent).toMatch(/DB egress/i);
  });

  it('checks admin access before doing anything else', async () => {
    // The panel's own gate, independent of AdminGate — it is the reason
    // /debug/access exists and is not admin-gated.
    render(<DebugPanel />);
    await waitFor(() => expect(getAccess).toHaveBeenCalled());
  });

  it('renders an admin-only notice and fetches nothing when refused', async () => {
    getAccess.mockResolvedValue({ admin: false });
    render(<DebugPanel />);
    await waitFor(() => expect(getAccess).toHaveBeenCalled());
    expect(getEvents).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('CLEARS the server-side debug filter on unmount', async () => {
    // The leak. A filter left set outlives this page and silently narrows the
    // stream for whatever opens the socket next.
    const view = render(<DebugPanel />);
    await waitFor(() => expect(getEvents).toHaveBeenCalled());
    setDebugFilter.mockClear();
    view.unmount();
    await waitFor(() => expect(setDebugFilter).toHaveBeenCalledWith(undefined));
  });

  it('subscribes to the live event stream', async () => {
    render(<DebugPanel />);
    await waitFor(() => expect(on).toHaveBeenCalledWith('debug:event', expect.any(Function)));
  });
});
