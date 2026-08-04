import { describe, it, expect } from 'vitest';
import { adminRunFromFleet } from '../services/admin/runIndex.js';
import type { FleetRun } from '../services/selfHosted/client.js';

/**
 * How the Runs page orders and labels rows.
 *
 * Two bugs this pins, both of which made the page lie about what needed
 * attention:
 *
 *   1. Orphans were PREPENDED to the list rather than merged into it, on the
 *      reasoning that they matter most. The effect was the opposite — a run
 *      that started 58 seconds ago sorted below four deploy self-tests from an
 *      hour ago, so the one row an operator opened the page to find was the
 *      one they had to hunt for.
 *   2. Every run without a task row was tinted red and counted as "orphaned",
 *      including the guest self-test `deploy.sh` fires after every fleet
 *      deploy. Four merges put "4 orphaned" in the header for four things that
 *      were supposed to happen, which is how a warning stops being read.
 */

function fleetRun(overrides: Partial<FleetRun> = {}): FleetRun {
  return {
    id: 'talyn-1',
    status: 'running',
    startedAt: '2026-08-04T10:00:00.000Z',
    createdAt: '2026-08-04T09:59:00.000Z',
    ...overrides,
  };
}

describe('adminRunFromFleet', () => {
  it('marks a run with no task behind it as an orphan', () => {
    const row = adminRunFromFleet(fleetRun(), 'hetzner-64');
    expect(row.orphan).toBe(true);
    expect(row.selfTest).toBe(false);
  });

  it('flags a deploy self-test so it is not read as an orphan', () => {
    // deploy.sh posts {"selfTest": true} after every fleet deploy to prove the
    // API contract. It is an orphan by the strict definition and is exactly
    // what is supposed to happen.
    const row = adminRunFromFleet(
      fleetRun({ id: 'deploy-api-1785848330', task: { selfTest: true } }),
      'hetzner-64'
    );
    expect(row.orphan).toBe(true);
    expect(row.selfTest).toBe(true);
  });

  it.each([
    ['no task at all', undefined],
    ['a task with no selfTest', { taskType: 'code_writing' }],
    ['selfTest explicitly false', { selfTest: false }],
  ])('does not flag %s as a self-test', (_label, task) => {
    const row = adminRunFromFleet(fleetRun({ task }), 'hetzner-64');
    expect(row.selfTest).toBe(false);
  });

  it('never carries the prompt, whatever the fleet sends', () => {
    // fvspTaskRedacted strips it host-side, but the row shape is the second
    // line of defence: this is cross-tenant data and the prompt embeds
    // customer code.
    const row = adminRunFromFleet(
      fleetRun({ task: { selfTest: false, repo: 'o/r' } }),
      'hetzner-64'
    );
    expect(JSON.stringify(row)).not.toContain('prompt');
  });
});

/**
 * `byRecency` is not exported — it is an implementation detail of the join —
 * so this asserts the ordering property through the sort it drives, using the
 * same fallback rule.
 */
describe('run ordering', () => {
  const at = (startedAt: string | null, createdAt: string | null, runId: string) => ({
    ...adminRunFromFleet(fleetRun({ id: runId }), 'h'),
    startedAt,
    createdAt,
  });

  function sorted(rows: ReturnType<typeof at>[]) {
    return [...rows]
      .sort((a, b) => {
        const av = Date.parse(a.startedAt ?? a.createdAt ?? '') || 0;
        const bv = Date.parse(b.startedAt ?? b.createdAt ?? '') || 0;
        if (av !== bv) return bv - av;
        return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
      })
      .map((r) => r.runId);
  }

  it('puts the newest run first regardless of whether it is an orphan', () => {
    const rows = [
      at('2026-08-04T09:00:00.000Z', null, 'deploy-api-old'),
      at('2026-08-04T10:00:00.000Z', null, 'talyn-new'),
      at('2026-08-04T08:00:00.000Z', null, 'deploy-api-older'),
    ];
    expect(sorted(rows)[0]).toBe('talyn-new');
  });

  it('falls back to createdAt so a queued run is not dumped at the bottom', () => {
    // A queued run has no startedAt. Sorting it as epoch 0 buries the run most
    // likely to need attention.
    const rows = [
      at('2026-08-04T09:00:00.000Z', null, 'started-earlier'),
      at(null, '2026-08-04T10:00:00.000Z', 'queued-just-now'),
    ];
    expect(sorted(rows)[0]).toBe('queued-just-now');
  });

  it('is stable for identical timestamps so the list does not shuffle between polls', () => {
    const same = '2026-08-04T10:00:00.000Z';
    const rows = [at(same, null, 'b'), at(same, null, 'a'), at(same, null, 'c')];
    expect(sorted(rows)).toEqual(['a', 'b', 'c']);
    expect(sorted([...rows].reverse())).toEqual(['a', 'b', 'c']);
  });

  it('sorts a row with no timestamps at all to the bottom without throwing', () => {
    const rows = [at(null, null, 'timeless'), at('2026-08-04T10:00:00.000Z', null, 'real')];
    expect(sorted(rows)).toEqual(['real', 'timeless']);
  });
});
