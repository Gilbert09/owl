import { useCallback, useEffect, useState } from 'react';
import { ApiNetworkError, api, type GitHubStatus, type GitHubUser } from '../lib/api';

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
  /** null until the first attempt resolves; false when the backend is unreachable. */
  const [reachable, setReachable] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const s = await api.github.getStatus(workspaceId);
      setReachable(true);
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
    } catch (err) {
      // A transport failure means we never got an answer — it is NOT the
      // backend telling us GitHub is unconfigured. Reporting it as
      // `configured: false` is what produced the misleading "set
      // GITHUB_CLIENT_ID" banner whenever the network dropped. Leave the last
      // known status alone and report unreachability instead.
      if (err instanceof ApiNetworkError) {
        setReachable(false);
        return;
      }
      setReachable(true);
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

  return { status, user, reachable, refresh, setStatus, setUser };
}
