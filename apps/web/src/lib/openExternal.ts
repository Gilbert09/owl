/**
 * Open a URL in a new tab. The desktop routes this through the Electron
 * preload bridge (`shell.openExternal`) so links leave the app window; in a
 * browser `window.open` is simply the right answer.
 *
 * Kept `async` so call sites read identically in both trees.
 *
 * Callers should invoke this from a user gesture without awaiting something
 * first. Browsers grant `window.open` only while user activation is live, and
 * an intervening `await` spends it — which is exactly how the desktop's
 * sign-in flow would have been popup-blocked here (see
 * components/auth/AuthProvider). Where a URL must be fetched first, navigate
 * the current tab instead.
 */
export async function openExternal(url: string): Promise<void> {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * True when a mouse event should open a link in the browser rather than trigger
 * the element's default action: cmd/ctrl-click (modifier) or a middle/aux click.
 */
export function isOpenInBrowserClick(
  e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'button'>
): boolean {
  return e.metaKey || e.ctrlKey || e.button === 1;
}
