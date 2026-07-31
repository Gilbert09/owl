import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { integrations as integrationsTable } from '../../db/schema.js';
import {
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  type EncryptedEnvelope,
} from '../tokenCrypto.js';
import { FleetClient } from './client.js';

const INTEGRATION_TYPE = 'selfhosted';

interface SelfHostedIntegrationConfig {
  fleetEndpoint?: string;
  fleetTokenEnc?: EncryptedEnvelope;
  /** Optional BYO LLM key. Absent means the fleet uses its own resold key. */
  anthropicKeyEnc?: EncryptedEnvelope;
}

export interface SelfHostedCredentials {
  fleetEndpoint: string;
  fleetToken: string;
  anthropicApiKey?: string;
}

function readEnc(env: EncryptedEnvelope | undefined, label: string): string | null {
  if (env && isEncryptedEnvelope(env)) {
    try {
      return decryptString(env);
    } catch (err) {
      console.error(`[selfhosted] failed to decrypt ${label}:`, err);
      return null;
    }
  }
  return null;
}

/** Resolve a workspace's fleet credentials, or null if unset. */
export async function getSelfHostedCredentials(
  workspaceId: string,
): Promise<SelfHostedCredentials | null> {
  const db = getDbClient();
  const rows = await db
    .select({ config: integrationsTable.config, enabled: integrationsTable.enabled })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.enabled) return null;

  const config = (row.config as SelfHostedIntegrationConfig | null) ?? {};
  const fleetToken = readEnc(config.fleetTokenEnc, 'fleet API token');
  if (!config.fleetEndpoint || !fleetToken) return null;

  return {
    fleetEndpoint: config.fleetEndpoint,
    fleetToken,
    anthropicApiKey: readEnc(config.anthropicKeyEnc, 'Anthropic key') ?? undefined,
  };
}

/** Build a client for a workspace, or null if it isn't configured. */
export async function getSelfHostedClient(workspaceId: string): Promise<FleetClient | null> {
  const creds = await getSelfHostedCredentials(workspaceId);
  if (!creds) return null;
  return new FleetClient(creds.fleetEndpoint, creds.fleetToken);
}

/** Upsert a workspace's fleet credentials (secrets encrypted at rest). */
export async function storeSelfHostedCredentials(
  workspaceId: string,
  input: { fleetEndpoint: string; fleetToken: string; anthropicApiKey?: string },
): Promise<void> {
  const db = getDbClient();
  const existing = await db
    .select({ id: integrationsTable.id })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);

  const config: SelfHostedIntegrationConfig = {
    fleetEndpoint: input.fleetEndpoint.replace(/\/+$/, ''),
    fleetTokenEnc: encryptString(input.fleetToken),
    ...(input.anthropicApiKey ? { anthropicKeyEnc: encryptString(input.anthropicApiKey) } : {}),
  };

  const now = new Date();
  if (existing[0]) {
    await db
      .update(integrationsTable)
      .set({ config, enabled: true, updatedAt: now })
      .where(eq(integrationsTable.id, existing[0].id));
  } else {
    await db.insert(integrationsTable).values({
      id: uuid(),
      workspaceId,
      type: INTEGRATION_TYPE,
      enabled: true,
      config,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** Remove a workspace's fleet credentials. */
export async function removeSelfHostedCredentials(workspaceId: string): Promise<void> {
  const db = getDbClient();
  await db
    .delete(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    );
}
