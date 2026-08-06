import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { getDbClient, getPoolDbClient, isRealPostgres } from '../../db/client.js';
import { posthogOauthStates } from '../../db/schema.js';
import { withBlockingAdvisoryLock } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { fetchWithTimeout } from '../httpTimeout.js';
import { encryptString, decryptString, isEncryptedEnvelope } from '../tokenCrypto.js';
import { getPostHogOAuthConfig } from './oauthConfig.js';
import {
  normalizeHost,
  readPostHogIntegration,
  upsertPostHogIntegration,
  type PostHogOAuthTokens,
} from './integrationRow.js';

/**
 * The PostHog OAuth (CIMD + PKCE) connect flow and its token lifecycle.
 *
 * PostHog is a full OAuth2/OIDC authorization server and its tasks API accepts
 * `pha_` bearer tokens with exactly the same scope + team enforcement as a
 * personal API key (posthog/permissions.py). What OAuth buys us over a pasted
 * key: the user never handles a credential, the grant is scoped to ONE project
 * and only `task:*`, and it is revocable from PostHog's own settings.
 *
 * What it costs, and what most of this module is about: PostHog access tokens
 * live 1 hour, refresh tokens 30 days, and refresh tokens ROTATE with reuse
 * protection (a 120-second grace, after which reusing a spent refresh token
 * revokes the entire token family). Talyn hits this API from a poll loop, a
 * streamer, and the dispatcher — across two instances during every deploy — so
 * an unguarded refresh would eventually revoke a workspace's own connection.
 * Refreshes are therefore single-flighted twice over: an in-process promise map
 * collapses the common case without a round-trip, and a Postgres advisory lock
 * covers the cross-instance overlap.
 */

/** Scopes Talyn asks for. `task:*` is everything the cloud-task API needs
 *  (products/tasks/backend — every action is gated on task:read or task:write);
 *  `openid` makes it a proper OIDC grant. Deliberately nothing else: the consent
 *  screen lists these verbatim, and a broad ask is both a security smell and a
 *  reason for a user to bail. */
const SCOPES = ['openid', 'task:read', 'task:write'] as const;

/** How long a started flow stays redeemable. PostHog expires the authorization
 *  code itself after 5 minutes, so there is nothing to gain from outliving it —
 *  a longer window would only keep dead rows around. */
const STATE_TTL_MS = 10 * 60_000;

/** Refresh this far ahead of expiry. Comfortably longer than any single API call
 *  (the SSE stream authenticates once at connect, so it isn't a factor), which
 *  keeps refreshes off the request path in the normal case. */
const REFRESH_SKEW_MS = 5 * 60_000;

const TOKEN_TIMEOUT_LABEL = 'PostHog OAuth';

/**
 * The connection needs the user to consent again — the refresh token was
 * rejected (revoked in PostHog, killed by secret scanning, or the whole family
 * revoked by reuse protection). Distinct from a transient failure so callers can
 * stop retrying and surface "Reconnect" instead of "PostHog is down".
 */
export class PostHogReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostHogReauthRequiredError';
  }
}

/** A recoverable failure talking to the token endpoint (5xx, network, throttle). */
export class PostHogOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostHogOAuthError';
  }
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function createPkcePair(): { verifier: string; challenge: string } {
  // 32 random bytes → 43 base64url chars, the RFC 7636 minimum-and-then-some.
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Start: mint state + build the authorize URL
// ---------------------------------------------------------------------------

export interface StartAuthorizationInput {
  workspaceId: string;
  userId: string;
  /** The PostHog instance to authorize against (us/eu cloud, or self-hosted). */
  host?: string;
  /** Which front end started the flow, so the callback can end correctly. */
  client: 'web' | 'desktop';
  /** Optional project to pre-select on PostHog's consent screen. */
  projectIdHint?: string;
}

export async function startAuthorization(
  input: StartAuthorizationInput
): Promise<{ authorizeUrl: string; state: string }> {
  const config = getPostHogOAuthConfig();
  if (!config) {
    throw new PostHogOAuthError('PostHog OAuth is not configured on this deployment.');
  }

  const host = normalizeHost(input.host);
  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes(32));

  const db = getDbClient();
  // Opportunistic sweep: these rows are worthless past their TTL and the flow
  // is rare enough that a dedicated poll loop would be all cost and no benefit.
  await db.delete(posthogOauthStates).where(lt(posthogOauthStates.expiresAt, new Date()));
  await db.insert(posthogOauthStates).values({
    state,
    workspaceId: input.workspaceId,
    userId: input.userId,
    codeVerifierEnc: encryptString(verifier),
    host,
    client: input.client,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });

  const url = new URL('/oauth/authorize/', host);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Make PostHog's consent screen render its organization + single-project
  // pickers, and narrow the resulting token to that one project. This is also
  // how we learn the project id (see `resolveProjectId`), which is what removes
  // the "paste your project id" step the personal-API-key path needs.
  url.searchParams.set('required_access_level', 'project');
  if (input.projectIdHint) url.searchParams.set('team_id', input.projectIdHint);

  return { authorizeUrl: url.toString(), state };
}

// ---------------------------------------------------------------------------
// Callback: redeem the code
// ---------------------------------------------------------------------------

interface PendingState {
  workspaceId: string;
  userId: string;
  verifier: string;
  host: string;
  client: 'web' | 'desktop';
}

/**
 * Consume a pending state. Single-use: the row is deleted as part of the lookup,
 * so a replayed callback finds nothing. The DELETE-and-return is what makes that
 * atomic — two concurrent callbacks with the same state cannot both proceed.
 */
export async function consumeState(state: string): Promise<PendingState | null> {
  if (!state) return null;
  const db = getDbClient();
  const rows = await db
    .delete(posthogOauthStates)
    .where(eq(posthogOauthStates.state, state))
    .returning({
      workspaceId: posthogOauthStates.workspaceId,
      userId: posthogOauthStates.userId,
      codeVerifierEnc: posthogOauthStates.codeVerifierEnc,
      host: posthogOauthStates.host,
      client: posthogOauthStates.client,
      expiresAt: posthogOauthStates.expiresAt,
    });
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  if (!isEncryptedEnvelope(row.codeVerifierEnc)) return null;

  let verifier: string;
  try {
    verifier = decryptString(row.codeVerifierEnc);
  } catch (err) {
    console.error('[posthog:oauth] failed to decrypt PKCE verifier:', err);
    return null;
  }
  return {
    workspaceId: row.workspaceId,
    userId: row.userId,
    verifier,
    host: row.host,
    client: row.client === 'web' ? 'web' : 'desktop',
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/**
 * Exchange an authorization code, discover which project the user granted, and
 * store the result as the workspace's credentials.
 *
 * Returns the connected project + host so the caller can report it.
 */
export async function completeAuthorization(input: {
  code: string;
  state: PendingState;
}): Promise<{ workspaceId: string; userId: string; projectId: string; host: string }> {
  const config = getPostHogOAuthConfig();
  if (!config) {
    throw new PostHogOAuthError('PostHog OAuth is not configured on this deployment.');
  }
  const { host, workspaceId, userId } = input.state;

  const token = await postToken(host, {
    grant_type: 'authorization_code',
    code: input.code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code_verifier: input.state.verifier,
  });

  if (!token.refresh_token) {
    // Without one, the connection would silently die an hour later. Better to
    // refuse the grant now, with a message, than to look connected and stop.
    throw new PostHogOAuthError(
      'PostHog did not return a refresh token — cannot keep this connection alive.'
    );
  }

  const refreshToken = token.refresh_token;
  const projectId = await resolveProjectId(host, token.access_token);

  // The mutator returns the WHOLE next config, so this deliberately drops any
  // `apiKeyEnc` the row was carrying: the user just connected via OAuth, and
  // leaving a personal API key behind means a revoked grant could silently fall
  // back to a credential they believe they replaced.
  await upsertPostHogIntegration(workspaceId, () => ({
    projectId,
    host,
    authMethod: 'oauth',
    oauth: {
      accessTokenEnc: encryptString(token.access_token),
      refreshTokenEnc: encryptString(refreshToken),
      expiresAt: expiryFrom(token.expires_in).toISOString(),
      scope: token.scope,
      clientId: config.clientId,
    },
  }));

  return { workspaceId, userId, projectId, host };
}

/**
 * Which project (team) the grant covers, read off the token itself.
 *
 * `required_access_level=project` makes PostHog's consent screen narrow the
 * token to a single team, and self-introspection (RFC 7662 — allowed without the
 * `introspection` scope when a token introspects itself) reports it back. So the
 * project id is a property of the grant rather than something the user has to
 * find and paste.
 *
 * Zero or several teams means the user consented at organization scope, or to
 * several projects, and there is no single right answer — refuse with something
 * actionable rather than guessing and filing every task into the wrong project.
 */
async function resolveProjectId(host: string, accessToken: string): Promise<string> {
  const url = `${host}/oauth/introspect/`;
  const body = new URLSearchParams({ token: accessToken });
  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        // Self-introspection: the bearer must be the token being introspected.
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    },
    { label: TOKEN_TIMEOUT_LABEL }
  );
  debugBus.recordHttp({
    service: 'posthog_oauth',
    method: 'POST',
    url,
    status: res.status,
    durationMs: Date.now() - startedAt,
    ok: res.ok,
    bytes: res.bodyText.length,
    ...(res.ok ? {} : { error: res.bodyText.slice(0, 300) }),
  });
  if (!res.ok) {
    throw new PostHogOAuthError(
      `Could not introspect the PostHog token (${res.status}) — cannot determine the project.`
    );
  }

  let parsed: { active?: boolean; scoped_teams?: unknown };
  try {
    parsed = JSON.parse(res.bodyText) as { active?: boolean; scoped_teams?: unknown };
  } catch {
    throw new PostHogOAuthError('PostHog returned an unreadable introspection response.');
  }
  if (!parsed.active) {
    throw new PostHogOAuthError('PostHog reported the new access token as inactive.');
  }

  const teams = Array.isArray(parsed.scoped_teams)
    ? parsed.scoped_teams.filter((t): t is number | string => typeof t === 'number' || typeof t === 'string')
    : [];
  if (teams.length !== 1) {
    throw new PostHogOAuthError(
      teams.length === 0
        ? 'That authorization covers a whole organization rather than one project. Reconnect and pick a single project on the PostHog screen.'
        : `That authorization covers ${teams.length} projects. Reconnect and pick a single project on the PostHog screen.`
    );
  }
  return String(teams[0]);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/** In-flight refreshes, keyed by workspace. Collapses the many callers inside
 *  ONE instance (poller + streamer + dispatcher) into a single token request —
 *  the cheap half of the single-flight; the advisory lock below is the other. */
const inflight = new Map<string, Promise<string>>();

/**
 * A usable access token for the workspace, refreshing if it is expired or close
 * to it. `force` re-refreshes regardless — for the one case where our expiry
 * bookkeeping can be wrong: the API answered 401 on a token we believed valid
 * (revoked remotely, or the clock drifted).
 */
export async function ensureFreshAccessToken(
  workspaceId: string,
  opts: { force?: boolean } = {}
): Promise<string> {
  const current = await readOAuthTokens(workspaceId);
  if (current.reauthRequiredAt) {
    throw new PostHogReauthRequiredError(
      current.reauthReason ?? 'The PostHog connection was revoked — reconnect to continue.'
    );
  }
  if (!opts.force && !isExpiring(current.expiresAt)) {
    return decryptString(current.accessTokenEnc);
  }

  const existing = inflight.get(workspaceId);
  if (existing) return existing;

  const attempt = refreshWithLock(workspaceId, opts.force === true).finally(() => {
    inflight.delete(workspaceId);
  });
  inflight.set(workspaceId, attempt);
  return attempt;
}

async function refreshWithLock(workspaceId: string, force: boolean): Promise<string> {
  const run = async (): Promise<string> => {
    // Re-read inside the lock: the instance that held it before us may have
    // already rotated the token, in which case reusing our copy of the refresh
    // token past the 120s grace would revoke the whole family.
    const fresh = await readOAuthTokens(workspaceId);
    if (fresh.reauthRequiredAt) {
      throw new PostHogReauthRequiredError(
        fresh.reauthReason ?? 'The PostHog connection was revoked — reconnect to continue.'
      );
    }
    if (!isExpiring(fresh.expiresAt) && !force) {
      return decryptString(fresh.accessTokenEnc);
    }

    try {
      return await performRefresh(workspaceId, fresh);
    } catch (err) {
      // A *preemptive* refresh that failed transiently must not fail the caller.
      // We refresh 5 minutes early, so the token in hand is normally still good
      // for minutes — failing here would turn a brief PostHog wobble into failed
      // dispatches and stalled polls for that whole window. (PostHog Desktop does
      // the same thing with its own 1-minute skew.)
      //
      // Two exclusions, both load-bearing: a FORCED refresh means the API just
      // rejected the token in hand, so returning it again is pointless, and a
      // PostHogReauthRequiredError is terminal — falling back would paper over a
      // revoked grant until the access token finally expired.
      if (!force && err instanceof PostHogOAuthError && !isExpired(fresh.expiresAt)) {
        console.warn(
          `[posthog:oauth] preemptive refresh failed for workspace ${workspaceId}; ` +
            `using the current access token (expires ${fresh.expiresAt}): ${err.message}`
        );
        return decryptString(fresh.accessTokenEnc);
      }
      throw err;
    }
  };

  // pglite (tests) runs one WASM connection whose transaction() takes an
  // exclusive mutex, so wrapping work that queries through getDbClient() would
  // self-deadlock — and cross-instance exclusion is meaningless in-process
  // anyway. The in-flight map above still provides single-flight there.
  if (!isRealPostgres()) return run();
  return withBlockingAdvisoryLock(
    getPoolDbClient(),
    `posthog-oauth-refresh:${workspaceId}`,
    run
  );
}

async function performRefresh(
  workspaceId: string,
  tokens: PostHogOAuthTokens & { host: string }
): Promise<string> {
  const config = getPostHogOAuthConfig();
  if (!config) {
    throw new PostHogOAuthError('PostHog OAuth is not configured on this deployment.');
  }

  let refreshed: TokenResponse;
  try {
    refreshed = await postToken(tokens.host, {
      grant_type: 'refresh_token',
      refresh_token: decryptString(tokens.refreshTokenEnc),
      client_id: config.clientId,
    });
  } catch (err) {
    if (err instanceof PostHogReauthRequiredError) {
      await markReauthRequired(workspaceId, err.message);
    }
    throw err;
  }

  // A refresh response without a rotated refresh token would leave us holding a
  // spent one; PostHog always rotates, so treat its absence as a hard failure
  // rather than persisting a token we know is dead.
  if (!refreshed.refresh_token) {
    throw new PostHogOAuthError('PostHog refresh response carried no refresh token.');
  }

  await upsertPostHogIntegration(workspaceId, (current) => ({
    ...current,
    authMethod: 'oauth',
    oauth: {
      ...(current.oauth ?? { clientId: config.clientId }),
      accessTokenEnc: encryptString(refreshed.access_token),
      refreshTokenEnc: encryptString(refreshed.refresh_token as string),
      expiresAt: expiryFrom(refreshed.expires_in).toISOString(),
      scope: refreshed.scope ?? current.oauth?.scope,
      clientId: config.clientId,
      reauthRequiredAt: undefined,
      reauthReason: undefined,
    },
  }));

  return refreshed.access_token;
}

/** Flag the connection as needing re-consent. Survives restarts (it is on the
 *  row) so every surface — status endpoint, dispatch, poller — agrees, and no
 *  code path keeps hammering a grant that cannot come back. */
export async function markReauthRequired(workspaceId: string, reason: string): Promise<void> {
  await upsertPostHogIntegration(workspaceId, (current) => {
    if (!current.oauth) return current;
    return {
      ...current,
      oauth: {
        ...current.oauth,
        reauthRequiredAt: new Date().toISOString(),
        reauthReason: reason,
      },
    };
  });
}

async function readOAuthTokens(
  workspaceId: string
): Promise<PostHogOAuthTokens & { host: string }> {
  const row = await readPostHogIntegration(workspaceId);
  const oauth = row?.config.oauth;
  if (!row || !oauth || !isEncryptedEnvelope(oauth.accessTokenEnc)) {
    throw new PostHogReauthRequiredError('PostHog is not connected for this workspace.');
  }
  return { ...oauth, host: normalizeHost(row.config.host) };
}

function isExpiring(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return at - Date.now() <= REFRESH_SKEW_MS;
}

/** Actually past its expiry, as opposed to merely inside the refresh window.
 *  An unknown or unparseable expiry counts as expired: guessing "still valid"
 *  about a token we can't date would hand callers something already dead. */
function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return at <= Date.now();
}

function expiryFrom(expiresIn: number | undefined): Date {
  // PostHog issues 1-hour access tokens; fall back to that if the response
  // omits `expires_in` so we never treat a token as immortal.
  const seconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600;
  return new Date(Date.now() + seconds * 1000);
}

/**
 * POST the token endpoint, form-encoded, as a public client (PKCE, no secret —
 * prod advertises only `none` and `client_secret_post`, and CIMD clients cannot
 * be issued a secret at all).
 *
 * `invalid_grant` is the one error worth distinguishing: per RFC 6749 it is the
 * server saying this code/refresh token will never work again, which for a
 * refresh means the grant is gone and the user must reconnect.
 */
async function postToken(host: string, params: Record<string, string>): Promise<TokenResponse> {
  const url = `${normalizeHost(host)}/oauth/token/`;
  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    },
    { label: TOKEN_TIMEOUT_LABEL }
  );
  debugBus.recordHttp({
    service: 'posthog_oauth',
    method: 'POST',
    url,
    status: res.status,
    durationMs: Date.now() - startedAt,
    ok: res.ok,
    bytes: res.bodyText.length,
    // The body carries an OAuth error code, never a token, on a failure —
    // and debugBus records metadata only, so this stays safe to keep.
    ...(res.ok ? {} : { error: res.bodyText.slice(0, 300) }),
  });

  if (!res.ok) {
    const { error, description } = parseOAuthError(res.bodyText);
    const detail = description || error || `HTTP ${res.status}`;
    if (error === 'invalid_grant' || error === 'invalid_client') {
      throw new PostHogReauthRequiredError(
        `PostHog rejected the stored authorization (${detail}) — reconnect to continue.`
      );
    }
    throw new PostHogOAuthError(`PostHog token request failed (${res.status}): ${detail}`);
  }

  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(res.bodyText) as TokenResponse;
  } catch {
    throw new PostHogOAuthError('PostHog returned an unreadable token response.');
  }
  if (!parsed.access_token) {
    throw new PostHogOAuthError('PostHog token response carried no access token.');
  }
  return parsed;
}

function parseOAuthError(body: string): { error?: string; description?: string } {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    return {
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      description:
        typeof parsed.error_description === 'string' ? parsed.error_description : undefined,
    };
  } catch {
    return {};
  }
}

/** Tests: clear the in-flight single-flight map between cases. */
export function resetOAuthInflightForTests(): void {
  inflight.clear();
}
