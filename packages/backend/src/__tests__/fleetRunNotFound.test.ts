import { describe, it, expect } from 'vitest';
import {
  FleetCapacityError,
  FleetRunNotFoundError,
  FleetThrottleError,
  isRunNotFoundResponse,
} from '../services/selfHosted/client.js';

/**
 * "The run is gone" must be terminal, not retryable.
 *
 * On 2026-08-06 a fleet host restarted while five tasks were mid-run. Two of them
 * then reconciled every tick for 21 hours, each attempt failing with `no such
 * run` — the host was healthy and idle the whole time, and nothing ever concluded
 * that a vanished run is never coming back. The log filled with one identical
 * failure per tick per task.
 *
 * The distinction being pinned here: unreachable / no-capacity / rate-limited all
 * mean "ask again later", because the run may well still be executing on the
 * metal. A reachable host saying it has no such run is authoritative.
 */
describe('fleet run-not-found detection', () => {
  describe('isRunNotFoundResponse', () => {
    it.each([
      ['a 404 with an unhelpful body', 404, 'fleet returned 404'],
      ['the message fleetd actually sent in production', 500, 'no such run'],
      ['a capitalised variant', 500, 'No such run'],
      ['an embedded variant', 500, 'get run abc123: no such run'],
      ['a "run not found" phrasing', 500, 'run not found'],
      ['an "unknown run" phrasing', 500, 'unknown run: abc'],
      ['a 404 whose body says something else entirely', 404, 'nope'],
    ])('treats %s as terminal', (_label, status, message) => {
      expect(isRunNotFoundResponse(status, message)).toBe(true);
    });

    it.each([
      ['a plain 500', 500, 'internal error'],
      ['a 502 from a proxy', 502, 'bad gateway'],
      ['a 503 with no capacity', 503, 'the fleet has no capacity'],
      ['a 429', 429, 'rate limited'],
      ['a timeout message', 500, 'context deadline exceeded'],
      // The words in another context must not trip it — this is the risk of
      // matching on a message at all.
      ['an unrelated message mentioning runs', 500, 'too many runs in flight'],
    ])('leaves %s retryable', (_label, status, message) => {
      expect(isRunNotFoundResponse(status, message)).toBe(false);
    });
  });

  describe('FleetRunNotFoundError', () => {
    it('is distinguishable from the retryable fleet errors', () => {
      const notFound = new FleetRunNotFoundError('no such run');
      expect(notFound).toBeInstanceOf(Error);
      expect(notFound.name).toBe('FleetRunNotFoundError');
      expect(notFound.isRunNotFound).toBe(true);

      // The poller branches with `instanceof`, so the retryable types must not
      // satisfy it — mistaking a capacity blip for a vanished run would fail a
      // task whose run is still going on the metal, which is the exact failure
      // the fail-back design exists to prevent.
      expect(new FleetCapacityError('no capacity')).not.toBeInstanceOf(FleetRunNotFoundError);
      expect(new FleetThrottleError('slow down')).not.toBeInstanceOf(FleetRunNotFoundError);
      expect(new Error('no such run')).not.toBeInstanceOf(FleetRunNotFoundError);
    });

    it('carries the host message for the task result', () => {
      // The task's stored error names the cause; a bare "failed" would send
      // someone looking for a failure on the metal that never happened.
      expect(new FleetRunNotFoundError('no such run: r-42').message).toBe('no such run: r-42');
    });
  });
});
