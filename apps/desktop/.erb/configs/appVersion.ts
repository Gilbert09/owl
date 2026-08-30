/**
 * The version string baked into the renderer bundle as `TALYN_APP_VERSION`.
 *
 * It feeds two things: the `app_version` analytics super property, and the
 * `X-Talyn-Client-Version` header every API request carries.
 *
 * `release/app/package.json` is committed with a static placeholder and only
 * CI stamps the real version into it before building (see publish.yml). So a
 * build made anywhere else — a contributor running `npm start`, a local
 * `npm run package` — bakes the placeholder and then reports itself as a
 * release that shipped long ago.
 *
 * That was not cosmetic. The backend's free-plan paywall used to exempt any
 * client identifying as a version below the release that shipped the upgrade
 * UI, on the reasoning that an old build can only render a bare error. The
 * placeholder is below every floor, so every local build was silently exempt
 * from both the task and merge-queue caps — and because it also predates the
 * analytics key being baked in, it produced no client events to notice it by.
 * That exemption is gone now, but the version is still wrong, and a local
 * build that is indistinguishable from a release makes analytics lie.
 *
 * So: when the file still holds the placeholder, report `dev`. A local build
 * genuinely has no release version, and `dev` is the vocabulary the renderer
 * already falls back to when the variable is missing entirely
 * (`renderer/lib/api.ts`). Keep this in sync with PLACEHOLDER_VERSION below if
 * `release/app/package.json` is ever re-based onto a different stub.
 */

/**
 * The committed stub in `release/app/package.json`. Anything equal to this was
 * NOT stamped by CI and is therefore a local build.
 */
export const PLACEHOLDER_VERSION = '0.1.0';

/**
 * The pure decision, split out so it can be tested without loading the build
 * file: a stamped version passes through, the placeholder (or nothing at all)
 * becomes `dev`.
 */
export function appVersionFrom(raw: string | undefined | null): string {
  return !raw || raw === PLACEHOLDER_VERSION ? 'dev' : raw;
}

export function resolveAppVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  return appVersionFrom(require('../../release/app/package.json').version);
}

export default resolveAppVersion;
