import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fleetHostsModule from '../services/fleetHosts.js';
import { listFleetIncidents } from '../services/admin/incidents.js';

/**
 * Egress refusals, listed rather than counted.
 *
 * The incident used to be a single number. 329 denials accumulated on
 * hetzner-64 in a week and the only way to see inside them was to ssh in and
 * grep fleetd's journal — which the host discards along with the run record two
 * hours after it ends.
 *
 * The number cannot be acted on because it merges three different events:
 *   - 104 × the agent guessing the route name `api` instead of `/gh/` — a bug
 *     in the prompt;
 *   - 18 × CONNECT to pypi.org / codeload.github.com — a toolchain the guest
 *     does not have;
 *   - anything reaching an unknown host — the exfiltration signal §12.3 wants
 *     the counter for in the first place.
 */

function host(metrics: Record<string, unknown>) {
  return {
    name: 'hetzner-64',
    online: true,
    reportedAt: new Date('2026-08-10T12:00:00.000Z'),
    metrics,
  } as unknown as fleetHostsModule.FleetHostView;
}

function stub(metrics: Record<string, unknown>) {
  vi.spyOn(fleetHostsModule, 'listFleetHosts').mockResolvedValue([host(metrics)] as never);
}

afterEach(() => vi.restoreAllMocks());

describe('egress_denied incidents', () => {
  it('lists one row per refused target instead of one total', async () => {
    stub({
      proxyDenied: 130,
      proxyDeniedBy: {
        'unrouted:api': 104,
        'connect:pypi.org': 5,
        'unauthorized:gh GET': 21,
      },
    });

    const egress = (await listFleetIncidents()).filter((i) => i.kind === 'egress_denied');
    expect(egress).toHaveLength(3);
    expect(egress.map((i) => i.detail).sort()).toEqual([
      'connect:pypi.org',
      'unauthorized:gh GET',
      'unrouted:api',
    ]);
    expect(egress.find((i) => i.detail === 'unrouted:api')?.count).toBe(104);
  });

  /**
   * A CONNECT to an unlisted host is a guest opening a tunnel it was never
   * given — the shape an exfiltration attempt has. A wrong route NAME is a
   * prompt bug, and paging on it would train people to ignore the row that
   * matters.
   */
  it('ranks a CONNECT above an unauthorized call above a wrong route name', async () => {
    stub({
      proxyDeniedBy: {
        'unrouted:api': 104,
        'unauthorized:gh GET': 21,
        'connect:evil.example': 1,
      },
    });

    const by = new Map(
      (await listFleetIncidents())
        .filter((i) => i.kind === 'egress_denied')
        .map((i) => [i.detail, i.severity])
    );
    expect(by.get('connect:evil.example')).toBe('critical');
    expect(by.get('unauthorized:gh GET')).toBe('warn');
    expect(by.get('unrouted:api')).toBe('info');
  });

  /**
   * A host on an older fleetd sends the total and no breakdown. Losing the
   * incident entirely would be worse than losing its detail.
   */
  it('still reports a total from a host that sends no breakdown', async () => {
    stub({ proxyDenied: 42 });
    const egress = (await listFleetIncidents()).filter((i) => i.kind === 'egress_denied');
    expect(egress).toHaveLength(1);
    expect(egress[0]?.count).toBe(42);
    expect(egress[0]?.detail).toBeNull();
  });

  it('says nothing when nothing was refused', async () => {
    stub({ proxyDenied: 0, proxyDeniedBy: {} });
    const egress = (await listFleetIncidents()).filter((i) => i.kind === 'egress_denied');
    expect(egress).toHaveLength(0);
  });

  /** The breakdown wins: double-counting the same refusals reads as twice the problem. */
  it('does not add the total on top of the breakdown', async () => {
    stub({ proxyDenied: 109, proxyDeniedBy: { 'unrouted:api': 104, 'connect:pypi.org': 5 } });
    const egress = (await listFleetIncidents()).filter((i) => i.kind === 'egress_denied');
    expect(egress).toHaveLength(2);
    expect(egress.reduce((n, i) => n + i.count, 0)).toBe(109);
  });
});
