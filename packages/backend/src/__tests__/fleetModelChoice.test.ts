import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FLEET_MODEL_ID,
  FLEET_MODELS,
  POSTHOG_CODE_MODELS,
  isStoredFleetModelId,
} from '@talyn/shared';

/**
 * Which model a fleet run uses, and why it is not Opus.
 *
 * Fleet runs were served by Opus 5 on every turn — nothing set a model, so the
 * SDK picked its own default — and cost $348 in 18.5 hours, about $15.85 a run.
 * Most of that work is mechanical: rebase, resolve conflicts, re-run CI, answer
 * review threads. Sonnet 5 is the default now, with the picker in Settings →
 * Talyn Fleet for workspaces that want Opus back.
 */
describe('fleet model choice', () => {
  it('defaults to Sonnet 5, not Opus', () => {
    expect(DEFAULT_FLEET_MODEL_ID).toBe('claude-sonnet-5');
  });

  it('offers the current-generation ids, not the 4.x set', () => {
    // A fleet run is the Claude Agent SDK in a microVM, so it takes the same
    // ids PostHog Code does — CLAUDE_MODELS is the older 4.x list and would
    // offer models the fleet never runs.
    expect(FLEET_MODELS).toBe(POSTHOG_CODE_MODELS);
    expect(FLEET_MODELS.some((m) => m.id === DEFAULT_FLEET_MODEL_ID)).toBe(true);
    expect(FLEET_MODELS.some((m) => m.id === 'claude-opus-5')).toBe(true);
  });

  /**
   * A workspace that pinned a model the picker no longer offers must keep it.
   * Falling back to the default would quietly move it — in the other direction
   * that is a bigger bill, in this one a weaker model, and both are surprises.
   */
  it('accepts a stored legacy id as well as an offered one', () => {
    expect(isStoredFleetModelId('claude-sonnet-5')).toBe(true);
    expect(isStoredFleetModelId('claude-opus-5')).toBe(true);
    expect(isStoredFleetModelId('claude-opus-4-7')).toBe(true); // legacy, still accepted
  });

  it('rejects anything it does not recognise', () => {
    for (const bad of ['gpt-4', '', null, undefined, 42, 'claude-opus-99']) {
      expect(isStoredFleetModelId(bad)).toBe(false);
    }
  });
});
