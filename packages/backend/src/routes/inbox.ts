import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { and, desc, eq, isNull, lte, or, sql, SQL, inArray } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import {
  inboxItems as inboxItemsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import {
  assertUser,
  handleAccessError,
  requireInboxAccess,
  requireWorkspaceAccess,
} from '../middleware/auth.js';
import type { InboxItem, ApiResponse } from '@fastowl/shared';

export function inboxRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const { workspaceId, status, type } = req.query;

    if (workspaceId) {
      try {
        await requireWorkspaceAccess(req, workspaceId as string);
      } catch (err) {
        return handleAccessError(err, res);
      }
    }

    const conditions: SQL[] = [eq(workspacesTable.ownerId, user.id)];
    if (workspaceId) conditions.push(eq(inboxItemsTable.workspaceId, workspaceId as string));
    if (status) conditions.push(eq(inboxItemsTable.status, status as string));
    if (type) conditions.push(eq(inboxItemsTable.type, type as string));

    const notSnoozedOrDue = or(
      isNull(inboxItemsTable.snoozedUntil),
      lte(inboxItemsTable.snoozedUntil, new Date())
    );
    conditions.push(notSnoozedOrDue as SQL);

    const priorityCase = sql<number>`CASE ${inboxItemsTable.priority}
      WHEN 'urgent' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      ELSE 4
    END`;

    const rows = await db
      .select({ item: inboxItemsTable })
      .from(inboxItemsTable)
      .innerJoin(workspacesTable, eq(inboxItemsTable.workspaceId, workspacesTable.id))
      .where(and(...conditions))
      .orderBy(priorityCase, desc(inboxItemsTable.createdAt));

    res.json({ success: true, data: rows.map((r) => rowToInboxItem(r.item)) } as ApiResponse<InboxItem[]>);
  });

  router.get('/:id', async (req, res) => {
    try {
      await requireInboxAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Inbox item not found' });
    }
    res.json({ success: true, data: rowToInboxItem(rows[0]) } as ApiResponse<InboxItem>);
  });

  router.post('/', async (req, res) => {
    const body = req.body;
    try {
      await requireWorkspaceAccess(req, body.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const id = uuid();
    const now = new Date();

    await db.insert(inboxItemsTable).values({
      id,
      workspaceId: body.workspaceId,
      type: body.type,
      priority: body.priority || 'medium',
      title: body.title,
      summary: body.summary,
      source: body.source,
      actions: body.actions || [],
      data: body.data ?? null,
      createdAt: now,
    });

    const rows = await db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.id, id))
      .limit(1);
    res.status(201).json({ success: true, data: rowToInboxItem(rows[0]) } as ApiResponse<InboxItem>);
  });

  router.post('/:id/read', async (req, res) => {
    try {
      await requireInboxAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    await db
      .update(inboxItemsTable)
      .set({ status: 'read', readAt: new Date() })
      .where(eq(inboxItemsTable.id, req.params.id));

    const updated = await db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToInboxItem(updated[0]) } as ApiResponse<InboxItem>);
  });

  router.post('/:id/action', async (req, res) => {
    try {
      await requireInboxAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    await db
      .update(inboxItemsTable)
      .set({ status: 'actioned', actionedAt: new Date() })
      .where(eq(inboxItemsTable.id, req.params.id));

    const updated = await db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToInboxItem(updated[0]) } as ApiResponse<InboxItem>);
  });

  router.post('/:id/snooze', async (req, res) => {
    try {
      await requireInboxAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();

    const { until } = req.body as { until: string };
    await db
      .update(inboxItemsTable)
      .set({ status: 'snoozed', snoozedUntil: new Date(until) })
      .where(eq(inboxItemsTable.id, req.params.id));

    const updated = await db
      .select()
      .from(inboxItemsTable)
      .where(eq(inboxItemsTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToInboxItem(updated[0]) } as ApiResponse<InboxItem>);
  });

  router.delete('/:id', async (req, res) => {
    try {
      await requireInboxAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const result = await db
      .delete(inboxItemsTable)
      .where(eq(inboxItemsTable.id, req.params.id))
      .returning({ id: inboxItemsTable.id });
    if (result.length === 0) {
      return res.status(404).json({ success: false, error: 'Inbox item not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  router.post('/bulk/read', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const { ids } = req.body as { ids: string[] };
    const now = new Date();

    const ownedIds = await filterToOwnedIds(db, ids, user.id);
    if (ownedIds.length > 0) {
      await db
        .update(inboxItemsTable)
        .set({ status: 'read', readAt: now })
        .where(inArray(inboxItemsTable.id, ownedIds));
    }
    res.json({ success: true, data: { updated: ownedIds.length } });
  });

  router.post('/bulk/action', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const { ids } = req.body as { ids: string[] };
    const now = new Date();

    const ownedIds = await filterToOwnedIds(db, ids, user.id);
    if (ownedIds.length > 0) {
      await db
        .update(inboxItemsTable)
        .set({ status: 'actioned', actionedAt: now })
        .where(inArray(inboxItemsTable.id, ownedIds));
    }
    res.json({ success: true, data: { updated: ownedIds.length } });
  });

  return router;
}

/**
 * Given a caller-supplied list of inbox item ids, reduce it to just the ones
 * whose workspace the user owns. Silently drops unknown/foreign ids —
 * consistent with our pattern of not leaking existence.
 */
async function filterToOwnedIds(
  db: ReturnType<typeof getDbClient>,
  ids: string[],
  userId: string
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: inboxItemsTable.id })
    .from(inboxItemsTable)
    .innerJoin(workspacesTable, eq(inboxItemsTable.workspaceId, workspacesTable.id))
    .where(and(inArray(inboxItemsTable.id, ids), eq(workspacesTable.ownerId, userId)));
  return rows.map((r) => r.id);
}

function rowToInboxItem(row: typeof inboxItemsTable.$inferSelect): InboxItem {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as InboxItem['type'],
    status: row.status as InboxItem['status'],
    priority: row.priority as InboxItem['priority'],
    title: row.title,
    summary: row.summary,
    source: row.source as InboxItem['source'],
    actions: (row.actions as InboxItem['actions']) ?? [],
    data: (row.data as InboxItem['data']) ?? undefined,
    snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : undefined,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : undefined,
    actionedAt: row.actionedAt ? row.actionedAt.toISOString() : undefined,
  };
}
