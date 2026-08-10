import type { AdminIncident, AdminIncidentKind, AdminIncidentSeverity } from '@talyn/shared';
import { listFleetHosts, type FleetHostView } from '../fleetHosts.js';

/**
 * Operator signals, DERIVED rather than stored.
 *
 * Every one of these is already a counter in the fleet's own metrics snapshot.
 * Materialising them into a table would create a second source of truth that
 * can disagree with the host it describes — and the disagreement would surface
 * as "the console says the host is wedged and the host says it is fine", which
 * is worse than not having the page. So this computes per request from the
 * registry rows the hosts already push every ~15s.
 *
 * The consequence worth stating: these are CUMULATIVE counters since each
 * host's last fleetd start, not a rate. "12 admission rejections" means twelve
 * since that process booted. Turning them into a rate needs a time series the
 * registry does not keep (it overwrites one snapshot per host), which is a
 * deliberate deferral, not an oversight — see the plan's note about
 * fleet_hosts holding no history.
 */

/** The fleet's Snapshot(), as far as we read it. Deliberately loose. */
interface FleetMetricsSnapshot {
  admissionRejections?: Record<string, number>;
  runFailures?: Record<string, number>;
  reaperOrphans?: Record<string, number>;
  wedgesDetected?: number;
  proxyDenied?: number;
  proxyDeniedBy?: Record<string, number>;
  goldensStale?: number;
  rebakesFailed?: number;
}

function metricsOf(host: FleetHostView): FleetMetricsSnapshot {
  const raw = host.metrics;
  return raw && typeof raw === 'object' ? (raw as FleetMetricsSnapshot) : {};
}

function counterEntries(map: Record<string, number> | undefined): Array<[string, number]> {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).filter(([, n]) => typeof n === 'number' && n > 0);
}

function incident(
  kind: AdminIncidentKind,
  severity: AdminIncidentSeverity,
  host: string | null,
  detail: string | null,
  count: number,
  observedAt: string
): AdminIncident {
  return { kind, severity, host, detail, count, observedAt };
}

/**
 * Severity for an egress refusal, by what was refused.
 *
 * A CONNECT to an unlisted host is the one that deserves attention: it is a
 * guest trying to open a tunnel somewhere it was never given, which is the
 * shape an exfiltration attempt has. A wrong route NAME is a prompt bug — the
 * agent reaching for `api` instead of `/gh/` — and paging on it would train
 * people to ignore the row that matters.
 */
function egressSeverity(target: string): AdminIncidentSeverity {
  if (target.startsWith('connect')) return 'critical';
  if (target.startsWith('unauthorized')) return 'warn';
  return 'info';
}

/**
 * Severity for an admission rejection, by reason.
 *
 * `mem` and `max_runs` are the fleet telling you it is full — spec §17.2 calls
 * queue depth and rejection reasons "the signal that says buy another box", so
 * they warn rather than inform. `disk` is worse: the disk check fails OPEN, so
 * a rejection on it means the reserve was genuinely breached.
 */
function admissionSeverity(reason: string): AdminIncidentSeverity {
  if (reason === 'disk') return 'critical';
  if (reason === 'mem' || reason === 'max_runs') return 'warn';
  return 'info';
}

export async function listFleetIncidents(now: number = Date.now()): Promise<AdminIncident[]> {
  const hosts = await listFleetHosts(now);
  const out: AdminIncident[] = [];

  for (const host of hosts) {
    const at = host.reportedAt.toISOString();

    // Reachability first — a host that stopped reporting is the loudest thing
    // on this page, and its counters below are by definition stale.
    if (!host.online) {
      out.push(
        incident(
          'host_offline',
          'critical',
          host.name,
          `last reported ${host.reportedAt.toISOString()}`,
          1,
          at
        )
      );
      continue;
    }
    if (host.draining) {
      // Informational: draining is usually deliberate. It earns a row because
      // a host left draining after a deploy is a silent capacity loss.
      out.push(incident('host_draining', 'info', host.name, null, 1, at));
    }

    const m = metricsOf(host);

    for (const [reason, n] of counterEntries(m.admissionRejections)) {
      out.push(incident('admission_rejection', admissionSeverity(reason), host.name, reason, n, at));
    }
    for (const [reason, n] of counterEntries(m.runFailures)) {
      out.push(incident('run_failure', 'warn', host.name, reason, n, at));
    }
    for (const [kind, n] of counterEntries(m.reaperOrphans)) {
      // The fleet spec says to watch these like a hawk: an orphaned namespace
      // or chroot is a leak that compounds.
      out.push(incident('reaper_orphan', 'critical', host.name, kind, n, at));
    }
    if ((m.wedgesDetected ?? 0) > 0) {
      out.push(incident('wedged_run', 'warn', host.name, null, m.wedgesDetected!, at));
    }
    // A guest tried to reach something outside the egress allowlist.
    //
    // One row per TARGET where the host reports the breakdown, because the
    // total cannot be acted on: "the agent guessed the route name `api` 104
    // times" is a prompt bug, "a CONNECT to pypi.org" is a missing toolchain,
    // and "a request to an unknown host" is the exfiltration signal §12.3
    // wants the counter for. A single number reports all three identically.
    const deniedBy = counterEntries(m.proxyDeniedBy);
    if (deniedBy.length > 0) {
      for (const [target, n] of deniedBy) {
        out.push(incident('egress_denied', egressSeverity(target), host.name, target, n, at));
      }
    } else if ((m.proxyDenied ?? 0) > 0) {
      // A host on an older fleetd sends the total and no breakdown. Still worth
      // one row — losing the incident entirely would be worse than losing its
      // detail.
      out.push(incident('egress_denied', 'warn', host.name, null, m.proxyDenied!, at));
    }
    if ((m.goldensStale ?? 0) > 0) {
      // Baked on a superseded base, so selection refuses them and every run on
      // that repo silently falls back to cloning — a slowdown, not an outage.
      out.push(incident('golden_stale', 'info', host.name, null, m.goldensStale!, at));
    }
    if ((m.rebakesFailed ?? 0) > 0) {
      out.push(incident('rebake_failure', 'warn', host.name, null, m.rebakesFailed!, at));
    }
  }

  const rank: Record<AdminIncidentSeverity, number> = { critical: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
}
