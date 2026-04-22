import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { daemonAutoUpdate } from '../services/daemonAutoUpdate.js';
import { daemonRegistry } from '../services/daemonRegistry.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';

const LATEST = 'abc1234';

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('daemonAutoUpdate', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    daemonAutoUpdate.init(); // Idempotent; subscribes to daemonRegistry once.
  });

  afterAll(() => {
    daemonAutoUpdate.shutdown();
  });

  beforeEach(async () => {
    process.env.FASTOWL_BUILD_SHA = LATEST;
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    // Stub registry request + connectivity so tests don't talk to a
    // real daemon.
    vi.spyOn(daemonRegistry, 'isConnected').mockReturnValue(true);
  });

  afterEach(async () => {
    await cleanup();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function seedEnv(overrides: {
    type?: 'local' | 'remote';
    autoUpdateDaemon?: boolean;
    daemonVersion?: string | null;
  }): Promise<string> {
    const id = `env-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(environmentsTable).values({
      id,
      ownerId: TEST_USER_ID,
      name: 'e',
      type: overrides.type ?? 'remote',
      status: 'connected',
      config: {},
      autoUpdateDaemon: overrides.autoUpdateDaemon ?? false,
      daemonVersion: overrides.daemonVersion ?? null,
    });
    return id;
  }

  it('does nothing for local envs (desktop ships its own daemon)', async () => {
    const envId = await seedEnv({ type: 'local', autoUpdateDaemon: true, daemonVersion: `0.1.0+stale123` });
    const request = vi.spyOn(daemonRegistry, 'request').mockResolvedValue({
      newSha: 'zzz',
      message: 'x',
    } as unknown as never);

    daemonRegistry.emit('daemon:connected', envId);
    // Wait past the 2s settle + some slack.
    await wait(2400);

    expect(request).not.toHaveBeenCalled();
  });

  it('does nothing when autoUpdateDaemon is false', async () => {
    const envId = await seedEnv({ type: 'remote', autoUpdateDaemon: false, daemonVersion: `0.1.0+stale123` });
    const request = vi.spyOn(daemonRegistry, 'request').mockResolvedValue({
      newSha: 'zzz',
      message: 'x',
    } as unknown as never);

    daemonRegistry.emit('daemon:connected', envId);
    await wait(2400);

    expect(request).not.toHaveBeenCalled();
  });

  it('does nothing when the reported SHA already matches latest', async () => {
    const envId = await seedEnv({
      type: 'remote',
      autoUpdateDaemon: true,
      daemonVersion: `0.1.0+${LATEST}`,
    });
    const request = vi.spyOn(daemonRegistry, 'request').mockResolvedValue({
      newSha: 'zzz',
      message: 'x',
    } as unknown as never);

    daemonRegistry.emit('daemon:connected', envId);
    await wait(2400);

    expect(request).not.toHaveBeenCalled();
  });

  it('does nothing when the env never reported a SHA (unpaired)', async () => {
    const envId = await seedEnv({
      type: 'remote',
      autoUpdateDaemon: true,
      daemonVersion: null,
    });
    const request = vi.spyOn(daemonRegistry, 'request').mockResolvedValue({
      newSha: 'zzz',
      message: 'x',
    } as unknown as never);

    daemonRegistry.emit('daemon:connected', envId);
    await wait(2400);

    expect(request).not.toHaveBeenCalled();
  });

  it('triggers update_daemon when autoUpdate + remote + stale SHA', async () => {
    const envId = await seedEnv({
      type: 'remote',
      autoUpdateDaemon: true,
      daemonVersion: `0.1.0+older11`,
    });
    const request = vi.spyOn(daemonRegistry, 'request').mockResolvedValue({
      newSha: LATEST,
      message: 'Updated',
    } as unknown as never);

    daemonRegistry.emit('daemon:connected', envId);
    await wait(2400);

    expect(request).toHaveBeenCalledTimes(1);
    const call = request.mock.calls[0];
    expect(call[0]).toBe(envId);
    expect((call[1] as { op: string }).op).toBe('update_daemon');
  });

  it('does nothing when no latest SHA env var is set (cannot compare)', async () => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    delete process.env.FASTOWL_BUILD_SHA;
    delete process.env.GITHUB_SHA;

    const envId = await seedEnv({
      type: 'remote',
      autoUpdateDaemon: true,
      daemonVersion: `0.1.0+older11`,
    });
    const request = vi.spyOn(daemonRegistry, 'request').mockResolvedValue({
      newSha: 'zzz',
      message: 'x',
    } as unknown as never);

    daemonRegistry.emit('daemon:connected', envId);
    await wait(2400);

    expect(request).not.toHaveBeenCalled();
  });

  it('does not issue a second request while one is in flight for the same env (inFlight dedup)', async () => {
    const envId = await seedEnv({
      type: 'remote',
      autoUpdateDaemon: true,
      daemonVersion: `0.1.0+older11`,
    });
    // Slow request so the second emit fires while the first is still
    // in flight.
    const request = vi
      .spyOn(daemonRegistry, 'request')
      .mockImplementation(
        () => new Promise((r) => setTimeout(() => r({ newSha: LATEST, message: 'ok' }), 800))
      );

    daemonRegistry.emit('daemon:connected', envId);
    // Fire the second connect event just as the first update request
    // will be in flight (past the 2s settle).
    setTimeout(() => daemonRegistry.emit('daemon:connected', envId), 2100);

    await wait(3500);

    // Only one call despite two connect events.
    expect(request).toHaveBeenCalledTimes(1);
  });
});
