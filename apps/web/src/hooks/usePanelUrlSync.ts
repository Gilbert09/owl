import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../stores/workspace';
import { PANEL_PATHS, panelForPath } from '../lib/routes';

/**
 * Keeps the URL and the store's `activePanel` in step.
 *
 * The desktop has no URL bar, so it navigates purely by setting `activePanel`.
 * That stays the source of truth here rather than being replaced by routes,
 * because the store also drives panel changes imperatively in places a route
 * can't express well — onboarding completion lands you on My PRs, and turning
 * debug mode off bounces you off the debug panel (stores/workspace.ts). So
 * instead the store keeps deciding, and this mirrors its decisions into the
 * address bar, which buys back shareable links, the back button, and
 * surviving Cmd-R.
 *
 * IMPLEMENTATION NOTE — this deliberately uses ONE effect that asks "which
 * side actually changed?", not one effect per direction. Two effects race:
 * they run in the same commit off the same snapshot, so when they disagree,
 * the store→URL one calls navigate() while the URL→store one simultaneously
 * "corrects" the store back to whatever the not-yet-updated pathname says.
 * The observable symptom was clicking Merge Queue, watching the sidebar
 * highlight it, and landing back on My PRs. A `syncing` flag does not fix it,
 * because both effects read it before either has set it.
 *
 * Comparing against the previously-synced pair removes the ambiguity: exactly
 * one side differs from last time, and that side wins.
 */
export function usePanelUrlSync(): void {
  const activePanel = useWorkspaceStore((s) => s.activePanel);
  const setActivePanel = useWorkspaceStore((s) => s.setActivePanel);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // null until the first run, which bootstraps rather than reconciles.
  const last = useRef<{ panel: string; path: string } | null>(null);

  useEffect(() => {
    // First load: the URL wins. Someone opening /merge-queue directly, or
    // restoring a tab, should land where the link says rather than on
    // whatever panel the persisted store happens to hold.
    if (last.current === null) {
      const fromUrl = panelForPath(pathname);
      if (fromUrl) {
        last.current = { panel: fromUrl, path: pathname };
        if (fromUrl !== activePanel) setActivePanel(fromUrl);
      } else {
        const target = PANEL_PATHS[activePanel];
        last.current = { panel: activePanel, path: target };
        // replace, not push: the unmapped URL we arrived on shouldn't
        // become a back-button stop.
        if (target !== pathname) navigate(target, { replace: true });
      }
      return;
    }

    const prev = last.current;

    // The store moved (sidebar click, or an imperative setActivePanel).
    if (activePanel !== prev.panel) {
      const target = PANEL_PATHS[activePanel];
      last.current = { panel: activePanel, path: target };
      if (target !== pathname) navigate(target);
      return;
    }

    // The URL moved (back/forward, or a pasted link).
    if (pathname !== prev.path) {
      const fromUrl = panelForPath(pathname);
      last.current = { panel: fromUrl ?? activePanel, path: pathname };
      if (fromUrl && fromUrl !== activePanel) setActivePanel(fromUrl);
    }
  }, [activePanel, pathname, navigate, setActivePanel]);
}
