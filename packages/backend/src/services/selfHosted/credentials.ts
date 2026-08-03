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
import { FleetCapacityError, FleetClient } from './client.js';
import { pickFleetHost } from '../fleetHosts.js';

const INTEGRATION_TYPE = 'selfhosted';

interface SelfHostedIntegrationConfig {
  fleetEndpoint?: string;
  fleetTokenEnc?: EncryptedEnvelope;
  /** Optional BYO LLM key. Absent means the fleet uses its own resold key. */
  anthropicKeyEnc?: EncryptedEnvelope;
}

export interface SelfHostedCredentials {
  /** Optional: blank means "use whichever registered host is least loaded".
   *  Set it to pin this workspace to one box. */
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
  // The TOKEN is what makes a workspace configured; the endpoint is optional
  // and blank means "resolve through the host registry" (resolveFleetTarget).
  // Requiring it here would make a registry-routed workspace look unconfigured,
  // which reads as "you never set this up" rather than "your hosts are down".
  if (!fleetToken) return null;

  return {
    fleetEndpoint: config.fleetEndpoint ?? '',
    fleetToken,
    anthropicApiKey: readEnc(config.anthropicKeyEnc, 'Anthropic key') ?? undefined,
  };
}

/** Build a client for a workspace, or null if it isn't configured. */
export async function getSelfHostedClient(workspaceId: string): Promise<FleetClient | null> {
  const target = await resolveFleetTarget(workspaceId);
  return target ? new FleetClient(target.endpoint, target.token) : null;
}

/** Where a workspace's fleet runs, and how to authenticate to it. */
export interface FleetTarget {
  endpoint: string;
  token: string;
  /** The registered host this resolved to, when it came from the registry.
   *  Absent when the workspace pinned an endpoint itself. */
  host?: string;
}

/**
 * Resolve which fleet host this workspace's next run should go to.
 *
 * The credential says WHETHER a workspace may use the fleet; the registry says
 * WHERE. Splitting them is what makes more than one host possible: a token
 * stored per workspace does not know which box is least loaded, or which is
 * draining, or which has stopped reporting.
 *
 * Order:
 *   1. An endpoint the workspace pinned itself. Explicit beats inferred, and
 *      pinning one host is how you debug a specific box without draining the
 *      others.
 *   2. The least-loaded dispatchable host in the registry.
 *
 * Returns null when the workspace has no credential at all — the fleet is not
 * configured for it, which is different from "configured and nothing is up".
 * That distinction is why the second case throws rather than returning null:
 * "you have not set this up" and "your hardware is down" need different
 * answers, and collapsing them into one silent null gives neither.
 */
export async function resolveFleetTarget(workspaceId: string): Promise<FleetTarget | null> {
  const creds = await getSelfHostedCredentials(workspaceId);
  if (!creds) return null;

  if (creds.fleetEndpoint) {
    return { endpoint: creds.fleetEndpoint, token: creds.fleetToken };
  }

  const host = await pickFleetHost();
  if (!host?.apiEndpoint) {
    // A capacity error, not a terminal one: no host is dispatchable right now,
    // which is exactly the condition fail-back exists for (§11.6). Failing the
    // user's task because every box is busy or offline would be the wrong
    // shape — another provider can still run it.
    throw new FleetCapacityError(
      'no self-hosted fleet host is currently dispatchable ' +
        '(none registered, all draining, all at capacity, or none advertising an endpoint)',
    );
  }
  return { endpoint: host.apiEndpoint, token: creds.fleetToken, host: host.name };
}

/** Upsert a workspace's fleet credentials (secrets encrypted at rest). */
export async function storeSelfHostedCredentials(
  workspaceId: string,
  input: { fleetEndpoint?: string; fleetToken: string; anthropicApiKey?: string },
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
    // Trailing slashes off, and blank stays blank — an empty endpoint is the
    // signal to resolve through the registry, not a malformed one.
    fleetEndpoint: (input.fleetEndpoint ?? '').replace(/\/+$/, ''),
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
