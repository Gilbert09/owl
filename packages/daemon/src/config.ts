import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * On-disk state for the daemon. Small enough to hand-roll; avoids a
 * config library. Lives at `~/.fastowl/daemon.json` for user installs
 * or `/etc/fastowl/daemon.json` for system installs (systemd).
 *
 * CLI args and environment variables take precedence — the file is the
 * fallback used on reboots.
 */
export interface DaemonConfig {
  backendUrl: string;
  deviceToken?: string; // set after the first successful pairing
}

const USER_CONFIG = path.join(os.homedir(), '.fastowl', 'daemon.json');
const SYSTEM_CONFIG = '/etc/fastowl/daemon.json';

export function resolveConfigPath(): string {
  // If a system install exists we prefer it — systemd units use it
  // and expect the root-owned file. Otherwise fall back to the user's
  // home dir.
  try {
    fs.accessSync(SYSTEM_CONFIG, fs.constants.R_OK);
    return SYSTEM_CONFIG;
  } catch {
    return USER_CONFIG;
  }
}

export function loadConfig(): DaemonConfig | null {
  const p = resolveConfigPath();
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw) as DaemonConfig;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function saveConfig(config: DaemonConfig): void {
  const p = resolveConfigPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export interface ResolvedConfig {
  backendUrl: string;
  pairingToken?: string;
  deviceToken?: string;
}

/**
 * Merge CLI/env/file sources. Precedence (highest first):
 *   1. CLI flags (--backend-url, --pairing-token)
 *   2. Env vars (FASTOWL_BACKEND_URL, FASTOWL_PAIRING_TOKEN)
 *   3. On-disk config file
 *
 * Pairing tokens are never persisted — they're one-shot. Device tokens
 * only come from the config file (the backend writes them after pairing).
 */
export function resolveConfig(argv: string[]): ResolvedConfig {
  const cli = parseCliArgs(argv);
  const file = loadConfig();

  const backendUrl =
    cli.backendUrl ?? process.env.FASTOWL_BACKEND_URL ?? file?.backendUrl;
  if (!backendUrl) {
    throw new Error(
      'No backend URL configured. Pass --backend-url, set FASTOWL_BACKEND_URL, or install via `fastowl daemon install`.'
    );
  }

  const pairingToken = cli.pairingToken ?? process.env.FASTOWL_PAIRING_TOKEN;
  const deviceToken = file?.deviceToken;

  if (!pairingToken && !deviceToken) {
    throw new Error(
      'Daemon has neither a pairing token nor a stored device token. Start with `--pairing-token <token>` on first run.'
    );
  }

  return { backendUrl, pairingToken, deviceToken };
}

function parseCliArgs(argv: string[]): { backendUrl?: string; pairingToken?: string } {
  const out: { backendUrl?: string; pairingToken?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--backend-url' && argv[i + 1]) {
      out.backendUrl = argv[i + 1];
      i++;
    } else if (arg === '--pairing-token' && argv[i + 1]) {
      out.pairingToken = argv[i + 1];
      i++;
    } else if (arg.startsWith('--backend-url=')) {
      out.backendUrl = arg.slice('--backend-url='.length);
    } else if (arg.startsWith('--pairing-token=')) {
      out.pairingToken = arg.slice('--pairing-token='.length);
    }
  }
  return out;
}
