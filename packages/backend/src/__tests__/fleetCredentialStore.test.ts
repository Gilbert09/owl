import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { integrations as integrationsTable, workspaces as workspacesTable } from '../db/schema.js';

/**
 * Two agents behind one provider, stored on one integration row.
 *
 * The write used to be WHOLE — the config was rebuilt from the patch and
 * everything else dropped — and that was deliberate: a workspace configured
 * before the fleet bearer and endpoint left the settings card still carries
 * `fleetTokenEnc`/`fleetEndpoint`, and carrying those forward would keep a dead
 * per-workspace endpoint alive as a silent routing override.
 *
 * A whole write cannot survive two independently connectable agents, though:
 * saving Codex would wipe Claude. So it merges by ENUMERATING the credential
 * fields rather than by spreading the stored object — the legacy keys are still
 * dropped, because nothing copies them, and each vendor survives a save of the
 * other. Both halves of that are load-bearing and both are pinned here.
 */
describe('fleet credential storage', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let priorKey: string | undefined;

  beforeAll(() => {
    priorKey = process.env.TALYN_TOKEN_KEY;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
  });
  afterAll(() => {
    if (priorKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorKey;
  });

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
  });
  afterEach(async () => cleanup());

  async function config(): Promise<Record<string, unknown>> {
    const rows = await db
      .select({ config: integrationsTable.config })
      .from(integrationsTable)
      .where(
        and(eq(integrationsTable.workspaceId, 'ws1'), eq(integrationsTable.type, 'selfhosted')),
      )
      .limit(1);
    return (rows[0]?.config as Record<string, unknown> | null) ?? {};
  }

  function codexFixture() {
    return {
      accessTokenEnc: { v: 1 } as never,
      refreshTokenEnc: { v: 1 } as never,
      accountId: 'acct-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  }

  it('saving Codex keeps the Claude credential, and the reverse', async () => {
    const { storeSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');

    await storeSelfHostedCredentials('ws1', { claudeToken: 'sk-ant-oat01-mine' });
    expect(await config()).toHaveProperty('anthropicKeyEnc');

    await storeSelfHostedCredentials('ws1', { codex: codexFixture() });
    const both = await config();
    expect(both).toHaveProperty('anthropicKeyEnc');
    expect(both).toHaveProperty('codexOAuth');

    await storeSelfHostedCredentials('ws1', { claudeToken: 'sk-ant-oat01-rotated' });
    const after = await config();
    expect(after).toHaveProperty('codexOAuth');
  });

  it('clearing one vendor leaves the other alone', async () => {
    const { storeSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    await storeSelfHostedCredentials('ws1', {
      claudeToken: 'sk-ant-oat01-mine',
      codex: codexFixture(),
    });

    await storeSelfHostedCredentials('ws1', { codex: null, openaiKey: null });
    const left = await config();
    expect(left).toHaveProperty('anthropicKeyEnc');
    expect(left).not.toHaveProperty('codexOAuth');

    await storeSelfHostedCredentials('ws1', { claudeToken: null });
    expect(await config()).not.toHaveProperty('anthropicKeyEnc');
  });

  // The reason the merge enumerates instead of spreading.
  it('still drops the legacy per-workspace bearer and endpoint', async () => {
    const { storeSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    await db.insert(integrationsTable).values({
      id: 'int-legacy',
      workspaceId: 'ws1',
      type: 'selfhosted',
      enabled: true,
      config: { fleetTokenEnc: { v: 1 }, fleetEndpoint: 'http://an-old-box:8080' },
    });

    await storeSelfHostedCredentials('ws1', { claudeToken: 'sk-ant-oat01-mine' });
    const after = await config();
    expect(after).not.toHaveProperty('fleetTokenEnc');
    expect(after).not.toHaveProperty('fleetEndpoint');
    expect(after).toHaveProperty('anthropicKeyEnc');
  });

  /**
   * The gate that moved. It used to be the Claude token specifically, because
   * every fleet model was Anthropic's — so a Codex-only workspace read as "the
   * fleet is not configured" and was sent back to a form it had already filled
   * in.
   */
  it('counts a Codex-only workspace as configured', async () => {
    const { storeSelfHostedCredentials, getSelfHostedCredentials } = await import(
      '../services/selfHosted/credentials.js'
    );
    const { codexCredentialFrom } = await import('../services/selfHosted/codexOauth.js');

    // A real (unsigned) JWT carrying the one claim the Codex backend needs.
    const claims = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } }),
    ).toString('base64url');
    const jwt = `h.${claims}.s`;

    await storeSelfHostedCredentials('ws1', {
      codex: codexCredentialFrom({ accessToken: jwt, refreshToken: 'rt', expiresIn: 3600 }),
    });

    const creds = await getSelfHostedCredentials('ws1');
    expect(creds).not.toBeNull();
    expect(creds?.openaiKey).toBe(jwt);
    expect(creds?.claudeToken).toBeUndefined();
  });

  it('is null only when the workspace holds neither vendor', async () => {
    const { getSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    expect(await getSelfHostedCredentials('ws1')).toBeNull();
  });

  // The account id is a claim inside the token, and the Codex backend wants it
  // as a SECOND header. A token without one is a 401 from chatgpt.com naming
  // nothing, so it is refused at connect time instead.
  it('refuses a Codex token carrying no ChatGPT account id', async () => {
    const { codexCredentialFrom } = await import('../services/selfHosted/codexOauth.js');
    expect(() =>
      codexCredentialFrom({ accessToken: 'not-a-jwt', refreshToken: 'rt' }),
    ).toThrow(/account id/i);
  });
});
