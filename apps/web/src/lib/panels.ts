/**
 * The panel set, mirroring the desktop's `activePanel` union
 * (apps/desktop/src/renderer/stores/workspace.ts). Kept as its own module so
 * lib/routes.ts can constrain PANEL_PATHS to exactly these keys — `satisfies
 * Record<ActivePanel, string>` is what makes tsc fail if a panel is added
 * without giving it a URL.
 */
export type ActivePanel =
  | 'queue'
  | 'my_prs'
  | 'reviews'
  | 'merge_queue'
  | 'settings'
  | 'debug';
