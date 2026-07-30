import { useEffect, useRef } from 'react';
import { useAuth } from './auth/AuthProvider';
import { useWorkspaceStore } from '../stores/workspace';
import {
  identifyAnalyticsUser,
  registerSuperProperties,
  resetAnalyticsUser,
  trackEvent,
} from '../lib/analytics';
import { consumeLogoutReason } from '../lib/logoutReason';

/**
 * PostHog identity and lifecycle events, mirroring the desktop's `Analytics`
 * component (apps/desktop/src/renderer/App.tsx).
 *
 * Its own module here because the web App.tsx is a router shell. The one
 * addition is the `client` super property — with two front ends reporting into
 * one project, every event needs to say which it came from or the funnels
 * silently merge.
 */
export function Analytics() {
  const { user } = useAuth();
  const activePanel = useWorkspaceStore((s) => s.activePanel);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const userId = user?.id;
  const email = user?.email;
  const githubLogin = user?.user_metadata?.user_name as string | undefined;
  // First identify of a mount is session restore, not a fresh login — only
  // track logged_in when the user id appears after being absent.
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  const previousPanelRef = useRef<string | null>(null);

  useEffect(() => {
    const prevUserId = prevUserIdRef.current;
    prevUserIdRef.current = userId;
    if (userId) {
      identifyAnalyticsUser(userId, { email, github_login: githubLogin });
      if (prevUserId === null) trackEvent('logged_in');
    } else {
      // Distinguish "no session yet" (undefined) from "session ended"
      // by recording null once auth has resolved to signed-out.
      prevUserIdRef.current = null;
      if (prevUserId) trackEvent('logged_out', { reason: consumeLogoutReason() });
      resetAnalyticsUser();
    }
  }, [userId, email, githubLogin]);

  // Active workspace as a super property — every event (incl. autocapture)
  // carries it, instead of threading it through each call site.
  useEffect(() => {
    if (currentWorkspaceId) {
      registerSuperProperties({ workspace_id: currentWorkspaceId });
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    if (activePanel) {
      trackEvent('panel_viewed', {
        panel: activePanel,
        previous_panel: previousPanelRef.current,
      });
      previousPanelRef.current = activePanel;
    }
  }, [activePanel]);

  return null;
}
