import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POSTHOG_CODE_MODEL_ID,
  LEGACY_POSTHOG_CODE_MODEL_IDS,
  POSTHOG_CODE_MODELS,
  isPostHogCodeModelId,
  isStoredPostHogCodeModelId,
} from '@talyn/shared';
import { DEFAULT_POSTHOG_CODE_MODEL } from '../services/posthogCode/client.js';

/**
 * Every model id Talyn may send to PostHog's task-run API for the `claude`
 * runtime adapter — the keys of `CLAUDE_REASONING_EFFORTS_BY_MODEL` in
 * `products/tasks/backend/temporal/process_task/utils.py`.
 *
 * Pinned as a literal because the runtime's catalog is NOT the LLM gateway's
 * catalog and there is no endpoint for it. `GET gateway.us.posthog.com/posthog_code/v1/models`
 * lists what the gateway serves — which includes `claude-haiku-4-5`,
 * `claude-sonnet-4-5` and every `gpt-*` — and sending one of those with the
 * `claude` adapter is a 400 at dispatch. So this list is the contract, and a
 * failure here means someone added a model from the wrong source.
 *
 * To re-check: read the map in that file (the gateway endpoint is the wrong
 * source, deliberately).
 */
const CLAUDE_ADAPTER_MODELS = new Set([
  '@cf/zai-org/glm-5.2',
  'moonshotai/kimi-k3',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]);

describe('PostHog Code models', () => {
  it('only offers ids the claude runtime adapter accepts', () => {
    // The failure this catches: populating the picker from the gateway catalog,
    // which serves models the tasks runtime rejects.
    for (const model of POSTHOG_CODE_MODELS) {
      expect(CLAUDE_ADAPTER_MODELS.has(model.id), `${model.id} unknown to the adapter`).toBe(
        true
      );
    }
  });

  it('keeps accepting legacy ids the adapter still knows', () => {
    for (const id of LEGACY_POSTHOG_CODE_MODEL_IDS) {
      expect(CLAUDE_ADAPTER_MODELS.has(id), `${id} unknown to the adapter`).toBe(true);
    }
  });

  it('has no id in both the offered and legacy lists', () => {
    const offered = new Set<string>(POSTHOG_CODE_MODELS.map((m) => m.id));
    for (const id of LEGACY_POSTHOG_CODE_MODEL_IDS) {
      expect(offered.has(id), `${id} is both offered and legacy`).toBe(false);
    }
  });

  it('has unique ids and labels', () => {
    const ids = POSTHOG_CODE_MODELS.map((m) => m.id);
    const labels = POSTHOG_CODE_MODELS.map((m) => m.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('defaults to a model it actually offers', () => {
    expect(isPostHogCodeModelId(DEFAULT_POSTHOG_CODE_MODEL_ID)).toBe(true);
  });

  it('has one default, shared by the backend fallback and the pickers', () => {
    // Three copies of this value is what let the composer drift a whole model
    // generation behind the Settings picker. The two front ends now derive their
    // list and default from `@talyn/shared` by construction; this pins the third
    // copy, the backend's dispatch fallback.
    expect(DEFAULT_POSTHOG_CODE_MODEL).toBe(DEFAULT_POSTHOG_CODE_MODEL_ID);
  });

  describe('isPostHogCodeModelId', () => {
    it.each([...POSTHOG_CODE_MODELS.map((m) => m.id)])('accepts the offered %s', (id) => {
      expect(isPostHogCodeModelId(id)).toBe(true);
    });

    it.each([
      ['a legacy id', 'claude-opus-4-7'],
      ['a gateway-only id', 'claude-haiku-4-5'],
      ['a codex id', 'gpt-5.6-sol'],
      ['an unknown string', 'claude-opus-9'],
      ['an empty string', ''],
    ])('rejects %s', (_label, value) => {
      expect(isPostHogCodeModelId(value)).toBe(false);
    });

    it.each([[null], [undefined], [42], [{}]])('rejects the non-string %s', (value) => {
      expect(isPostHogCodeModelId(value)).toBe(false);
    });
  });

  describe('isStoredPostHogCodeModelId', () => {
    it.each([
      ...POSTHOG_CODE_MODELS.map((m) => m.id),
      ...LEGACY_POSTHOG_CODE_MODEL_IDS,
    ])('accepts %s', (id) => {
      expect(isStoredPostHogCodeModelId(id)).toBe(true);
    });

    it.each([
      ['a gateway-only id', 'claude-haiku-4-5'],
      ['an unknown string', 'claude-opus-9'],
      ['an empty string', ''],
    ])('rejects %s', (_label, value) => {
      expect(isStoredPostHogCodeModelId(value)).toBe(false);
    });

    it('is what a stored workspace setting is read with', () => {
      // A workspace that pinned Opus 4.5 for cost must keep running Opus 4.5 —
      // the narrower guard would fall back to the default, which is dearer.
      expect(isStoredPostHogCodeModelId('claude-opus-4-5')).toBe(true);
      expect(isPostHogCodeModelId('claude-opus-4-5')).toBe(false);
    });
  });
});
