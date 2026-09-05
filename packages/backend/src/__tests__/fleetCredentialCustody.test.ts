import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Environment, Task } from '@talyn/shared';

/**
 * The dispatch must spend the WORKSPACE'S OWN agent credential, never the
 * sandbox gateway's.
 *
 * # The hole this closes
 *
 * The gateway fills an ABSENT OR BLANK `anthropicKey`/`openaiKey` on a create
 * from its own tenant's sealed custody (yas README, `POST /v1/sandboxes` — "a
 * caller's own key always wins"). The dispatch used to send
 * `openaiKey: creds.openaiKey ?? ''`, so a workspace with no Codex credential
 * did not fail — it ran on whatever key the Talyn tenant holds, billing one
 * account's subscription for another account's work, silently.
 *
 * Nothing is behind that door TODAY: custody is only ever populated for
 * GitHub-born tenants (yas `internal/control/user_api.go`) and Talyn's gateway
 * key is operator-minted. That is a fact about one environment variable, not a
 * property of the code, and the failure is invisible when it changes.
 *
 * So there are two defences and this pins both:
 *   1. Never send a blank or absent key for the vendor being dispatched —
 *      REFUSE instead, with a message naming the fix.
 *   2. Suppress the OTHER vendor with `policy.credentials`, which the fleet
 *      applies at every door a credential can enter the run's proxy — including
 *      the adoption re-pull that runs when nobody is watching.
 */

const createSandbox = vi.fn(async () => ({
  sandbox: { id: 'talyn-t1', status: 'starting' },
  host: 'hetzner-64',
}));

vi.mock('../services/selfHosted/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/selfHosted/client.js')>(
    '../services/selfHosted/client.js',
  );
  return {
    ...actual,
    FleetClient: vi.fn().mockImplementation(() => ({ createSandbox })),
  };
});

const getSelfHostedCredentials = vi.fn();
vi.mock('../services/selfHosted/credentials.js', async () => {
  const actual = await vi.importActual<typeof import('../services/selfHosted/credentials.js')>(
    '../services/selfHosted/credentials.js',
  );
  return {
    ...actual,
    getSelfHostedCredentials,
    resolveFleetTarget: vi.fn(async () => ({
      endpoint: 'https://gateway.invalid',
      token: 'yas_sk_test',
    })),
  };
});

vi.mock('../services/github.js', () => ({
  githubService: { getAccessToken: vi.fn(() => 'gho_test') },
}));

vi.mock('../services/repoDefaultBranch.js', () => ({
  reconcileDefaultBranch: vi.fn(async () => 'main'),
}));

const patchTaskMetadata = vi.fn(async (_id: string, _fn: unknown) => {});
vi.mock('../services/taskMetadataMutex.js', () => ({ patchTaskMetadata }));
vi.mock('../services/websocket.js', () => ({ emitTaskStatus: vi.fn() }));

const dbRows: unknown[] = [
  { url: 'https://github.com/acme/widgets', name: 'widgets', defaultBranch: 'main' },
];
vi.mock('../db/client.js', () => ({
  getDbClient: () => ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: async () => dbRows }) }),
        where: () => ({ limit: async () => dbRows }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
  getPoolDbClient: () => ({}),
}));

const { dispatchTaskToFleet } = await import('../services/selfHosted/executor.js');

const env = { id: 'env1', type: 'selfhosted', config: {} } as unknown as Environment;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    workspaceId: 'ws1',
    type: 'pr_response',
    status: 'queued',
    priority: 'medium',
    title: 'Fix it',
    description: 'Fix it',
    prompt: 'Fix it',
    repositoryId: 'repo1',
    createdAt: '',
    updatedAt: '',
    ...over,
  } as Task;
}

beforeEach(() => {
  createSandbox.mockClear();
  patchTaskMetadata.mockClear();
  getSelfHostedCredentials.mockReset();
});

describe('a fleet dispatch never lets the gateway supply the agent key', () => {
  it('REFUSES a Codex model when the workspace has no Codex credential', async () => {
    getSelfHostedCredentials.mockResolvedValue({ claudeToken: 'sk-ant-oat01-mine' });

    const res = await dispatchTaskToFleet(
      task({ metadata: { model: 'gpt-5.1-codex' } }),
      env,
    );

    expect(res.ok).toBe(false);
    // The create must never have gone out. A dispatch that reaches the gateway
    // with a blank key is exactly the thing custody answers.
    expect(createSandbox).not.toHaveBeenCalled();
    if (res.ok) return;
    expect(res.error).toMatch(/Codex/);
    // Names the cheaper fix too, since the workspace does hold Claude.
    expect(res.error).toMatch(/run this task on Claude/i);
    // NOT a capacity refusal: falling this over to another provider would run
    // the task somewhere the user did not choose.
    expect(res.capacity).toBeUndefined();
  });

  it('REFUSES a Claude model when the workspace has only Codex', async () => {
    getSelfHostedCredentials.mockResolvedValue({ openaiKey: 'ey.codex.token' });

    const res = await dispatchTaskToFleet(task({ metadata: { model: 'claude-opus-5' } }), env);

    expect(res.ok).toBe(false);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it('sends the workspace key and suppresses the OTHER vendor (Claude run)', async () => {
    getSelfHostedCredentials.mockResolvedValue({
      claudeToken: 'sk-ant-oat01-mine',
      openaiKey: 'ey.codex.token',
    });

    const res = await dispatchTaskToFleet(task({ metadata: { model: 'claude-sonnet-5' } }), env);
    expect(res.ok).toBe(true);

    const body = createSandbox.mock.calls[0][0] as Record<string, unknown>;
    expect(body.anthropicKey).toBe('sk-ant-oat01-mine');
    // Never both: the run has exactly one upstream, so the second key is a
    // credential it could not use and should not be handed.
    expect(body).not.toHaveProperty('openaiKey');
    expect(body.policy).toEqual({ credentials: { openai: 'none' } });
  });

  it('sends the workspace key and suppresses the OTHER vendor (Codex run)', async () => {
    getSelfHostedCredentials.mockResolvedValue({
      claudeToken: 'sk-ant-oat01-mine',
      openaiKey: 'ey.codex.token',
    });

    const res = await dispatchTaskToFleet(task({ metadata: { model: 'gpt-5.1-codex' } }), env);
    expect(res.ok).toBe(true);

    const body = createSandbox.mock.calls[0][0] as Record<string, unknown>;
    expect(body.openaiKey).toBe('ey.codex.token');
    expect(body).not.toHaveProperty('anthropicKey');
    expect(body.policy).toEqual({ credentials: { anthropic: 'none' } });
    expect((body.task as { provider?: string }).provider).toBe('openai');
  });

  // Suppressing everything nulls the fleet's whole refresh hook
  // (`allCredentialsSuppressed`), which would strip the key we just sent — and
  // suppressing `github` would take away the token the run clones and pushes
  // with. Exactly one entry, and never those.
  it('never suppresses github, and never suppresses both vendors', async () => {
    getSelfHostedCredentials.mockResolvedValue({
      claudeToken: 'sk-ant-oat01-mine',
      openaiKey: 'ey.codex.token',
    });

    for (const model of ['claude-sonnet-5', 'gpt-5.1-codex']) {
      createSandbox.mockClear();
      await dispatchTaskToFleet(task({ metadata: { model } }), env);
      const policy = (createSandbox.mock.calls[0][0] as { policy: { credentials: object } }).policy;
      expect(Object.keys(policy.credentials)).toHaveLength(1);
      expect(policy.credentials).not.toHaveProperty('github');
    }
  });

  // No blank strings, ever. The gateway reads a blank the same way it reads an
  // absent field, so `?? ''` was the hole rather than a safety net.
  it('never sends an empty-string credential', async () => {
    getSelfHostedCredentials.mockResolvedValue({ claudeToken: 'sk-ant-oat01-mine' });
    await dispatchTaskToFleet(task({ metadata: { model: 'claude-sonnet-5' } }), env);
    const body = createSandbox.mock.calls[0][0] as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') expect(value, `${key} was blank`).not.toBe('');
    }
  });

  it('records the vendor it spent, so the re-credential paths can agree', async () => {
    getSelfHostedCredentials.mockResolvedValue({ openaiKey: 'ey.codex.token' });
    await dispatchTaskToFleet(task({ metadata: { model: 'gpt-5.1-codex' } }), env);
    // `patchTaskMetadata` takes an updater, so apply it the way the mutex would.
    const update = patchTaskMetadata.mock.calls[0][1] as unknown as (
      m: Record<string, unknown>,
    ) => { cloudTask: { extra: { llm: string; model: string } } };
    const patched = update({});
    expect(patched.cloudTask.extra.llm).toBe('openai');
    expect(patched.cloudTask.extra.model).toBe('gpt-5.1-codex');
  });

  // A workspace that connected only Codex and never picked a model must not be
  // sent to the Claude default and then refused for a credential it was never
  // asked for — a dead end reached by doing nothing wrong.
  it('defaults a Codex-only workspace to a Codex model', async () => {
    getSelfHostedCredentials.mockResolvedValue({ openaiKey: 'ey.codex.token' });
    const res = await dispatchTaskToFleet(task(), env);
    expect(res.ok).toBe(true);
    const body = createSandbox.mock.calls[0][0] as { task: { model: string; provider: string } };
    expect(body.task.model).toBe('gpt-5.1-codex');
    expect(body.task.provider).toBe('openai');
  });
});
