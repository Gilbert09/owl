import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { inboxRoutes } from '../../routes/inbox.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  inboxItems as inboxItemsTable,
} from '../../db/schema.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/inbox', requireAuth, inboxRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await seedUser(db, { id: OTHER_USER_ID });
  await db.insert(workspacesTable).values([
    { id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
    { id: 'ws2', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
  ]);
}

async function insertInboxItem(
  db: Database,
  overrides: Partial<{
    id: string;
    workspaceId: string;
    type: string;
    status: string;
    priority: string;
    snoozedUntil: Date | null;
    createdAt: Date;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? `i${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date();
  await db.insert(inboxItemsTable).values({
    id,
    workspaceId: overrides.workspaceId ?? 'ws1',
    type: overrides.type ?? 'agent_question',
    status: overrides.status ?? 'unread',
    priority: overrides.priority ?? 'medium',
    title: 't',
    summary: 's',
    source: { type: 'agent', id: 'agent-x' },
    actions: [],
    snoozedUntil: overrides.snoozedUntil ?? null,
    createdAt,
  });
  return id;
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/inbox', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
  });

  it('401s unauthenticated callers', async () => {
    expect((await fetch(`${serverUrl}/inbox`)).status).toBe(401);
  });

  describe('GET /inbox', () => {
    it('returns items sorted urgent → high → medium → low then newest-first', async () => {
      const baseDate = new Date('2026-04-22T00:00:00Z').getTime();
      await insertInboxItem(db, { id: 'low-new', priority: 'low', createdAt: new Date(baseDate + 3000) });
      await insertInboxItem(db, { id: 'urgent-old', priority: 'urgent', createdAt: new Date(baseDate + 1000) });
      await insertInboxItem(db, { id: 'high-mid', priority: 'high', createdAt: new Date(baseDate + 2000) });
      await insertInboxItem(db, { id: 'urgent-new', priority: 'urgent', createdAt: new Date(baseDate + 4000) });

      const res = await fetch(`${serverUrl}/inbox?workspaceId=ws1`, { headers: authHeaders });
      const body = await res.json();
      const ids = (body.data as Array<{ id: string }>).map((i) => i.id);
      expect(ids).toEqual(['urgent-new', 'urgent-old', 'high-mid', 'low-new']);
    });

    it('hides snoozed items whose until is still in the future', async () => {
      const future = new Date(Date.now() + 10 * 60 * 1000);
      const past = new Date(Date.now() - 60 * 1000);
      await insertInboxItem(db, { id: 'future-snoozed', status: 'snoozed', snoozedUntil: future });
      await insertInboxItem(db, { id: 'past-snoozed', status: 'snoozed', snoozedUntil: past });
      await insertInboxItem(db, { id: 'not-snoozed' });

      const res = await fetch(`${serverUrl}/inbox?workspaceId=ws1`, { headers: authHeaders });
      const body = await res.json();
      const ids = (body.data as Array<{ id: string }>).map((i) => i.id).sort();
      expect(ids).toEqual(['not-snoozed', 'past-snoozed']);
    });

    it('filters by status and type', async () => {
      await insertInboxItem(db, { id: 'u1', status: 'unread', type: 'agent_question' });
      await insertInboxItem(db, { id: 'r1', status: 'read', type: 'agent_question' });
      await insertInboxItem(db, { id: 'u-diff', status: 'unread', type: 'pr_comment' });

      const res = await fetch(
        `${serverUrl}/inbox?workspaceId=ws1&status=unread&type=agent_question`,
        { headers: authHeaders }
      );
      const body = await res.json();
      expect((body.data as Array<{ id: string }>).map((i) => i.id)).toEqual(['u1']);
    });

    it('never returns items from a workspace the caller does not own', async () => {
      await insertInboxItem(db, { id: 'mine' });
      await insertInboxItem(db, { id: 'theirs', workspaceId: 'ws2' });
      const res = await fetch(`${serverUrl}/inbox`, { headers: authHeaders });
      const body = await res.json();
      const ids = (body.data as Array<{ id: string }>).map((i) => i.id);
      expect(ids).toEqual(['mine']);
    });
  });

  describe('POST /inbox/:id/{read,action,snooze}', () => {
    it('mark-as-read updates status + readAt', async () => {
      const id = await insertInboxItem(db);
      const res = await fetch(`${serverUrl}/inbox/${id}/read`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('read');
      expect(body.data.readAt).toBeTruthy();
    });

    it('action updates status + actionedAt', async () => {
      const id = await insertInboxItem(db);
      const res = await fetch(`${serverUrl}/inbox/${id}/action`, {
        method: 'POST',
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data.status).toBe('actioned');
      expect(body.data.actionedAt).toBeTruthy();
    });

    it('snooze sets the snoozedUntil timestamp', async () => {
      const id = await insertInboxItem(db);
      const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await fetch(`${serverUrl}/inbox/${id}/snooze`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ until }),
      });
      const body = await res.json();
      expect(body.data.status).toBe('snoozed');
      expect(body.data.snoozedUntil).toBe(until);
    });

    it('404s a cross-tenant inbox id (no-leak)', async () => {
      const id = await insertInboxItem(db, { workspaceId: 'ws2' });
      const res = await fetch(`${serverUrl}/inbox/${id}/read`, {
        method: 'POST',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /inbox/bulk/{read,action}', () => {
    it('silently drops ids the user does not own', async () => {
      const mine1 = await insertInboxItem(db);
      const theirs = await insertInboxItem(db, { workspaceId: 'ws2' });
      const res = await fetch(`${serverUrl}/inbox/bulk/read`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ids: [mine1, theirs, 'unknown-id'] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.updated).toBe(1);

      const rows = await db
        .select({ id: inboxItemsTable.id, status: inboxItemsTable.status })
        .from(inboxItemsTable);
      const map = new Map(rows.map((r) => [r.id, r.status]));
      expect(map.get(mine1)).toBe('read');
      expect(map.get(theirs)).toBe('unread'); // untouched
    });

    it('bulk action updates all owned ids to actioned', async () => {
      const ids = await Promise.all([
        insertInboxItem(db),
        insertInboxItem(db),
        insertInboxItem(db),
      ]);
      const res = await fetch(`${serverUrl}/inbox/bulk/action`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ids }),
      });
      const body = await res.json();
      expect(body.data.updated).toBe(3);

      const rows = await db
        .select({ status: inboxItemsTable.status })
        .from(inboxItemsTable);
      expect(rows.every((r) => r.status === 'actioned')).toBe(true);
    });

    it('resolves bulk/read before /:id/read (route-order regression guard)', async () => {
      // If the router registered `/:id/read` first, POST /inbox/bulk/read
      // would be treated as id='bulk' and 404.
      const res = await fetch(`${serverUrl}/inbox/bulk/read`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ids: [] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.updated).toBe(0);
    });
  });

  describe('DELETE /inbox/:id', () => {
    it('removes an owned item', async () => {
      const id = await insertInboxItem(db);
      const res = await fetch(`${serverUrl}/inbox/${id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const rows = await db.select().from(inboxItemsTable).where(eq(inboxItemsTable.id, id));
      expect(rows).toHaveLength(0);
    });

    it('404s a cross-tenant item (no-leak)', async () => {
      const id = await insertInboxItem(db, { workspaceId: 'ws2' });
      const res = await fetch(`${serverUrl}/inbox/${id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
      const rows = await db.select().from(inboxItemsTable).where(eq(inboxItemsTable.id, id));
      expect(rows).toHaveLength(1);
    });
  });
});
