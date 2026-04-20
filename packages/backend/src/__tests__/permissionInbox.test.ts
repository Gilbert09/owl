import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { permissionInboxService } from '../services/permissionInbox.js';
import { permissionService } from '../services/permissionService.js';
import {
  inboxItems as inboxItemsTable,
  tasks as tasksTable,
  workspaces as workspacesTable,
  environments as environmentsTable,
} from '../db/schema.js';
import type { Database } from '../db/client.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';

async function seedTaskAndEnv(db: Database, taskId = 'task-A', wsId = 'ws-1', envId = 'env-1') {
  await seedUser(db);
  await db
    .insert(workspacesTable)
    .values({ id: wsId, ownerId: TEST_USER_ID, name: 'ws' })
    .onConflictDoNothing();
  await db
    .insert(environmentsTable)
    .values({
      id: envId,
      ownerId: TEST_USER_ID,
      name: 'local',
      type: 'local',
      status: 'connected',
      config: { type: 'local' },
      renderer: 'structured',
    })
    .onConflictDoNothing();
  await db
    .insert(tasksTable)
    .values({
      id: taskId,
      workspaceId: wsId,
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 'A working task',
      description: 'doing work',
    })
    .onConflictDoNothing();
  return { taskId, wsId, envId };
}

async function settle() {
  // The 'request' event is synchronous, but permissionInboxService
  // handlers chain several DB awaits. A fixed sleep is the simplest
  // way to let them drain before asserting.
  await new Promise((r) => setTimeout(r, 150));
}

describe('permissionInboxService', () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(() => {
    // Reset permissionService in-memory state between tests. The
    // inbox service subscribes globally once — we re-subscribe in each
    // test via init() to avoid leftover listeners interfering.
    (permissionService as unknown as { runTokens: Map<string, unknown>; pending: Map<string, unknown> }).runTokens.clear();
    (permissionService as unknown as { pending: Map<string, unknown> }).pending.clear();
    permissionService.removeAllListeners();
    permissionInboxService._resetForTests();
    permissionInboxService.init();
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
    permissionService.removeAllListeners();
    permissionInboxService._resetForTests();
  });

  it('creates an inbox item for the first pending permission prompt on a task', async () => {
    const td = await createTestDb();
    cleanup = td.cleanup;
    const { taskId, wsId } = await seedTaskAndEnv(td.db);

    const token = permissionService.registerRun({
      agentId: 'a',
      environmentId: 'env-1',
      workspaceId: wsId,
      taskId,
    });

    void permissionService.requestDecision(token, 'Bash', { command: 'ls' }, 'tu', 's');
    await settle();

    const rows = await td.db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('agent_question');
    expect(rows[0].status).toBe('unread');
    expect(rows[0].priority).toBe('high');
    expect(rows[0].title).toContain('Bash');
  });

  it('coalesces multiple pending prompts into a single item per task, patched with a counter', async () => {
    const td = await createTestDb();
    cleanup = td.cleanup;
    const { taskId, wsId } = await seedTaskAndEnv(td.db);

    const token = permissionService.registerRun({
      agentId: 'a',
      environmentId: 'env-1',
      workspaceId: wsId,
      taskId,
    });

    void permissionService.requestDecision(token, 'Bash', {}, undefined, undefined);
    void permissionService.requestDecision(token, 'Edit', {}, undefined, undefined);
    void permissionService.requestDecision(token, 'Read', {}, undefined, undefined);
    await settle();

    const rows = await td.db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    const data = rows[0].data as { pendingRequestIds?: unknown[] } | null;
    expect(data?.pendingRequestIds).toHaveLength(3);
    expect(rows[0].summary).toMatch(/awaiting approval/);
  });

  it('marks the item actioned when the last pending prompt is resolved', async () => {
    const td = await createTestDb();
    cleanup = td.cleanup;
    const { taskId, wsId } = await seedTaskAndEnv(td.db);

    const token = permissionService.registerRun({
      agentId: 'a',
      environmentId: 'env-1',
      workspaceId: wsId,
      taskId,
    });

    const requestIds: string[] = [];
    permissionService.on('request', (p: { requestId: string }) => requestIds.push(p.requestId));

    void permissionService.requestDecision(token, 'Bash', {}, undefined, undefined);
    void permissionService.requestDecision(token, 'Edit', {}, undefined, undefined);
    await settle();

    // Resolve one → item still unread with 1 pending
    await permissionService.respond(requestIds[0], 'allow');
    await settle();
    let rows = await td.db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.workspaceId, wsId));
    expect(rows[0].status).toBe('unread');
    const data1 = rows[0].data as { pendingRequestIds: string[] };
    expect(data1.pendingRequestIds).toHaveLength(1);

    // Resolve the last → item auto-actioned
    await permissionService.respond(requestIds[1], 'deny');
    await settle();
    rows = await td.db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.workspaceId, wsId));
    expect(rows[0].status).toBe('actioned');
    expect(rows[0].actionedAt).toBeTruthy();
  });

  it('keeps inbox items per task separate (task A + task B)', async () => {
    const td = await createTestDb();
    cleanup = td.cleanup;
    const { taskId: aId, wsId } = await seedTaskAndEnv(td.db, 'task-A');
    await seedTaskAndEnv(td.db, 'task-B', wsId, 'env-1');

    const tokA = permissionService.registerRun({ agentId: 'agA', environmentId: 'env-1', workspaceId: wsId, taskId: aId });
    const tokB = permissionService.registerRun({ agentId: 'agB', environmentId: 'env-1', workspaceId: wsId, taskId: 'task-B' });

    void permissionService.requestDecision(tokA, 'Bash', {}, undefined, undefined);
    void permissionService.requestDecision(tokB, 'Edit', {}, undefined, undefined);
    await settle();

    const rows = await td.db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.workspaceId, wsId));
    expect(rows).toHaveLength(2);
    // Each item is scoped to its task via `source.id`.
    const sourceIds = rows.map((r) => (r.source as { id?: string }).id).sort();
    expect(sourceIds).toEqual(['task-A', 'task-B']);
  });
});
