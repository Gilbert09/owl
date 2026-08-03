import { describe, it, expect } from 'vitest';
import { selfHostedProvider } from '../services/cloudProviders/selfhosted/provider.js';
import {
  registerCloudProvider,
  getCloudProvider,
  listCloudProviders,
} from '../services/cloudProviders/registry.js';
import { fleetRunIdForTask } from '../services/selfHosted/executor.js';
import {
  shouldPersistTranscript,
  isFleetRunTerminal,
  taskStatusForFleetRun,
} from '../services/selfHosted/poller.js';
import { FleetCapacityError, FleetThrottleError } from '../services/selfHosted/client.js';

describe('selfHostedProvider — CloudTaskProvider conformance', () => {
  it('declares the expected identity + capabilities', () => {
    // The TYPE is the wire/DB value and must not follow the product name: it is
    // persisted in `environments.type` and `integrations.type`, so renaming it
    // would orphan every configured workspace. Only the label is the product's.
    expect(selfHostedProvider.type).toBe('selfhosted');
    expect(selfHostedProvider.displayName).toBe('Talyn Fleet');
    expect(selfHostedProvider.capabilities).toMatchObject({ model: true });
  });

  it('implements the full provider surface', () => {
    for (const method of [
      'validateCredentials',
      'hasCredentials',
      'testConnection',
      'removeCredentials',
      'dispatch',
      'reconcile',
      'stopStreaming',
      'cancel',
    ] as const) {
      expect(typeof selfHostedProvider[method]).toBe('function');
    }
  });

  // The CLAUDE TOKEN is now the one required credential. The endpoint became
  // optional when the host registry landed (blank = least-loaded host), and the
  // fleet API bearer left the workspace entirely for FLEET_API_TOKEN — so this
  // pins the narrower rule, and still refuses the case that matters.
  //
  // All four of these must reject BEFORE any DB or network work: this suite
  // runs with no database, so a regression that reordered the checks would show
  // up as a connection error rather than a quiet pass.
  it.each([
    ['nothing at all', {}],
    ['an endpoint but no token', { fleetEndpoint: 'http://x' }],
    ['a blank token', { claudeToken: '' }],
  ])('rejects %s (no DB/network hit)', async (_label, input) => {
    expect(await selfHostedProvider.validateCredentials('ws1', input)).toEqual({
      ok: false,
      error: 'A Claude OAuth token is required.',
    });
  });

  // A wrong-shaped credential is caught in the form, not twenty minutes into a
  // run when the agent's first request 401s. The two accepted prefixes are the
  // fleet proxy's (`oauthTokenPrefix = "sk-ant-oat"` and Console keys).
  it.each([
    ['a GitHub PAT', 'ghp_abcdefghijklmnop'],
    ['a bare word', 'my-token'],
    ['the prefix with nothing after it', 'sk-ant-'],
    ['a token with embedded whitespace', 'sk-ant-oat01 truncated'],
  ])('rejects %s as not a Claude credential', async (_label, claudeToken) => {
    const result = await selfHostedProvider.validateCredentials('ws1', { claudeToken });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not look like a Claude credential');
  });

  // Past the shape check with no FLEET_API_TOKEN set, the failure must name the
  // DEPLOYMENT, not the workspace — the user's input was fine and sending them
  // back to the settings form they just filled in correctly helps nobody.
  it('blames the deployment, not the workspace, when FLEET_API_TOKEN is unset', async () => {
    const saved = process.env.FLEET_API_TOKEN;
    delete process.env.FLEET_API_TOKEN;
    try {
      const result = await selfHostedProvider.validateCredentials('ws1', {
        claudeToken: 'sk-ant-oat01-abc',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('FLEET_API_TOKEN');
    } finally {
      if (saved !== undefined) process.env.FLEET_API_TOKEN = saved;
    }
  });

  it('registers and resolves through the registry by type', () => {
    registerCloudProvider(selfHostedProvider);
    expect(getCloudProvider('selfhosted')).toBe(selfHostedProvider);
    expect(listCloudProviders().some((p) => p.type === 'selfhosted')).toBe(true);
  });
});

describe('selfHosted run ids are deterministic', () => {
  // The fleet is idempotent on runId, so a redelivered webhook that
  // re-dispatches the same task must not spawn a second microVM. A random id
  // here would silently double-spend real compute and LLM tokens.
  it('derives the same run id for the same task, every time', () => {
    expect(fleetRunIdForTask('abc-123')).toBe(fleetRunIdForTask('abc-123'));
    expect(fleetRunIdForTask('abc-123')).not.toBe(fleetRunIdForTask('abc-124'));
  });
});

describe('selfHosted terminal-state mapping', () => {
  it.each([
    ['queued', false],
    ['running', false],
    [undefined, false],
    ['completed', true],
    ['failed', true],
    ['cancelled', true],
  ])('isFleetRunTerminal(%s) === %s', (status, expected) => {
    expect(isFleetRunTerminal(status as string | undefined)).toBe(expected);
  });

  // A run the fleet cancelled — deadline, wedge detection, or an operator —
  // did not do the work. Reporting it completed would be a lie the user acts on.
  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
  ])('taskStatusForFleetRun(%s) === %s', (fleet, local) => {
    expect(taskStatusForFleetRun(fleet)).toBe(local);
  });
});

describe('selfHosted transcript persistence debounce', () => {
  const WINDOW = 45_000;
  const base = { persistedCount: 0, lastPersistAt: 0, now: WINDOW, force: false };

  it('skips when the DB is already current', () => {
    expect(shouldPersistTranscript({ ...base, length: 5, persistedCount: 5 })).toBe(false);
  });

  it('skips inside the debounce window', () => {
    expect(
      shouldPersistTranscript({ ...base, length: 5, lastPersistAt: 1, now: WINDOW - 1 }),
    ).toBe(false);
  });

  it('writes once the window has elapsed', () => {
    expect(shouldPersistTranscript({ ...base, length: 5, now: WINDOW })).toBe(true);
  });

  it('always writes on a forced (terminal) tick', () => {
    expect(
      shouldPersistTranscript({ ...base, length: 5, lastPersistAt: 1, now: 2, force: true }),
    ).toBe(true);
  });

  it('does not write on a forced tick when there is nothing new', () => {
    expect(
      shouldPersistTranscript({ ...base, length: 5, persistedCount: 5, force: true }),
    ).toBe(false);
  });
});

describe('selfHosted error taxonomy', () => {
  // Capacity is availability, not failure: the task is fine and belongs on
  // another provider or a later tick. Collapsing the two turns a full box into
  // a wave of failed user tasks.
  it('marks capacity errors distinctly from terminal ones', () => {
    const err = new FleetCapacityError('host is draining');
    expect(err.isCapacity).toBe(true);
    expect(err.status).toBe(503);
    expect(err instanceof Error).toBe(true);
  });

  // The generic poller's ThrottleBackoff duck-types on `status === 429` and an
  // optional `retryAfterMs`; this is the whole contract.
  it('shapes throttle errors for the generic poller backoff', () => {
    const err = new FleetThrottleError('slow down', 30_000);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(30_000);
  });
});
