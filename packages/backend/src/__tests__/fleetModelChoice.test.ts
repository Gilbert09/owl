import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FLEET_CODEX_MODEL_ID,
  DEFAULT_FLEET_MODEL_ID,
  FLEET_MODELS,
  POSTHOG_CODE_MODELS,
  defaultFleetModelForAgent,
  fleetAgentForModel,
  fleetProviderForModel,
  isStoredFleetModelId,
  isStoredPostHogCodeModelId,
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

  it('defaults a Codex-only workspace to a Codex model', () => {
    expect(DEFAULT_FLEET_CODEX_MODEL_ID).toBe('gpt-5.1-codex');
    expect(fleetProviderForModel(DEFAULT_FLEET_CODEX_MODEL_ID)).toBe('openai');
    expect(defaultFleetModelForAgent('codex')).toBe(DEFAULT_FLEET_CODEX_MODEL_ID);
    expect(defaultFleetModelForAgent('claude')).toBe(DEFAULT_FLEET_MODEL_ID);
  });

  it('offers the current-generation Claude ids', () => {
    expect(FLEET_MODELS.some((m) => m.id === DEFAULT_FLEET_MODEL_ID)).toBe(true);
    expect(FLEET_MODELS.some((m) => m.id === 'claude-opus-5')).toBe(true);
  });

  /**
   * The two catalogues used to be the SAME OBJECT (`FLEET_MODELS =
   * POSTHOG_CODE_MODELS`). They cannot be, now the fleet offers Codex: Talyn
   * always sends PostHog's tasks API `runtime_adapter: 'claude'`, and that
   * adapter 400s on a `gpt-*` id — so a shared list would offer every PostHog
   * Code user a model their own dispatch refuses.
   */
  it('does not offer Codex models to PostHog Code', () => {
    const codex = FLEET_MODELS.filter((m) => m.provider === 'openai');
    expect(codex.length).toBeGreaterThan(0);
    for (const m of codex) {
      expect(POSTHOG_CODE_MODELS.some((p) => p.id === m.id)).toBe(false);
      // The guard is the enforcement: a gpt id stored as a fleet model must
      // never validate as a PostHog Code one.
      expect(isStoredFleetModelId(m.id)).toBe(true);
      expect(isStoredPostHogCodeModelId(m.id)).toBe(false);
    }
  });

  /**
   * Every model's vendor decides the microVM's egress route table — a run
   * dispatched at an OpenAI model has no route to api.anthropic.com at all. So
   * a wrong entry here is a run that cannot make a single call, and guessing is
   * worse than being explicit.
   */
  it('pins every offered model to its vendor', () => {
    for (const m of FLEET_MODELS) {
      expect(fleetProviderForModel(m.id)).toBe(m.provider);
      expect(fleetAgentForModel(m.id)).toBe(m.provider === 'openai' ? 'codex' : 'claude');
    }
    expect(fleetProviderForModel('gpt-5.1-codex')).toBe('openai');
    // An id this build has never heard of answers Anthropic — the back-compat
    // answer, because every model that predates the field was Anthropic's and a
    // workspace may still have one pinned.
    expect(fleetProviderForModel('some-future-model')).toBe('anthropic');
    expect(fleetProviderForModel(undefined)).toBe('anthropic');
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
    for (const bad of ['gpt-4', '', null, undefined, 42, 'claude-opus-99', 'gpt-5.2-codex']) {
      expect(isStoredFleetModelId(bad)).toBe(false);
    }
  });
});
