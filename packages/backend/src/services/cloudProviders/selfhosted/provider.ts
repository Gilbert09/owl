import { readCloudTaskMeta, type Environment, type Task } from '@talyn/shared';
import { FleetClient } from '../../selfHosted/client.js';
import {
  getSelfHostedCredentials,
  getSelfHostedClient,
  storeSelfHostedCredentials,
  removeSelfHostedCredentials,
} from '../../selfHosted/credentials.js';
import { dispatchTaskToFleet } from '../../selfHosted/executor.js';
import { selfHostedPoller } from '../../selfHosted/poller.js';
import type { CloudTaskProvider, CloudTaskRow, DispatchResult } from '../types.js';

interface SelfHostedCredInput {
  fleetEndpoint?: string;
  fleetToken?: string;
  anthropicApiKey?: string;
}

/**
 * Self-hosted provider — delegates to a Talyn-owned Firecracker fleet
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
  displayName: 'Self-hosted (Firecracker)',
  capabilities: { model: true },

  async validateCredentials(workspaceId, input) {
    const { fleetEndpoint, fleetToken, anthropicApiKey } = (input ?? {}) as SelfHostedCredInput;
    if (!fleetEndpoint || !fleetToken) {
      return { ok: false, error: 'fleetEndpoint and fleetToken are required' };
    }
    try {
      await new FleetClient(fleetEndpoint, fleetToken).ping();
    } catch (err) {
      return {
        ok: false,
        error: `Could not reach the fleet: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    await storeSelfHostedCredentials(workspaceId, { fleetEndpoint, fleetToken, anthropicApiKey });
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
    if (!client) throw new Error('The self-hosted fleet is not configured for this workspace.');
    await client.cancelRun(cloud.remoteTaskId);
  },
};
