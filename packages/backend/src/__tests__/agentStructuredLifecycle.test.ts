import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentStructuredService } from '../services/agentStructured.js';
import { environmentService } from '../services/environment.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  tasks as tasksTable,
} from '../db/schema.js';

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({
    id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {},
  });
  await db.insert(environmentsTable).values({
    id: 'env1',
    ownerId: TEST_USER_ID,
    name: 'e',
    type: 'local',
    status: 'connected',
    config: {},
  });
  const now = new Date();
  await db.insert(tasksTable).values({
    id: 't-struct',
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'in_progress',
    priority: 'medium',
    title: 't',
    description: 'd',
    prompt: 'p',
    createdAt: now,
    updatedAt: now,
  });
}

describe('agentStructuredService lifecycle', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let spawnCalls: Array<{
    environmentId: string;
    sessionId: string;
    binary: string;
    args: string[];
    options: { env?: Record<string, string>; keepStdinOpen: boolean };
  }>;
  let killedSessions: string[];

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);

    spawnCalls = [];
    killedSessions = [];
    // Manual, silent spawnStreaming — no auto-close, so tests drive the
    // lifecycle themselves.
    vi.spyOn(environmentService, 'spawnStreaming').mockImplementation(
      async (environmentId, sessionId, binary, args, options) => {
        spawnCalls.push({ environmentId, sessionId, binary, args, options });
      }
    );
    vi.spyOn(environmentService, 'killSession').mockImplementation((sid) => {
      killedSessions.push(sid);
    });
    vi.spyOn(environmentService, 'closeStreamInput').mockResolvedValue();
  });

  afterEach(async () => {
    environmentService.removeAllListeners('session:data');
    environmentService.removeAllListeners('session:stderr');
    environmentService.removeAllListeners('session:close');
    await cleanup();
    vi.restoreAllMocks();
  });

  it('start() spawns the child and registers the run in the live map', async () => {
    const run = await agentStructuredService.start({
      sessionKey: 'agent:s1',
      agentId: 'a1',
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId: 't-struct',
      permissionMode: 'bypass',
      prompt: 'hello',
    });

    expect(agentStructuredService.has('agent:s1')).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain('-p');
    const pm = spawnCalls[0].args.indexOf('--permission-mode');
    expect(spawnCalls[0].args[pm + 1]).toBe('bypassPermissions');

    // Drain to shutdown so nothing lingers.
    environmentService.emit('session:close', 'agent:s1', 0);
    await run.completion;
    expect(agentStructuredService.has('agent:s1')).toBe(false);
  });

  it('throws when a run is already active on the same sessionKey', async () => {
    const run = await agentStructuredService.start({
      sessionKey: 'agent:dup',
      agentId: 'a',
      environmentId: 'env1',
      workspaceId: 'ws1',
      permissionMode: 'bypass',
    });

    await expect(
      agentStructuredService.start({
        sessionKey: 'agent:dup',
        agentId: 'a',
        environmentId: 'env1',
        workspaceId: 'ws1',
        permissionMode: 'bypass',
      })
    ).rejects.toThrow(/already active/);

    environmentService.emit('session:close', 'agent:dup', 0);
    await run.completion;
  });

  it('forwards session:data into the transcript with monotonic seq', async () => {
    const run = await agentStructuredService.start({
      sessionKey: 'agent:data',
      agentId: 'a',
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId: 't-struct',
      permissionMode: 'bypass',
    });

    environmentService.emit(
      'session:data',
      'agent:data',
      Buffer.from('{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"role":"assistant"}}\n')
    );

    // Allow the microtask queue to flush onRawEvent + its async persist.
    await new Promise((r) => setTimeout(r, 10));

    expect(run.transcript).toHaveLength(2);
    expect(run.transcript[0].seq).toBe(0);
    expect(run.transcript[1].seq).toBe(1);
    expect((run.transcript[0] as { type: string }).type).toBe('system');

    environmentService.emit('session:close', 'agent:data', 0);
    await run.completion;
  });

  it('session:close resolves completion, cleans up the map, and emits exit', async () => {
    const run = await agentStructuredService.start({
      sessionKey: 'agent:close',
      agentId: 'a',
      environmentId: 'env1',
      workspaceId: 'ws1',
      permissionMode: 'bypass',
    });

    const exitSpy = vi.fn();
    agentStructuredService.once('exit', exitSpy);

    environmentService.emit('session:close', 'agent:close', 42);
    const code = await run.completion;

    expect(code).toBe(42);
    expect(exitSpy).toHaveBeenCalledWith(run, 42);
    expect(agentStructuredService.has('agent:close')).toBe(false);
  });

  it('spawn failure resolves completion with 1 and emits a synthetic spawn_error event', async () => {
    // Force spawnStreaming to throw — overrides the fake just for this test.
    const svc = environmentService as unknown as {
      spawnStreaming: typeof environmentService.spawnStreaming;
    };
    const original = svc.spawnStreaming;
    svc.spawnStreaming = vi.fn(async () => {
      throw new Error('boom');
    });

    try {
      const run = await agentStructuredService.start({
        sessionKey: 'agent:boom',
        agentId: 'a',
        environmentId: 'env1',
        workspaceId: 'ws1',
        taskId: 't-struct',
        permissionMode: 'bypass',
      });

      const code = await run.completion;
      expect(code).toBe(1);
      expect(agentStructuredService.has('agent:boom')).toBe(false);

      // The synthetic spawn_error event should be in the transcript.
      const spawnErr = run.transcript.find(
        (e) => (e as { subtype?: string }).subtype === 'spawn_error'
      );
      expect(spawnErr).toBeTruthy();
      expect((spawnErr as { text?: string }).text).toMatch(/boom/);
    } finally {
      svc.spawnStreaming = original;
    }
  });

  it('sendMessage on an interactive run writes a JSONL user envelope', async () => {
    const writeSpy = vi.spyOn(environmentService, 'writeToSession').mockImplementation(() => {});

    const run = await agentStructuredService.start({
      sessionKey: 'agent:int',
      agentId: 'a',
      environmentId: 'env1',
      workspaceId: 'ws1',
      permissionMode: 'bypass',
      interactive: true,
    });

    agentStructuredService.sendMessage('agent:int', 'next turn');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [sid, payload] = writeSpy.mock.calls[0];
    expect(sid).toBe('agent:int');
    expect(payload).toMatch(/\n$/);
    const parsed = JSON.parse((payload as string).trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content).toBe('next turn');

    environmentService.emit('session:close', 'agent:int', 0);
    await run.completion;
  });

  it('sendMessage on a one-shot run throws (stdin is already closed)', async () => {
    const run = await agentStructuredService.start({
      sessionKey: 'agent:oneshot',
      agentId: 'a',
      environmentId: 'env1',
      workspaceId: 'ws1',
      permissionMode: 'bypass',
      interactive: false,
    });

    expect(() =>
      agentStructuredService.sendMessage('agent:oneshot', 'nope')
    ).toThrow(/one-shot/);

    environmentService.emit('session:close', 'agent:oneshot', 0);
    await run.completion;
  });

  it('sendMessage throws when no run is active on that sessionKey', () => {
    expect(() =>
      agentStructuredService.sendMessage('agent:ghost', 'hi')
    ).toThrow(/no active structured run/);
  });

  it('stop() asks environmentService to kill the child', async () => {
    const run = await agentStructuredService.start({
      sessionKey: 'agent:stop',
      agentId: 'a',
      environmentId: 'env1',
      workspaceId: 'ws1',
      permissionMode: 'bypass',
    });

    agentStructuredService.stop('agent:stop');
    expect(killedSessions).toContain('agent:stop');
    // Child would normally exit with 143 (SIGTERM); drive it ourselves
    // since the fake kill spy only records the call.
    environmentService.emit('session:close', 'agent:stop', 143);
    const code = await run.completion;
    expect(code).toBe(143);
  });

  it('stop() on an unknown sessionKey is a silent no-op', () => {
    expect(() => agentStructuredService.stop('does-not-exist')).not.toThrow();
  });

  it('closeInput() on an unknown sessionKey swallows transport errors', () => {
    // `closeStreamInput` on the fake resolves quietly; the service itself
    // wraps it in `.catch()` so a rejection wouldn't surface anyway.
    expect(() => agentStructuredService.closeInput('missing')).not.toThrow();
  });

  it('a `result` event emits turn_complete and force-persists the transcript', async () => {
    const run = await agentStructuredService.start({
      sessionKey: 'agent:result',
      agentId: 'a',
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId: 't-struct',
      permissionMode: 'bypass',
    });

    const turnComplete = vi.fn();
    agentStructuredService.once('turn_complete', turnComplete);

    environmentService.emit(
      'session:data',
      'agent:result',
      Buffer.from('{"type":"result","subtype":"success"}\n')
    );
    // Let persist flush.
    await new Promise((r) => setTimeout(r, 20));

    expect(turnComplete).toHaveBeenCalledTimes(1);

    // Transcript persisted to DB.
    const rows = await db
      .select({ transcript: tasksTable.transcript })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't-struct'));
    const persisted = rows[0].transcript as Array<{ type: string }>;
    expect(persisted.map((e) => e.type)).toContain('result');

    environmentService.emit('session:close', 'agent:result', 0);
    await run.completion;
  });

  it('captures claudeSessionId from the first event that carries session_id', async () => {
    const run = await agentStructuredService.start({
      sessionKey: 'agent:sid',
      agentId: 'a',
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId: 't-struct',
      permissionMode: 'bypass',
    });

    const captured = vi.fn();
    agentStructuredService.once('session_id_captured', captured);

    environmentService.emit(
      'session:data',
      'agent:sid',
      Buffer.from('{"type":"system","subtype":"init","session_id":"sess-abc"}\n')
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(run.claudeSessionId).toBe('sess-abc');
    expect(captured).toHaveBeenCalledWith(run, 'sess-abc');

    environmentService.emit('session:close', 'agent:sid', 0);
    await run.completion;
  });

  it('flush() persists the live transcript to tasks.transcript', async () => {
    const run = await agentStructuredService.start({
      sessionKey: 'agent:flush',
      agentId: 'a',
      environmentId: 'env1',
      workspaceId: 'ws1',
      taskId: 't-struct',
      permissionMode: 'bypass',
    });

    // Feed a non-result, non-fastowl event — not persisted automatically
    // until the 25-event threshold.
    environmentService.emit(
      'session:data',
      'agent:flush',
      Buffer.from('{"type":"assistant","message":{"role":"assistant","content":"hi"}}\n')
    );
    await new Promise((r) => setTimeout(r, 10));

    await agentStructuredService.flush('agent:flush');

    const rows = await db
      .select({ transcript: tasksTable.transcript })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't-struct'));
    const persisted = rows[0].transcript as Array<{ type: string }>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0].type).toBe('assistant');

    environmentService.emit('session:close', 'agent:flush', 0);
    await run.completion;
  });

  it('ignores session:data for other sessionKeys', async () => {
    const run = await agentStructuredService.start({
      sessionKey: 'agent:mine',
      agentId: 'a',
      environmentId: 'env1',
      workspaceId: 'ws1',
      permissionMode: 'bypass',
    });

    environmentService.emit(
      'session:data',
      'someone-else',
      Buffer.from('{"type":"noise"}\n')
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(run.transcript).toHaveLength(0);

    environmentService.emit('session:close', 'agent:mine', 0);
    await run.completion;
  });
});
