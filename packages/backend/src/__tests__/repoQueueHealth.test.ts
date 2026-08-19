// The cross-PR view of an external merge queue: is it worth submitting into?
//
// Every other guard is per PR, so with a backlog each entry rediscovers a dead
// runner alone and spends its own budget doing it. Trunk batches, so those
// submissions lengthen the outage for the PRs already queued.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEGRADED_AFTER_DISTINCT_PRS,
  HEALTH_WINDOW_MS,
  noteInfraFailure,
  noteMerge,
  queueHealth,
  _resetQueueHealth,
} from '../services/repoQueueHealth.js';

describe('repoQueueHealth', () => {
  const OWNER = 'PostHog';
  const REPO = 'posthog';
  const BASE = 'master';
  const health = () => queueHealth(OWNER, REPO, BASE);
  const failOn = (n: number) => noteInfraFailure(OWNER, REPO, BASE, n);

  afterEach(() => {
    _resetQueueHealth();
    vi.useRealTimers();
  });

  it('says nothing about a queue it has never seen fail', () => {
    expect(health()).toBeNull();
  });

  it('holds its verdict until enough DISTINCT PRs have failed', () => {
    for (let i = 1; i < DEGRADED_AFTER_DISTINCT_PRS; i++) {
      failOn(i);
      expect(health()).toBeNull();
    }
    failOn(DEGRADED_AFTER_DISTINCT_PRS);
    expect(health()).toMatchObject({ state: 'degraded' });
  });

  // THE case this counts by PR rather than by failure: one PR resubmitting
  // through its own infra budget is one PR having a bad day, not a sick queue.
  it('never lets a single PR resubmitting condemn the queue', () => {
    for (let i = 0; i < DEGRADED_AFTER_DISTINCT_PRS * 3; i++) failOn(7);
    expect(health()).toBeNull();
  });

  it('names the PRs it based the verdict on, in order', () => {
    failOn(30);
    failOn(10);
    failOn(20);
    expect(health()?.prs).toEqual([10, 20, 30]);
  });

  it('scopes the verdict to one base branch', () => {
    for (let i = 1; i <= DEGRADED_AFTER_DISTINCT_PRS; i++) failOn(i);
    expect(queueHealth(OWNER, REPO, 'release-1.0')).toBeNull();
    expect(queueHealth(OWNER, 'other-repo', BASE)).toBeNull();
  });

  // Recovery must need no restart and no human, which is the discipline
  // repoMergeGate's decay note argues for.
  it('ages observations out of the window on its own', () => {
    vi.useFakeTimers();
    for (let i = 1; i <= DEGRADED_AFTER_DISTINCT_PRS; i++) failOn(i);
    expect(health()).toMatchObject({ state: 'degraded' });

    vi.advanceTimersByTime(HEALTH_WINDOW_MS + 1_000);
    expect(health()).toBeNull();
  });

  it('drops a stale failure while keeping a fresh one', () => {
    vi.useFakeTimers();
    failOn(1);
    vi.advanceTimersByTime(HEALTH_WINDOW_MS + 1_000);
    failOn(2);
    failOn(3);
    // Only the two fresh ones remain, which is one short of the threshold.
    expect(health()).toBeNull();
  });

  // A merge is the only direct proof the queue works, so it beats the window.
  it('clears the record outright when something merges', () => {
    for (let i = 1; i <= DEGRADED_AFTER_DISTINCT_PRS; i++) failOn(i);
    expect(health()).toMatchObject({ state: 'degraded' });

    noteMerge(OWNER, REPO, BASE);
    expect(health()).toBeNull();
  });

  it('matches the repo and branch case-insensitively, as GitHub does for owners', () => {
    for (let i = 1; i <= DEGRADED_AFTER_DISTINCT_PRS; i++) failOn(i);
    expect(queueHealth('posthog', 'PostHog', BASE)).toMatchObject({ state: 'degraded' });
  });
});
