import { decryptString, encryptString, isEncryptedEnvelope } from '../tokenCrypto.js';
import { PostHogCodeClient, type PostHogTokenSource } from './client.js';
import {
  DEFAULT_POSTHOG_HOST,
  deletePostHogIntegration,
  normalizeHost,
  readAuthMethod,
  readPostHogIntegration,
  upsertPostHogIntegration,
  type PostHogAuthMethod,
  type PostHogIntegrationConfig,
} from './integrationRow.js';
import { ensureFreshAccessToken, PostHogReauthRequiredError } from './oauth.js';

/**
 * Resolving a workspace's PostHog Code credentials — across BOTH auth methods.
 *
 * Two paths, one shape. A personal API key is a fixed string; an OAuth grant is
 * a rotating pair that has to be refreshed. Callers get a `getToken()` either
 * way and never have to care which they're on, which is what keeps the executor,
 * poller, streamer and provider free of auth branching.
 *
 * A row with no `authMethod` is a personal-API-key row — that is every install
 * that existed before OAuth, and it keeps working with no migration and no
 * prompt to switch.
 */

export type { PostHogAuthMethod };

export interface PostHogCodeCredentials {
  projectId: string;
  host: string;
  authMethod: PostHogAuthMethod;
  /** OAuth only: the grant is gone and the user must reconnect. Reads still
   *  resolve (so the UI can explain itself) but `getToken()` will throw. */
  reauthRequired: boolean;
  /** Resolve a bearer token for one request. Refreshes an expiring OAuth token;
   *  a no-op read for a personal API key. */
  getToken: PostHogTokenSource;
}

function readApiKey(config: PostHogIntegrationConfig): string | null {
  if (config.apiKeyEnc && isEncryptedEnvelope(config.apiKeyEnc)) {
    try {
      return decryptString(config.apiKeyEnc);
    } catch (err) {
      console.error('[posthogCode] failed to decrypt API key:', err);
      return null;
    }
  }
  // No plaintext fallback: legacy `config.apiKey` rows are re-encrypted by
  // the boot sweep (services/credentialMigration.ts).
  return null;
}

/** Resolve a workspace's PostHog Code credentials, or null if unset. */
export async function getPostHogCodeCredentials(
  workspaceId: string
): Promise<PostHogCodeCredentials | null> {
  const row = await readPostHogIntegration(workspaceId);
  if (!row || !row.enabled) return null;

  const config = row.config;
  if (!config.projectId) return null;
  const host = normalizeHost(config.host);
  const authMethod = readAuthMethod(config);

  if (authMethod === 'oauth') {
    const oauth = config.oauth;
    if (!oauth || !isEncryptedEnvelope(oauth.accessTokenEnc)) return null;
    return {
      projectId: config.projectId,
      host,
      authMethod,
      reauthRequired: Boolean(oauth.reauthRequiredAt),
      getToken: (opts) => ensureFreshAccessToken(workspaceId, { force: opts?.forceRefresh }),
    };
  }

  const apiKey = readApiKey(config);
  if (!apiKey) return null;
  return {
    projectId: config.projectId,
    host,
    authMethod,
    reauthRequired: false,
    getToken: async () => apiKey,
  };
}

/** Build a client for a workspace, or null if it isn't configured. */
export async function getPostHogCodeClient(
  workspaceId: string
): Promise<PostHogCodeClient | null> {
  const creds = await getPostHogCodeCredentials(workspaceId);
  if (!creds) return null;
  return new PostHogCodeClient(creds.getToken, creds.projectId, creds.host);
}

/**
 * Upsert a workspace's personal API key credentials (key encrypted).
 *
 * Switching to a key from an OAuth grant drops the stored tokens: the two are
 * alternatives, and a leftover refresh token would be a live credential nobody
 * believes is there any more. (We can't revoke it at PostHog on the user's
 * behalf here — `DELETE /config` and PostHog's own Connected Apps screen are the
 * paths for that.)
 */
export async function storePostHogCodeCredentials(
  workspaceId: string,
  input: { apiKey: string; projectId: string; host?: string }
): Promise<void> {
  await upsertPostHogIntegration(workspaceId, () => ({
    apiKeyEnc: encryptString(input.apiKey),
    projectId: input.projectId,
    host: input.host?.replace(/\/+$/, '') || DEFAULT_POSTHOG_HOST,
    authMethod: 'personal_api_key',
  }));
}

/** Remove a workspace's PostHog Code credentials. */
export async function removePostHogCodeCredentials(workspaceId: string): Promise<void> {
  await deletePostHogIntegration(workspaceId);
}

export { PostHogReauthRequiredError };
