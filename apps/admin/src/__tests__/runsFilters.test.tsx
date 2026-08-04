import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AdminRunIndex } from '@talyn/shared';

/**
 * Filter state lives in the URL, not component state.
 *
 * A filtered view has to be a link an operator can paste into Slack — the same
 * reason drill-ins are routes rather than modals. The regression this pins is
 * the react-router analogue of the one `usePanelUrlSync`'s docblock records in
 * the product apps: a change that applies and then immediately reverts,
 * because two sources of truth are racing to write the same value.
 */

const runs = vi.fn();
vi.mock('../lib/api', () => ({
  api: { admin: { fleet: { runs: (...a: unknown[]) => runs(...a) } } },
}));

vi.mock('../components/auth/AdminGate', () => ({
  AdminGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAccess: () => ({ admin: true, email: 'op@talyn.dev', capabilities: [] }),
  // Capabilities are the UI's COPY of what the deploy permits; the server
  // re-checks every one. Granting them here keeps a routing/rendering test
  // from silently exercising the hidden-button path.
  useCapability: () => true,
}));

const { RunsPage } = await import('../routes/fleet/RunsPage');

function page(overrides: Partial<AdminRunIndex> = {}): AdminRunIndex {
  return { items: [], nextCursor: null, degraded: [], ...overrides };
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <RunsPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runs.mockResolvedValue(page());
});
afterEach(cleanup);

describe('reading filters from the URL', () => {
  it('passes a pasted host filter through to the request', async () => {
    renderAt('/fleet/runs?host=hetzner-64');
    await waitFor(() => expect(runs).toHaveBeenCalledWith({ host: 'hetzner-64', status: undefined }));
  });

  it('passes a pasted status filter through', async () => {
    renderAt('/fleet/runs?status=running');
    await waitFor(() => expect(runs).toHaveBeenCalledWith({ host: undefined, status: 'running' }));
  });

  it('restores both controls from the URL', async () => {
    renderAt('/fleet/runs?host=hetzner-64&status=failed');
    await waitFor(() => expect(runs).toHaveBeenCalled());
    expect((screen.getByLabelText(/Filter by host/i) as HTMLInputElement).value).toBe('hetzner-64');
    expect((screen.getByLabelText(/Filter by status/i) as HTMLSelectElement).value).toBe('failed');
  });

  it('sends no filters when the URL has none', async () => {
    renderAt('/fleet/runs');
    await waitFor(() => expect(runs).toHaveBeenCalledWith({ host: undefined, status: undefined }));
  });

  it('does not choke on an unknown status value', async () => {
    // A stale link should degrade to an unfiltered-ish view, not blow up.
    renderAt('/fleet/runs?status=bogus');
    await waitFor(() => expect(runs).toHaveBeenCalledWith({ host: undefined, status: 'bogus' }));
    expect(document.body.textContent).toBeTruthy();
  });
});

describe('degraded hosts', () => {
  it('says which hosts are missing rather than implying the fleet is idle', async () => {
    // Without this the list silently under-reports and "no runs" reads as
    // "nothing is running" instead of "we could not ask".
    runs.mockResolvedValue(page({ degraded: [{ host: 'hetzner-64', error: 'ETIMEDOUT' }] }));
    renderAt('/fleet/runs');
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/Couldn't reach hetzner-64/i)
    );
  });

  it('says nothing when every host answered', async () => {
    renderAt('/fleet/runs');
    await waitFor(() => expect(runs).toHaveBeenCalled());
    expect(document.body.textContent).not.toMatch(/Couldn't reach/i);
  });
});

describe('empty states', () => {
  it('distinguishes "no runs at all" from "no runs match"', async () => {
    renderAt('/fleet/runs');
    await waitFor(() => expect(document.body.textContent).toMatch(/No fleet runs yet/i));

    cleanup();
    renderAt('/fleet/runs?host=nope');
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/No runs match these filters/i)
    );
  });
});
