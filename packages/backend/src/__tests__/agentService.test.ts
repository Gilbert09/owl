import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentService } from '../services/agent.js';
import { agentStructuredService } from '../services/agentStructured.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  agents as agentsTable,
} from '../db/schema.js';

async function insertAgent(
  db: Database,
  overrides: Partial<{
    id: string;
    workspaceId: string;
    environmentId: string;
    status: string;
    attention: string;
    terminalOutput: string;
    permissionToken: string | null;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? 'agent-1';
  const now = new Date();
  await db.insert(agentsTable).values({
    id,
    environmentId: overrides.environmentId ?? 'env1',
    workspaceId: overrides.workspaceId ?? 'ws1',
    status: overrides.status ?? 'idle',
    attention: overrides.attention ?? 'none',
    currentTaskId: null,
    permissionToken: overrides.permissionToken ?? null,
    terminalOutput: overrides.terminalOutput ?? '',
    lastActivity: now,
    createdAt: now,
  });
  return id;
}

describe('agentService', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
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
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  describe('getAgent', () => {
    it('returns a hydrated Agent object for an existing row', async () => {
      await insertAgent(db, { id: 'a1', status: 'working' });
      const agent = await agentService.getAgent('a1');
      expect(agent).not.toBeNull();
      expect(agent?.id).toBe('a1');
      expect(agent?.status).toBe('working');
      expect(agent?.environmentId).toBe('env1');
    });

    it('returns null for a missing id', async () => {
      expect(await agentService.getAgent('never-existed')).toBeNull();
    });
  });

  describe('getAgentsByWorkspace', () => {
    it('returns agents filtered by workspaceId', async () => {
      await insertAgent(db, { id: 'a-1', workspaceId: 'ws1' });
      await insertAgent(db, { id: 'a-2', workspaceId: 'ws1' });
      // Another workspace.
      await db.insert(workspacesTable).values({
        id: 'ws2', ownerId: TEST_USER_ID, name: 'x', settings: {},
      });
      await insertAgent(db, { id: 'a-3', workspaceId: 'ws2' });

      const list = await agentService.getAgentsByWorkspace('ws1');
      const ids = list.map((a) => a.id).sort();
      expect(ids).toEqual(['a-1', 'a-2']);
    });
  });

  describe('getIdleAgents', () => {
    it('returns [] when no agents are active in-memory (DB rows alone do not count)', async () => {
      // getIdleAgents iterates the in-memory `activeAgents` map — it's
      // the "what's this service running RIGHT NOW" view, not a DB
      // query. Rows seeded directly into the DB aren't surfaced.
      await insertAgent(db, { id: 'idle-1', status: 'idle' });
      const idle = await agentService.getIdleAgents();
      expect(idle).toEqual([]);
    });
  });

  describe('isAgentActive', () => {
    it('returns false for an id the service has never tracked', () => {
      expect(agentService.isAgentActive('never-started')).toBe(false);
    });
  });

  describe('getAgentByTaskId', () => {
    it('returns null when no agent is running for the task', () => {
      expect(agentService.getAgentByTaskId('task-nope')).toBeNull();
    });
  });

  describe('stopAgent', () => {
    it('is a no-op when the agent is not active in-memory', async () => {
      // DB row exists but the service never started it → activeAgents
      // map is empty. stopAgent should just return without updating
      // the DB.
      await insertAgent(db, { id: 'a-dormant', status: 'idle', permissionToken: 'tok' });
      const stopSpy = vi.spyOn(agentStructuredService, 'stop').mockImplementation(() => {});

      agentService.stopAgent('a-dormant');
      await new Promise((r) => setTimeout(r, 50));

      expect(stopSpy).not.toHaveBeenCalled();
      const rows = await db
        .select({ permissionToken: agentsTable.permissionToken, status: agentsTable.status })
        .from(agentsTable)
        .where(eq(agentsTable.id, 'a-dormant'));
      // Still present, unchanged.
      expect(rows[0].permissionToken).toBe('tok');
      expect(rows[0].status).toBe('idle');
    });
  });

  describe('init + cleanupStaleAgents', () => {
    it('starts with no active agents after init when DB has no in-flight rows', async () => {
      // Seed only terminal-status rows — init should treat these as
      // nothing to reconcile.
      await insertAgent(db, { id: 'old-idle', status: 'idle' });

      // init is idempotent and attaches listeners + runs a sweep. The
      // sweep should leave completed/idle rows alone and not mark any
      // agent active in-memory.
      await agentService.init();

      expect(agentService.isAgentActive('old-idle')).toBe(false);
    });
  });
});
