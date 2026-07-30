import { useCallback, useEffect } from 'react';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { useGithubConnection } from './useGithubConnection';
import { useGithubInstallations } from './useGithubInstallations';
import { useOnReconnect } from './useOnReconnect';

/**
 * Preloads integration connection state into the workspace store at startup
 * (mount once from MainLayout) so anything that reads it — the global
 * SystemStatusBanner and Settings → Integrations — renders instantly instead
 * of fetching on open.
 *
 * GitHub reuses useGithubConnection's fetch + on-focus re-check, which also
 * catches OAuth completing in the external browser, so reconnecting clears the
 * banner without a manual refresh. PostHog Code credentials only change from
 * inside the app (the Settings card writes the new status straight to the
 * store), so a one-shot fetch per workspace is enough.
 *
 * Cloud-provider connection status is loaded here too (not per-component) so
 * the Settings cards, the default-provider selector, the sidebar status row,
 * and the per-task picker all read one store value — and it's re-checked on
 * window focus, on the env WS events, and after a reconnect, so connecting a
 * provider then leaving + returning to the tab never shows a stale state.
 */
export function useSystemStatus(): void {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setGitHubStatus = useWorkspaceStore((s) => s.setGitHubStatus);
  const setGitHubUser = useWorkspaceStore((s) => s.setGitHubUser);
  const setPostHogStatus = useWorkspaceStore((s) => s.setPostHogStatus);
  const setCloudProviders = useWorkspaceStore((s) => s.setCloudProviders);
  const { status, user } = useGithubConnection(currentWorkspaceId);
  // Load which orgs/accounts have the App installed (kept fresh on focus), so
  // the banner + Settings can flag watched repos whose owner lacks an install.
  useGithubInstallations(currentWorkspaceId, Boolean(status?.connected));

  useEffect(() => {
    setGitHubStatus(status);
  }, [status, setGitHubStatus]);

  useEffect(() => {
    setGitHubUser(user);
  }, [user, setGitHubUser]);

  useEffect(() => {
    if (!currentWorkspaceId) {
      setPostHogStatus(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.posthog.getStatus(currentWorkspaceId);
        if (!cancelled) setPostHogStatus(s);
      } catch {
        if (!cancelled) setPostHogStatus({ connected: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, setPostHogStatus]);

  const refreshCloudProviders = useCallback(() => {
    if (!currentWorkspaceId) {
      setCloudProviders(null);
      return;
    }
    api.cloudProviders
      .list(currentWorkspaceId)
      .then(setCloudProviders)
      // Leave the last-known list in place on a transient failure rather than
      // blanking it (which would flash "disconnected").
      .catch(() => {});
  }, [currentWorkspaceId, setCloudProviders]);

  // Initial load + whenever the workspace changes.
  useEffect(() => {
    setCloudProviders(null); // mark "checking" so cards don't flash "Not Connected"
    refreshCloudProviders();
  }, [refreshCloudProviders, setCloudProviders]);

  // Re-check on window focus (a key was added/rotated in another window), on the
  // env provisioning WS events, and after an outage.
  useEffect(() => {
    const onFocus = () => refreshCloudProviders();
    window.addEventListener('focus', onFocus);
    const offCreated = api.ws.on('environment:created', refreshCloudProviders);
    const offStatus = api.ws.on('environment:status', refreshCloudProviders);
    return () => {
      window.removeEventListener('focus', onFocus);
      offCreated();
      offStatus();
    };
  }, [refreshCloudProviders]);

  useOnReconnect(refreshCloudProviders);
}
