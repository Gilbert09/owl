import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setFocused,
  clearFocused,
  markRefreshed,
  ttlFor,
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
});
