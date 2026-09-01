import { useEffect } from 'react';
import { shouldShowWhatsNew, nextSeenVersion } from '@talyn/shared';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * Decides whether to open the "What's new" modal on launch.
 *
 * The version this client last showed lives in localStorage, per device — like
 * the theme and the auto-keep explainer. It gates an explainer, not an
 * entitlement, so there is nothing here worth a schema column: the worst case
 * of losing it is one extra baseline read on a new machine.
 *
 * Three outcomes:
 *   - No stored version (first ever run): record the latest release and show
 *     nothing. A brand-new user wants the app, not a changelog.
 *   - Stored version, nothing notable since: record the new high-water mark
 *     and show nothing. Most nightlies land here.
 *   - Stored version with notable releases since: open the modal.
 *
 * A build whose version isn't a semver — which is every local build — opts out
 * of all three. Without a version there is no way to tell which releases this
 * build actually contains, and guessing in either direction is worse than
 * saying nothing: no ceiling shows features that aren't here, and recording a
 * baseline from a dev profile would swallow real notes later.
 *
 * Mounted once from MainLayout, which is inside the onboarding gate — so this
 * can never fire over the wizard.
 */

export const LAST_SEEN_KEY = 'fastowl:whatsNew:lastSeenVersion';

/** Fail toward showing nothing: private mode shouldn't pop a modal every launch. */
export function readLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

export function writeLastSeenVersion(version: string | null): void {
  if (!version) return;
  try {
    localStorage.setItem(LAST_SEEN_KEY, version);
  } catch {
    // best-effort
  }
}

/**
 * The running build's version.
 *
 * Baked in by webpack at build time (see .erb/configs/appVersion.ts) so it can
 * be read synchronously — the IPC `app:getVersion()` round-trip resolves after
 * this hook has already decided. Every local build reports the string `'dev'`,
 * which is not a semver, so the auto-open path simply never fires outside a CI
 * build; Settings → About is how you look at the modal on a dev machine.
 */
export function currentAppVersion(): string | null {
  const raw = process.env.TALYN_APP_VERSION;
  return raw && raw !== 'dev' ? raw : null;
}

export function useWhatsNew(): void {
  const checked = useWorkspaceStore((s) => s.whatsNewChecked);
  const markChecked = useWorkspaceStore((s) => s.markWhatsNewChecked);
  const openWhatsNew = useWorkspaceStore((s) => s.openWhatsNew);
  // A user who just finished onboarding installed the app minutes ago. Nothing
  // in the feed is "new" to them, whatever their (absent) stored version says.
  const justOnboarded = useWorkspaceStore((s) => s.justOnboarded);

  useEffect(() => {
    if (checked || justOnboarded) return;
    markChecked();

    // See the docblock: an unversioned build cannot answer "do I have this
    // release?", so it doesn't try. Settings → About still opens the modal.
    const currentVersion = currentAppVersion();
    if (!currentVersion) return;

    void (async () => {
      try {
        const lastSeenVersion = readLastSeenVersion();

        if (!lastSeenVersion) {
          const latest = await api.releaseNotes.latest();
          writeLastSeenVersion(latest?.version ?? null);
          return;
        }

        const entries = await api.releaseNotes.list(lastSeenVersion);
        const input = {
          lastSeenVersion,
          currentVersion,
          entries,
          surface: 'desktop' as const,
        };

        // Written back whether or not anything is shown: a release whose
        // highlights were all web-only is still seen, and leaving it unrecorded
        // means re-fetching and re-evaluating it on every launch forever.
        writeLastSeenVersion(nextSeenVersion(input));

        const toShow = shouldShowWhatsNew(input);
        if (toShow.length > 0) openWhatsNew(toShow);
      } catch {
        // Offline, or the backend is mid-deploy. Nothing is written, so the
        // next launch tries again from the same point.
      }
    })();
  }, [checked, justOnboarded, markChecked, openWhatsNew]);
}
