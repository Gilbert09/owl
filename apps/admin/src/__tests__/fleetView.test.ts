import { describe, it, expect } from 'vitest';
import type { AdminFleetHost, AdminRunRow } from '@talyn/shared';
import {
  HOST_STALE_AFTER_MS,
  WEDGE_WARN_SECONDS,
  hostState,
  idleSeconds,
  looksStale,
  looksWedged,
  memoryPct,
  runRank,
  slotsPct,
  sortRuns,
} from '../lib/fleetView';
import { bytes, countdown, mib, parseTime, pct, relativeAge, usd } from '../lib/format';

/**
 * The judgements an operator acts on.
 *
 * Every function here answers a question with consequences — "is this host
 * gone?", "is this run stuck?", "is memory full?" — and the failure mode is
 * always the same shape: an unknown value rendered as a definite one. A host
 * that never reported its memory budget must not read as 100% full, because
 * the response to that is draining a healthy box.
 */

const NOW = Date.parse('2026-08-04T12:00:00.000Z');

function host(overrides: Partial<AdminFleetHost> = {}): AdminFleetHost {
  return {
    name: 'hetzner-64',
    apiEndpoint: 'http://10.0.0.1:8080',
    version: '1.0.0',
    reportedAt: new Date(NOW - 5_000).toISOString(),
    draining: false,
    runsLive: 1,
    runsMax: 2,
    memReservedMib: 512,
    memBudgetMib: 2048,
    diskFreeMib: 40_000,
    maxIdleSeconds: 3,
    online: true,
    dispatchable: true,
    live: null,
    liveError: null,
    liveErrorCode: null,
    ...overrides,
  };
}

function run(overrides: Partial<AdminRunRow> = {}): AdminRunRow {
  return {
    runId: 'talyn-1',
    host: 'hetzner-64',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    ownerEmail: 'a@b.test',
    repo: null,
    status: 'running',
    phase: 'agent',
    adopted: false,
    slot: 0,
    goldenLayer: 'repo',
    createdAt: new Date(NOW - 60_000).toISOString(),
    startedAt: new Date(NOW - 55_000).toISOString(),
    endedAt: null,
    deadline: new Date(NOW + 600_000).toISOString(),
    lastHeartbeat: new Date(NOW - 10_000).toISOString(),
    lastActivity: new Date(NOW - 5_000).toISOString(),
    costUsd: 0.25,
    prUrl: null,
    error: null,
    orphan: false,
    selfTest: false,
    ...overrides,
  };
}

describe('hostState', () => {
  it('reports ready for a healthy host', () => {
    expect(hostState(host())).toBe('ready');
  });

  it('reports offline whatever else the last report claimed', () => {
    // Precedence matters: an offline host is offline even if its final
    // snapshot said it had capacity.
    expect(hostState(host({ online: false, draining: false, runsLive: 0 }))).toBe('offline');
  });

  it('reports draining even with slots free', () => {
    expect(hostState(host({ draining: true, runsLive: 0 }))).toBe('draining');
  });

  it('reports full at capacity', () => {
    expect(hostState(host({ runsLive: 2, runsMax: 2 }))).toBe('full');
  });

  it('does NOT report full when the host never told us its cap', () => {
    // runsMax 0 is unknown, not zero-capacity. The backend's
    // hostIsDispatchable makes the same distinction.
    expect(hostState(host({ runsLive: 5, runsMax: 0 }))).toBe('ready');
  });
});

describe('looksStale', () => {
  it.each([
    ['just under the threshold', HOST_STALE_AFTER_MS - 1_000, false],
    ['just over the threshold', HOST_STALE_AFTER_MS + 1_000, true],
  ])('%s', (_label, age, expected) => {
    expect(looksStale(host({ reportedAt: new Date(NOW - age).toISOString() }), NOW)).toBe(expected);
  });

  it('treats an unparseable timestamp as stale', () => {
    // Fail toward "we do not know", not toward "everything is fine".
    expect(looksStale(host({ reportedAt: 'not a date' }), NOW)).toBe(true);
  });
});

describe('memoryPct / slotsPct', () => {
  it('computes a percentage', () => {
    expect(memoryPct(host({ memReservedMib: 512, memBudgetMib: 2048 }))).toBe(25);
    expect(slotsPct(host({ runsLive: 1, runsMax: 2 }))).toBe(50);
  });

  it('returns NULL for a zero budget rather than NaN or 100', () => {
    // The bug this prevents: a host that never reported a budget rendering as
    // full, and an operator draining it.
    expect(memoryPct(host({ memReservedMib: 0, memBudgetMib: 0 }))).toBeNull();
    expect(slotsPct(host({ runsLive: 3, runsMax: 0 }))).toBeNull();
  });

  it('clamps rather than exceeding 100', () => {
    expect(memoryPct(host({ memReservedMib: 4096, memBudgetMib: 2048 }))).toBe(100);
  });
});

describe('idleSeconds', () => {
  it('prefers lastActivity over lastHeartbeat', () => {
    // Load-bearing: the fleet killed healthy runs by watching heartbeats
    // alone (HANDOFF failure #2). A run busy enough not to heartbeat is still
    // plainly alive on any other frame.
    const r = run({
      lastActivity: new Date(NOW - 5_000).toISOString(),
      lastHeartbeat: new Date(NOW - 300_000).toISOString(),
    });
    expect(idleSeconds(r, NOW)).toBe(5);
  });

  it('falls back to lastHeartbeat when there is no activity', () => {
    const r = run({ lastActivity: null, lastHeartbeat: new Date(NOW - 30_000).toISOString() });
    expect(idleSeconds(r, NOW)).toBe(30);
  });

  it('is null when the fleet reported neither', () => {
    expect(idleSeconds(run({ lastActivity: null, lastHeartbeat: null }), NOW)).toBeNull();
  });
});

describe('looksWedged', () => {
  it('flags a long-silent running run', () => {
    const r = run({ lastActivity: new Date(NOW - (WEDGE_WARN_SECONDS + 10) * 1000).toISOString() });
    expect(looksWedged(r, NOW)).toBe(true);
  });

  it('does not flag a recently active run', () => {
    expect(looksWedged(run(), NOW)).toBe(false);
  });

  it.each([['completed'], ['failed'], ['cancelled']] as const)(
    'never flags a %s run, however long ago it stopped',
    (status) => {
      // A finished run stops sending frames BY DEFINITION. Flagging every one
      // as wedged would make the signal useless.
      const r = run({ status, lastActivity: new Date(NOW - 86_400_000).toISOString() });
      expect(looksWedged(r, NOW)).toBe(false);
    }
  );
});

describe('run ranking', () => {
  it('puts orphans first', () => {
    // A microVM with no task behind it is the thing this page exists to
    // catch; burying it below history would defeat the point.
    expect(runRank(run({ orphan: true }), NOW)).toBeLessThan(runRank(run(), NOW));
  });

  it('ranks wedged above healthy, and healthy above finished', () => {
    const wedged = run({ lastActivity: new Date(NOW - 600_000).toISOString() });
    const live = run();
    const done = run({ status: 'completed' });
    expect(runRank(wedged, NOW)).toBeLessThan(runRank(live, NOW));
    expect(runRank(live, NOW)).toBeLessThan(runRank(done, NOW));
  });

  it('sorts newest first within a rank', () => {
    const older = run({ runId: 'a', createdAt: new Date(NOW - 100_000).toISOString() });
    const newer = run({ runId: 'b', createdAt: new Date(NOW - 10_000).toISOString() });
    expect(sortRuns([older, newer], NOW).map((r) => r.runId)).toEqual(['b', 'a']);
  });

  it('does not mutate its input', () => {
    const rows = [run({ runId: 'a' }), run({ runId: 'b', orphan: true })];
    sortRuns(rows, NOW);
    expect(rows.map((r) => r.runId)).toEqual(['a', 'b']);
  });
});

describe('formatters', () => {
  it.each([
    [null, '—'],
    [0, '0 MiB'],
    [512, '512 MiB'],
    [2048, '2.0 GiB'],
    [1024 * 1024 * 3, '3.0 TiB'],
  ])('mib(%s) = %s', (input, expected) => {
    expect(mib(input as number | null)).toBe(expected);
  });

  it.each([
    [null, '—'],
    [512, '512 B'],
    [2048, '2.0 KiB'],
    [5 * 1024 * 1024 * 1024, '5.0 GiB'],
  ])('bytes(%s) = %s', (input, expected) => {
    expect(bytes(input as number | null)).toBe(expected);
  });

  it('formats cost, and unknown cost as a dash not $0.00', () => {
    // "$0.00" claims a run was free; "—" says we do not know.
    expect(usd(1.5)).toBe('$1.50');
    expect(usd(null)).toBe('—');
  });

  it('returns null from pct on a zero denominator', () => {
    expect(pct(1, 0)).toBeNull();
    expect(pct(null, 10)).toBeNull();
  });

  it.each([
    ['null', null, '—'],
    ['a Go zero-value time', '0001-01-01T00:00:00Z', '—'],
    ['garbage', 'not a date', '—'],
  ])('renders %s as a dash', (_label, input, expected) => {
    // fleetd serialises an unset time.Time as year 1 rather than omitting it.
    // "01/01/0001" on a dashboard reads as data corruption, not "not yet".
    expect(relativeAge(input, NOW)).toBe(expected);
    expect(parseTime(input)).toBeNull();
  });

  it.each([
    [5_000, '5s'],
    [90_000, '2m'],
    [7_200_000, '2h'],
    [3 * 86_400_000, '3d'],
  ])('renders an age of %sms as %s', (age, expected) => {
    expect(relativeAge(new Date(NOW - age).toISOString(), NOW)).toBe(expected);
  });

  it('says "expired" for a deadline in the past', () => {
    expect(countdown(new Date(NOW - 1_000).toISOString(), NOW)).toBe('expired');
  });

  it('counts down to a future deadline', () => {
    expect(countdown(new Date(NOW + 300_000).toISOString(), NOW)).toBe('5m');
  });
});
