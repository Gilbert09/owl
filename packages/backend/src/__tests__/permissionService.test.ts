import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { permissionService } from '../services/permissionService.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import {
  environments as environmentsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';

async function seedEnv(
  db: Database,
  overrides: { id?: string; toolAllowlist?: string[] } = {}
): Promise<string> {
  await seedUser(db);
  const envId = overrides.id ?? 'env-test';
  await db.insert(workspacesTable).values({
    id: 'ws-test',
    ownerId: TEST_USER_ID,
    name: 'ws',
  }).onConflictDoNothing();
  await db.insert(environmentsTable).values({
    id: envId,
    ownerId: TEST_USER_ID,
    name: 'local',
    type: 'local',
    status: 'connected',
    config: { type: 'local' },
    renderer: 'structured',
    toolAllowlist: overrides.toolAllowlist ?? [],
  }).onConflictDoNothing();
  return envId;
}

describe('permissionService', () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(() => {
    // Every test starts from a blank service state — the singleton
    // keeps pending requests across tests otherwise.
    (permissionService as unknown as { runTokens: Map<string, unknown>; pending: Map<string, unknown> }).runTokens.clear();
    (permissionService as unknown as { pending: Map<string, unknown> }).pending.clear();
    permissionService.removeAllListeners();
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  describe('run token lifecycle', () => {
    it('mints a token and verifies it back to the registered ctx', () => {
      const token = permissionService.registerRun({
        agentId: 'a',
        environmentId: 'e',
        workspaceId: 'w',
        taskId: 't',
      });
      const ctx = permissionService.verifyRunToken(token);
      expect(ctx).toEqual({ environmentId: 'e', agentId: 'a', taskId: 't' });
    });

    it('returns null for an unknown token', () => {
      expect(permissionService.verifyRunToken('not-a-real-token')).toBeNull();
      expect(permissionService.verifyRunToken(undefined)).toBeNull();
    });

    it('mints distinct tokens across calls', () => {
      const a = permissionService.registerRun({ agentId: 'a', environmentId: 'e', workspaceId: 'w' });
      const b = permissionService.registerRun({ agentId: 'b', environmentId: 'e', workspaceId: 'w' });
      expect(a).not.toBe(b);
    });

    it('unregisterRun invalidates the token and denies pending requests', async () => {
      const td = await createTestDb();
      cleanup = td.cleanup;
      await seedEnv(td.db);

      const token = permissionService.registerRun({
        agentId: 'a',
        environmentId: 'env-test',
        workspaceId: 'ws-test',
        taskId: 't',
      });

      // Kick off a pending decision. Don't await — we'll unregister
      // first, then assert the promise resolves to deny.
      const pending = permissionService.requestDecision(
        token,
        'Bash',
        { command: 'ls' },
        'tool-1',
        'sess-1'
      );

      // Let the microtask queue flush so the pending entry is recorded.
      await new Promise((r) => setImmediate(r));

      permissionService.unregisterRun(token);
      const resolved = await pending;
      expect(resolved.decision).toBe('deny');
      expect(resolved.reason).toMatch(/terminated/);
      expect(permissionService.verifyRunToken(token)).toBeNull();
    });
  });

  describe('requestDecision', () => {
    it('immediately allows a pre-approved tool without emitting a request event', async () => {
      const td = await createTestDb();
      cleanup = td.cleanup;
      await seedEnv(td.db, { toolAllowlist: ['Read'] });

      const token = permissionService.registerRun({
        agentId: 'a',
        environmentId: 'env-test',
        workspaceId: 'ws-test',
        taskId: 't',
      });

      const onRequest = vi.fn();
      const onAutoAllowed = vi.fn();
      permissionService.on('request', onRequest);
      permissionService.on('auto_allowed', onAutoAllowed);

      const result = await permissionService.requestDecision(
        token,
        'Read',
        { file_path: '/etc/passwd' },
        'tu-1',
        's-1'
      );
      expect(result.decision).toBe('allow');
      expect(result.reason).toMatch(/pre-approved/);
      expect(onRequest).not.toHaveBeenCalled();
      expect(onAutoAllowed).toHaveBeenCalledTimes(1);
    });

    it('registers a pending request when the tool is not pre-approved', async () => {
      const td = await createTestDb();
      cleanup = td.cleanup;
      await seedEnv(td.db);

      const token = permissionService.registerRun({
        agentId: 'a',
        environmentId: 'env-test',
        workspaceId: 'ws-test',
        taskId: 't-pending',
      });

      const onRequest = vi.fn();
      permissionService.on('request', onRequest);

      // Fire and don't await — the decision is waiting on `respond`.
      const p = permissionService.requestDecision(
        token,
        'Bash',
        { command: 'rm -rf /' },
        'tu-2',
        's-1'
      );
      await new Promise((r) => setImmediate(r));

      expect(onRequest).toHaveBeenCalledTimes(1);
      const request = onRequest.mock.calls[0][0] as { requestId: string; toolName: string };
      expect(request.toolName).toBe('Bash');

      // Resolve it so the promise doesn't hang.
      const ok = await permissionService.respond(request.requestId, 'deny');
      expect(ok).toBe(true);
      const result = await p;
      expect(result.decision).toBe('deny');
    });

    it('returns deny for an invalid run token', async () => {
      const result = await permissionService.requestDecision(
        'bogus',
        'Bash',
        {},
        undefined,
        undefined
      );
      expect(result.decision).toBe('deny');
      expect(result.reason).toMatch(/invalid run token/);
    });

    it('times out to deny when no response arrives in time', async () => {
      vi.useFakeTimers();
      try {
        const td = await createTestDb();
        cleanup = td.cleanup;
        await seedEnv(td.db);

        const token = permissionService.registerRun({
          agentId: 'a',
          environmentId: 'env-test',
          workspaceId: 'ws-test',
          taskId: 't',
        });

        const p = permissionService.requestDecision(token, 'Bash', {}, undefined, undefined);
        // Advance past the 10 min timeout.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
        const result = await p;
        expect(result.decision).toBe('deny');
        expect(result.reason).toMatch(/timed out/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('respond + persistence', () => {
    it('allow + persist: adds the tool to the env allowlist', async () => {
      const td = await createTestDb();
      cleanup = td.cleanup;
      await seedEnv(td.db);

      const token = permissionService.registerRun({
        agentId: 'a',
        environmentId: 'env-test',
        workspaceId: 'ws-test',
        taskId: 't',
      });

      const onRequest = vi.fn();
      permissionService.on('request', onRequest);

      const p = permissionService.requestDecision(token, 'Edit', { file_path: '/x' }, 'tu', 's');
      await new Promise((r) => setImmediate(r));
      const request = onRequest.mock.calls[0][0] as { requestId: string };

      await permissionService.respond(request.requestId, 'allow', { persist: true });
      const result = await p;
      expect(result.decision).toBe('allow');

      const rows = await td.db
        .select({ toolAllowlist: environmentsTable.toolAllowlist })
        .from(environmentsTable)
        .where(eq(environmentsTable.id, 'env-test'))
        .limit(1);
      expect(rows[0].toolAllowlist).toContain('Edit');
    });

    it('allow without persist: does NOT add to the allowlist', async () => {
      const td = await createTestDb();
      cleanup = td.cleanup;
      await seedEnv(td.db);

      const token = permissionService.registerRun({
        agentId: 'a',
        environmentId: 'env-test',
        workspaceId: 'ws-test',
        taskId: 't',
      });

      const onRequest = vi.fn();
      permissionService.on('request', onRequest);

      const p = permissionService.requestDecision(token, 'Edit', {}, undefined, undefined);
      await new Promise((r) => setImmediate(r));
      const request = onRequest.mock.calls[0][0] as { requestId: string };

      await permissionService.respond(request.requestId, 'allow', { persist: false });
      await p;

      const rows = await td.db
        .select({ toolAllowlist: environmentsTable.toolAllowlist })
        .from(environmentsTable)
        .where(eq(environmentsTable.id, 'env-test'))
        .limit(1);
      expect(rows[0].toolAllowlist).not.toContain('Edit');
    });

    it('returns false when responding to an unknown requestId', async () => {
      const ok = await permissionService.respond('not-a-real-id', 'allow');
      expect(ok).toBe(false);
    });

    it('emits resolved event with the final decision + persist flag', async () => {
      const td = await createTestDb();
      cleanup = td.cleanup;
      await seedEnv(td.db);

      const token = permissionService.registerRun({
        agentId: 'a',
        environmentId: 'env-test',
        workspaceId: 'ws-test',
        taskId: 't-resolve',
      });

      const onResolved = vi.fn();
      const onRequest = vi.fn();
      permissionService.on('request', onRequest);
      permissionService.on('resolved', onResolved);

      const p = permissionService.requestDecision(token, 'Write', {}, undefined, undefined);
      await new Promise((r) => setImmediate(r));
      const request = onRequest.mock.calls[0][0] as { requestId: string };
      await permissionService.respond(request.requestId, 'deny');
      await p;

      expect(onResolved).toHaveBeenCalledTimes(1);
      const payload = onResolved.mock.calls[0][0] as {
        decision: string;
        persist: boolean;
        toolName: string;
      };
      expect(payload.decision).toBe('deny');
      expect(payload.persist).toBe(false);
      expect(payload.toolName).toBe('Write');
    });
  });

  describe('listPendingForTask', () => {
    it('returns only pending requests belonging to the given task', async () => {
      const td = await createTestDb();
      cleanup = td.cleanup;
      await seedEnv(td.db);

      const tokenA = permissionService.registerRun({
        agentId: 'a', environmentId: 'env-test', workspaceId: 'ws-test', taskId: 'task-A',
      });
      const tokenB = permissionService.registerRun({
        agentId: 'b', environmentId: 'env-test', workspaceId: 'ws-test', taskId: 'task-B',
      });

      // Fire two requests (one per task) — don't await either.
      const onRequest = vi.fn();
      permissionService.on('request', onRequest);
      void permissionService.requestDecision(tokenA, 'Bash', {}, undefined, undefined);
      void permissionService.requestDecision(tokenB, 'Edit', {}, undefined, undefined);
      await new Promise((r) => setImmediate(r));

      const pendingA = permissionService.listPendingForTask('task-A');
      const pendingB = permissionService.listPendingForTask('task-B');
      expect(pendingA).toHaveLength(1);
      expect(pendingB).toHaveLength(1);
      expect(pendingA[0].toolName).toBe('Bash');
      expect(pendingB[0].toolName).toBe('Edit');

      // Clean up — resolve both so Node doesn't complain about open handles.
      const reqA = onRequest.mock.calls[0][0] as { requestId: string };
      const reqB = onRequest.mock.calls[1][0] as { requestId: string };
      await permissionService.respond(reqA.requestId, 'deny');
      await permissionService.respond(reqB.requestId, 'deny');
    });
  });
});
