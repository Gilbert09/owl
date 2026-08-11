import { describe, it, expect } from 'vitest';
import { DEFAULT_FLEET_MODEL_ID, FLEET_MODELS, fleetProviderForModel } from '@talyn/shared';

/**
 * Which provider a fleet run is dispatched at.
 *
 * This is not a label. The host builds the run's egress route table from it and
 * a run reaches exactly one provider, so a wrong answer here is a microVM that
 * boots and cannot make a single call — it has no route to the API its model
 * lives on.
 */
describe('fleetProviderForModel', () => {
  it('maps every offered fleet model to a provider', () => {
    for (const model of FLEET_MODELS) {
      const provider = fleetProviderForModel(model.id);
      expect(provider, `${model.id} has no provider`).toBeTruthy();
      expect(['anthropic', 'openai']).toContain(provider);
    }
  });

  it('puts the default model on anthropic', () => {
    expect(fleetProviderForModel(DEFAULT_FLEET_MODEL_ID)).toBe('anthropic');
  });

  it('defaults an unset model to anthropic, as an omitted field means host-side', () => {
    expect(fleetProviderForModel(undefined)).toBe('anthropic');
  });

  /**
   * A model the pickers no longer offer but a workspace may still have pinned
   * (LEGACY_POSTHOG_CODE_MODEL_IDS). Answering for it matters: a stored Opus
   * 4.5 is a live choice, and routing it nowhere would break the workspaces
   * that made that choice deliberately, for cost.
   */
  it('answers for a legacy pinned model', () => {
    expect(fleetProviderForModel('claude-opus-4-5')).toBe('anthropic');
  });

  /**
   * An id this build has never heard of — a workspace pinned it under a later
   * release and rolled back. Anthropic is the right fallback because it is what
   * an omitted provider has always meant, and the fleet refuses an unknown one
   * outright: guessing 'openai' would turn a stale pin into a 400 at dispatch.
   */
  it('falls back to anthropic for an unrecognised id', () => {
    expect(fleetProviderForModel('gpt-nonexistent-9')).toBe('anthropic');
  });
});
