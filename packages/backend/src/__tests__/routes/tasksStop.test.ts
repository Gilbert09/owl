import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import type { Task } from '@talyn/shared';
import { taskRoutes } from '../../routes/tasks.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import {
  registerCloudProvider,
} from '../../services/cloudProviders/registry.js';
import type { CloudTaskProvider } from '../../services/cloudProviders/types.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  tasks as tasksTable,
} from '../../db/schema.js';

/**
 * POST /tasks/:id/stop — aborting a running cloud task must (1) try to
 * cancel the remote run via the provider, (2) drop the transcript stream,
 * and (3) land the task in `cancelled` (NOT `failed`) with a clear result.
 * A failed remote cancel still cancels locally but says the run may
 * continue.
 */

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/tasks', requireAuth, taskRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}

const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };

function makeFakeProvider(overrides: Partial<CloudTaskProvider> = {}): {
  provider: CloudTaskProvider;
  cancel: ReturnType<typeof vi.fn>;
  stopStreaming: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn(async () => {});
  const stopStreaming = vi.fn();
  const provider: CloudTaskProvider = {
    type: 'posthog_code',
    displayName: 'Fake PostHog Code',
    validateCredentials: async () => ({ ok: true }),
    hasCredentials: async () => true,
    removeCredentials: async () => {},
    dispatch: async () => ({ ok: true }),
    reconcile: async () => {},
    stopStreaming,
    cancel,
    ...overrides,
  };
  return { provider, cancel, stopStreaming };
}

describe('POST /tasks/:id/stop', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'mine',
      settings: {},
    });
    const server = await makeServer();
    url = server.url;
    close = server.close;
  });

  afterEach(async () => {
    await close();
    await cleanup();
  });

  async function seedTask(status: string, metadata: Record<string, unknown> = {}) {
    await db.insert(tasksTable).values({
      id: 't1',
      workspaceId: 'ws1',
      type: 'code_writing',
      status,
      priority: 'medium',
      title: 'a task',
      description: '',
      metadata,
    });
  }

  it('cancels the remote run and marks the task cancelled', async () => {
    const { provider, cancel, stopStreaming } = makeFakeProvider();
    registerCloudProvider(provider);
    await seedTask('in_progress', { posthogTaskId: 'ph-1', posthogRunId: 'run-1' });

    const res = await fetch(`${url}/tasks/t1/stop`, { method: 'POST', headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Task };
    expect(body.data.status).toBe('cancelled');
    expect(body.data.result).toEqual({ success: false, error: 'Cancelled by user' });
    expect(body.data.completedAt).toBeTruthy();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0]).toMatchObject({ id: 't1' });
    expect(stopStreaming).toHaveBeenCalledWith('t1');
  });

  it('still cancels locally when the remote cancel fails, and says so', async () => {
    const { provider } = makeFakeProvider({
      cancel: async () => {
        throw new Error('vendor exploded');
      },
    });
    registerCloudProvider(provider);
    await seedTask('in_progress', { posthogTaskId: 'ph-1', posthogRunId: 'run-1' });

    const res = await fetch(`${url}/tasks/t1/stop`, { method: 'POST', headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Task };
    expect(body.data.status).toBe('cancelled');
    expect(body.data.result?.error).toContain('may still finish');
    expect(body.data.result?.error).toContain('vendor exploded');
  });

  it('cancels locally even when the task has no resolvable provider', async () => {
    // No cloud metadata → readCloudTaskProvider returns null → no remote
    // call, but the local task must still land in cancelled.
    await seedTask('in_progress', {});

    const res = await fetch(`${url}/tasks/t1/stop`, { method: 'POST', headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Task };
    expect(body.data.status).toBe('cancelled');
    expect(body.data.result).toEqual({ success: false, error: 'Cancelled by user' });
  });

  it.each(['queued', 'pending'])(
    'cancels a %s task in place without a remote cancel',
    async (status) => {
      const { provider, cancel, stopStreaming } = makeFakeProvider();
      registerCloudProvider(provider);
      await seedTask(status, { posthogTaskId: 'ph-1' });

      const res = await fetch(`${url}/tasks/t1/stop`, { method: 'POST', headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Task };
      expect(body.data.status).toBe('cancelled');
      expect(body.data.result).toEqual({ success: false, error: 'Cancelled by user' });
      expect(body.data.completedAt).toBeTruthy();
      expect(cancel).not.toHaveBeenCalled();
      expect(stopStreaming).not.toHaveBeenCalled();
    }
  );

  it.each(['completed', 'failed', 'cancelled'])(
    'rejects stop with 400 when the task is %s',
    async (status) => {
      const { provider, cancel } = makeFakeProvider();
      registerCloudProvider(provider);
      await seedTask(status, { posthogTaskId: 'ph-1' });

      const res = await fetch(`${url}/tasks/t1/stop`, { method: 'POST', headers });
      expect(res.status).toBe(400);
      expect(cancel).not.toHaveBeenCalled();
    }
  );
});
