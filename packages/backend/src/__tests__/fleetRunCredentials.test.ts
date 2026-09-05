import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { tasks as tasksTable, workspaces as workspacesTable } from '../db/schema.js';
import type { Database } from '../db/client.js';

/**
 * The authorization on the credential pull.
 *
 * fleetd asks for an adopted run's credentials back the moment it adopts it,
 * authenticating with `FLEET_REPORT_TOKEN` — a deployment-wide secret every
 * host shares. That token is enough to say "give me the credentials for run
 * X", so the bound on WHICH runs it may name is the entire security property:
 * a run this backend dispatched, to exactly that host, still in flight. Then a
 * host can only re-obtain what it was already holding, which is what makes the
 * pull no more powerful than the push it replaces.
 *
 * Each `ok: false` case below is a way that bound could be lost. They are not
 * hypothetical shapes — `wrong_host` is the one that turns a single compromised
 * host into every workspace's GitHub token.
 */

let db: Database;
let cleanup: () => Promise<void>;

const GH_TOKEN = 'gho_workspace_token';
const CLAUDE_TOKEN = 'sk-ant-oat-workspace';
const OPENAI_KEY = 'sk-openai-workspace';

vi.mock('../services/github.js', () => ({
  githubService: { getAccessToken: vi.fn(() => GH_TOKEN) },
}));
vi.mock('../services/selfHosted/credentials.js', () => ({
  getSelfHostedCredentials: vi.fn(async () => ({ claudeToken: CLAUDE_TOKEN })),
}));

const { githubService } = await import('../services/github.js');
const { resolveRunCredentials } = await import('../services/selfHosted/runCredentials.js');

function fleetTask(over: {
  id: string;
  status: string;
  runId?: string;
  host?: string | null;
  provider?: string;
  /** `undefined` writes no `llm` at all — a row from before the field existed. */
  llm?: 'anthropic' | 'openai';
}) {
  const extra: Record<string, unknown> = { repo: 'PostHog/posthog' };
  if (over.host !== null) extra.host = over.host ?? 'hetzner-64';
  if (over.llm) extra.llm = over.llm;
  return {
    id: over.id,
    workspaceId: 'ws-1',
    type: 'pr_response',
    status: over.status,
    priority: 'medium',
    title: over.id,
    description: '',
    metadata: {
      cloudTask: {
        provider: over.provider ?? 'selfhosted',
        remoteTaskId: over.runId ?? `talyn-${over.id}`,
        status: 'running',
        extra,
      },
    },
  };
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db, { id: TEST_USER_ID });
  await db
    .insert(workspacesTable)
    .values({ id: 'ws-1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
  await db.insert(tasksTable).values([
    fleetTask({ id: 'live', status: 'in_progress', llm: 'anthropic' }),
    fleetTask({ id: 'openai', status: 'in_progress', llm: 'openai' }),
    fleetTask({ id: 'legacy', status: 'in_progress' }),
    fleetTask({ id: 'queued', status: 'queued' }),
    fleetTask({ id: 'done', status: 'completed' }),
    fleetTask({ id: 'failedrun', status: 'failed' }),
    fleetTask({ id: 'nohost', status: 'in_progress', host: null }),
    fleetTask({ id: 'otherprov', status: 'in_progress', provider: 'posthog_code' }),
  ]);
  vi.mocked(githubService.getAccessToken).mockReturnValue(GH_TOKEN);
});

afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
});

describe('resolveRunCredentials', () => {
  it('serves a run that is live on the host that asks', async () => {
    const res = await resolveRunCredentials('hetzner-64', 'talyn-live');
    expect(res).toEqual({
      ok: true,
      credentials: {
        githubToken: GH_TOKEN,
        anthropicKey: CLAUDE_TOKEN,
        repo: 'PostHog/posthog',
      },
    });
  });

  // A queued task has been dispatched and may already be booting. Refusing it
  // would make the pull fail on exactly the runs that restart soonest after a
  // deploy.
  it('serves a queued run too', async () => {
    await expect(resolveRunCredentials('hetzner-64', 'talyn-queued')).resolves.toMatchObject({
      ok: true,
    });
  });

  // THE one that matters. A host holding the shared token must not be able to
  // collect credentials for a run that landed on a different box.
  it('refuses a run dispatched to a different host', async () => {
    await expect(resolveRunCredentials('hetzner-99', 'talyn-live')).resolves.toEqual({
      ok: false,
      reason: 'wrong_host',
    });
  });

  // A run with no recorded host matches nobody. Treating "unknown" as "anyone"
  // is the same hole as the case above, reached by a different route.
  it('refuses a run with no recorded host', async () => {
    await expect(resolveRunCredentials('hetzner-64', 'talyn-nohost')).resolves.toEqual({
      ok: false,
      reason: 'wrong_host',
    });
  });

  it.each([
    ['completed', 'talyn-done'],
    ['failed', 'talyn-failedrun'],
  ])('refuses a %s run — there is nothing left to authenticate', async (_status, runId) => {
    await expect(resolveRunCredentials('hetzner-64', runId)).resolves.toEqual({
      ok: false,
      reason: 'run_not_live',
    });
  });

  it('refuses an unknown run id', async () => {
    await expect(resolveRunCredentials('hetzner-64', 'talyn-nope')).resolves.toEqual({
      ok: false,
      reason: 'unknown_run',
    });
  });

  // Scoped to this provider. Another provider's remote id is not a fleet run,
  // and matching one would hand fleet credentials out on a foreign identifier.
  it('refuses a run id belonging to another provider', async () => {
    await expect(resolveRunCredentials('hetzner-64', 'talyn-otherprov')).resolves.toEqual({
      ok: false,
      reason: 'unknown_run',
    });
  });

  // An answer with an empty GitHub token would close the proxy's
  // credentials-ready gate on nothing, converting its 90-second wait into an
  // immediate failure — worse than either waiting or refusing honestly.
  it('refuses rather than answering with an empty github token', async () => {
    vi.mocked(githubService.getAccessToken).mockReturnValue(null);
    await expect(resolveRunCredentials('hetzner-64', 'talyn-live')).resolves.toEqual({
      ok: false,
      reason: 'credentials_unavailable',
    });
  });

  // The read must not drag `transcript` along. It is megabytes of conversation
  // log and this runs on every adoption of every run — the egress rule in
  // CLAUDE.md exists for exactly this shape of query.
  it('does not select the transcript blob', async () => {
    const spy = vi.spyOn(db, 'select');
    await resolveRunCredentials('hetzner-64', 'talyn-live');
    const columns = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(columns).toBeDefined();
    expect(Object.keys(columns!)).not.toContain('transcript');
  });
});

/**
 * An adopted run's provider decides which key it needs, and the host cannot ask
 * for one by name — it authenticates with a token that says nothing about the
 * run. What bounds the answer is the RUN, not the caller: it must be a run this
 * backend dispatched, to this host, that is still live.
 *
 * The answer carries the key for the vendor the RUN was dispatched on, and only
 * that one. It used to carry both, on the argument that the host's route table
 * decides which is spent — true of the spending, and wrong about the rest: a
 * host holding a credential its guest has no route to use is a wider answer to
 * the same question, on a pull authorized by a deployment-wide token.
 */
describe('run credentials serve the vendor the run was dispatched on', () => {
  it('serves the OpenAI key, and NOT the Claude one, for a Codex run', async () => {
    const { getSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    vi.mocked(getSelfHostedCredentials).mockResolvedValueOnce({
      claudeToken: CLAUDE_TOKEN,
      openaiKey: OPENAI_KEY,
    });

    const res = await resolveRunCredentials('hetzner-64', 'talyn-openai');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.credentials.openaiKey).toBe(OPENAI_KEY);
    expect(res.credentials).not.toHaveProperty('anthropicKey');
  });

  it('serves the Claude key, and NOT the OpenAI one, for an Anthropic run', async () => {
    const { getSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    vi.mocked(getSelfHostedCredentials).mockResolvedValueOnce({
      claudeToken: CLAUDE_TOKEN,
      openaiKey: OPENAI_KEY,
    });

    const res = await resolveRunCredentials('hetzner-64', 'talyn-live');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.credentials.anthropicKey).toBe(CLAUDE_TOKEN);
    expect(res.credentials).not.toHaveProperty('openaiKey');
  });

  // A row written before `extra.llm` existed is an Anthropic run — nothing could
  // dispatch an OpenAI model then — so answering with the Claude key is the
  // fact, not a default.
  it('reads a row with no recorded vendor as Anthropic', async () => {
    const res = await resolveRunCredentials('hetzner-64', 'talyn-legacy');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.credentials.anthropicKey).toBe(CLAUDE_TOKEN);
    expect(res.credentials).not.toHaveProperty('openaiKey');
  });

  // An empty string would be a credential as far as the fleet's dispatch check
  // is concerned, and would pass a run that cannot call out. Omit the field.
  it('omits the key entirely when the workspace no longer holds that vendor', async () => {
    const { getSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    vi.mocked(getSelfHostedCredentials).mockResolvedValueOnce({ claudeToken: CLAUDE_TOKEN });

    const res = await resolveRunCredentials('hetzner-64', 'talyn-openai');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.credentials).not.toHaveProperty('openaiKey');
    expect(res.credentials).not.toHaveProperty('anthropicKey');
  });
});
