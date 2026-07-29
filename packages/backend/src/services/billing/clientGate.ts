import type { Request } from 'express';
import { captureServerEvent } from '../analytics.js';

/**
 * TRANSITIONAL (billing rollout): who is exempt from the free-plan paywalls.
 *
 * A 402 is only useful against a client that can turn it into an upgrade
 * flow. Desktop builds that predate the paywall UI can only render a bare
 * error string, so they're let through until they auto-update.
 *
 * The rule is FAIL-CLOSED: a caller is exempt ONLY when it identifies itself
 * as a bare `X.Y.Z` build older than the release that shipped the relevant
 * paywall. Everything else enforces — a missing header, an unparseable one,
 * `dev`, or any future namespaced form (`desktop/1.4.2`, `web/2026-07-29`).
 *
 * This used to be the other way round (`!req.headers['x-talyn-client-version']`
 * meant "exempt"), which made the paywall opt-in: the desktop renderer is the
 * only thing in the repo that sends the header, so the CLI, the MCP server,
 * and plain `curl` all bypassed both limits silently — no error, no log, no
 * metric, and no UpgradeModal, so the funnel read as "these users just don't
 * convert". Worse, the merge-queue path fell through to an ungated `armQueue`,
 * uncapping a subsystem that spends cloud-provider tokens per fix attempt.
 *
 * Removal plan: the exemption decays as old builds auto-update. Watch the
 * `billing_paywall_bypassed` PostHog event — when it stops firing, delete
 * this module and call the gates unconditionally.
 */

/**
 * First release whose renderer turns a 402 `task_limit_reached` into the
 * UpgradeModal (commit 44889ec — "desktop billing UI", tagged v0.2.3).
 */
export const MIN_TASK_PAYWALL_CLIENT = '0.2.3';

/**
 * First release that renders the merge-queue cap (commit b63a101 — "cap the
 * free plan's merge queue at 3 queued PRs", tagged v0.2.9). Later than the
 * task paywall, so it needs its own floor: a v0.2.5 build understands a task
 * 402 but not a merge-queue one.
 */
export const MIN_MERGE_QUEUE_PAYWALL_CLIENT = '0.2.9';

export type PaywallGate = 'task' | 'merge_queue';

const GATE_FLOOR: Record<PaywallGate, string> = {
  task: MIN_TASK_PAYWALL_CLIENT,
  merge_queue: MIN_MERGE_QUEUE_PAYWALL_CLIENT,
};

type Version = readonly [number, number, number];

/**
 * Parse a bare `X.Y.Z` (an optional `-prerelease` suffix is ignored, so CI's
 * `0.3.0-test` reads as 0.3.0). Returns null for anything else — including
 * the namespaced `client/version` form reserved for non-desktop clients,
 * which are all new enough to enforce.
 */
export function parseClientVersion(raw: unknown): Version | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isBelow(a: Version, b: Version): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

/**
 * Pure predicate behind {@link bypassesPaywall} — exported for tests so the
 * decision table can be asserted without an Express request or a live
 * analytics config.
 */
export function versionBypassesPaywall(raw: unknown, gate: PaywallGate): boolean {
  const version = parseClientVersion(raw);
  if (!version) return false; // missing / 'dev' / namespaced / junk → enforce
  const floor = parseClientVersion(GATE_FLOOR[gate]);
  return floor !== null && isBelow(version, floor);
}

/**
 * Whether this request skips the given free-plan gate because it comes from a
 * pre-paywall build. Records a PostHog event on every exemption so the
 * long tail is measurable — without it the "remove once clients have aged
 * out" note above could never be acted on.
 */
export function bypassesPaywall(req: Request, gate: PaywallGate): boolean {
  const raw = req.headers['x-talyn-client-version'];
  if (!versionBypassesPaywall(raw, gate)) return false;
  // Fire-and-forget; captureServerEvent never throws and no-ops without a key.
  void captureServerEvent(req.user?.id ?? 'anonymous', 'billing_paywall_bypassed', {
    gate,
    client_version: typeof raw === 'string' ? raw : null,
  });
  return true;
}
