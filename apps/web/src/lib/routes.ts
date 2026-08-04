import type { ActivePanel } from './panels';

/**
 * Panel ⇄ URL mapping.
 *
 * The desktop switches on a zustand `activePanel` enum in MainLayout and has
 * no URLs at all. The store stays the source of truth in the fork too — it
 * drives transitions imperatively (onboarding completion) in a way that would
 * be awkward to express as a navigation — but each panel now also has a path,
 * kept in sync by usePanelUrlSync.
 *
 * (The other imperative transition this used to cite — bouncing off the Debug
 * panel when debug mode was switched off — went away with the panel itself,
 * which now lives on admin.talyn.dev.)
 */
export const PANEL_PATHS = {
  queue: '/queue',
  my_prs: '/prs',
  reviews: '/reviews',
  merge_queue: '/merge-queue',
  settings: '/settings',
} as const satisfies Record<ActivePanel, string>;

export const PATH_TO_PANEL: Record<string, ActivePanel> = Object.fromEntries(
  Object.entries(PANEL_PATHS).map(([panel, path]) => [path, panel as ActivePanel])
);

export function panelForPath(pathname: string): ActivePanel | null {
  return PATH_TO_PANEL[pathname] ?? null;
}
