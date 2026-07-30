import { useEffect } from 'react';

/**
 * Closes this window when it is the GitHub-connect popup that has just come
 * back from the backend callback.
 *
 * lib/githubInstall opens the flow in a separate tab so the page that started
 * it — notably the onboarding wizard — stays mounted. The backend then 302s
 * browser clients to /settings?github=connected, which would otherwise load
 * the entire app a second time inside that popup.
 *
 * Both conditions are required. `window.opener` alone would close a tab the
 * user opened themselves from a link in the app; the `github` param alone
 * would close the real tab when someone lands on /settings after connecting
 * in-tab (the popup-blocked fallback path).
 */
export function useClosePopupAfterGithub(): void {
  useEffect(() => {
    if (!window.opener || window.opener === window) return;
    const result = new URLSearchParams(window.location.search).get('github');
    if (result !== 'connected' && result !== 'error') return;
    // The opener re-checks GitHub status on focus, which it regains as this
    // closes — so there is nothing to notify.
    window.close();
  }, []);
}
