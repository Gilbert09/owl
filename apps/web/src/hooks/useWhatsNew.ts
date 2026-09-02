import { useEffect } from 'react';
import { shouldShowWhatsNew, nextSeenVersion } from '@talyn/shared';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * Decides whether to open the "What's new" modal on load. The web half of the
 * desktop hook of the same name, with one structural difference.
 *
 * **There is no `currentVersion` here.** The desktop's version is a real semver
 * baked into the build; this app's is `web/<sha>` (see lib/env.ts), which has
 * no order. That is not a gap to work around — it is correct for this client.
 * app.talyn.dev is continuously deployed on every push to main, so it is always
 * at or ahead of the newest cut release, and there is no such thing as a
 * release entry describing code this build does not have. The desktop needs the
 * ceiling precisely because the opposite is true there: the backend knows about
 * tonight's release the moment CI posts it, while the user is still on last
 * night's build.
 *
 * Everything else matches: the last-seen version is per-device localStorage,
 * the first run records a baseline and shows nothing, and highlights that
 * apply only to the desktop are filtered out.
 */

export const LAST_SEEN_KEY = 'fastowl:whatsNew:lastSeenVersion';

/** Fail toward showing nothing: private mode shouldn't pop a modal every load. */
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

export function useWhatsNew(): void {
  const checked = useWorkspaceStore((s) => s.whatsNewChecked);
  const markChecked = useWorkspaceStore((s) => s.markWhatsNewChecked);
  const openWhatsNew = useWorkspaceStore((s) => s.openWhatsNew);
  const justOnboarded = useWorkspaceStore((s) => s.justOnboarded);

  useEffect(() => {
    // `whatsNewChecked` is store state rather than a ref because MainLayout is
    // rendered per route here — a component-local guard would re-run this on
    // every navigation.
    if (checked) return;
    markChecked();

    void (async () => {
      try {
        const lastSeenVersion = readLastSeenVersion();

        if (!lastSeenVersion) {
          // A brand-new user gets a baseline and no changelog — they signed up
          // minutes ago and nothing in the feed is "new" to them.
          if (justOnboarded) {
            const latest = await api.releaseNotes.latest();
            writeLastSeenVersion(latest?.version ?? null);
            return;
          }

          // But an EXISTING user reaches here too, and that is the case this
          // branch exists for. A missing key does not mean "new install"; it
          // also means "first load after this feature shipped", which is every
          // user Talyn already had. Baselining them silently is why the 0.2.64
          // notes were invisible to everyone who was already using it.
          //
          // Scoped deliberately to the ONE newest release rather than the whole
          // table — which is what this client is running, since app.talyn.dev
          // deploys on every push and is always at or ahead of the newest cut.
          const all = await api.releaseNotes.list();
          const newest = all[0];
          writeLastSeenVersion(newest?.version ?? null);
          if (!newest) return;
          const toShow = shouldShowWhatsNew({
            // Floor, not a real version: the window is already narrowed to the
            // single entry above, so this just means "no lower bound".
            lastSeenVersion: '0.0.0',
            currentVersion: null,
            entries: [newest],
            surface: 'web' as const,
          });
          if (toShow.length > 0) openWhatsNew(toShow);
          return;
        }

        const entries = await api.releaseNotes.list(lastSeenVersion);
        const input = {
          lastSeenVersion,
          currentVersion: null,
          entries,
          surface: 'web' as const,
        };

        writeLastSeenVersion(nextSeenVersion(input));

        const toShow = shouldShowWhatsNew(input);
        if (toShow.length > 0) openWhatsNew(toShow);
      } catch {
        // Offline, or the backend is mid-deploy. Nothing is written, so the
        // next load tries again from the same point.
      }
    })();
  }, [checked, justOnboarded, markChecked, openWhatsNew]);
}
