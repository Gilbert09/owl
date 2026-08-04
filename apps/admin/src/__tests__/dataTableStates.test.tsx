import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { DataTable, type Column } from '../components/ui/DataTable';

/**
 * An empty result and a failed request must never look the same.
 *
 * "No hosts have reported" is a fact about the fleet. "We couldn't reach the
 * backend" is a fact about us. Rendering the first when the second is true
 * tells an operator the fleet is gone — and they may go and restart something
 * on the strength of it. This is `offlineBanner.test.tsx`'s lesson at the
 * table level, where it gets hit daily rather than once.
 *
 * The second property here is that a background refresh never blanks the
 * table. A poll tick that flashes the empty state reads as the fleet dropping
 * out and back.
 */

interface Row {
  id: string;
  name: string;
}

const columns: Column<Row>[] = [{ key: 'name', header: 'Name', cell: (r) => r.name }];
const ROWS: Row[] = [{ id: '1', name: 'hetzner-64' }];

function renderTable(props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  return render(
    <DataTable<Row>
      rows={null}
      columns={columns}
      rowKey={(r) => r.id}
      emptyMessage="No fleet hosts have reported in"
      {...props}
    />
  );
}

const text = () => document.body.textContent ?? '';

afterEach(cleanup);

describe('the three non-happy states', () => {
  it('shows a loading state on first load, not the empty message', () => {
    renderTable({ initialLoading: true });
    expect(text()).toMatch(/Loading/i);
    expect(text()).not.toMatch(/No fleet hosts/i);
  });

  it('shows the empty message when the server genuinely returned nothing', () => {
    renderTable({ rows: [], initialLoading: false });
    expect(text()).toMatch(/No fleet hosts have reported in/i);
    expect(text()).not.toMatch(/Couldn't load/i);
  });

  it('shows the ERROR state, not the empty message, when the request failed', () => {
    // The assertion this file exists for.
    renderTable({ rows: null, error: "Couldn't reach the Talyn backend." });
    expect(text()).toMatch(/Couldn't load this/i);
    expect(text()).toMatch(/Couldn't reach the Talyn backend/i);
    expect(text()).not.toMatch(/No fleet hosts have reported in/i);
  });

  it('offers a retry on the error state', () => {
    const onRetry = vi.fn();
    renderTable({ rows: null, error: 'boom', onRetry });
    screen.getByText(/Try again/i).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it('surfaces the empty hint so an operator knows what would populate it', () => {
    renderTable({
      rows: [],
      emptyHint: 'A host appears once fleetd posts its first snapshot.',
    });
    expect(text()).toMatch(/fleetd posts its first snapshot/i);
  });
});

describe('a refresh never blanks the view', () => {
  it('keeps rows on screen while loading', () => {
    renderTable({ rows: ROWS, loading: true });
    expect(text()).toContain('hetzner-64');
    expect(text()).toMatch(/Refreshing/i);
  });

  it('keeps rows and shows a STALE banner when a refresh fails', () => {
    // A transient failure mid-incident should leave the numbers on screen
    // with a caveat, not wipe the page an operator is reading.
    renderTable({ rows: ROWS, error: "Couldn't reach the Talyn backend." });
    expect(text()).toContain('hetzner-64');
    expect(text()).toMatch(/Showing the last data we had/i);
    expect(text()).not.toMatch(/Couldn't load this/i);
  });

  it('does not show the empty state just because loading is true', () => {
    renderTable({ rows: ROWS, initialLoading: true });
    expect(text()).toContain('hetzner-64');
  });
});

describe('rendering', () => {
  it('renders one row per item with the column cells', () => {
    renderTable({ rows: [...ROWS, { id: '2', name: 'hetzner-65' }] });
    expect(text()).toContain('hetzner-64');
    expect(text()).toContain('hetzner-65');
  });

  it('calls onRowClick with the row', () => {
    const onRowClick = vi.fn();
    renderTable({ rows: ROWS, onRowClick });
    screen.getByText('hetzner-64').click();
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });
});
