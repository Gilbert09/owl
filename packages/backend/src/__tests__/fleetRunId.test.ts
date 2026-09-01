import { describe, expect, it } from 'vitest';
import { fleetRunIdForTask, fleetRunAttempt } from '../services/selfHosted/executor.js';

/**
 * The fleet sandbox id is chosen by US and the fleet's create is idempotent on
 * it (spec §11.5) — that is what stops a redelivered webhook spawning a second
 * microVM, and why the id must never be random.
 *
 * Once a task ROW could be reused for a later run at the same PR, keying on the
 * task id alone turned that guarantee into a bug: the second run asked for the
 * id its own first run already held, and idempotency handed it back that run —
 * already finished — so the poller settled the "new" run the moment it started.
 * The task looked like it failed instantly, which read as a fix run that errors
 * and vanishes.
 *
 * So: same run, same id (still no double-spend); different run, different id.
 */
describe('fleetRunIdForTask', () => {
  it('is stable for one run — the redelivery guard', () => {
    expect(fleetRunIdForTask('abc', 0)).toBe(fleetRunIdForTask('abc', 0));
    expect(fleetRunIdForTask('abc', 2)).toBe(fleetRunIdForTask('abc', 2));
  });

  it('gives a reused task a different sandbox than its previous run', () => {
    const first = fleetRunIdForTask('abc', 0);
    expect(fleetRunIdForTask('abc', 1)).not.toBe(first);
    expect(fleetRunIdForTask('abc', 2)).not.toBe(fleetRunIdForTask('abc', 1));
  });

  it('leaves the first run on the original format, so nothing in flight moves', () => {
    expect(fleetRunIdForTask('abc')).toBe('talyn-abc');
    expect(fleetRunIdForTask('abc', 0)).toBe('talyn-abc');
  });

  it('still separates two different tasks', () => {
    expect(fleetRunIdForTask('abc', 1)).not.toBe(fleetRunIdForTask('def', 1));
  });
});

describe('fleetRunAttempt', () => {
  it('reads the counter the reuse path writes', () => {
    expect(fleetRunAttempt({ metadata: { runAttempt: 3 } })).toBe(3);
  });

  it('treats a task that has never been reused as its first run', () => {
    // Every task predating the counter, and every freshly inserted one.
    expect(fleetRunAttempt({ metadata: {} })).toBe(0);
    expect(fleetRunAttempt({ metadata: null })).toBe(0);
    expect(fleetRunAttempt({})).toBe(0);
  });

  it('refuses junk rather than building an id out of it', () => {
    for (const runAttempt of ['2', -1, 0, Number.NaN, Infinity, null, {}]) {
      expect(fleetRunAttempt({ metadata: { runAttempt } })).toBe(0);
    }
  });
});
