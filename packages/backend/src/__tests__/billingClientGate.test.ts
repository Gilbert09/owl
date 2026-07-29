import { describe, it, expect } from 'vitest';
import {
  MIN_MERGE_QUEUE_PAYWALL_CLIENT,
  MIN_TASK_PAYWALL_CLIENT,
  parseClientVersion,
  versionBypassesPaywall,
  type PaywallGate,
} from '../services/billing/clientGate.js';

/**
 * The paywall exemption's decision table. This is the file that stops the
 * gate from silently reverting to fail-OPEN: every "not a pre-paywall build"
 * shape MUST enforce, because the header is trivially omittable and the
 * failure mode is invisible (no error, no log, just free unlimited tasks).
 */

describe('parseClientVersion', () => {
  it.each([
    ['0.2.3', [0, 2, 3]],
    ['1.0.0', [1, 0, 0]],
    ['0.3.0-test', [0, 3, 0]], // prerelease suffix ignored
    ['10.20.30', [10, 20, 30]],
    ['  0.2.9  ', [0, 2, 9]], // whitespace tolerated
    ['0.2.3+build7', [0, 2, 3]],
  ])('parses %s', (raw, expected) => {
    expect(parseClientVersion(raw)).toEqual(expected);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['dev', 'dev'],
    ['namespaced desktop', 'desktop/1.4.2'],
    ['namespaced web', 'web/2026-07-29-abc1234'],
    ['two-part', '0.2'],
    ['leading v', 'v0.2.3'],
    ['four-part', '0.2.3.4'],
    ['non-numeric', 'x.y.z'],
    ['array (duplicate header)', ['0.2.2', '9.9.9']],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientVersion(raw)).toBeNull();
  });
});

describe('versionBypassesPaywall', () => {
  const GATES: PaywallGate[] = ['task', 'merge_queue'];

  // The whole point of the rewrite: anything we can't positively identify as
  // an old build gets enforced.
  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['dev build', 'dev'],
    ['namespaced desktop', 'desktop/0.0.1'],
    ['namespaced web', 'web/2026-07-29-abc1234'],
    ['junk', 'not-a-version'],
    ['duplicate header array', ['0.2.2', '0.2.2']],
  ])('%s enforces on every gate', (_label, raw) => {
    for (const gate of GATES) {
      expect(versionBypassesPaywall(raw, gate)).toBe(false);
    }
  });

  it.each([
    ['0.0.1', true],
    ['0.1.99', true],
    ['0.2.2', true], // one below the task floor
    [MIN_TASK_PAYWALL_CLIENT, false], // the floor itself enforces
    ['0.2.4', false],
    ['0.3.0-test', false],
    ['1.0.0', false],
  ])('task gate: %s → bypass %s', (raw, expected) => {
    expect(versionBypassesPaywall(raw, 'task')).toBe(expected);
  });

  it.each([
    ['0.2.2', true],
    ['0.2.8', true], // one below the merge-queue floor
    [MIN_MERGE_QUEUE_PAYWALL_CLIENT, false],
    ['0.2.10', false], // segment-wise compare, not lexicographic
    ['1.0.0', false],
  ])('merge-queue gate: %s → bypass %s', (raw, expected) => {
    expect(versionBypassesPaywall(raw, 'merge_queue')).toBe(expected);
  });

  it('the merge-queue floor is above the task floor', () => {
    // A build in this window renders a task 402 but not a merge-queue one, so
    // a single shared floor would either over- or under-enforce.
    expect(versionBypassesPaywall('0.2.5', 'task')).toBe(false);
    expect(versionBypassesPaywall('0.2.5', 'merge_queue')).toBe(true);
  });
});
