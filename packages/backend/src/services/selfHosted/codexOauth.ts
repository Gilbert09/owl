import { and, eq } from 'drizzle-orm';
import { getDbClient, getPoolDbClient, isRealPostgres } from '../../db/client.js';
import { integrations as integrationsTable } from '../../db/schema.js';
import { withBlockingAdvisoryLock } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { fetchWithTimeout } from '../httpTimeout.js';
import { decryptString, encryptString, isEncryptedEnvelope } from '../tokenCrypto.js';
import type { CodexOAuthCredential } from './credentials.js';

/**
 * The ChatGPT-subscription credential lifecycle for Talyn Fleet.
 *
 * # Why the flow runs on the user's machine and not here
 *
 * OpenAI publishes no third-party OAuth for ChatGPT-subscription inference. The
 * only client whose tokens the Codex backend accepts is OpenAI's own Codex CLI
 * client, and its registered redirect is `http://localhost:1455/auth/callback`
 * — a loopback address, which a hosted backend can never be. So the authorize
 * leg runs in the desktop app's main process (`main/codexAuth.ts`), which owns
 * a loopback listener the way `codex login` does, and the backend receives the
 * finished token pair. `apps/web` cannot do this at all and pastes instead.
 *
 * That is also why there is no `codex_oauth_states` table here, unlike PostHog
 * Code's (migration 0040): nothing on the server mints or redeems a PKCE state,
 * so there is no cross-instance handoff to survive.
 *
 * # What this module owns
 *
 * The half that must be on the server: REFRESH. A subscription access token is
 * short-lived, a fleet run outlives it, and the run cannot refresh for itself —
 * the guest never sees the credential at all (the host's proxy injects it). So
 * the token has to be fresh before the dispatch and re-servable to a host that
 * asks for it back.
 *
 * The single-flight is the same shape as `posthogCode/oauth.ts` and for the
 * same reason: an in-process promise map collapses the many callers inside ONE
 * instance without a round-trip, and a blocking Postgres advisory lock collapses
 * the instances. Both halves matter — OpenAI rotates the refresh token on every
 * use, so two concurrent refreshes mean one of them replays a spent token.
 */

const INTEGRATION_TYPE = 'selfhosted';

/**
 * OpenAI's own Codex CLI client id, and the loopback it redirects to.
 *
 * Exported because the desktop's authorize leg builds the URL from the same
 * constants — two copies of a client id is how one of them ends up stale, and
 * a mismatched `redirect_uri` between the authorize and the token call is an
 * `invalid_grant` with nothing in it about the cause.
 *
 * Using OpenAI's first-party client id from a third-party app is what every
 * other tool that offers ChatGPT-subscription coding does (OpenCode identifies
 * itself with `originator=opencode` on the same client id). It is not a
 * documented integration point: OpenAI can revoke the client or start refusing
 * unfamiliar originators, and that would break every connected workspace at
 * once rather than one at a time. See docs/CLOUD_PROVIDERS.md.
 */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
/** Identifies us to OpenAI the way OpenCode identifies itself. */
export const CODEX_ORIGINATOR = 'talyn';

/** Refresh this far before expiry, so a run starts on a token with time on it. */
const REFRESH_SKEW_MS = 5 * 60_000;

const TOKEN_TIMEOUT_LABEL = 'Codex OAuth token request';

/** The claim OpenAI hangs the ChatGPT account id off, inside the access token. */
const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth';

export class CodexOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexOAuthError';
  }
}

/** The grant is gone. Nothing retries; the user must reconnect. */
export class CodexReauthRequiredError extends Error {
  readonly reauthRequired = true;
  constructor(message: string) {
    super(message);
    this.name = 'CodexReauthRequiredError';
  }
}

export interface CodexTokenPair {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  /** ISO. */
  expiresAt: string;
}

/**
 * Read `chatgpt_account_id` out of an access token.
 *
 * The token is a signed JWT and we do not verify it — we are not the audience,
 * and the party that must trust it (the fleet's credential proxy) reads the
 * same claim for itself. This is a decode for one non-secret field, so a
 * malformed token is a validation failure at connect time rather than a
 * security question.
 *
 * Refusing a token with no account id is the point: the Codex backend wants the
 * id as a SECOND header beside the bearer, and a run dispatched without it gets
 * a 401 from chatgpt.com with nothing in it naming the cause.
 */
export function chatgptAccountIdFrom(accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const auth = payload[CHATGPT_AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === 'string' && id.trim() ? id : null;
  } catch {
    return null;
  }
}

/** Seconds-from-now to an ISO instant, defaulting to an hour when unstated. */
function expiryFrom(seconds: number | undefined): string {
  return new Date(Date.now() + (typeof seconds === 'number' ? seconds : 3600) * 1000).toISOString();
}

function isExpiring(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return at - Date.now() <= REFRESH_SKEW_MS;
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at <= Date.now();
}

/** The token pair as it arrives from a completed authorize leg. */
export function codexCredentialFrom(input: {
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  expiresIn?: number;
}): CodexOAuthCredential {
  const accountId = input.accountId?.trim() || chatgptAccountIdFrom(input.accessToken);
  if (!accountId) {
    throw new CodexOAuthError(
      'That access token carries no ChatGPT account id, so a Codex run could not authenticate. ' +
        'Sign in again with `codex login` and use the token it writes.',
    );
  }
  return {
    accessTokenEnc: encryptString(input.accessToken),
    refreshTokenEnc: encryptString(input.refreshToken),
    accountId,
    expiresAt: expiryFrom(input.expiresIn),
  };
}

// ---------------------------------------------------------------------------

/** In-flight refreshes keyed by workspace — the cheap half of the single-flight. */
const inflight = new Map<string, Promise<CodexTokenPair>>();

/**
 * A usable Codex access token for a workspace, refreshed if it is due.
 *
 * Returns null when the workspace has no Codex credential at all, which is the
 * ordinary case for a Claude-only workspace and is NOT an error. Throws only
 * when a credential exists and cannot be made usable.
 *
 * `reauthRequiredAt` short-circuits everything: once OpenAI has said the grant
 * is gone, retrying it on every dispatch and every poll tick just spends
 * requests to be told the same thing.
 */
export async function resolveCodexAccessToken(
  workspaceId: string,
  stored: CodexOAuthCredential | undefined,
): Promise<{ accessToken: string; accountId: string } | null> {
  if (!stored || !isEncryptedEnvelope(stored.accessTokenEnc)) return null;
  if (stored.reauthRequiredAt) {
    console.warn(
      `[codex] workspace ${workspaceId.slice(0, 8)} needs to reconnect Codex — ` +
        'the stored authorization was rejected, so nothing is being retried.',
    );
    return null;
  }
  if (!isExpiring(stored.expiresAt)) {
    return { accessToken: decryptString(stored.accessTokenEnc), accountId: stored.accountId };
  }

  const existing = inflight.get(workspaceId);
  if (existing) {
    const pair = await existing;
    return { accessToken: pair.accessToken, accountId: pair.accountId };
  }

  const attempt = refreshWithLock(workspaceId, stored).finally(() => inflight.delete(workspaceId));
  inflight.set(workspaceId, attempt);
  try {
    const pair = await attempt;
    return { accessToken: pair.accessToken, accountId: pair.accountId };
  } catch (err) {
    // A PREEMPTIVE refresh that failed transiently must not fail the caller: we
    // refresh five minutes early, so the token in hand is normally still good.
    // Turning a brief OpenAI wobble into a failed dispatch would be worse than
    // spending the last minutes of a token that still works.
    //
    // Not for a token that is genuinely expired, and not for a dead grant —
    // there, handing back the old token only moves the failure into the guest,
    // where it reads as "the agent could not make a single call".
    if (err instanceof CodexReauthRequiredError) throw err;
    if (!isExpired(stored.expiresAt)) {
      console.warn(
        `[codex] preemptive refresh for workspace ${workspaceId.slice(0, 8)} failed; ` +
          `using the token in hand (${err instanceof Error ? err.message : String(err)})`,
      );
      return { accessToken: decryptString(stored.accessTokenEnc), accountId: stored.accountId };
    }
    throw err;
  }
}

async function refreshWithLock(
  workspaceId: string,
  hint: CodexOAuthCredential,
): Promise<CodexTokenPair> {
  const run = async (): Promise<CodexTokenPair> => {
    // Re-read INSIDE the lock. The instance that held it before us may already
    // have rotated the pair, and OpenAI rotates on every use — replaying the
    // copy we walked in with would spend a token that is already spent.
    const fresh = (await readCodexCredential(workspaceId)) ?? hint;
    if (fresh.reauthRequiredAt) {
      throw new CodexReauthRequiredError('Reconnect Codex to continue — the stored sign-in was rejected.');
    }
    if (!isExpiring(fresh.expiresAt)) {
      return {
        accessToken: decryptString(fresh.accessTokenEnc),
        refreshToken: decryptString(fresh.refreshTokenEnc),
        accountId: fresh.accountId,
        expiresAt: fresh.expiresAt,
      };
    }
    return performRefresh(workspaceId, fresh);
  };

  // The lock is the CROSS-INSTANCE half of the single-flight; the in-process
  // promise map is the other. Skipped off real Postgres for the reason the
  // module docs give: pglite is one WASM connection whose `transaction()` takes
  // an exclusive mutex, and `run`'s own queries go through the same client — so
  // wrapping it self-deadlocks. Cross-replica exclusion is meaningless in a
  // single-process test anyway. Same shape as posthogCode/oauth.ts.
  if (!isRealPostgres()) return run();
  return withBlockingAdvisoryLock(getPoolDbClient(), `codex-oauth-refresh:${workspaceId}`, run);
}

async function performRefresh(
  workspaceId: string,
  current: CodexOAuthCredential,
): Promise<CodexTokenPair> {
  const body = await postToken({
    grant_type: 'refresh_token',
    refresh_token: decryptString(current.refreshTokenEnc),
    client_id: CODEX_CLIENT_ID,
  });

  const accessToken = body.access_token;
  // OpenAI rotates, but treat a response without a new refresh token as "keep
  // the one we have" rather than as a failure — dropping it would strand the
  // workspace on an access token it can never renew.
  const refreshToken = body.refresh_token ?? decryptString(current.refreshTokenEnc);
  const accountId = chatgptAccountIdFrom(accessToken) ?? current.accountId;
  const expiresAt = expiryFrom(body.expires_in);

  await patchCodexCredential(workspaceId, {
    accessTokenEnc: encryptString(accessToken),
    refreshTokenEnc: encryptString(refreshToken),
    accountId,
    expiresAt,
  });

  return { accessToken, refreshToken, accountId, expiresAt };
}

/**
 * POST OpenAI's token endpoint as a public client (PKCE, no secret).
 *
 * `invalid_grant` is the one error worth distinguishing: per RFC 6749 it is the
 * server saying this refresh token will never work again, so the grant is gone
 * and only the user can restore it.
 */
export async function postToken(params: Record<string, string>): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    CODEX_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    },
    { label: TOKEN_TIMEOUT_LABEL },
  );
  debugBus.recordHttp({
    service: 'codex_oauth',
    method: 'POST',
    url: CODEX_TOKEN_URL,
    status: res.status,
    durationMs: Date.now() - startedAt,
    ok: res.ok,
    bytes: res.bodyText.length,
    // On a failure the body carries an OAuth error code, never a token.
    ...(res.ok ? {} : { error: res.bodyText.slice(0, 300) }),
  });

  if (!res.ok) {
    const { error, description } = parseOAuthError(res.bodyText);
    const detail = description || error || `HTTP ${res.status}`;
    if (error === 'invalid_grant' || error === 'invalid_client') {
      throw new CodexReauthRequiredError(`OpenAI rejected the stored sign-in (${detail}) — reconnect Codex.`);
    }
    throw new CodexOAuthError(`Codex token request failed (${res.status}): ${detail}`);
  }

  let parsed: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(res.bodyText) as typeof parsed;
  } catch {
    throw new CodexOAuthError('OpenAI returned an unreadable token response.');
  }
  if (!parsed.access_token) {
    throw new CodexOAuthError('OpenAI token response carried no access token.');
  }
  return { ...parsed, access_token: parsed.access_token };
}

function parseOAuthError(body: string): { error?: string; description?: string } {
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string };
    return { error: parsed.error, description: parsed.error_description };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Row access. Deliberately narrow: this module reads and writes ONE key of the
// selfhosted integration's config, so it never has to know the rest of the
// shape and can never clobber the Claude credential beside it.

async function readCodexCredential(workspaceId: string): Promise<CodexOAuthCredential | null> {
  const rows = await getDbClient()
    .select({ config: integrationsTable.config })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  const config = rows[0]?.config as { codexOAuth?: CodexOAuthCredential } | null;
  return config?.codexOAuth ?? null;
}

async function patchCodexCredential(
  workspaceId: string,
  patch: Partial<CodexOAuthCredential>,
): Promise<void> {
  const db = getDbClient();
  const rows = await db
    .select({ id: integrationsTable.id, config: integrationsTable.config })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return;
  const config = (row.config as Record<string, unknown> | null) ?? {};
  const current = (config.codexOAuth as CodexOAuthCredential | undefined) ?? undefined;
  if (!current) return;
  await db
    .update(integrationsTable)
    .set({
      // A rotation CLEARS reauthRequiredAt: the pair we just wrote works, so
      // leaving the flag would keep every later dispatch skipping a live
      // credential.
      config: { ...config, codexOAuth: { ...current, ...patch, reauthRequiredAt: undefined } },
      updatedAt: new Date(),
    })
    .where(eq(integrationsTable.id, row.id));
}

/**
 * Flag the connection as needing re-consent. On the row, so it survives a
 * restart and every surface agrees — dispatch, the poller, the settings card.
 */
export async function markCodexReauthRequired(workspaceId: string): Promise<void> {
  const db = getDbClient();
  const rows = await db
    .select({ id: integrationsTable.id, config: integrationsTable.config })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return;
  const config = (row.config as Record<string, unknown> | null) ?? {};
  const current = config.codexOAuth as CodexOAuthCredential | undefined;
  if (!current) return;
  await db
    .update(integrationsTable)
    .set({
      config: { ...config, codexOAuth: { ...current, reauthRequiredAt: new Date().toISOString() } },
      updatedAt: new Date(),
    })
    .where(eq(integrationsTable.id, row.id));
}

/** Test seam — the promise map is module state and would leak between cases. */
export function resetCodexOauthCache(): void {
  inflight.clear();
}
