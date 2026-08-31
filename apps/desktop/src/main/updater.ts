/**
 * Auto-update wiring. Uses electron-updater against the GitHub Releases feed
 * configured in package.json `build.publish` (the public `owl-releases` repo).
 *
 * The main process drives the whole flow — checking, downloading, and applying
 * — and forwards normalized `UpdaterEvent`s to the renderer over the
 * `updater:event` channel so the sidebar's UpdateNotice can react. The renderer
 * triggers a manual check or the restart via the `updater:check` /
 * `updater:quit-and-install` invoke handlers.
 *
 * macOS: builds are signed + notarized (package.json build.mac), so
 * Squirrel.Mac applies updates end-to-end — verified working.
 */
import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import type { UpdaterEvent, UpdaterCheckResult, UpdateChannel } from './updaterEvents';
import { getUpdateChannel, setUpdateChannel } from './updateChannel';

// Re-check this often while the app stays open, so long-running sessions
// still pick up releases without a restart.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
// Small delay after window-ready so we don't compete with first paint.
const INITIAL_CHECK_DELAY_MS = 10 * 1000;

/**
 * How long the MACHINE must sit idle before a downloaded update is applied
 * without anyone asking for it.
 *
 * `autoInstallOnAppQuit` already means nobody has to press a button — but it
 * only fires on QUIT, and Talyn is a dashboard people leave open on a second
 * monitor for days. Measured against real installs, the median user was several
 * releases behind while the update sat staged the whole time.
 *
 * The signal is deliberately SYSTEM idle (`powerMonitor.getSystemIdleTime()`),
 * not window blur. Blur only means they are in another app and could come back
 * mid-keystroke; system idle means they are away from the keyboard entirely, so
 * the restart is something they never see. 30 minutes is long enough that it
 * cannot fire while someone is reading the screen.
 *
 * What a restart costs is close to nothing here, which is what makes this safe:
 * the desktop app is a viewer and the backend owns every piece of durable
 * state, so nothing in flight is lost. Local UI state (filter chips, scroll
 * position, an open detail sheet) does reset.
 */
export const IDLE_RESTART_AFTER_MS = 30 * 60 * 1000;
/** How often to look, once an update is actually staged. Cheap either way. */
const IDLE_POLL_INTERVAL_MS = 60 * 1000;

let checkTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Pure decision behind the idle restart — exported so the policy can be tested
 * without an Electron main process.
 *
 * `stagedVersion` is null until `update-downloaded` has fired: an update that
 * has not finished downloading must never trigger a quit, or the user comes
 * back to a closed app and no new version.
 */
export function shouldApplyUpdateWhileIdle(state: {
  stagedVersion: string | null;
  systemIdleMs: number;
  idleThresholdMs?: number;
}): boolean {
  if (state.stagedVersion === null) return false;
  const threshold = state.idleThresholdMs ?? IDLE_RESTART_AFTER_MS;
  return state.systemIdleMs >= threshold;
}

/**
 * Poll for the machine going idle with an update staged, then apply it.
 *
 * Idempotent: `update-downloaded` can fire again (a second release landing
 * while the app stays open), and re-arming would otherwise stack timers.
 *
 * `quitAndInstall(isSilent: true, isForceRunAfter: true)` — silent so Windows
 * does not raise an installer window at an unattended machine, and force-run so
 * the user returns to a RUNNING app rather than finding Talyn closed itself.
 * That differs from the renderer's `updater:quit-and-install`, where the user
 * asked for the restart and is watching it happen.
 */
function armIdleRestart(version: string): void {
  if (idleTimer) return;
  log.info(
    `[updater] ${version} staged — applying after ${IDLE_RESTART_AFTER_MS / 60000}m idle`,
  );
  idleTimer = setInterval(() => {
    let systemIdleMs: number;
    try {
      systemIdleMs = powerMonitor.getSystemIdleTime() * 1000;
    } catch (err) {
      // No idle signal available (some Linux sessions) — fall back to the
      // pre-existing behaviour and let it install on quit.
      log.warn('[updater] system idle time unavailable:', err);
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = null;
      return;
    }
    if (!shouldApplyUpdateWhileIdle({ stagedVersion: version, systemIdleMs })) return;
    log.info(`[updater] applying ${version} after ${Math.round(systemIdleMs / 60000)}m idle`);
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    if (checkTimer) clearInterval(checkTimer);
    autoUpdater.quitAndInstall(true, true);
  }, IDLE_POLL_INTERVAL_MS);
}

/**
 * A 404 on `latest-*.yml` means a GitHub release with a newer tag exists but its
 * artifacts haven't finished uploading yet (a Publish build still running), or
 * this platform has no artifact in that release. There's nothing to offer yet
 * and it isn't a real failure — so we report it as "up to date" rather than an
 * error, and the next (or periodic) check picks it up once the files are there.
 */
function isPendingReleaseArtifact(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return (
    /Cannot find .*\.yml in the latest release artifacts/i.test(raw) ||
    (/latest(-mac|-linux|-arm64)?\.yml/i.test(raw) && /\b404\b/.test(raw)) ||
    // Stable channel while every existing release is still a pre-release:
    // there's no stable build to offer yet, which is "you're up to date",
    // not an error. Goes away after the first tagged (full) release.
    /Unable to find latest version/i.test(raw)
  );
}

/**
 * Menu-bar "Check for Updates…" — same autoUpdater flow the Settings → About
 * check uses (so the renderer's updater events still stream as usual), but
 * with native-dialog feedback since there's no panel open to show status.
 */
export async function checkForUpdatesInteractively(): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Auto-update only runs in the installed app.',
      detail: 'Development builds cannot check for updates.',
    });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    // With autoDownload on, a non-null downloadPromise means an update was
    // found and is already downloading.
    if (result?.downloadPromise) {
      await dialog.showMessageBox({
        type: 'info',
        message: `Update ${result.updateInfo.version} is downloading.`,
        detail:
          'It installs automatically the next time Talyn restarts — or restart right away from Settings → About once the download finishes.',
      });
    } else {
      await dialog.showMessageBox({
        type: 'info',
        message: "You're on the latest version.",
        detail: `Talyn ${app.getVersion()}`,
      });
    }
  } catch (err) {
    if (isPendingReleaseArtifact(err)) {
      await dialog.showMessageBox({
        type: 'info',
        message: "You're on the latest version.",
        detail: `Talyn ${app.getVersion()}`,
      });
      return;
    }
    await dialog.showMessageBox({
      type: 'error',
      message: "Couldn't check for updates.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null) {
  autoUpdater.logger = log;
  log.transports.file.level = 'info';
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Channel: `stable` (default) follows tagged full releases only; `nightly`
  // (allowPrerelease) also follows the nightly pre-releases. Persisted in
  // userData; switchable from Settings → About.
  autoUpdater.allowPrerelease = getUpdateChannel() === 'nightly';

  const send = (event: UpdaterEvent) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater:event', event);
    }
  };

  autoUpdater.on('checking-for-update', () => send({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    send({ kind: 'available', version: info.version }),
  );
  autoUpdater.on('update-not-available', () => send({ kind: 'not-available' }));
  autoUpdater.on('download-progress', (progress) =>
    send({ kind: 'progress', percent: Math.round(progress.percent) }),
  );
  autoUpdater.on('update-downloaded', (info) => {
    send({ kind: 'downloaded', version: info.version });
    // The sidebar's UpdateNotice offers "restart now" from here; this is the
    // fallback for everyone who ignores it and never quits.
    armIdleRestart(info.version);
  });
  autoUpdater.on('error', (err) => {
    // A release whose artifacts aren't uploaded yet isn't an update we can offer
    // and isn't a failure — show "no updates" instead of an error.
    if (isPendingReleaseArtifact(err)) {
      send({ kind: 'not-available' });
      return;
    }
    send({ kind: 'error', message: err?.message ?? String(err) });
  });

  // Renderer-driven controls. Returns whether a check actually started so the
  // Settings UI can distinguish "checking…" from "unsupported in dev". The
  // result (available/not) still arrives via the forwarded events.
  ipcMain.handle('updater:check', async (): Promise<UpdaterCheckResult> => {
    if (!app.isPackaged) return { started: false, reason: 'not-packaged' };
    await autoUpdater.checkForUpdates();
    return { started: true };
  });
  ipcMain.handle('updater:quit-and-install', () => {
    autoUpdater.quitAndInstall();
  });
  ipcMain.handle('updater:get-channel', (): UpdateChannel => getUpdateChannel());
  ipcMain.handle('updater:set-channel', async (_e, channel: UpdateChannel) => {
    const next: UpdateChannel = channel === 'nightly' ? 'nightly' : 'stable';
    setUpdateChannel(next);
    autoUpdater.allowPrerelease = next === 'nightly';
    log.info(`[updater] channel set to ${next}`);
    // Re-check right away so switching to nightly offers the newest nightly
    // (and switching to stable settles on the latest tagged build) without
    // waiting for the 4h timer.
    if (app.isPackaged) {
      autoUpdater.checkForUpdates().catch((err) => log.error('[updater]', err));
    }
    return next;
  });

  // electron-updater can't resolve an update from an unpackaged dev tree
  // unless a dev-app-update.yml is present; gate background checks on
  // isPackaged so dev runs stay quiet (manual check above also no-ops).
  if (!app.isPackaged) {
    log.info('[updater] skipping auto-check (app not packaged)');
    return;
  }

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => log.error('[updater]', err));
  }, INITIAL_CHECK_DELAY_MS);

  checkTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => log.error('[updater]', err));
  }, CHECK_INTERVAL_MS);

  app.on('before-quit', () => {
    if (checkTimer) clearInterval(checkTimer);
    if (idleTimer) clearInterval(idleTimer);
  });
}
