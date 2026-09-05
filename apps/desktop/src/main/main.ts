/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import {
  app,
  BrowserWindow,
  dialog,
  shell,
  ipcMain,
  safeStorage,
} from 'electron';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';
import { AuthStorage, type EncryptionBackend } from './authStorage';
import { initAutoUpdater } from './updater';
import { signInToCodex } from './codexAuth';

let mainWindow: BrowserWindow | null = null;

/**
 * Only ever hand http(s) URLs to the OS. Renderer-supplied input (IPC,
 * window.open, link clicks) could otherwise smuggle file:, javascript: or
 * arbitrary app-scheme payloads into shell.openExternal. Anything else is
 * silently ignored.
 */
function openExternalGuarded(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:') {
      void shell.openExternal(url);
    }
  } catch {
    // Not a parseable URL — drop it.
  }
}
// Buffer callbacks that arrive before the renderer is ready — macOS
// open-url can fire during app launch, before any window exists.
let pendingAuthCallbackUrl: string | null = null;

// ============================================================================
// Auth deep-link handling
// ============================================================================
//
// After a user signs in via GitHub in their system browser, Supabase
// redirects to `fastowl://auth-callback#access_token=...&refresh_token=...`.
// The OS hands that URL to whichever app claims the `fastowl` scheme —
// i.e. us. We forward it over IPC to the renderer, which feeds the tokens
// to the Supabase client.

// True only when running via the electron binary + a script path, i.e. a
// local dev run (never a packaged build). Drives the dev-only deep-link
// scheme, dock icon, and the renderer's "DEV" badge.
const IS_DEV_BUILD = !!process.defaultApp;

// Dev builds claim a distinct scheme so a `fastowl://auth-callback` deep link
// isn't stolen by an installed *production* Talyn.app (macOS LaunchServices
// routes a shared scheme to whichever app it prefers — usually the one in
// /Applications). The renderer reads the matching redirect URL back over IPC
// so both sides always agree.
const DEEP_LINK_SCHEME = IS_DEV_BUILD ? 'fastowl-dev' : 'fastowl';
const AUTH_REDIRECT_URL = `${DEEP_LINK_SCHEME}://auth-callback`;

function registerDeepLinkProtocol() {
  if (process.defaultApp) {
    // Dev: Electron needs to know the script path so `fastowl://` reopens
    // the running instance instead of launching a fresh electron binary.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
}

function forwardAuthCallback(url: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:callback', url);
    // Pop the window to the front so the user sees confirmation.
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pendingAuthCallbackUrl = url;
  }
}

// macOS delivers deep links via open-url even for already-running apps.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith(`${DEEP_LINK_SCHEME}://`)) {
    forwardAuthCallback(url);
  }
});

// Windows/Linux deliver deep links as a second argv to a second instance.
// We grab the single-instance lock and handle it on `second-instance`.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
    if (url) forwardAuthCallback(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Renderer asks us to open OAuth URLs in the default browser. The URL is
// renderer-supplied, so it goes through the http(s)-only guard.
ipcMain.handle('auth:open-external', async (_event, url: string) => {
  openExternalGuarded(url);
});

// The deep-link redirect URL the renderer should hand to Supabase's OAuth
// flow — scheme-matched to this build (dev vs prod) so the callback reopens
// THIS app, not the other one.
ipcMain.handle('auth:get-redirect-url', async () => AUTH_REDIRECT_URL);

// Renderer asks on mount for any deep-link that arrived before it was ready.
ipcMain.handle('auth:drain-pending', async () => {
  const pending = pendingAuthCallbackUrl;
  pendingAuthCallbackUrl = null;
  return pending;
});

// Encrypted-at-rest store for Supabase session tokens. The renderer's
// localStorage would otherwise keep the JWT + refresh token in
// plaintext under the Electron userData dir — readable by anyone with
// filesystem access (other local users, backup snapshots, malware
// running as the user). safeStorage binds the encryption key to the OS
// user account via Keychain / DPAPI / libsecret.
const safeStorageBackend: EncryptionBackend = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptString(plaintext),
  decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
};
const authStorage = new AuthStorage(
  safeStorageBackend,
  path.join(app.getPath('userData'), 'auth-storage')
);
ipcMain.handle('auth:storage:get', async (_event, key: string) => {
  return authStorage.getItem(key);
});
ipcMain.handle('auth:storage:set', async (_event, key: string, value: string) => {
  await authStorage.setItem(key, value);
});
ipcMain.handle('auth:storage:remove', async (_event, key: string) => {
  await authStorage.removeItem(key);
});

// Connect a ChatGPT subscription for Talyn Fleet.
//
// The whole flow runs here because OpenAI's Codex client redirects to a
// LOOPBACK address, which only a process on the user's machine can answer —
// see main/codexAuth.ts. The renderer gets the finished token pair back and
// forwards it to the backend through the normal cloud-providers route, so
// there is still exactly one place that knows how to talk to the backend.
ipcMain.handle('codex:sign-in', async () => {
  return signInToCodex((url) => openExternalGuarded(url));
});

// Current app version, for display in Settings → About.
ipcMain.handle('app:get-version', () => app.getVersion());

// Whether this is a local dev build — the renderer uses it to flag the UI
// (e.g. a "DEV" badge on the profile) so a dev build is unmistakable.
ipcMain.handle('app:is-dev', () => IS_DEV_BUILD);

// Local agent skills: ~/.claude/skills/<dir>/SKILL.md. Content rides the
// listing (skills are small); frontmatter parsing happens renderer-side with
// the shared parser. Over the size guard, content is omitted but the entry
// still surfaces so the UI can say "too large to run".
const LOCAL_SKILL_MAX_BYTES = 256 * 1024; // == @talyn/shared SKILL_MAX_BYTES (main can't import the workspace package)
ipcMain.handle('skills:list-local', async () => {
  const skillsRoot = path.join(os.homedir(), '.claude', 'skills');
  let dirs: import('fs').Dirent[];
  try {
    dirs = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return []; // no ~/.claude/skills — nothing local
  }
  const results = await Promise.all(
    dirs
      .filter((d) => d.isDirectory())
      .map(async (dir) => {
        const skillPath = path.join(skillsRoot, dir.name, 'SKILL.md');
        try {
          const stat = await fs.stat(skillPath);
          if (!stat.isFile()) return null;
          const entry = {
            dirName: dir.name,
            path: skillPath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
          if (stat.size > LOCAL_SKILL_MAX_BYTES) return { ...entry, content: null };
          return { ...entry, content: await fs.readFile(skillPath, 'utf8') };
        } catch {
          return null; // dir without SKILL.md, or unreadable
        }
      })
  );
  return results.filter((r) => r !== null);
});

registerDeepLinkProtocol();

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug').default();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  // In dev the app isn't packaged, so macOS shows Electron's default dock
  // icon; set ours at runtime (packaged builds get it from icon.icns).
  // Dev builds use the amber-background variant so the dock icon makes it
  // obvious at a glance this isn't the production app.
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(
      getAssetPath('icons', IS_DEV_BUILD ? 'dev-512x512.png' : '512x512.png')
    );
  }

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    // Warm off-white, matching the default light theme's content surface —
    // avoids a stark white flash on launch.
    backgroundColor: '#fcfbf8',
    // macOS: drop the native title bar and float the inset traffic lights
    // over the renderer, which reserves a drag strip for them (sidebar top
    // in MainLayout, a fixed overlay on chrome-less screens).
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hiddenInset' as const,
    }),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
      // Explicit defense-in-depth: these are the Electron defaults on
      // recent versions, but pinning them makes the posture visible
      // and survives future default-flipping.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
    // If a deep-link came in while the window was booting, deliver it now.
    if (pendingAuthCallbackUrl) {
      mainWindow.webContents.send('auth:callback', pendingAuthCallbackUrl);
      pendingAuthCallbackUrl = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Renderer crash recovery: reload the window instead of leaving a dead
  // white pane. Guard against a tight crash loop — if the renderer dies more
  // than RENDER_CRASH_MAX times inside RENDER_CRASH_WINDOW_MS, stop reloading
  // and surface a native dialog instead.
  const RENDER_CRASH_MAX = 3;
  const RENDER_CRASH_WINDOW_MS = 60_000;
  const crashTimestamps: number[] = [];
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    // A deliberate teardown (window close, app quit) isn't a crash.
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    crashTimestamps.push(now);
    while (
      crashTimestamps.length &&
      now - crashTimestamps[0] > RENDER_CRASH_WINDOW_MS
    ) {
      crashTimestamps.shift();
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (crashTimestamps.length > RENDER_CRASH_MAX) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: 'Talyn keeps crashing.',
        detail: `The app window crashed repeatedly (${details.reason}). Try restarting Talyn; if it persists, report it at github.com/Gilbert09/talyn/issues.`,
      });
      return;
    }
    mainWindow.webContents.reload();
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser (http/https only — see the guard).
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    openExternalGuarded(edata.url);
    return { action: 'deny' };
  });

  // The window must never navigate away from the app's own index — a
  // compromised or misbehaving renderer following an <a href> (or a
  // redirect) would otherwise load remote content with our preload bridge
  // attached. Block everything else; http(s) targets open in the browser.
  const appIndexUrl = resolveHtmlPath('index.html');
  const guardNavigation = (
    event: { preventDefault: () => void },
    url: string
  ) => {
    if (url.split('#')[0] === appIndexUrl) return;
    event.preventDefault();
    openExternalGuarded(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(() => {
    createWindow();
    // Registers updater IPC handlers + background checks once for the app.
    // Reads the live window lazily so events reach whatever window exists.
    initAutoUpdater(() => mainWindow);
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
