/**
 * Local daemon lifecycle — installs, starts, stops, and inspects the
 * FastOwl daemon as a user-level OS service on the host machine.
 *
 * The daemon is a long-running background process that outlives the
 * desktop app: cmd-Q'ing Electron, closing the main window, and even
 * logging out and back in should leave the daemon running (well, log-out
 * kills user services, but re-login brings them back via RunAtLoad).
 * Only an explicit uninstall or a force-reboot stops it.
 *
 * Layout per platform:
 *   macOS:
 *     binary:  ~/Library/Application Support/FastOwl/daemon/fastowl-daemon
 *     plist:   ~/Library/LaunchAgents/com.fastowl.daemon.plist
 *     label:   com.fastowl.daemon
 *   Linux:
 *     binary:  ~/.local/share/fastowl/daemon/fastowl-daemon
 *     unit:    ~/.config/systemd/user/fastowl-daemon.service
 *     name:    fastowl-daemon
 *   Windows:
 *     deferred — tracked in docs/DAEMON_EVERYWHERE.md Slice 3.
 *
 * In development (NODE_ENV=development) we spawn the daemon as an
 * Electron child process instead — iterating on daemon code shouldn't
 * require `launchctl kickstart` every time.
 */
import { spawn, spawnSync, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import log from 'electron-log';

const LABEL = 'com.fastowl.daemon';
const UNIT_NAME = 'fastowl-daemon';

export interface DaemonStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
}

// --------------------------------------------------------------------
// Path resolution
// --------------------------------------------------------------------

/**
 * Where the daemon binary should live once installed. Separate from the
 * app bundle so uninstalling/updating the app doesn't immediately break
 * the daemon, and so the OS service's plist/unit can point at a stable
 * path across app updates.
 */
export function installedBinaryPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library/Application Support/FastOwl/daemon/fastowl-daemon');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.local/share/fastowl/daemon/fastowl-daemon');
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}

/**
 * Where the daemon binary currently ships from inside the desktop app.
 * In prod, electron-builder puts it under Contents/Resources/daemon/
 * via the extraResources entry in apps/desktop/package.json. In dev
 * there's no bundled binary — callers must take the dev-child path.
 */
export function bundledBinaryPath(): string {
  if (!app.isPackaged) {
    throw new Error('bundledBinaryPath() only valid in packaged app');
  }
  const filename = process.platform === 'win32' ? 'fastowl-daemon.exe' : 'fastowl-daemon';
  return path.join(process.resourcesPath, 'daemon', filename);
}

// --------------------------------------------------------------------
// Install / uninstall
// --------------------------------------------------------------------

/**
 * Copy the bundled binary into place, chmod +x, and write the OS
 * service unit. Idempotent — safe to call on every app launch.
 *
 * Does NOT start the daemon. The caller is expected to write a
 * pairing token (or verify a device token already exists) and then
 * call `startDaemon()` separately. This keeps the install path simple
 * and lets Slice 4's pairing flow own the "now actually run it" step.
 */
export async function installDaemon(options: { backendUrl: string }): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`installDaemon not yet supported on ${process.platform}`);
  }
  const src = bundledBinaryPath();
  const dst = installedBinaryPath();
  const dstDir = path.dirname(dst);

  if (!fs.existsSync(src)) {
    throw new Error(`bundled daemon binary not found at ${src}`);
  }
  fs.mkdirSync(dstDir, { recursive: true });

  const needsCopy = !fs.existsSync(dst) || !filesEqual(src, dst);
  if (needsCopy) {
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
    log.info(`[localDaemon] installed binary to ${dst}`);
  }

  // Seed daemon config with the backend URL before we start it.
  writeDaemonConfig({ backendUrl: options.backendUrl });

  if (process.platform === 'darwin') {
    writeLaunchdPlist(dst);
    bootstrapLaunchd();
  } else {
    writeSystemdUnit(dst);
    reloadSystemd();
  }
}

export function uninstallDaemon(): void {
  if (process.platform === 'darwin') {
    booutLaunchd();
    rmSafe(launchdPlistPath());
  } else if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
    rmSafe(systemdUnitPath());
    spawnSync('systemctl', ['--user', 'daemon-reload']);
  }
  // We deliberately leave the binary + config on disk. A full wipe is
  // the user's call (documented in the .app's Scripts/fastowl-uninstall.sh).
}

// --------------------------------------------------------------------
// Start / stop / status
// --------------------------------------------------------------------

export function startDaemon(): void {
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/${LABEL}`], {
      stdio: 'ignore',
    });
  } else if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'start', UNIT_NAME], { stdio: 'ignore' });
  }
}

export function stopDaemon(): void {
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['kill', 'SIGTERM', `gui/${process.getuid?.()}/${LABEL}`], {
      stdio: 'ignore',
    });
  } else if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'stop', UNIT_NAME], { stdio: 'ignore' });
  }
}

export function daemonStatus(): DaemonStatus {
  if (process.platform === 'darwin') {
    const installed = fs.existsSync(launchdPlistPath());
    const r = spawnSync('launchctl', ['list', LABEL], { encoding: 'utf-8' });
    // `launchctl list <label>` exits 0 if loaded; parses as plist-ish
    // k/v; PID = - means loaded but not currently running.
    if (r.status !== 0) return { installed, running: false };
    const pidMatch = r.stdout.match(/"PID"\s*=\s*(\d+);/);
    const pid = pidMatch ? Number(pidMatch[1]) : undefined;
    return { installed, running: pid !== undefined, pid };
  }
  if (process.platform === 'linux') {
    const installed = fs.existsSync(systemdUnitPath());
    const r = spawnSync('systemctl', ['--user', 'is-active', UNIT_NAME], { encoding: 'utf-8' });
    return { installed, running: r.stdout.trim() === 'active' };
  }
  return { installed: false, running: false };
}

// --------------------------------------------------------------------
// Dev-mode: run daemon as an Electron child
// --------------------------------------------------------------------

let devChild: ChildProcess | null = null;

/**
 * Dev mode spawns `tsx packages/daemon/src/index.ts` under the desktop
 * app's lifetime. Restarting Electron restarts the daemon — which is
 * what you want when iterating on daemon code.
 *
 * __dirname in dev is `apps/desktop/.erb/dll/` (webpack main bundle
 * lives there). Four levels up = repo root.
 */
export function startDevDaemon(backendUrl: string): void {
  if (devChild) return;
  const repoRoot = path.resolve(__dirname, '../../../..');
  const daemonEntry = path.join(repoRoot, 'packages/daemon/src/index.ts');
  const tsxBin = path.join(repoRoot, 'node_modules/.bin/tsx');
  if (!fs.existsSync(daemonEntry)) {
    log.warn(`[localDaemon] dev daemon entry not found at ${daemonEntry}; skipping`);
    return;
  }
  if (!fs.existsSync(tsxBin)) {
    log.warn(`[localDaemon] tsx binary not found at ${tsxBin}; skipping`);
    return;
  }
  writeDaemonConfig({ backendUrl });
  devChild = spawn(tsxBin, [daemonEntry, '--backend-url', backendUrl], {
    stdio: 'pipe',
    env: { ...process.env },
    cwd: repoRoot,
    detached: false,
  });
  devChild.stdout?.on('data', (d) => log.info(`[daemon] ${d.toString().trimEnd()}`));
  devChild.stderr?.on('data', (d) => log.warn(`[daemon] ${d.toString().trimEnd()}`));
  devChild.on('exit', (code, signal) => {
    log.info(`[localDaemon] dev daemon exited code=${code} signal=${signal}`);
    devChild = null;
  });
}

export function stopDevDaemon(): void {
  if (!devChild) return;
  devChild.kill('SIGTERM');
  devChild = null;
}

// --------------------------------------------------------------------
// Helpers — launchd
// --------------------------------------------------------------------

function launchdPlistPath(): string {
  return path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
}

function writeLaunchdPlist(binaryPath: string): void {
  const logDir = path.join(os.homedir(), 'Library/Logs/FastOwl');
  fs.mkdirSync(logDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, 'daemon.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, 'daemon.err.log')}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
  fs.writeFileSync(launchdPlistPath(), plist, { mode: 0o644 });
}

function bootstrapLaunchd(): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('no uid on this process');
  // `bootstrap` is the modern replacement for the old `launchctl load`.
  // If it's already loaded, bootstrap returns non-zero; that's fine —
  // we run bootout first to make the operation idempotent.
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  const r = spawnSync(
    'launchctl',
    ['bootstrap', `gui/${uid}`, launchdPlistPath()],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0) {
    log.error(`[localDaemon] launchctl bootstrap failed: ${r.stderr}`);
    throw new Error(`launchctl bootstrap failed (exit ${r.status}): ${r.stderr}`);
  }
  log.info('[localDaemon] launchd agent bootstrapped');
}

function booutLaunchd(): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
}

// --------------------------------------------------------------------
// Helpers — systemd --user
// --------------------------------------------------------------------

function systemdUnitPath(): string {
  return path.join(os.homedir(), '.config/systemd/user', `${UNIT_NAME}.service`);
}

function writeSystemdUnit(binaryPath: string): void {
  const unit = `[Unit]
Description=FastOwl daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${binaryPath}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
  const unitPath = systemdUnitPath();
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, unit, { mode: 0o644 });
}

function reloadSystemd(): void {
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  spawnSync('systemctl', ['--user', 'enable', UNIT_NAME], { stdio: 'ignore' });
}

// --------------------------------------------------------------------
// Helpers — daemon config file
// --------------------------------------------------------------------

interface DaemonConfigPatch {
  backendUrl?: string;
  pairingToken?: string;
  deviceToken?: string;
}

/**
 * Merge a patch into `~/.fastowl/daemon.json`. The daemon reads this
 * file on startup (see packages/daemon/src/config.ts) — all three
 * fields above are what it expects.
 */
export function writeDaemonConfig(patch: DaemonConfigPatch): void {
  const configPath = path.join(os.homedir(), '.fastowl/daemon.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  let existing: DaemonConfigPatch = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // corrupt config — overwrite is fine, pairing will re-seed it
    }
  }
  const merged = { ...existing, ...patch };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
}

// --------------------------------------------------------------------
// Misc
// --------------------------------------------------------------------

function filesEqual(a: string, b: string): boolean {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  // Cheap check — size + mtime is good enough for "did the update
  // change the binary?" We don't need cryptographic equality here.
  return sa.mtimeMs === sb.mtimeMs;
}

function rmSafe(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
