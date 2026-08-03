import { IS_DEV_BUILD } from '../lib/env';

/**
 * Whether this is a local dev build (vs the deployed app). Used to flag the
 * UI — e.g. the amber "DEV" badge on the sidebar profile — so a dev build is
 * unmistakable.
 *
 * The desktop reads this from the main process over IPC and so needs state;
 * on the web it is a build-time constant. The hook shape is kept so call
 * sites read identically in both trees.
 */
export function useIsDevBuild(): boolean {
  return IS_DEV_BUILD;
}
