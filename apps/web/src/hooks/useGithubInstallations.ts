import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * Loads the GitHub App installations the connected user can access into the
 * workspace store, and keeps them fresh on window focus — so an install the user
 * just completed in the external browser is reflected without a manual refresh.
 *
 * Backed by the store (single source of truth) so the global SystemStatusBanner,
 * Settings, and onboarding all read one value. Mounted by useSystemStatus for the
 * main app; onboarding mounts it directly (it renders before MainLayout).
 */
export function useGithubInstallations(workspaceId: string | null, connected: boolean) {
  const installations = useWorkspaceStore((s) => s.githubInstallations);
  const setGitHubInstallations = useWorkspaceStore((s) => s.setGitHubInstallations);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId || !connected) {
      // null = "not checked" (no connection), so the UI doesn't flash a
      // "not installed" warning before a real load.
      setGitHubInstallations(null);
      return;
    }
    setLoading(true);
    try {
      const list = await api.github.listInstallations(workspaceId);
      setGitHubInstallations(list);
    } catch {
      // Leave the last-known list in place on a transient failure rather than
      // blanking it (which would flash a false "not installed" banner).
    } finally {
      setLoading(false);
    }
  }, [workspaceId, connected, setGitHubInstallations]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return { installations: installations ?? [], checked: installations !== null, loading, refresh };
}
