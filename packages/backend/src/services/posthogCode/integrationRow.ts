import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { integrations as integrationsTable } from '../../db/schema.js';
import type { EncryptedEnvelope } from '../tokenCrypto.js';

/**
 * The `posthog` integration row — read and upsert, shared by the two auth
 * paths so neither can drift from the other's storage shape.
 *
 * Kept separate from `credentials.ts` purely to keep the module graph a DAG:
 * `credentials` resolves a bearer token (which for OAuth means asking `oauth.ts`
 * to refresh), and `oauth.ts` persists what it gets back. Both need the row;
 * neither should need the other.
 */

export const POSTHOG_INTEGRATION_TYPE = 'posthog';
export const DEFAULT_POSTHOG_HOST = 'https://us.posthog.com';

/** How a workspace authenticates to PostHog. */
export type PostHogAuthMethod = 'personal_api_key' | 'oauth';

export interface PostHogOAuthTokens {
  accessTokenEnc: EncryptedEnvelope;
  /** Rotated on every refresh — PostHog sets `ROTATE_REFRESH_TOKEN`. */
  refreshTokenEnc: EncryptedEnvelope;
  /** ISO expiry of the access token (PostHog issues 1-hour tokens). */
  expiresAt: string;
  /** The granted scope string, for display and for spotting a downgrade. */
  scope?: string;
  /** The CIMD client_id the grant was issued to. A deployment that changes its
   *  client identity invalidates its grants, and this is how we notice. */
  clientId: string;
  /** Set when the refresh token was rejected outright (revoked by the user,
   *  caught by secret scanning, or reuse-protection revoking the family).
   *  Reconnecting is the only way out, so the flag drives the UI rather than
   *  the code retrying a grant that can never succeed. */
  reauthRequiredAt?: string;
  /** Why the connection needs re-consent, verbatim from the token endpoint. */
  reauthReason?: string;
}

/**
 * Persisted shape of the `posthog` integration row's `config`.
 *
 * `authMethod` is absent on every row written before OAuth existed, and absent
 * MUST mean `personal_api_key` — that is what keeps existing installs working
 * untouched (see `readAuthMethod`).
 */
export interface PostHogIntegrationConfig {
  /** Personal API key, encrypted (the legacy path, still fully supported). */
  apiKeyEnc?: EncryptedEnvelope;
  /** Legacy plaintext field — migrated + nulled at boot
   *  (services/credentialMigration.ts), never read/written. */
  apiKey?: string;
  projectId?: string;
  host?: string;
  authMethod?: PostHogAuthMethod;
  oauth?: PostHogOAuthTokens;
}

export interface PostHogIntegrationRow {
  id: string;
  enabled: boolean;
  config: PostHogIntegrationConfig;
}

/**
 * A row's auth method. Anything that isn't an explicit `oauth` is the personal
 * API key path, so a config written by an older build (no `authMethod` at all)
 * resolves exactly as it did before this feature existed.
 */
export function readAuthMethod(config: PostHogIntegrationConfig): PostHogAuthMethod {
  return config.authMethod === 'oauth' ? 'oauth' : 'personal_api_key';
}

export function normalizeHost(host?: string | null): string {
  return host?.trim().replace(/\/+$/, '') || DEFAULT_POSTHOG_HOST;
}

export async function readPostHogIntegration(
  workspaceId: string
): Promise<PostHogIntegrationRow | null> {
  const db = getDbClient();
  const rows = await db
    .select({
      id: integrationsTable.id,
      enabled: integrationsTable.enabled,
      config: integrationsTable.config,
    })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, POSTHOG_INTEGRATION_TYPE)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    enabled: row.enabled,
    config: (row.config as PostHogIntegrationConfig | null) ?? {},
  };
}

/**
 * Read-modify-write the integration config.
 *
 * `mutate` receives the current config (`{}` when there is no row yet) and
 * returns the whole next config — the row is replaced, not merged, so a caller
 * switching auth methods can drop the other method's fields deliberately rather
 * than leaving a half-populated row behind.
 */
export async function upsertPostHogIntegration(
  workspaceId: string,
  mutate: (current: PostHogIntegrationConfig) => PostHogIntegrationConfig
): Promise<void> {
  const db = getDbClient();
  const existing = await readPostHogIntegration(workspaceId);
  const config = mutate(existing?.config ?? {});
  const now = new Date();

  if (existing) {
    await db
      .update(integrationsTable)
      .set({ config, enabled: true, updatedAt: now })
      .where(eq(integrationsTable.id, existing.id));
    return;
  }
  await db.insert(integrationsTable).values({
    id: uuid(),
    workspaceId,
    type: POSTHOG_INTEGRATION_TYPE,
    enabled: true,
    config,
    createdAt: now,
    updatedAt: now,
  });
}

export async function deletePostHogIntegration(workspaceId: string): Promise<void> {
  const db = getDbClient();
  await db
    .delete(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, POSTHOG_INTEGRATION_TYPE)
      )
    );
}
