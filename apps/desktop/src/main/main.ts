/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import { app, BrowserWindow, shell, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;
// Buffer callbacks that arrive before the renderer is ready — macOS
// open-url can fire during app launch, before any window exists.
let pendingAuthCallbackUrl: string | null = null;

ipcMain.on('ipc-example', async (event, arg) => {
  const msgTemplate = (pingPong: string) => `IPC test: ${pingPong}`;
  console.log(msgTemplate(arg));
  event.reply('ipc-example', msgTemplate('pong'));
});

// ============================================================================
// Auth deep-link handling
// ============================================================================
//
// After a user signs in via GitHub in their system browser, Supabase
// redirects to `fastowl://auth-callback#access_token=...&refresh_token=...`.
// The OS hands that URL to whichever app claims the `fastowl` scheme —
// i.e. us. We forward it over IPC to the renderer, which feeds the tokens
// to the Supabase client.

const DEEP_LINK_SCHEME = 'fastowl';

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

// Renderer asks us to open OAuth URLs in the default browser.
ipcMain.handle('auth:open-external', async (_event, url: string) => {
  await shell.openExternal(url);
});

// Renderer asks on mount for any deep-link that arrived before it was ready.
ipcMain.handle('auth:drain-pending', async () => {
  const pending = pendingAuthCallbackUrl;
  pendingAuthCallbackUrl = null;
  return pending;
});

registerDeepLinkProtocol();

// ============================================================================

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

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
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

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
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
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
