import { readCloudTaskMeta, type Environment, type Task } from '@talyn/shared';
import { FleetClient } from '../../selfHosted/client.js';
import { pickFleetHost } from '../../fleetHosts.js';
import {
  getSelfHostedCredentials,
  getSelfHostedClient,
  storeSelfHostedCredentials,
  removeSelfHostedCredentials,
  fleetApiToken,
  FleetNotDeployedError,
} from '../../selfHosted/credentials.js';
import { dispatchTaskToFleet } from '../../selfHosted/executor.js';
import { selfHostedPoller } from '../../selfHosted/poller.js';
import type { CloudTaskProvider, CloudTaskRow, DispatchResult } from '../types.js';

interface SelfHostedCredInput {
  fleetEndpoint?: string;
  claudeToken?: string;
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
    const { fleetEndpoint, claudeToken } = (input ?? {}) as SelfHostedCredInput;
    if (!claudeToken) {
      return { ok: false, error: 'A Claude OAuth token is required.' };
    }
    // Checked here rather than left to the fleet, because the fleet only finds
    // out when the agent's first request 401s — twenty minutes into a run, as a
    // task failure. A pasted GitHub PAT or a truncated copy is caught in the
    // form instead, where the fix is obvious.
    if (!/^sk-ant-\S+$/.test(claudeToken)) {
      return {
        ok: false,
        error:
          'That does not look like a Claude credential. Expected an OAuth token ' +
          '(sk-ant-oat…) from a Claude subscription, or a Console API key (sk-ant-api…).',
      };
    }

    // The fleet API bearer is deployment config, not something the workspace
    // supplies — see fleetApiToken(). Without it there is nothing to ping with,
    // and storing a Claude token against a fleet the backend cannot talk to
    // would just defer the failure to dispatch.
    const bearer = fleetApiToken();
    if (!bearer) return { ok: false, error: new FleetNotDeployedError().message };

    // The endpoint is optional: blank means "whichever registered host is
    // least loaded" (see resolveFleetTarget). Pinning one is for debugging a
    // specific box, and it is the only case where there is an address to
    // verify before storing anything.
    if (fleetEndpoint) {
      try {
        await new FleetClient(fleetEndpoint, bearer).ping();
      } catch (err) {
        return {
          ok: false,
          error: `Could not reach the fleet: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      // Verify against whatever the registry would actually pick, rather than
      // storing a token nobody has checked. A credential accepted without ever
      // being tried is one that fails at dispatch, hours later, on somebody
      // else's task.
      const host = await pickFleetHost();
      if (!host?.apiEndpoint) {
        return {
          ok: false,
          error:
            'No fleet host is currently dispatchable. Either start a host and let it report in, ' +
            'or set an explicit Fleet API URL to pin this workspace to one.',
        };
      }
      try {
        await new FleetClient(host.apiEndpoint, bearer).ping();
      } catch (err) {
        return {
          ok: false,
          error: `Could not reach ${host.name}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    await storeSelfHostedCredentials(workspaceId, { fleetEndpoint, claudeToken });
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
    await client.cancelRun(cloud.remoteTaskId);
  },
};
