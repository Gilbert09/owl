import { api, type GitHubInstallation } from './api';

/**
 * Helpers shared by every surface that reasons about GitHub App *installation
 * coverage* — onboarding, Settings, and the global banner. A repo is only
 * tracked by Talyn if its owner org/account has an active (non-suspended)
 * App installation, so these turn the raw installation list into the
 * owner-level checks the UI needs, and start the install flow in the browser.
 */

/**
 * Start the GitHub App flow. `connect` runs OAuth authorize (first
 * connection); `manage` opens the installations page to add the App to
 * another org or change which repos it can access.
 *
 * Runs in a SEPARATE tab, because callers depend on this page staying alive.
 * ConnectGitHubStep is the reason: the onboarding wizard shows the flow
 * inline and waits for `useGithubConnection` to re-check on window focus.
 * Navigating this tab away unmounts the wizard mid-onboarding and — since the
 * backend sends browser clients to /settings — drops the user out of setup
 * entirely.
 *
 * The tab is opened SYNCHRONOUSLY, before awaiting the install URL. Browsers
 * grant `window.open` only while user activation is live, and the fetch below
 * would spend it — so we claim the tab first and point it somewhere once we
 * know where. If the popup is blocked anyway, fall back to this tab: losing
 * wizard position beats the button doing nothing.
 *
 * The opened tab lands on the backend callback, which 302s browser clients to
 * /settings?github=connected. useClosePopupAfterGithub (App.tsx) notices it
 * is a popup and closes it, returning focus here — which is exactly the
 * signal the wizard is waiting for.
 */
export async function openGithubAppFlow(
  workspaceId: string,
  mode: 'connect' | 'manage'
): Promise<void> {
  const opened = window.open('', '_blank', 'noopener=no');
  try {
    const { installUrl, manageUrl } = await api.github.installViaApp(workspaceId);
    const url = mode === 'manage' ? manageUrl : installUrl;
    if (opened && !opened.closed) opened.location.href = url;
    else window.location.assign(url);
  } catch (err) {
    opened?.close();
    throw err;
  }
}

/** Lowercased account logins with an active (non-suspended) installation. */
export function installedAccounts(installations: GitHubInstallation[]): Set<string> {
  return new Set(
    installations.filter((i) => !i.suspended).map((i) => i.accountLogin.toLowerCase())
  );
}

/** True when the App is installed (and active) on `owner`. */
export function isOwnerCovered(
  owner: string,
  installations: GitHubInstallation[]
): boolean {
  return installedAccounts(installations).has(owner.toLowerCase());
}

/**
 * Distinct owners (original casing, sorted) from `owners` that have no active
 * installation — the accounts the user must install the App on for those repos
 * to be tracked.
 */
export function uncoveredOwners(
  owners: string[],
  installations: GitHubInstallation[]
): string[] {
  const covered = installedAccounts(installations);
  const seen = new Map<string, string>();
  for (const owner of owners) {
    const key = owner.toLowerCase();
    if (!covered.has(key) && !seen.has(key)) seen.set(key, owner);
  }
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Human-readable "@a, @b and @c" list of account logins. */
export function formatOwnerList(owners: string[]): string {
  const tagged = owners.map((o) => `@${o}`);
  if (tagged.length <= 1) return tagged.join('');
  if (tagged.length === 2) return `${tagged[0]} and ${tagged[1]}`;
  return `${tagged.slice(0, -1).join(', ')} and ${tagged[tagged.length - 1]}`;
}
