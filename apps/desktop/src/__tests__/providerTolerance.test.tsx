import { readCloudTaskProvider } from '@talyn/shared';

import {
  PROVIDER_META,
  providerLabel,
  providerMeta,
  taskCloudProvider,
} from '../renderer/lib/providerMeta';

/**
 * The desktop app is a released Electron binary; users run old versions against
 * a newer backend indefinitely. A provider id this build has never heard of is
 * therefore a normal runtime state, and it must degrade to something readable
 * rather than to nothing.
 *
 * These tests use a deliberately fake provider id. Nothing here should ever be
 * updated to name a real provider — the whole point is the id being unknown.
 */
const UNKNOWN = 'some_future_provider';

describe('unknown cloud providers degrade rather than disappear', () => {
  it('resolves an unknown provider from the task column instead of returning null', () => {
    expect(readCloudTaskProvider({ provider: UNKNOWN })).toBe(UNKNOWN);
  });

  it('resolves an unknown provider from cloud metadata', () => {
    expect(
      readCloudTaskProvider({
        metadata: { cloudTask: { provider: UNKNOWN, remoteTaskId: 'r1' } },
      }),
    ).toBe(UNKNOWN);
  });

  it('still returns null when a task genuinely has no cloud run', () => {
    expect(readCloudTaskProvider({})).toBeNull();
    expect(readCloudTaskProvider({ provider: '' })).toBeNull();
    expect(readCloudTaskProvider({ provider: '   ' })).toBeNull();
    expect(readCloudTaskProvider({ metadata: {} })).toBeNull();
  });

  it('still maps the legacy posthog metadata forward', () => {
    expect(readCloudTaskProvider({ metadata: { posthogTaskId: 'abc' } })).toBe('posthog_code');
  });

  it('prefers the task column over metadata', () => {
    expect(
      readCloudTaskProvider({
        provider: 'claude_code',
        metadata: { cloudTask: { provider: UNKNOWN, remoteTaskId: 'r1' } },
      }),
    ).toBe('claude_code');
  });

  it('gives an unknown provider a readable label rather than a blank badge', () => {
    expect(providerLabel(UNKNOWN)).toBe('Some Future Provider');
    expect(providerLabel(null)).toBeNull();
    expect(providerLabel(undefined)).toBeNull();
  });

  it('gives an unknown provider a logo rather than an empty box', () => {
    const meta = providerMeta(UNKNOWN);
    expect(meta.src).toMatch(/^data:image\//);
    expect(meta.src.length).toBeGreaterThan(0);
  });

  it('keeps the branding of providers it does know', () => {
    expect(providerLabel('posthog_code')).toBe('PostHog Code');
    expect(providerLabel('claude_code')).toBe('Claude Code');
    expect(providerLabel('codex_cloud')).toBe('Codex Cloud');
    // Every known provider must carry both, or its badge renders half-empty.
    for (const meta of Object.values(PROVIDER_META)) {
      expect(meta.label).toBeTruthy();
      expect(meta.src).toMatch(/^data:image\//);
    }
  });

  it('humanises assorted id shapes without throwing', () => {
    expect(providerLabel('fleet')).toBe('Fleet');
    expect(providerLabel('a_b_c')).toBe('A B C');
    expect(providerLabel('kebab-case-id')).toBe('Kebab Case Id');
  });
});

describe('taskCloudProvider', () => {
  const task = { assignedEnvironmentId: 'env1' };

  it('resolves an environment whose type this build does not know', () => {
    expect(taskCloudProvider(task, [{ id: 'env1', type: UNKNOWN }])).toBe(UNKNOWN);
  });

  it('resolves a known environment type', () => {
    expect(taskCloudProvider(task, [{ id: 'env1', type: 'claude_code' }])).toBe('claude_code');
  });

  it('does not treat local or remote environments as cloud providers', () => {
    expect(taskCloudProvider(task, [{ id: 'env1', type: 'local' }])).toBeNull();
    expect(taskCloudProvider(task, [{ id: 'env1', type: 'remote' }])).toBeNull();
  });

  it('falls back to metadata when the environment is not in the store yet', () => {
    expect(
      taskCloudProvider(
        { assignedEnvironmentId: 'env1', metadata: { cloudTask: { provider: UNKNOWN, remoteTaskId: 'r' } } },
        [],
      ),
    ).toBe(UNKNOWN);
  });

  it('returns null for a task that has never been dispatched', () => {
    expect(taskCloudProvider({}, [])).toBeNull();
  });
});
