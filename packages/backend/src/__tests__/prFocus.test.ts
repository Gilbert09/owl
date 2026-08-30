import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setFocused,
  clearFocused,
  markRefreshed,
  ttlFor,
  setActiveView,
  getActiveView,
  isCohortActive,
  _resetPrFocus,
  PR_FOCUS_CONSTANTS,
} from '../services/prFocus.js';

describe('prFocus', () => {
  beforeEach(() => {
    _resetPrFocus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the unfocused TTL by default', () => {
    expect(ttlFor('ws1', 'pr1')).toBe(PR_FOCUS_CONSTANTS.UNFOCUSED_TTL_MS);
  });

  it('returns the focused TTL after setFocused', () => {
    setFocused('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr1')).toBe(PR_FOCUS_CONSTANTS.FOCUSED_TTL_MS);
  });

  it('reverts to unfocused TTL after clearFocused', () => {
    setFocused('ws1', 'pr1');
    clearFocused('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr1')).toBe(PR_FOCUS_CONSTANTS.UNFOCUSED_TTL_MS);
  });

  it('isolates focus per (workspace, prId) — different keys do not bleed', () => {
    setFocused('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr2')).toBe(PR_FOCUS_CONSTANTS.UNFOCUSED_TTL_MS);
    expect(ttlFor('ws2', 'pr1')).toBe(PR_FOCUS_CONSTANTS.UNFOCUSED_TTL_MS);
  });

  it('returns an effectively-infinite TTL while inside the post-refresh cooldown', () => {
    markRefreshed('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr1')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('falls back to focus-aware TTL once the cooldown expires', () => {
    setFocused('ws1', 'pr1');
    markRefreshed('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr1')).toBe(Number.MAX_SAFE_INTEGER);
    vi.advanceTimersByTime(PR_FOCUS_CONSTANTS.COOLDOWN_MS + 1);
    expect(ttlFor('ws1', 'pr1')).toBe(PR_FOCUS_CONSTANTS.FOCUSED_TTL_MS);
  });

  it('cooldown is per (workspace, prId) — does not bleed across PRs', () => {
    markRefreshed('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr2')).toBe(PR_FOCUS_CONSTANTS.UNFOCUSED_TTL_MS);
  });

  it('setFocused is idempotent (no double-counting)', () => {
    setFocused('ws1', 'pr1');
    setFocused('ws1', 'pr1');
    clearFocused('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr1')).toBe(PR_FOCUS_CONSTANTS.UNFOCUSED_TTL_MS);
  });

  it('returns the slacker untracked TTL when the untracked flag is set', () => {
    expect(ttlFor('ws1', 'pr1', { untracked: true })).toBe(
      PR_FOCUS_CONSTANTS.UNTRACKED_TTL_MS
    );
    // ...and the untracked TTL really is slacker than the unfocused one.
    expect(PR_FOCUS_CONSTANTS.UNTRACKED_TTL_MS).toBeGreaterThan(
      PR_FOCUS_CONSTANTS.UNFOCUSED_TTL_MS
    );
  });

  it('focus overrides the untracked flag (a focused fallen-out PR still refreshes fast)', () => {
    setFocused('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr1', { untracked: true })).toBe(
      PR_FOCUS_CONSTANTS.FOCUSED_TTL_MS
    );
  });

  it('cooldown overrides the untracked flag', () => {
    markRefreshed('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr1', { untracked: true })).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('gives the inactive cohort the slack TTL, the active cohort the normal one', () => {
    expect(ttlFor('ws1', 'pr1', { cohortActive: false })).toBe(
      PR_FOCUS_CONSTANTS.UNTRACKED_TTL_MS
    );
    expect(ttlFor('ws1', 'pr1', { cohortActive: true })).toBe(
      PR_FOCUS_CONSTANTS.UNFOCUSED_TTL_MS
    );
  });

  it('focus and cooldown override an inactive cohort', () => {
    setFocused('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr1', { cohortActive: false })).toBe(
      PR_FOCUS_CONSTANTS.FOCUSED_TTL_MS
    );
    clearFocused('ws1', 'pr1');
    markRefreshed('ws1', 'pr1');
    expect(ttlFor('ws1', 'pr1', { cohortActive: false })).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('prFocus — active view', () => {
  beforeEach(() => _resetPrFocus());

  it('defaults to "all" before any client reports', () => {
    expect(getActiveView('ws1')).toBe('all');
    expect(isCohortActive('ws1', { authored: true, reviewRequested: false })).toBe(true);
    expect(isCohortActive('ws1', { authored: false, reviewRequested: true })).toBe(true);
  });

  it('under "mine", only authored PRs are the active cohort', () => {
    setActiveView('ws1', 'mine');
    expect(isCohortActive('ws1', { authored: true, reviewRequested: false })).toBe(true);
    expect(isCohortActive('ws1', { authored: false, reviewRequested: true })).toBe(false);
  });

  it('under "review", only review-requested PRs are the active cohort', () => {
    setActiveView('ws1', 'review');
    expect(isCohortActive('ws1', { authored: true, reviewRequested: false })).toBe(false);
    expect(isCohortActive('ws1', { authored: false, reviewRequested: true })).toBe(true);
  });

  it('under "none", neither cohort is active', () => {
    setActiveView('ws1', 'none');
    expect(isCohortActive('ws1', { authored: true, reviewRequested: false })).toBe(false);
    expect(isCohortActive('ws1', { authored: false, reviewRequested: true })).toBe(false);
  });

  it('counts a manually watched PR into "mine" — that is the page it renders on', () => {
    const watched = { authored: false, reviewRequested: false, watching: true };
    setActiveView('ws1', 'mine');
    expect(isCohortActive('ws1', watched)).toBe(true);
    setActiveView('ws1', 'all');
    expect(isCohortActive('ws1', watched)).toBe(true);
    // Not the Reviews page, and nothing is active when the panel is hidden.
    setActiveView('ws1', 'review');
    expect(isCohortActive('ws1', watched)).toBe(false);
    setActiveView('ws1', 'none');
    expect(isCohortActive('ws1', watched)).toBe(false);
  });

  it('a PR that is both authored and review-requested is active in either single view', () => {
    setActiveView('ws1', 'mine');
    expect(isCohortActive('ws1', { authored: true, reviewRequested: true })).toBe(true);
    setActiveView('ws1', 'review');
    expect(isCohortActive('ws1', { authored: true, reviewRequested: true })).toBe(true);
  });

  it('is isolated per workspace', () => {
    setActiveView('ws1', 'mine');
    expect(getActiveView('ws2')).toBe('all');
  });
});
