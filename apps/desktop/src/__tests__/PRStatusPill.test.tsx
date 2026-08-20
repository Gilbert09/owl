import '@testing-library/jest-dom';
import { render, screen, cleanup } from '@testing-library/react';
import { PRStatusPill } from '../renderer/components/widgets/PRStatusPill';
import type { PRChecks } from '../renderer/lib/api';

const checks = (over: Partial<PRChecks> = {}): PRChecks => ({
  total: 0,
  passed: 0,
  failed: 0,
  inProgress: 0,
  skipped: 0,
  ...over,
});

afterEach(cleanup);

describe('PRStatusPill', () => {
  it('renders a red "N/M failing" pill when checks are genuinely failing', () => {
    render(
      <PRStatusPill
        blockingReason="checks_failed"
        checks={checks({ total: 167, passed: 165, failed: 2 })}
      />
    );
    expect(screen.getByText('2/167 failing')).toBeInTheDocument();
    expect(screen.getByRole('button').className).toContain('red-500');
  });

  it('does NOT render a red "0 failing" pill when checks_failed is stale (failed === 0)', () => {
    // Regression: the last failing check re-ran green, so `checks` refreshed to
    // 0 failing, but `blockingReason` lagged at 'checks_failed' (the row store
    // shallow-merges partial summaries). A red "0/N failing" is self-
    // contradictory — it must read Ready/green instead.
    render(
      <PRStatusPill
        blockingReason="checks_failed"
        checks={checks({ total: 167, passed: 167, failed: 0 })}
      />
    );
    expect(screen.queryByText('0/167 failing')).not.toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('emerald-500');
    expect(cls).not.toContain('red-500');
  });

  it('shows "N running" (not "Review") when blocked only by in-flight required checks', () => {
    // Regression: an APPROVED PR reads mergeStateStatus BLOCKED while its check
    // rollup is PENDING, so the backend returns blockingReason 'blocked'. The
    // immediate gate is CI, not a review — show the running spinner.
    render(
      <PRStatusPill
        blockingReason="blocked"
        checks={checks({ total: 131, passed: 40, inProgress: 91 })}
      />
    );
    expect(screen.getByText('91/131 running')).toBeInTheDocument();
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
    expect(screen.getByRole('button').className).toContain('blue-500');
  });

  it('still shows "Review" when blocked and no checks are running', () => {
    render(<PRStatusPill blockingReason="blocked" checks={checks({ total: 5, passed: 5 })} />);
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByRole('button').className).toContain('amber-500');
  });

  it('does NOT render a green "Ready" pill when a stale mergeable hides failing checks', () => {
    // The reported bug: an incremental {checks}-only update advanced `failed` to
    // 26 while `blockingReason` lagged at 'mergeable', so the pill read a green
    // "Ready" beside 26 failing checks. Required failures (non-UNSTABLE) must
    // surface as red.
    render(
      <PRStatusPill
        blockingReason="mergeable"
        checks={checks({ total: 167, passed: 141, failed: 26 })}
        mergeStateStatus="BLOCKED"
      />
    );
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByText('26/167 failing')).toBeInTheDocument();
    expect(screen.getByRole('button').className).toContain('red-500');
  });

  it('reads non-required (green) for a stale mergeable when UNSTABLE', () => {
    render(
      <PRStatusPill
        blockingReason="mergeable"
        checks={checks({ total: 167, passed: 141, failed: 26 })}
        mergeStateStatus="UNSTABLE"
      />
    );
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByText('26 non-required')).toBeInTheDocument();
    expect(screen.getByRole('button').className).toContain('emerald-500');
  });

  it('shows a running spinner when a stale checks_failed still has in-progress checks', () => {
    render(
      <PRStatusPill
        blockingReason="checks_failed"
        checks={checks({ total: 10, passed: 7, failed: 0, inProgress: 3 })}
      />
    );
    expect(screen.getByText('3/10 running')).toBeInTheDocument();
    expect(screen.getByRole('button').className).toContain('blue-500');
  });

  // Trunk reports `not_ready` for the whole CI run — it is waiting on the PR's
  // own branch protection — so it must not hide what the PR is actually doing.
  describe("an external queue that is waiting on the PR's own checks", () => {
    it('keeps the running pill rather than an amber "Queue: not ready"', () => {
      render(
        <PRStatusPill
          blockingReason="blocked"
          checks={checks({ total: 201, passed: 168, inProgress: 33 })}
          state="open"
          externalQueueState="not_ready"
        />
      );
      expect(screen.getByText('33/201 running')).toBeInTheDocument();
      expect(screen.queryByText('Queue: not ready')).not.toBeInTheDocument();
    });

    it('keeps the failing pill — that IS the branch protection trunk waits on', () => {
      render(
        <PRStatusPill
          blockingReason="checks_failed"
          checks={checks({ total: 201, passed: 195, failed: 6 })}
          state="open"
          externalQueueState="not_ready"
        />
      );
      expect(screen.getByText('6/201 failing')).toBeInTheDocument();
      expect(screen.queryByText('Queue: not ready')).not.toBeInTheDocument();
    });

    it('still shows the queue when the PR itself has nothing left to report', () => {
      render(
        <PRStatusPill
          blockingReason="mergeable"
          checks={checks({ total: 201, passed: 201 })}
          state="open"
          externalQueueState="not_ready"
        />
      );
      expect(screen.getByText('Queue: not ready')).toBeInTheDocument();
      expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    });

    it('never defers for a state the queue owns (testing)', () => {
      render(
        <PRStatusPill
          blockingReason="checks_failed"
          checks={checks({ total: 201, passed: 195, failed: 6 })}
          state="open"
          externalQueueState="testing"
        />
      );
      expect(screen.getByText('Queue: testing')).toBeInTheDocument();
    });
  });
});
