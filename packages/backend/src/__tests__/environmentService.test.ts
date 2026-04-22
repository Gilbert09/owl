import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { environmentService } from '../services/environment.js';
import { daemonRegistry } from '../services/daemonRegistry.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';

describe('environmentService', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(environmentsTable).values({
      id: 'env1',
      ownerId: TEST_USER_ID,
      name: 'local',
      type: 'local',
      status: 'disconnected',
      config: {},
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  describe('getEnvironment / getAllEnvironments', () => {
    it('returns an env by id with default fields', async () => {
      const env = await environmentService.getEnvironment('env1');
      expect(env?.id).toBe('env1');
      expect(env?.type).toBe('local');
      expect(env?.status).toBe('disconnected');
    });

    it('returns null for a missing id', async () => {
      expect(await environmentService.getEnvironment('nope')).toBeNull();
    });

    it('returns all envs', async () => {
      await db.insert(environmentsTable).values({
        id: 'env2',
        ownerId: TEST_USER_ID,
        name: 'remote',
        type: 'remote',
        status: 'connected',
        config: {},
      });
      const envs = await environmentService.getAllEnvironments();
      expect(envs).toHaveLength(2);
    });
  });

  describe('connect', () => {
    it('throws when the env does not exist', async () => {
      await expect(environmentService.connect('ghost')).rejects.toThrow(/not found/);
    });

    it('sets status=connected when the daemon is connected in the registry', async () => {
      vi.spyOn(daemonRegistry, 'isConnected').mockReturnValue(true);
      await environmentService.connect('env1');

      const rows = await db
        .select({ status: environmentsTable.status, error: environmentsTable.error })
        .from(environmentsTable)
        .where(eq(environmentsTable.id, 'env1'));
      expect(rows[0].status).toBe('connected');
      expect(rows[0].error).toBeNull();
    });

    it('sets status=disconnected with an error when the daemon is not connected', async () => {
      vi.spyOn(daemonRegistry, 'isConnected').mockReturnValue(false);
      await environmentService.connect('env1');

      const rows = await db
        .select({ status: environmentsTable.status, error: environmentsTable.error })
        .from(environmentsTable)
        .where(eq(environmentsTable.id, 'env1'));
      expect(rows[0].status).toBe('disconnected');
      expect(rows[0].error).toBe('daemon not connected');
    });
  });

  describe('disconnect', () => {
    it('marks the env disconnected in the DB', async () => {
      await db
        .update(environmentsTable)
        .set({ status: 'connected' })
        .where(eq(environmentsTable.id, 'env1'));

      await environmentService.disconnect('env1');
      const rows = await db
        .select({ status: environmentsTable.status })
        .from(environmentsTable)
        .where(eq(environmentsTable.id, 'env1'));
      expect(rows[0].status).toBe('disconnected');
    });
  });

  describe('run / spawnStreaming / writeToSession / killSession / closeStreamInput', () => {
    it('forwards run() to daemonRegistry.request with op=run', async () => {
      const request = vi.spyOn(daemonRegistry, 'request').mockResolvedValue({
        stdout: 'hi\n', stderr: '', code: 0,
      } as unknown as never);

      const result = await environmentService.run('env1', 'git', ['status'], {
        cwd: '/tmp/x',
      });
      expect(result.stdout).toBe('hi\n');
      expect(request).toHaveBeenCalledWith('env1', expect.objectContaining({
        op: 'run',
        binary: 'git',
        args: ['status'],
        cwd: '/tmp/x',
      }));
    });

    it('forwards spawnStreaming with stream_spawn + base64 stdin', async () => {
      const request = vi.spyOn(daemonRegistry, 'request').mockResolvedValue(undefined as never);

      await environmentService.spawnStreaming('env1', 'sess-1', 'claude', ['--print'], {
        cwd: '/tmp',
        keepStdinOpen: false,
        initialStdin: 'hello',
      });
      expect(request).toHaveBeenCalledWith('env1', expect.objectContaining({
        op: 'stream_spawn',
        sessionId: 'sess-1',
        binary: 'claude',
        args: ['--print'],
        keepStdinOpen: false,
        initialStdinBase64: Buffer.from('hello', 'utf-8').toString('base64'),
      }));
    });

    it('killSession broadcasts to every connected daemon (best-effort)', () => {
      vi.spyOn(daemonRegistry, 'listConnected').mockReturnValue(['env1', 'env2']);
      const request = vi.spyOn(daemonRegistry, 'request').mockResolvedValue(undefined as never);

      environmentService.killSession('sess-kill');
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledWith('env1', expect.objectContaining({
        op: 'kill_session',
        sessionId: 'sess-kill',
      }));
      expect(request).toHaveBeenCalledWith('env2', expect.objectContaining({
        op: 'kill_session',
        sessionId: 'sess-kill',
      }));
    });

    it('writeToSession fan-outs to every connected daemon as well', () => {
      vi.spyOn(daemonRegistry, 'listConnected').mockReturnValue(['env1']);
      const request = vi.spyOn(daemonRegistry, 'request').mockResolvedValue(undefined as never);

      environmentService.writeToSession('sess-write', 'hi');
      expect(request).toHaveBeenCalledWith('env1', expect.objectContaining({
        op: 'write_session',
        sessionId: 'sess-write',
        dataBase64: Buffer.from('hi', 'utf-8').toString('base64'),
      }));
    });

    it('closeStreamInput fan-outs and ignores failures from wrong-owner daemons', async () => {
      vi.spyOn(daemonRegistry, 'listConnected').mockReturnValue(['env1', 'env2']);
      const request = vi
        .spyOn(daemonRegistry, 'request')
        // env1 throws (doesn't own the session) — should be swallowed.
        .mockImplementation(async (envId) => {
          if (envId === 'env1') throw new Error('unknown session');
          return undefined as never;
        });

      await expect(
        environmentService.closeStreamInput('sess-close')
      ).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  describe('testConnection', () => {
    it('returns success:true for local/remote envs (backend does not probe)', async () => {
      expect(
        await environmentService.testConnection({ type: 'local' } as never)
      ).toEqual({ success: true });
      expect(
        await environmentService.testConnection({ type: 'remote' } as never)
      ).toEqual({ success: true });
    });

    it('returns success:false for an unknown env type', async () => {
      const res = await environmentService.testConnection({ type: 'weird' } as never);
      expect(res.success).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('returns disconnected for a missing env', async () => {
      expect(await environmentService.getStatus('ghost')).toBe('disconnected');
    });

    it('reflects daemonRegistry.isConnected for an existing env', async () => {
      vi.spyOn(daemonRegistry, 'isConnected').mockReturnValue(true);
      expect(await environmentService.getStatus('env1')).toBe('connected');

      vi.spyOn(daemonRegistry, 'isConnected').mockReturnValue(false);
      expect(await environmentService.getStatus('env1')).toBe('disconnected');
    });
  });
});
