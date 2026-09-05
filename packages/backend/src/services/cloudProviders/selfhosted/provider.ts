import { readCloudTaskMeta, type Environment, type Task } from '@talyn/shared';
import { FleetClient } from '../../selfHosted/client.js';
import { pickFleetHost } from '../../fleetHosts.js';
import {
  getSelfHostedCredentials,
  getSelfHostedClient,
  storeSelfHostedCredentials,
  removeSelfHostedCredentials,
  type CodexOAuthCredential,
  fleetApiToken,
  fleetGatewayToken,
  fleetPinnedEndpoint,
  FleetNotDeployedError,
} from '../../selfHosted/credentials.js';
import { codexCredentialFrom } from '../../selfHosted/codexOauth.js';
import { dispatchTaskToFleet } from '../../selfHosted/executor.js';
import { selfHostedPoller } from '../../selfHosted/poller.js';
import type { CloudTaskProvider, CloudTaskRow, DispatchResult } from '../types.js';

/**
 * What the settings card and the onboarding step send.
 *
 * Every field is optional and a request must carry at least one action, because
 * the card now has TWO independently connectable agents behind one provider:
 * saving Codex must not require re-pasting Claude, and disconnecting one must
 * not disconnect the other. `clearClaude`/`clearCodex` are the explicit
 * disconnects — an absent field means "leave it alone", which is a different
 * thing and cannot be spelled with the same key.
 */
interface SelfHostedCredInput {
  claudeToken?: string;
  /** A completed ChatGPT-subscription sign-in (desktop loopback flow, or pasted). */
  codexAccessToken?: string;
  codexRefreshToken?: string;
  /** Optional — read off the access token's claims when absent. */
  codexAccountId?: string;
  codexExpiresIn?: number;
  /** An OpenAI PLATFORM key (`sk-…`), for metered billing instead of a subscription. */
  openaiKey?: string;
  clearClaude?: boolean;
  clearCodex?: boolean;
}

/**
 * Talyn Fleet provider — delegates to a Talyn-owned Firecracker fleet
 * (Gilbert09/talyn-fleet). Each task runs in its own microVM on hardware we
 * own; the fleet clones the repo, runs the agent, and opens the PR, with the
 * GitHub token injected host-side so it never enters the VM.
 *
 * It is the third implementation of this seam, which is what
 * docs/CLOUD_PROVIDERS.md named as the threshold for generalising transcript
 * ingestion. That refactor is deliberately NOT done here — it touches working
 * PostHog and Claude code paths, and a little duplication is much cheaper than
 * a broken transcript for existing customers.
 */
export const selfHostedProvider: CloudTaskProvider = {
  type: 'selfhosted',
  displayName: 'Talyn Fleet',
  capabilities: { model: true },

  async validateCredentials(workspaceId, input) {
    const body = (input ?? {}) as SelfHostedCredInput;
    const { claudeToken, codexAccessToken, openaiKey, clearClaude, clearCodex } = body;

    const acting =
      claudeToken || codexAccessToken || openaiKey || clearClaude || clearCodex;
    if (!acting) {
      return { ok: false, error: 'Connect a Claude or Codex subscription, or disconnect one.' };
    }

    // Shapes are checked HERE rather than left to the fleet, because the fleet
    // only finds out when the agent's first request 401s — twenty minutes into
    // a run, as a task failure with nothing in it naming the cause. A pasted
    // GitHub PAT or a truncated copy is caught in the form instead, where the
    // fix is obvious.
    if (claudeToken && !/^sk-ant-\S+$/.test(claudeToken)) {
      return {
        ok: false,
        error:
          'That does not look like a Claude credential. Expected an OAuth token ' +
          '(sk-ant-oat…) from a Claude subscription, or a Console API key (sk-ant-api…).',
      };
    }

    // A Codex sign-in needs BOTH tokens. The access token alone works for an
    // hour and then strands the workspace with no way to renew it, which
    // surfaces as runs that worked this morning and do not this afternoon.
    let codex: CodexOAuthCredential | undefined;
    if (codexAccessToken) {
      if (!body.codexRefreshToken) {
        return {
          ok: false,
          error:
            'That sign-in carried no refresh token, so it would stop working within the hour. ' +
            'Sign in again and include the refresh token.',
        };
      }
      try {
        codex = codexCredentialFrom({
          accessToken: codexAccessToken,
          refreshToken: body.codexRefreshToken,
          accountId: body.codexAccountId,
          expiresIn: body.codexExpiresIn,
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (openaiKey && !/^sk-\S+$/.test(openaiKey)) {
      return {
        ok: false,
        error: 'That does not look like an OpenAI platform key. Expected sk-….',
      };
    }

    // Ping WHAT DISPATCH WOULD ACTUALLY USE — the same endpoint and the same
    // bearer. Storing a credential nobody has tried is how a bad setup surfaces
    // hours later, on somebody else's task, as a dispatch failure rather than a
    // form error.
    //
    // "The same bearer" is the part that was wrong and could not be caught. The
    // gateway and a fleet host are different trust domains with different
    // credentials (see fleetGatewayToken), and this pinged the gateway holding
    // FLEET_API_TOKEN — which the gateway does not know. It passed anyway,
    // because /healthz is the one gateway route that takes no credential at all,
    // so the check exercised the URL and never the key. A gateway-only
    // deployment also failed here outright, on a variable it has no reason to
    // set. Resolving the target the way dispatch does fixes both.
    const gateway = fleetPinnedEndpoint();
    const bearer = gateway ? fleetGatewayToken() : fleetApiToken();
    if (!bearer) return { ok: false, error: new FleetNotDeployedError().message };

    const host = gateway ? null : await pickFleetHost();
    const endpoint = gateway || host?.apiEndpoint;
    if (!endpoint) {
      return {
        ok: false,
        error:
          'No fleet host is currently dispatchable. Start a host and let it report in ' +
          '(it registers itself within ~15s), or set FLEET_PINNED_ENDPOINT on the backend.',
      };
    }
    try {
      const client = new FleetClient(endpoint, bearer);
      // Against the GATEWAY, list the tenant's sandboxes rather than ping: it
      // is the cheapest route that actually presents the key, and a bad key is
      // exactly what this form has to catch. /healthz would answer 200 for a
      // credential the gateway has never seen or has revoked.
      //
      // Against a HOST, ping stays: every route there is authenticated, and
      // /healthz already proves the bearer.
      if (gateway) await client.listGatewaySandboxes();
      else await client.ping();
    } catch (err) {
      const where = host?.name ?? endpoint;
      return {
        ok: false,
        error: `Could not reach ${where}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // `null` clears, `undefined` leaves alone — see SelfHostedCredentialPatch.
    // Connecting Codex as a subscription clears any platform key beside it and
    // vice versa: a leftover credential the user believes they replaced is one
    // the dispatch path could silently fall back to.
    await storeSelfHostedCredentials(workspaceId, {
      ...(clearClaude ? { claudeToken: null } : claudeToken ? { claudeToken } : {}),
      ...(clearCodex
        ? { codex: null, openaiKey: null }
        : codex
          ? { codex, openaiKey: null }
          : openaiKey
            ? { openaiKey, codex: null }
            : {}),
    });
    return { ok: true };
  },

  async hasCredentials(workspaceId) {
    return Boolean(await getSelfHostedCredentials(workspaceId));
  },

  async testConnection(workspaceId) {
    const client = await getSelfHostedClient(workspaceId);
    if (!client) return { connected: false, error: 'Not configured' };
    try {
      await client.ping();
      return { connected: true };
    } catch (err) {
      return { connected: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async removeCredentials(workspaceId) {
    await removeSelfHostedCredentials(workspaceId);
  },

  dispatch(task: Task, env: Environment): Promise<DispatchResult> {
    return dispatchTaskToFleet(task, env);
  },

  reconcile(taskRow: CloudTaskRow): Promise<void> {
    return selfHostedPoller.reconcileTask(taskRow);
  },

  stopStreaming(taskId: string): void {
    selfHostedPoller.stopStreaming(taskId);
  },

  async cancel(task: Task): Promise<void> {
    const cloud = readCloudTaskMeta(task);
    if (!cloud?.remoteTaskId) return; // never dispatched — nothing to cancel.
    const client = await getSelfHostedClient(task.workspaceId);
    if (!client) throw new Error('Talyn Fleet is not configured for this workspace.');
    await client.cancelSandbox(cloud.remoteTaskId);
  },
};
