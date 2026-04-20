import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { daemonRegistry } from '../services/daemonRegistry.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { environments as environmentsTable } from '../db/schema.js';
import type { Database } from '../db/client.js';

// Minimal WebSocket stand-in — only needs the bits the registry touches
// (`send` + `close`). Keeps tests fast and deterministic.
class FakeWs extends EventEmitter {
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  readyState = 1; // OPEN
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
}

async function seedDaemonEnv(db: Database, id: string): Promise<void> {
  await db.insert(environmentsTable).values({
    id,
    ownerId: TEST_USER_ID,
    name: 'daemon-test',
    type: 'remote',
    status: 'disconnected',
    config: { type: 'remote' },
  });
}

describe('daemonRegistry', () => {
  let cleanup: (() => Promise<void>) | null = null;
  let db: Database;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db);
    daemonRegistry.init();
  });

  afterEach(async () => {
    await daemonRegistry.shutdown();
    daemonRegistry.removeAllListeners();
    await cleanup?.();
    cleanup = null;
  });

  it('pairing token authenticates once and mints a device token', async () => {
    await seedDaemonEnv(db, 'env-pair');
    const pairing = daemonRegistry.createPairingToken('env-pair', TEST_USER_ID);

    const first = await daemonRegistry.authenticate({ pairingToken: pairing });
    expect(first?.environmentId).toBe('env-pair');
    expect(first?.newDeviceToken).toBeTypeOf('string');

    // One-shot: second use rejects.
    const second = await daemonRegistry.authenticate({ pairingToken: pairing });
    expect(second).toBeNull();
  });

  it('device token matches a stored hash on subsequent connects', async () => {
    await seedDaemonEnv(db, 'env-reconnect');
    const pairing = daemonRegistry.createPairingToken('env-reconnect', TEST_USER_ID);
    const { newDeviceToken } = (await daemonRegistry.authenticate({ pairingToken: pairing }))!;

    const reconnect = await daemonRegistry.authenticate({ deviceToken: newDeviceToken });
    expect(reconnect?.environmentId).toBe('env-reconnect');
    // Subsequent connects do not issue a new device token.
    expect(reconnect?.newDeviceToken).toBeUndefined();
  });

  it('request/resolveResponse round-trips data payloads', async () => {
    await seedDaemonEnv(db, 'env-rpc');
    const ws = new FakeWs();
    daemonRegistry.register({
      environmentId: 'env-rpc',
      ws: ws as unknown as never,
      meta: { os: 'darwin', arch: 'arm64', hostname: 'mac', daemonVersion: '0.1.0' },
    });

    // Kick off a request — the registry serializes it to the ws.
    const promise = daemonRegistry.request('env-rpc', { op: 'ping' });
    expect(ws.sent).toHaveLength(1);
    const { id } = JSON.parse(ws.sent[0]);

    daemonRegistry.resolveResponse(id, true, { pong: true });
    await expect(promise).resolves.toEqual({ pong: true });
  });

  it('disconnecting a daemon rejects its in-flight requests', async () => {
    await seedDaemonEnv(db, 'env-drop');
    const ws = new FakeWs();
    daemonRegistry.register({
      environmentId: 'env-drop',
      ws: ws as unknown as never,
      meta: { os: 'darwin', arch: 'arm64', hostname: 'mac', daemonVersion: '0.1.0' },
    });

    const inflight = daemonRegistry.request('env-drop', { op: 'ping' });
    daemonRegistry.unregister('env-drop');

    await expect(inflight).rejects.toThrow(/disconnected/);
  });

  it('forwards daemon events as EventEmitter events', () => {
    const handler = vi.fn();
    daemonRegistry.on('session.data', handler);
    daemonRegistry.handleEvent('env-event', {
      type: 'session.data',
      sessionId: 's1',
      dataBase64: Buffer.from('hi').toString('base64'),
    });
    expect(handler).toHaveBeenCalledWith(
      'env-event',
      expect.objectContaining({ sessionId: 's1' })
    );
  });
});
