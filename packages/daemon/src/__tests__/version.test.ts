import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { resolveDaemonVersion } from '../version.js';

describe('resolveDaemonVersion', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  beforeEach(() => {
    delete process.env.FASTOWL_DAEMON_SHA;
    delete process.env.GITHUB_SHA;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    process.chdir(originalCwd);
  });

  it('prefers FASTOWL_DAEMON_SHA over GITHUB_SHA', () => {
    process.env.FASTOWL_DAEMON_SHA = 'aaaaaaabbbbbbbccccccc';
    process.env.GITHUB_SHA = 'ffffffff';
    const v = resolveDaemonVersion();
    // Format is <pkgVersion>+<short-sha>; short-sha is first 7 chars.
    expect(v).toMatch(/^[0-9a-zA-Z.-]+\+aaaaaaa$/);
  });

  it('falls back to GITHUB_SHA when FASTOWL_DAEMON_SHA is unset', () => {
    process.env.GITHUB_SHA = '1234567abcdef';
    const v = resolveDaemonVersion();
    expect(v).toMatch(/\+1234567$/);
  });

  it('ignores an empty-string FASTOWL_DAEMON_SHA (treats as unset)', () => {
    process.env.FASTOWL_DAEMON_SHA = '';
    process.env.GITHUB_SHA = 'deadbeefcafebabe';
    const v = resolveDaemonVersion();
    expect(v).toMatch(/\+deadbee$/);
  });

  it('returns the dev-suffix shape when no SHA is resolvable from env or disk', () => {
    // Block every version.json candidate on disk so we force the
    // "no build identity available" path. Leave package.json lookups
    // intact so the pkgVersion part is still populated.
    const origExists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('version.json')) return false;
      return origExists(p as fs.PathLike);
    });

    const v = resolveDaemonVersion();
    expect(v).toMatch(/-dev$/);
    // And it should NOT contain a `+` (sha marker).
    expect(v).not.toMatch(/\+/);
  });

  it('includes the daemon package version in the output', () => {
    process.env.FASTOWL_DAEMON_SHA = '1234567';
    const v = resolveDaemonVersion();
    // Shape "<semver>+1234567" — pkg version is read from the daemon
    // package.json via a path walk.
    const [pkgPart] = v.split('+');
    expect(pkgPart).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('picks up a version.json from cwd when no env var is set', () => {
    // Write a fake version.json in a tmpdir and chdir there. The
    // resolver's `path.resolve(process.cwd(), 'version.json')` candidate
    // will find it. Other candidates (packages/daemon/version.json,
    // monorepo/version.json) may or may not exist on disk; we block
    // those so the cwd candidate is the one that matches.
    const tmp = path.join(
      os.tmpdir(),
      `fastowl-version-test-${randomBytes(4).toString('hex')}`,
    );
    fs.mkdirSync(tmp, { recursive: true });
    // macOS's /tmp is a symlink to /private/tmp; process.cwd() returns
    // the resolved realpath after chdir. Accept either spelling in the
    // filter so the cwd candidate path makes it through.
    const realTmp = fs.realpathSync(tmp);
    fs.writeFileSync(
      path.join(tmp, 'version.json'),
      JSON.stringify({ sha: 'feedbeeeead', builtAt: '2024-01-01T00:00:00Z' }),
    );
    try {
      const origExists = fs.existsSync;
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith('version.json')) {
          if (s.startsWith(tmp) || s.startsWith(realTmp)) {
            return origExists(p as fs.PathLike);
          }
          return false;
        }
        return origExists(p as fs.PathLike);
      });

      process.chdir(tmp);
      const v = resolveDaemonVersion();
      expect(v).toMatch(/\+feedbee$/);
    } finally {
      // Windows refuses to rmdir the cwd of a running process
      // (EBUSY). The afterEach also chdirs back, but that runs after
      // this finally — so we need to escape tmp before deleting it.
      process.chdir(originalCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
