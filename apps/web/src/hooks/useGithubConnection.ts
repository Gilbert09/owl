import { useCallback, useEffect, useState } from 'react';
import { api, type GitHubStatus, type GitHubUser } from '../lib/api';

/**
 * Tracks GitHub connection state for a workspace and detects OAuth
 * completion. The OAuth flow happens in the system browser (not the
 * renderer), so we can't read query params off window.location — instead we
 * re-check status whenever the app regains focus, since the user naturally
 * returns to Talyn after authorizing in their browser. Shared by the
 * Settings integrations card and the onboarding GitHub step.
 */
export function useGithubConnection(workspaceId: string | null) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [user, setUser] = useState<GitHubUser | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const s = await api.github.getStatus(workspaceId);
      setStatus(s);
      if (s.connected) {
        try {
          setUser(await api.github.getUser(workspaceId));
        } catch {
          // User fetch failed, but the connection might still be valid.
        }
      } else {
        setUser(null);
      }
    } catch {
      setStatus({ configured: false, connected: false });
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  return { status, user, refresh, setStatus, setUser };
}
