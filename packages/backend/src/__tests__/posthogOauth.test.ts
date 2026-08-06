import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  completeAuthorization,
  consumeState,
  createPkcePair,
  ensureFreshAccessToken,
  markReauthRequired,
  PostHogOAuthError,
  PostHogReauthRequiredError,
  resetOAuthInflightForTests,
  startAuthorization,
} from '../services/posthogCode/oauth.js';
import { resetPostHogOAuthConfigForTests } from '../services/posthogCode/oauthConfig.js';
import {
  getPostHogCodeCredentials,
  storePostHogCodeCredentials,
} from '../services/posthogCode/credentials.js';
import { readPostHogIntegration } from '../services/posthogCode/integrationRow.js';
import { encryptString } from '../services/tokenCrypto.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  integrations as integrationsTable,
  posthogOauthStates,
} from '../db/schema.js';

const WS = 'ws-oauth';
const HOST = 'https://us.posthog.com';
const CLIENT_ID = 'https://www.talyn.dev/oauth-client';
const REDIRECT_URI = 'https://prod.talyn.dev/api/v1/posthog/oauth/callback';

/**
 * The OAuth auth path, end to end against a real (pglite) database and a scripted
 * token endpoint. What these cases are really pinning down is the token
 * lifecycle: PostHog rotates refresh tokens with reuse protection, so the
 * expensive failure mode isn't "refresh didn't work", it's "two callers
 * refreshed and PostHog revoked the whole grant".
 */
describe('PostHog OAuth', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let savedKey: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    savedKey = process.env.TALYN_TOKEN_KEY;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.POSTHOG_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.POSTHOG_OAUTH_REDIRECT_URI = REDIRECT_URI;
    resetPostHogOAuthConfigForTests();
    resetOAuthInflightForTests();

    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
    await seedUser(db);
    await db.insert(workspacesTable).values({ id: WS, ownerId: TEST_USER_ID, name: 'WS' });

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    if (savedKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = savedKey;
    delete process.env.POSTHOG_OAUTH_CLIENT_ID;
    delete process.env.POSTHOG_OAUTH_REDIRECT_URI;
    resetPostHogOAuthConfigForTests();
    resetOAuthInflightForTests();
    vi.unstubAllGlobals();
    await cleanup();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** Script the token endpoint + self-introspection in the order they're called. */
  function scriptTokenExchange(opts: {
    token?: Record<string, unknown>;
    tokenStatus?: number;
    scopedTeams?: unknown[];
  }) {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token/')) {
        return Promise.resolve(
          jsonResponse(
            opts.token ?? {
              access_token: 'pha_access_1',
              refresh_token: 'phr_refresh_1',
              expires_in: 3600,
              scope: 'openid task:read task:write',
            },
            opts.tokenStatus ?? 200
          )
        );
      }
      if (url.endsWith('/oauth/introspect/')) {
        return Promise.resolve(
          jsonResponse({ active: true, scoped_teams: opts.scopedTeams ?? [42] })
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  async function start(): Promise<{ authorizeUrl: string; state: string }> {
    return startAuthorization({ workspaceId: WS, userId: TEST_USER_ID, host: HOST, client: 'desktop' });
  }

  describe('PKCE', () => {
    it('derives an S256 challenge from the verifier', () => {
      const { verifier, challenge } = createPkcePair();
      expect(challenge).toBe(
        createHash('sha256').update(verifier).digest('base64url')
      );
      // 32 random bytes, base64url — no padding, URL-safe alphabet only.
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('never repeats a verifier or a state', async () => {
      const a = await start();
      const b = await start();
      expect(a.state).not.toBe(b.state);
      const rows = await db.select().from(posthogOauthStates);
      expect(rows).toHaveLength(2);
    });
  });

  describe('startAuthorization', () => {
    it('builds an authorize URL PostHog will accept', async () => {
      const { authorizeUrl, state } = await start();
      const url = new URL(authorizeUrl);
      expect(url.origin + url.pathname).toBe(`${HOST}/oauth/authorize/`);
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBe(state);
      // The scope ask is the consent screen's contents — keep it minimal and
      // keep it pinned, so widening it is a deliberate diff.
      expect(url.searchParams.get('scope')).toBe('openid task:read task:write');
      // Drives PostHog's single-project picker, which is also how we learn the
      // project id without asking the user to paste one.
      expect(url.searchParams.get('required_access_level')).toBe('project');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
    });

    it('passes a project hint through only when given one', async () => {
      const withHint = await startAuthorization({
        workspaceId: WS,
        userId: TEST_USER_ID,
        client: 'web',
        projectIdHint: '7',
      });
      expect(new URL(withHint.authorizeUrl).searchParams.get('team_id')).toBe('7');
      const without = await start();
      expect(new URL(without.authorizeUrl).searchParams.has('team_id')).toBe(false);
    });

    it('defaults the host and refuses to run unconfigured', async () => {
      const noHost = await startAuthorization({
        workspaceId: WS,
        userId: TEST_USER_ID,
        client: 'desktop',
      });
      expect(new URL(noHost.authorizeUrl).origin).toBe(HOST);

      delete process.env.POSTHOG_OAUTH_CLIENT_ID;
      resetPostHogOAuthConfigForTests();
      await expect(start()).rejects.toThrow(PostHogOAuthError);
    });

    it('sweeps states that outlived their window', async () => {
      await db.insert(posthogOauthStates).values({
        state: 'stale',
        workspaceId: WS,
        userId: TEST_USER_ID,
        codeVerifierEnc: encryptString('v'),
        host: HOST,
        client: 'desktop',
        expiresAt: new Date(Date.now() - 1000),
      });
      await start();
      const rows = await db.select().from(posthogOauthStates);
      expect(rows.map((r) => r.state)).not.toContain('stale');
    });
  });

  describe('consumeState', () => {
    it('is single-use — a replayed callback finds nothing', async () => {
      const { state } = await start();
      const first = await consumeState(state);
      expect(first?.workspaceId).toBe(WS);
      expect(first?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await consumeState(state)).toBeNull();
    });

    it.each([
      ['an unknown state', 'never-minted'],
      ['an empty state', ''],
    ])('refuses %s', async (_label, state) => {
      await start();
      expect(await consumeState(state)).toBeNull();
    });

    it('refuses an expired state even though the row is still there', async () => {
      await db.insert(posthogOauthStates).values({
        state: 'expired',
        workspaceId: WS,
        userId: TEST_USER_ID,
        codeVerifierEnc: encryptString('verifier'),
        host: HOST,
        client: 'desktop',
        expiresAt: new Date(Date.now() - 1),
      });
      expect(await consumeState('expired')).toBeNull();
    });
  });

  describe('completeAuthorization', () => {
    it('stores the grant and takes the project id off the token', async () => {
      scriptTokenExchange({ scopedTeams: [42] });
      const { state } = await start();
      const pending = await consumeState(state);
      const result = await completeAuthorization({ code: 'code-1', state: pending! });

      expect(result).toMatchObject({ workspaceId: WS, projectId: '42', host: HOST });

      const creds = await getPostHogCodeCredentials(WS);
      expect(creds).toMatchObject({ projectId: '42', host: HOST, authMethod: 'oauth' });
      expect(await creds!.getToken()).toBe('pha_access_1');

      // Neither token is readable off the row without the key.
      const row = await readPostHogIntegration(WS);
      expect(JSON.stringify(row!.config)).not.toContain('pha_access_1');
      expect(JSON.stringify(row!.config)).not.toContain('phr_refresh_1');
    });

    it('sends the PKCE verifier and the exact redirect URI', async () => {
      scriptTokenExchange({});
      const { state } = await start();
      const pending = await consumeState(state);
      await completeAuthorization({ code: 'code-1', state: pending! });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = new URLSearchParams(init.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('code-1');
      expect(body.get('code_verifier')).toBe(pending!.verifier);
      expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(body.get('client_id')).toBe(CLIENT_ID);
      // A public client sends no secret — CIMD cannot deliver one.
      expect(body.has('client_secret')).toBe(false);
    });

    it('replaces a personal API key rather than leaving it live alongside', async () => {
      await storePostHogCodeCredentials(WS, { apiKey: 'phx_legacy', projectId: '1', host: HOST });
      scriptTokenExchange({ scopedTeams: [42] });
      const { state } = await start();
      await completeAuthorization({ code: 'c', state: (await consumeState(state))! });

      const row = await readPostHogIntegration(WS);
      expect(row!.config.apiKeyEnc).toBeUndefined();
      expect(row!.config.authMethod).toBe('oauth');
    });

    it.each([
      ['no project', [], /whole organization/],
      ['several projects', [1, 2], /covers 2 projects/],
    ])('refuses a grant covering %s', async (_label, scopedTeams, expected) => {
      scriptTokenExchange({ scopedTeams: scopedTeams as unknown[] });
      const { state } = await start();
      await expect(
        completeAuthorization({ code: 'c', state: (await consumeState(state))! })
      ).rejects.toThrow(expected as RegExp);
      // Nothing half-written: the workspace is still unconnected.
      expect(await getPostHogCodeCredentials(WS)).toBeNull();
    });

    it('refuses a grant with no refresh token instead of connecting for an hour', async () => {
      scriptTokenExchange({ token: { access_token: 'pha_1', expires_in: 3600 } });
      const { state } = await start();
      await expect(
        completeAuthorization({ code: 'c', state: (await consumeState(state))! })
      ).rejects.toThrow(/refresh token/);
      expect(await getPostHogCodeCredentials(WS)).toBeNull();
    });

    it('surfaces a rejected code as a reconnect, not a retry', async () => {
      scriptTokenExchange({
        token: { error: 'invalid_grant', error_description: 'Authorization code is invalid' },
        tokenStatus: 400,
      });
      const { state } = await start();
      await expect(
        completeAuthorization({ code: 'c', state: (await consumeState(state))! })
      ).rejects.toThrow(PostHogReauthRequiredError);
    });
  });

  describe('ensureFreshAccessToken', () => {
    async function connect(expiresInMs: number): Promise<void> {
      await db.insert(integrationsTable).values({
        id: 'int-oauth',
        workspaceId: WS,
        type: 'posthog',
        enabled: true,
        config: {
          projectId: '42',
          host: HOST,
          authMethod: 'oauth',
          oauth: {
            accessTokenEnc: encryptString('pha_old'),
            refreshTokenEnc: encryptString('phr_old'),
            expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
            clientId: CLIENT_ID,
          },
        },
      });
    }

    it('uses the stored token while it has life left', async () => {
      await connect(30 * 60_000);
      expect(await ensureFreshAccessToken(WS)).toBe('pha_old');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['expired', -1000],
      ['inside the refresh skew', 60_000],
    ])('refreshes a token that is %s', async (_label, ms) => {
      await connect(ms);
      fetchMock.mockResolvedValue(
        jsonResponse({ access_token: 'pha_new', refresh_token: 'phr_new', expires_in: 3600 })
      );

      expect(await ensureFreshAccessToken(WS)).toBe('pha_new');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = new URLSearchParams(init.body as string);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('phr_old');
      // The rotated refresh token must be persisted, or the next refresh
      // presents a spent one and reuse protection kills the whole grant.
      expect(await ensureFreshAccessToken(WS)).toBe('pha_new');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('collapses concurrent callers into ONE refresh', async () => {
      // The failure this prevents: poller, streamer and dispatcher all notice the
      // expiry at once, each POSTs the same refresh token, and PostHog's reuse
      // protection revokes the entire family — logging the workspace out of a
      // connection it never touched.
      await connect(-1000);
      let calls = 0;
      fetchMock.mockImplementation(async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse({ access_token: 'pha_new', refresh_token: 'phr_new', expires_in: 3600 });
      });

      const tokens = await Promise.all([
        ensureFreshAccessToken(WS),
        ensureFreshAccessToken(WS),
        ensureFreshAccessToken(WS),
        ensureFreshAccessToken(WS),
      ]);

      expect(tokens).toEqual(['pha_new', 'pha_new', 'pha_new', 'pha_new']);
      expect(calls).toBe(1);
    });

    it('marks the connection for reconnect when the refresh token is rejected', async () => {
      await connect(-1000);
      fetchMock.mockResolvedValue(
        jsonResponse(
          { error: 'invalid_grant', error_description: 'Refresh token revoked' },
          400
        )
      );

      await expect(ensureFreshAccessToken(WS)).rejects.toThrow(PostHogReauthRequiredError);

      // Persisted, so every surface agrees and nothing keeps retrying a grant
      // that cannot come back.
      const creds = await getPostHogCodeCredentials(WS);
      expect(creds?.reauthRequired).toBe(true);

      // And it fails fast from then on — without another token request.
      fetchMock.mockClear();
      resetOAuthInflightForTests();
      await expect(ensureFreshAccessToken(WS)).rejects.toThrow(PostHogReauthRequiredError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('leaves a transient failure recoverable', async () => {
      await connect(-1000);
      fetchMock.mockResolvedValue(jsonResponse({ error: 'server_error' }, 503));

      await expect(ensureFreshAccessToken(WS)).rejects.toThrow(PostHogOAuthError);
      // A 503 is not a revocation: the row must NOT be flagged, or a PostHog
      // blip would turn into "reconnect your account" for every workspace.
      const creds = await getPostHogCodeCredentials(WS);
      expect(creds?.reauthRequired).toBe(false);

      resetOAuthInflightForTests();
      fetchMock.mockResolvedValue(
        jsonResponse({ access_token: 'pha_new', refresh_token: 'phr_new', expires_in: 3600 })
      );
      expect(await ensureFreshAccessToken(WS)).toBe('pha_new');
    });

    it('clears the reconnect flag once a refresh succeeds again', async () => {
      await connect(-1000);
      await markReauthRequired(WS, 'revoked');
      expect((await getPostHogCodeCredentials(WS))?.reauthRequired).toBe(true);

      // Reconnecting is what clears it in production; prove the refresh path
      // does too, so a recovered grant doesn't stay flagged forever.
      await db
        .update(integrationsTable)
        .set({
          config: {
            projectId: '42',
            host: HOST,
            authMethod: 'oauth',
            oauth: {
              accessTokenEnc: encryptString('pha_old'),
              refreshTokenEnc: encryptString('phr_old'),
              expiresAt: new Date(Date.now() - 1000).toISOString(),
              clientId: CLIENT_ID,
            },
          },
        })
        .where(eq(integrationsTable.id, 'int-oauth'));
      resetOAuthInflightForTests();
      fetchMock.mockResolvedValue(
        jsonResponse({ access_token: 'pha_new', refresh_token: 'phr_new', expires_in: 3600 })
      );
      await ensureFreshAccessToken(WS);
      expect((await getPostHogCodeCredentials(WS))?.reauthRequired).toBe(false);
    });

    it('treats an unconnected workspace as needing authorization', async () => {
      await expect(ensureFreshAccessToken(WS)).rejects.toThrow(PostHogReauthRequiredError);
    });
  });

  describe('credential resolution across both auth methods', () => {
    it('reads a pre-OAuth row (no authMethod) as a personal API key', async () => {
      // Exactly the shape every install written before this feature has.
      await db.insert(integrationsTable).values({
        id: 'int-legacy',
        workspaceId: WS,
        type: 'posthog',
        enabled: true,
        config: { apiKeyEnc: encryptString('phx_legacy'), projectId: '9', host: HOST },
      });

      const creds = await getPostHogCodeCredentials(WS);
      expect(creds).toMatchObject({
        projectId: '9',
        host: HOST,
        authMethod: 'personal_api_key',
        reauthRequired: false,
      });
      expect(await creds!.getToken()).toBe('phx_legacy');
      // No OAuth machinery involved — a key install makes no token requests.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps a key install on the key path even with tokens left on the row', async () => {
      await db.insert(integrationsTable).values({
        id: 'int-mixed',
        workspaceId: WS,
        type: 'posthog',
        enabled: true,
        config: {
          apiKeyEnc: encryptString('phx_legacy'),
          projectId: '9',
          host: HOST,
          authMethod: 'personal_api_key',
          oauth: {
            accessTokenEnc: encryptString('pha_stale'),
            refreshTokenEnc: encryptString('phr_stale'),
            expiresAt: new Date(Date.now() - 1000).toISOString(),
            clientId: CLIENT_ID,
          },
        },
      });
      const creds = await getPostHogCodeCredentials(WS);
      expect(creds?.authMethod).toBe('personal_api_key');
      expect(await creds!.getToken()).toBe('phx_legacy');
    });

    it('switching back to a key drops the OAuth tokens', async () => {
      scriptTokenExchange({});
      const { state } = await start();
      await completeAuthorization({ code: 'c', state: (await consumeState(state))! });

      await storePostHogCodeCredentials(WS, { apiKey: 'phx_new', projectId: '3', host: HOST });
      const row = await readPostHogIntegration(WS);
      expect(row!.config.oauth).toBeUndefined();
      expect(row!.config.authMethod).toBe('personal_api_key');
    });

    it.each([
      ['a row with no project id', { apiKeyEnc: 'key' }],
      ['an OAuth row with no tokens', { projectId: '1', authMethod: 'oauth' }],
    ])('resolves %s to "not configured"', async (_label, config) => {
      await db.insert(integrationsTable).values({
        id: 'int-partial',
        workspaceId: WS,
        type: 'posthog',
        enabled: true,
        config:
          'apiKeyEnc' in config
            ? { apiKeyEnc: encryptString('phx'), host: HOST }
            : (config as Record<string, unknown>),
      });
      expect(await getPostHogCodeCredentials(WS)).toBeNull();
    });
  });
});
