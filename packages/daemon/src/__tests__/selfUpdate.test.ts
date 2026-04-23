import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

import { performSelfUpdate } from '../selfUpdate.js';
import * as executor from '../executor.js';

describe('performSelfUpdate — safety gates', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FASTOWL_SELF_UPDATE_ENABLED;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('refuses when FASTOWL_SELF_UPDATE_ENABLED is not set', async () => {
    await expect(performSelfUpdate({})).rejects.toThrow(
      /Self-update is disabled/,
    );
  });

  it('refuses when FASTOWL_SELF_UPDATE_ENABLED is set but not exactly "true"', async () => {
    // Strict equality check in the source — "1", "yes", "TRUE" all
    // leave the gate closed. Intentional: we don't want operators
    // enabling this by accident.
    for (const bad of ['1', 'yes', 'TRUE', 'True']) {
      process.env.FASTOWL_SELF_UPDATE_ENABLED = bad;
      await expect(performSelfUpdate({})).rejects.toThrow(
        /Self-update is disabled/,
      );
    }
  });

  it('rejects when the daemon is not a source install (findSourceRoot returns null)', async () => {
    // In the dev monorepo checkout, no walked-up package.json has a
    // workspaces entry whose string contains "daemon", so
    // findSourceRoot returns null. The gate-passing path lands on the
    // source-install-only error.
    process.env.FASTOWL_SELF_UPDATE_ENABLED = 'true';
    await expect(performSelfUpdate({})).rejects.toThrow(
      /source-install daemons/,
    );
  });

  it('throws "daemon is busy" when active sessions do not drain before the deadline', async () => {
    process.env.FASTOWL_SELF_UPDATE_ENABLED = 'true';

    // Fake a source-install layout by redirecting fs reads of
    // package.json files to return a workspaces manifest with a
    // "daemon" entry. Minimal surface — we only fake the package.json
    // walk, other fs calls pass through.
    const realExists = fs.existsSync;
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return true;
      return realExists(p as fs.PathLike);
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, enc?: BufferEncoding) => {
      if (typeof p === 'string' && p.endsWith('package.json')) {
        return JSON.stringify({ workspaces: ['packages/daemon'] });
      }
      return realRead(p as fs.PathLike, enc);
    }) as typeof fs.readFileSync);

    // Pretend there's a stuck session so drain never completes.
    vi.spyOn(executor, 'listActiveSessions').mockReturnValue([
      { sessionId: 'stuck', pid: 9999, startedAt: Date.now() },
    ]);

    await expect(performSelfUpdate({ drainTimeoutSeconds: 1 })).rejects.toThrow(
      /did not drain within 1s/,
    );
  });
});
