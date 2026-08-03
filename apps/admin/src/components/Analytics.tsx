import { useEffect, useRef } from 'react';
import { useAuth, takePendingLogin } from './auth/AuthProvider';
import { identifyAnalyticsUser, resetAnalyticsUser, trackEvent } from '../lib/analytics';
import { consumeLogoutReason } from '../lib/logoutReason';

/**
 * PostHog identity and lifecycle events.
 *
 * Narrower than the product apps' version: there is no workspace to register
 * as a super property (this console is cross-tenant by definition) and no
 * panel_viewed, because pageviews are captured natively — see lib/analytics.
 */
export function Analytics() {
  const { user } = useAuth();
  const userId = user?.id;
  const email = user?.email;
  const githubLogin = user?.user_metadata?.user_name as string | undefined;
  // First identify of a mount is session restore, not a fresh login — only
  // track logged_in when the user id appears after being absent.
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const prevUserId = prevUserIdRef.current;
    prevUserIdRef.current = userId;
    if (userId) {
      identifyAnalyticsUser(userId, { email, github_login: githubLogin });
      // `prevUserId === null` is how the desktop spots a fresh login, and it
      // cannot work here: OAuth is a full-page redirect, so the ref is a new
      // `undefined` by the time we come back. takePendingLogin bridges that
      // gap via sessionStorage — set before leaving for GitHub, consumed once
      // on return. A restored session has no marker and is not a login.
      if (prevUserId === null || takePendingLogin()) trackEvent('logged_in');
    } else {
      // Distinguish "no session yet" (undefined) from "session ended" by
      // recording null once auth has resolved to signed-out.
      prevUserIdRef.current = null;
      if (prevUserId) {
        trackEvent('logged_out', { reason: consumeLogoutReason() });
        // Only reset on a REAL sign-out. This effect also runs on first
        // render, before auth resolves, where userId is simply not known yet
        // — resetting there churns the anonymous distinct_id on every load.
        resetAnalyticsUser();
      }
    }
  }, [userId, email, githubLogin]);

  return null;
}
