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
 * Navigates the CURRENT tab rather than opening one. The desktop opens the
 * system browser, because its own window can't host GitHub's cookies — but
 * here `window.open` would be popup-blocked: the URL has to be fetched first,
 * and that `await` spends the user activation the browser was going to grant.
 *
 * Same-tab also closes the loop properly. The backend's callback recognises a
 * browser client by Origin and 302s back to `/settings?github=connected`
 * (routes/github.ts), instead of the desktop's "you can close this tab" page —
 * which, in-tab, would strand the user on the API origin.
 */
export async function openGithubAppFlow(
  workspaceId: string,
  mode: 'connect' | 'manage'
): Promise<void> {
  const { installUrl, manageUrl } = await api.github.installViaApp(workspaceId);
  window.location.assign(mode === 'manage' ? manageUrl : installUrl);
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
