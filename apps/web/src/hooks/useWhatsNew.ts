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
    if (checked || justOnboarded) return;
    markChecked();

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
