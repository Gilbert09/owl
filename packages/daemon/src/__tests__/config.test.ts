import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Override HOME/USERPROFILE BEFORE importing the config module.
// `USER_CONFIG` captures os.homedir() at module-load time, so all the
// tests in this file share the same tmp-dir-rooted home.
const TEST_HOME = path.join(
  os.tmpdir(),
  `fastowl-daemon-config-test-${randomBytes(4).toString('hex')}`,
);
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
fs.mkdirSync(TEST_HOME, { recursive: true });

const { resolveConfig, loadConfig, saveConfig, resolveConfigPath } = await import(
  '../config.js'
);

const FASTOWL_DIR = path.join(TEST_HOME, '.fastowl');
const USER_CONFIG_PATH = path.join(FASTOWL_DIR, 'daemon.json');

function cleanHome(): void {
  if (fs.existsSync(FASTOWL_DIR)) {
    fs.rmSync(FASTOWL_DIR, { recursive: true, force: true });
  }
}

describe('daemon config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    cleanHome();
    // Strip any FASTOWL_* vars a parent shell might have set — tests
    // need a clean env surface so CLI/env/file precedence assertions
    // aren't contaminated by the host.
    delete process.env.FASTOWL_BACKEND_URL;
    delete process.env.FASTOWL_PAIRING_TOKEN;
  });

  afterEach(() => {
    cleanHome();
    process.env = { ...originalEnv };
  });

  describe('resolveConfigPath', () => {
    it('falls back to $HOME/.fastowl/daemon.json when no system config exists', () => {
      // /etc/fastowl/daemon.json doesn't exist on CI runners; resolver
      // hits ENOENT on accessSync and returns the user path.
      expect(resolveConfigPath()).toBe(USER_CONFIG_PATH);
    });
  });

  describe('saveConfig + loadConfig', () => {
    it('round-trips a config through disk', () => {
      saveConfig({ backendUrl: 'https://backend.example', deviceToken: 'tok-1' });
      expect(loadConfig()).toEqual({
        backendUrl: 'https://backend.example',
        deviceToken: 'tok-1',
      });
    });

    it('creates the .fastowl directory with restrictive perms on first save', () => {
      saveConfig({ backendUrl: 'https://b', deviceToken: 't' });
      const dirStat = fs.statSync(FASTOWL_DIR);
      const fileStat = fs.statSync(USER_CONFIG_PATH);
      // Mask & 0o777 — ignore the upper type bits; only compare perm
      // bits. 0o700 dir / 0o600 file: owner-only read/write, nothing
      // for group or world. Not enforced on Windows but CI test os
      // runners on win don't hit this assertion path — skip there.
      if (process.platform !== 'win32') {
        expect(dirStat.mode & 0o777).toBe(0o700);
        expect(fileStat.mode & 0o777).toBe(0o600);
      }
    });

    it('returns null when the file does not exist', () => {
      expect(loadConfig()).toBeNull();
    });

    it('overwrites the existing file — save is idempotent', () => {
      saveConfig({ backendUrl: 'https://a', deviceToken: 'first' });
      saveConfig({ backendUrl: 'https://a', deviceToken: 'second' });
      expect(loadConfig()?.deviceToken).toBe('second');
    });

    it('throws on read errors other than ENOENT', () => {
      // Seed a file, then make it unreadable. readFileSync will raise
      // EACCES, not ENOENT, so loadConfig should rethrow.
      if (process.platform === 'win32') return; // chmod semantics differ.
      saveConfig({ backendUrl: 'https://b', deviceToken: 't' });
      fs.chmodSync(USER_CONFIG_PATH, 0o000);
      try {
        expect(() => loadConfig()).toThrow();
      } finally {
        // Restore so cleanHome can remove it.
        fs.chmodSync(USER_CONFIG_PATH, 0o600);
      }
    });
  });

  describe('resolveConfig — precedence', () => {
    it('prefers CLI flags over env vars over file', () => {
      saveConfig({ backendUrl: 'https://from-file', deviceToken: 'dev-tok' });
      process.env.FASTOWL_BACKEND_URL = 'https://from-env';
      const res = resolveConfig(['--backend-url', 'https://from-cli']);
      expect(res.backendUrl).toBe('https://from-cli');
    });

    it('falls through to env when CLI omits the flag', () => {
      saveConfig({ backendUrl: 'https://from-file', deviceToken: 'tok' });
      process.env.FASTOWL_BACKEND_URL = 'https://from-env';
      const res = resolveConfig([]);
      expect(res.backendUrl).toBe('https://from-env');
    });

    it('falls through to file when CLI + env are both unset', () => {
      saveConfig({ backendUrl: 'https://from-file', deviceToken: 'tok' });
      const res = resolveConfig([]);
      expect(res.backendUrl).toBe('https://from-file');
    });

    it('reads the pairing token from the file when seeded there', () => {
      // The desktop auto-pair flow writes pairing tokens into the file
      // for bundled launchd/systemd daemons. resolveConfig must accept
      // them — handleHelloAck clears them after first use.
      saveConfig({ backendUrl: 'https://b', pairingToken: 'pair-xyz' });
      const res = resolveConfig([]);
      expect(res.pairingToken).toBe('pair-xyz');
      expect(res.deviceToken).toBeUndefined();
    });

    it('prefers CLI pairing token over env over file', () => {
      saveConfig({ backendUrl: 'https://b', pairingToken: 'from-file' });
      process.env.FASTOWL_PAIRING_TOKEN = 'from-env';
      const res = resolveConfig(['--pairing-token', 'from-cli']);
      expect(res.pairingToken).toBe('from-cli');
    });

    it('accepts --flag=value style args', () => {
      const res = resolveConfig([
        '--backend-url=https://b',
        '--pairing-token=pair-1',
      ]);
      expect(res.backendUrl).toBe('https://b');
      expect(res.pairingToken).toBe('pair-1');
    });

    it('allows a device token from the file with no pairing token', () => {
      saveConfig({ backendUrl: 'https://b', deviceToken: 'dev-tok' });
      const res = resolveConfig([]);
      expect(res.deviceToken).toBe('dev-tok');
      expect(res.pairingToken).toBeUndefined();
    });

    it('throws when no backend URL is configured', () => {
      // No file, no env, no CLI — daemon has nothing to dial.
      expect(() => resolveConfig([])).toThrow(/No backend URL configured/);
    });

    it('throws when backend is set but no token is available anywhere', () => {
      // File has backendUrl but no tokens; daemon can't authenticate.
      saveConfig({ backendUrl: 'https://b' });
      expect(() => resolveConfig([])).toThrow(
        /neither a pairing token nor a stored device token/,
      );
    });

    it('ignores an --backend-url flag with no following value', () => {
      // Malformed `--backend-url` with no arg should not consume
      // subsequent args as its value — the parser requires argv[i+1]
      // to exist. Combined with env seeded, precedence still resolves.
      process.env.FASTOWL_BACKEND_URL = 'https://from-env';
      process.env.FASTOWL_PAIRING_TOKEN = 'tok';
      const res = resolveConfig(['--backend-url']);
      expect(res.backendUrl).toBe('https://from-env');
    });
  });
});
