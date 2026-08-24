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
  /** The workspace's own Claude credential — an OAuth token from a Claude
   *  subscription, or a Console API key. This is the ONE secret a user supplies,
   *  and the only key this config carries. */
  anthropicKeyEnc?: EncryptedEnvelope;
  /**
   * The workspace's OpenAI credential, for runs dispatched at an OpenAI model.
   *
   * Absent on every workspace today: no OpenAI model is in FLEET_MODELS yet, so
   * nothing can select one, and there is no settings field to put a key in. It
   * is carried here so the dispatch and credential-pull paths are complete when
   * the first one lands — see docs in talyn-fleet's HARNESS_PLAN.
   */
  openaiKeyEnc?: EncryptedEnvelope;

  // Legacy, read nowhere. Both were fields on the settings card and neither was
  // ever the workspace's to give: `fleetTokenEnc` authenticated the BACKEND to a
  // host, and `fleetEndpoint` chose WHICH host, which is the registry's job.
  // They live in deployment config now (FLEET_API_TOKEN / FLEET_PINNED_ENDPOINT)
  // and stay in the type so an old row is recognisably old rather than
  // mysteriously shaped.
  fleetTokenEnc?: EncryptedEnvelope;
  fleetEndpoint?: string;
}

export interface SelfHostedCredentials {
  /** `sk-ant-oat…` (OAuth) or `sk-ant-api…` (Console key) — the fleet's
   *  credential proxy accepts either and picks the right auth header. */
  claudeToken: string;
  /** Set only once a workspace can select an OpenAI model. See the config
   *  field's note. */
  openaiKey?: string;
}

/**
 * The bearer the backend presents to a fleet host's API.
 *
 * Deployment config, not a workspace secret. It authenticates ONE service to
 * another — every host in a deployment shares it, and no user of the product
 * has any reason to know it exists, let alone to paste it into a settings form.
 * Putting it in the UI made the workspace responsible for a credential it does
 * not own and cannot rotate.
 *
 * Set it on the backend and on every host's `/etc/fleet/secrets.env`
 * (`FLEET_API_TOKEN`); the two must match or dispatch 401s.
 */
export function fleetApiToken(): string {
  return process.env.FLEET_API_TOKEN ?? '';
}

/**
 * The bearer the backend presents to the SANDBOX GATEWAY, when one is pinned.
 *
 * A gateway and a fleet host are different trust domains and issue different
 * credentials. `FLEET_API_TOKEN` is a deployment-wide operator secret shared
 * with every host's `/etc/fleet/secrets.env`; a gateway key is a per-tenant API
 * key the gateway minted and can revoke on its own. Sending either one to the
 * other simply 401s.
 *
 * They cannot be the same variable because BOTH destinations are still in use:
 * dispatch goes to the gateway, while the operator console keeps talking to
 * hosts directly — deliberately, since draining a specific box and reading its
 * goldens are host operations that no gateway route covers. Reusing
 * FLEET_API_TOKEN for the pin therefore fixes dispatch and blanks the console.
 *
 * Falls back to `fleetApiToken()`, so a deployment that has not been given a
 * gateway key behaves exactly as it did before this existed.
 */
export function fleetGatewayToken(): string {
  return process.env.FLEET_GATEWAY_TOKEN?.trim() || fleetApiToken();
}

/**
 * The ONE endpoint dispatch addresses: the sandbox gateway. Blank falls back to
 * dialling a host out of the registry.
 *
 * # This is the normal path now, not an override
 *
 * The variable is called `FLEET_PINNED_ENDPOINT` because it began as a
 * debugging pin — force every run onto one box while you bisect it — and the
 * name is deployed, so renaming it would be a coordinated restart of the
 * backend to change a string. What it points at changed on 2026-08-24: it is
 * the control plane, which does the placing itself.
 *
 * That inverts the old warning rather than repeating it. Pinned at a HOST this
 * really was dangerous — one box, chosen once, no idea whether it is draining
 * or offline, and a stale value silently routed every task to a machine that
 * had been down for a week. Pinned at the GATEWAY it is the opposite: the
 * gateway reads the same reports the registry does, places per create, retries
 * a 503 on the next candidate, and — the part no client-side registry can do —
 * refuses to offer an AGENTIC id to a second host when an answer is lost. A
 * duplicated sandbox is idle capacity; a duplicated agent is a second LLM bill
 * for the same work, and only the party holding the index can prevent it.
 *
 * The registry fallback stays, and is not dead code: it is what a deployment
 * with no control plane uses, and it is the path every run took before this.
 * It is also still the operator console's path — see fleetGatewayToken.
 */
export function fleetPinnedEndpoint(): string {
  return (process.env.FLEET_PINNED_ENDPOINT ?? '').replace(/\/+$/, '');
}

/** Thrown when the deployment itself is misconfigured — not a per-workspace fault. */
export class FleetNotDeployedError extends Error {
  constructor() {
    super(
      'Neither FLEET_GATEWAY_TOKEN nor FLEET_API_TOKEN is set on the backend, so it cannot ' +
        'authenticate to the sandbox gateway or to any fleet host. ' +
        'This is deployment configuration, not a workspace setting.',
    );
    this.name = 'FleetNotDeployedError';
  }
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
  // The CLAUDE TOKEN is what makes a workspace configured, and it is now the
  // only thing this config holds. Nothing else could play that role: the fleet
  // bearer is identical for every workspace so it distinguishes nothing, and
  // the endpoint answers "which host", which the registry answers better.
  //
  // A row written before this change carries `fleetTokenEnc`/`fleetEndpoint`
  // and no Claude token; it reads as unconfigured, which is accurate — the user
  // still has to supply the one secret that is now actually theirs.
  const claudeToken = readEnc(config.anthropicKeyEnc, 'Claude token');
  if (!claudeToken) return null;

  // The Claude token still gates "is this workspace configured": every fleet
  // model is Anthropic's, so a workspace with only an OpenAI key could not
  // dispatch anything. That gate moves when the first OpenAI model lands.
  const openaiKey = readEnc(config.openaiKeyEnc, 'OpenAI key');

  return { claudeToken, ...(openaiKey ? { openaiKey } : {}) };
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
  /**
   * The host this resolved to, when the REGISTRY chose it.
   *
   * Absent for the gateway, which has not placed anything yet at the moment this
   * is called. Nothing may treat that absence as "unknown forever": the create
   * answers with the name (FleetClient.createSandbox), and the dispatch records
   * it, because `resolveRunCredentials` refuses a credential pull for a run with
   * no host on it.
   */
  host?: string;
}

/**
 * Resolve where this workspace's next run goes, and how to authenticate to it.
 *
 * The credential says WHETHER a workspace may use the fleet; something else
 * says WHERE. Splitting them is what makes more than one host possible: a
 * workspace does not know which box is least loaded, or which is draining, or
 * which has stopped reporting, so it was never in a position to choose one.
 *
 * Order:
 *   1. The GATEWAY (`FLEET_PINNED_ENDPOINT`), when one is configured. The
 *      normal path: it does the placing, so this returns no `host` and the
 *      caller learns which box took the work from the create's own answer —
 *      see FleetTarget.host and FleetClient.createSandbox.
 *   2. The least-loaded dispatchable host in the local registry. The path a
 *      deployment with no control plane takes, and the one every run took
 *      before the gateway.
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

  // Deliberately thrown, not returned as null: a missing deployment token is
  // an operator error and every workspace hits it identically. Reporting it as
  // "not configured" would send the user back to a settings form they have
  // already filled in correctly.
  // The gateway is resolved BEFORE the host token, because it is authenticated
  // by a different credential — see fleetGatewayToken. Reading FLEET_API_TOKEN
  // first would make a gateway-only deployment fail on a variable it has no
  // reason to set.
  const gateway = fleetPinnedEndpoint();
  if (gateway) {
    const gatewayToken = fleetGatewayToken();
    if (!gatewayToken) throw new FleetNotDeployedError();
    // No `host`, and that is the honest answer rather than a gap: placement has
    // not happened yet. The create's response names the box that took it.
    return { endpoint: gateway, token: gatewayToken };
  }

  const token = fleetApiToken();
  if (!token) throw new FleetNotDeployedError();

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
  return { endpoint: host.apiEndpoint, token, host: host.name };
}

/** Upsert a workspace's fleet credentials (secrets encrypted at rest). */
export async function storeSelfHostedCredentials(
  workspaceId: string,
  input: { claudeToken: string },
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

  // Written whole, not merged into what was there. A workspace configured
  // before the fleet bearer and endpoint left the card still has them on disk;
  // carrying them forward would keep a dead per-workspace endpoint alive as a
  // silent routing override long after the field that set it was removed.
  const config: SelfHostedIntegrationConfig = {
    anthropicKeyEnc: encryptString(input.claudeToken),
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
