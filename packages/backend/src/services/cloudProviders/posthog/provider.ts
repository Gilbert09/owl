import { readCloudTaskMeta, type Environment, type Task } from '@talyn/shared';
import { PostHogCodeClient } from '../../posthogCode/client.js';
import {
  getPostHogCodeClient,
  getPostHogCodeCredentials,
  storePostHogCodeCredentials,
  removePostHogCodeCredentials,
} from '../../posthogCode/credentials.js';
import { dispatchTaskToPostHogCode } from '../../posthogCode/executor.js';
import { postHogCodePoller } from '../../posthogCode/poller.js';
import { postHogCodeStreamer } from '../../posthogCode/streamer.js';
import type { CloudTaskProvider, CloudTaskRow, DispatchResult } from '../types.js';

const DEFAULT_HOST = 'https://us.posthog.com';

interface PostHogCredInput {
  apiKey?: string;
  projectId?: string;
  host?: string;
}

/**
 * PostHog Code provider — wraps the existing posthogCode/* executor,
 * poller, and streamer behind the CloudTaskProvider interface. This is the
 * seam the task queue, generic poller, and generic credential routes drive
 * through; the heavy lifting still lives in the proven posthogCode modules.
 */
export const postHogCodeProvider: CloudTaskProvider = {
  type: 'posthog_code',
  displayName: 'PostHog Code',
  capabilities: { model: true, runtimeAdapter: true },

  async validateCredentials(workspaceId, input) {
    const { apiKey, projectId, host } = (input ?? {}) as PostHogCredInput;
    if (!apiKey || !projectId) {
      return { ok: false, error: 'apiKey and projectId are required' };
    }
    const resolvedHost = host?.replace(/\/+$/, '') || DEFAULT_HOST;
    try {
      await new PostHogCodeClient(apiKey, projectId, resolvedHost).ping();
    } catch (err) {
      return {
        ok: false,
        error: `Could not authenticate with PostHog: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    await storePostHogCodeCredentials(workspaceId, {
      apiKey,
      projectId,
      host: resolvedHost,
    });
    return { ok: true };
  },

  async hasCredentials(workspaceId) {
    return Boolean(await getPostHogCodeCredentials(workspaceId));
  },

  async testConnection(workspaceId) {
    const client = await getPostHogCodeClient(workspaceId);
    if (!client) return { connected: false, error: 'Not configured' };
    try {
      await client.ping();
      return { connected: true };
    } catch (err) {
      return { connected: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async removeCredentials(workspaceId) {
    await removePostHogCodeCredentials(workspaceId);
  },

  dispatch(task: Task, env: Environment): Promise<DispatchResult> {
    return dispatchTaskToPostHogCode(task, env);
  },

  reconcile(taskRow: CloudTaskRow): Promise<void> {
    return postHogCodePoller.reconcileTask(taskRow);
  },

  stopStreaming(taskId: string): void {
    postHogCodeStreamer.stop(taskId);
  },

  async cancel(task: Task): Promise<void> {
    const cloud = readCloudTaskMeta(task);
    // No remote run was ever started — nothing to cancel.
    if (!cloud?.remoteTaskId || !cloud.remoteRunId) return;
    const client = await getPostHogCodeClient(task.workspaceId);
    if (!client) {
      throw new Error('PostHog Code is not configured for this workspace.');
    }
    await client.cancelRun(cloud.remoteTaskId, cloud.remoteRunId);
  },
};
