import { useEffect } from 'react';
import { api } from '../lib/api';
import { useOnReconnect } from './useOnReconnect';
import { useWorkspaceStore } from '../stores/workspace';
import {
  usePullRequestStore,
  type PullRequestUpdatePayload,
} from '../stores/pullRequests';

/**
 * A real GitHub force-poll followed by a re-list of the workspace's open PRs.
 * Standalone (reads both stores via `getState`) so the page header's Refresh
 * button can call it directly without threading a callback through the tree.
 */
export async function refreshPullRequests(): Promise<void> {
  const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
  if (!currentWorkspaceId) return;
  const { setRows, setLoading, setError, setConnected } = usePullRequestStore.getState();
  setLoading(true);
  setError(null);
  // A failed force-poll (backend busy/restarting) shouldn't abort the
  // refresh — the cached list is still worth re-reading, and a successful
  // list clears the error so the page recovers instead of pinning a stale
  // banner. Only an error from the list itself surfaces.
  let pollFailure: string | null = null;
  try {
    await api.repositories.forcePoll();
  } catch (err) {
    pollFailure = err instanceof Error ? err.message : 'Refresh failed';
  }
  try {
    const data = await api.pullRequests.list({
      workspaceId: currentWorkspaceId,
      state: 'open',
    });
    setRows(data);
    setConnected(true); // a successful list implies a working connection
    if (pollFailure) {
      console.warn(`PR refresh: force-poll failed (${pollFailure}); showing cached rows`);
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : pollFailure ?? 'Refresh failed');
  } finally {
    setLoading(false);
  }
}

/**
 * Owns the open-PR data lifecycle for the whole app: the initial fetch, the
 * GitHub/PostHog connection probes, and the single `pull_request:updated`
 * subscription that patches rows in place. Mounted once (in MainLayout) so the
 * Sidebar badges and all three GitHub pages share one live set of rows.
 */
export function usePullRequestSync(): void {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const fetchError = usePullRequestStore((s) => s.error);
  const {
    setRows,
    setLoading,
    setError,
    setConnected,
    setViewerLogin,
    setPosthogConnected,
    applyPullRequestUpdate,
  } = usePullRequestStore.getState();

  // Initial fetch of every open PR for the workspace. Relationship/repo
  // filtering happens client-side per page, so we pull the full open set once.
  useEffect(() => {
    if (!currentWorkspaceId) {
      setRows([]);
      // No workspace means no fetch is coming — clear the initial-true
      // loading flag so the pages settle on their empty state.
      setLoading(false);
      return;
    }
    // Just finished onboarding: the freshly-watched repos haven't been polled
    // yet, so a plain cached list would land the user on an empty state. Force
    // a real GitHub poll instead (refreshPullRequests keeps `loading` true
    // throughout) so their PRs populate immediately. One-shot — clear the flag.
    const { justOnboarded, setJustOnboarded } = useWorkspaceStore.getState();
    if (justOnboarded) {
      setJustOnboarded(false);
      void refreshPullRequests();
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.pullRequests
      .list({ workspaceId: currentWorkspaceId, state: 'open' })
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, setRows, setLoading, setError]);

  // GitHub connection status + viewer login — drive the "Connect GitHub" CTA
  // and the Reviews "requested directly (@you)" label.
  useEffect(() => {
    if (!currentWorkspaceId) {
      setConnected(null);
      setViewerLogin(null);
      return;
    }
    let cancelled = false;
    api.github
      .getStatus(currentWorkspaceId)
      .then((s) => {
        if (cancelled) return;
        setConnected(s.connected);
        if (s.connected) {
          api.github
            .getUser(currentWorkspaceId)
            .then((u) => {
              if (!cancelled) setViewerLogin(u.login);
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, setConnected, setViewerLogin]);

  // PostHog Code connection status — gates the per-row "Get PR mergeable" run.
  useEffect(() => {
    if (!currentWorkspaceId) {
      setPosthogConnected(false);
      return;
    }
    let cancelled = false;
    api.posthog
      .getStatus(currentWorkspaceId)
      .then((s) => {
        if (!cancelled) setPosthogConnected(s.connected);
      })
      .catch(() => {
        if (!cancelled) setPosthogConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, setPosthogConnected]);

  // Live updates from the prMonitor. A brand-new open PR we don't hold yet
  // can't be hand-merged (we lack workspaceId/repositoryId), so refetch.
  useEffect(() => {
    const unsubscribe = api.ws.on('pull_request:updated', (payload) => {
      const needsRefetch = applyPullRequestUpdate(payload as PullRequestUpdatePayload);
      if (needsRefetch && currentWorkspaceId) {
        api.pullRequests
          .list({ workspaceId: currentWorkspaceId, state: 'open' })
          .then(setRows)
          .catch(() => {});
      }
    });
    return unsubscribe;
  }, [currentWorkspaceId, applyPullRequestUpdate, setRows]);

  // Self-heal: while the store holds a fetch error (backend outage, edge
  // 5xx), retry the plain list every 30s until one succeeds — success clears
  // the error and replaces the stale rows, so a transient outage recovers
  // without the user mashing Refresh. The cheap list (no force-poll) keeps
  // the retry gentle on a backend that's struggling.
  useEffect(() => {
    if (!fetchError || !currentWorkspaceId) return;
    const timer = window.setInterval(() => {
      api.pullRequests
        .list({ workspaceId: currentWorkspaceId, state: 'open' })
        .then((data) => {
          setRows(data);
          setError(null);
          setConnected(true);
        })
        .catch(() => {}); // still down — banner stays, next tick retries
    }, 30_000);
    return () => clearInterval(timer);
  }, [fetchError, currentWorkspaceId, setRows, setError, setConnected]);

  // Reconnect catch-up: `pull_request:updated` broadcasts (which carry live
  // merge-queue positions/status) are fire-and-forget to open sockets only, so
  // any change that lands while we're disconnected is lost — leaving the merge
  // queue stale until the next change happens to fire. On a genuine *re*connect,
  // re-list the open PRs to reconcile. Mirrors `reconcileTasksFromServer` for
  // tasks; the first connect is covered by the initial fetch above.
  useOnReconnect(() => {
    if (!currentWorkspaceId) return;
    api.pullRequests
      .list({ workspaceId: currentWorkspaceId, state: 'open' })
      .then(setRows)
      .catch(() => {});
  });
}
