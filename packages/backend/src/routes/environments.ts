import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';
import type {
  Environment,
  EnvironmentConfig,
  EnvironmentStatus,
  CreateEnvironmentRequest,
  ApiResponse,
} from '@fastowl/shared';

export function environmentRoutes(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(environmentsTable)
      .orderBy(environmentsTable.name);
    res.json({ success: true, data: rows.map(rowToEnvironment) } as ApiResponse<Environment[]>);
  });

  router.get('/:id', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    res.json({ success: true, data: rowToEnvironment(rows[0]) } as ApiResponse<Environment>);
  });

  router.post('/', async (req, res) => {
    const db = getDbClient();
    const body = req.body as CreateEnvironmentRequest;
    const id = uuid();
    const now = new Date();
    const initialStatus = body.type === 'local' ? 'connected' : 'disconnected';

    await db.insert(environmentsTable).values({
      id,
      name: body.name,
      type: body.type,
      status: initialStatus,
      config: body.config,
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.id, id))
      .limit(1);
    res.status(201).json({ success: true, data: rowToEnvironment(rows[0]) } as ApiResponse<Environment>);
  });

  router.patch('/:id', async (req, res) => {
    const db = getDbClient();
    const body = req.body as {
      name?: string;
      config?: EnvironmentConfig;
      status?: EnvironmentStatus;
    };
    const existing = await db
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.id, req.params.id))
      .limit(1);
    if (!existing[0]) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.config !== undefined) updates.config = body.config;
    if (body.status !== undefined) updates.status = body.status;

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await db
        .update(environmentsTable)
        .set(updates)
        .where(eq(environmentsTable.id, req.params.id));
    }

    const rows = await db
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToEnvironment(rows[0]) } as ApiResponse<Environment>);
  });

  router.delete('/:id', async (req, res) => {
    const db = getDbClient();
    const result = await db
      .delete(environmentsTable)
      .where(eq(environmentsTable.id, req.params.id))
      .returning({ id: environmentsTable.id });
    if (result.length === 0) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  // Test connection (placeholder)
  router.post('/:id/test', async (req, res) => {
    const db = getDbClient();
    const rows = await db
      .select({ id: environmentsTable.id })
      .from(environmentsTable)
      .where(eq(environmentsTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    res.json({ success: true, data: { connected: true } });
  });

  return router;
}

function rowToEnvironment(row: typeof environmentsTable.$inferSelect): Environment {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Environment['type'],
    status: row.status as EnvironmentStatus,
    config: row.config as EnvironmentConfig,
    lastConnected: row.lastConnected ? row.lastConnected.toISOString() : undefined,
    error: row.error ?? undefined,
  };
}
