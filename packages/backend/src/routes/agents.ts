import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { and, eq, SQL } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import {
  agents as agentsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { agentService } from '../services/agent.js';
import {
  assertUser,
  handleAccessError,
  requireAgentAccess,
  requireEnvironmentAccess,
  requireWorkspaceAccess,
} from '../middleware/auth.js';
import type {
  Agent,
  AgentStatus,
  AgentAttention,
  StartAgentRequest,
  ApiResponse,
} from '@fastowl/shared';

export function agentRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const { workspaceId, environmentId, status } = req.query;

    if (workspaceId) {
      try {
        await requireWorkspaceAccess(req, workspaceId as string);
      } catch (err) {
        return handleAccessError(err, res);
      }
    }
    if (environmentId) {
      try {
        await requireEnvironmentAccess(req, environmentId as string);
      } catch (err) {
        return handleAccessError(err, res);
      }
    }

    const conditions: SQL[] = [eq(workspacesTable.ownerId, user.id)];
    if (workspaceId) conditions.push(eq(agentsTable.workspaceId, workspaceId as string));
    if (environmentId) conditions.push(eq(agentsTable.environmentId, environmentId as string));
    if (status) conditions.push(eq(agentsTable.status, status as string));

    const rows = await db
      .select({ agent: agentsTable })
      .from(agentsTable)
      .innerJoin(workspacesTable, eq(agentsTable.workspaceId, workspacesTable.id))
      .where(and(...conditions))
      .orderBy(agentsTable.createdAt);

    res.json({ success: true, data: rows.map((r) => rowToAgent(r.agent)) } as ApiResponse<Agent[]>);
  });

  router.get('/:id', async (req, res) => {
    try {
      await requireAgentAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    res.json({ success: true, data: rowToAgent(rows[0]) } as ApiResponse<Agent>);
  });

  router.post('/start', async (req, res) => {
    const body = req.body as StartAgentRequest;
    try {
      await requireWorkspaceAccess(req, body.workspaceId);
      await requireEnvironmentAccess(req, body.environmentId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const id = uuid();
    const now = new Date();

    await db.insert(agentsTable).values({
      id,
      environmentId: body.environmentId,
      workspaceId: body.workspaceId,
      status: 'idle',
      attention: 'none',
      currentTaskId: body.taskId ?? null,
      terminalOutput: '',
      lastActivity: now,
      createdAt: now,
    });

    const rows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, id))
      .limit(1);

    res.status(201).json({ success: true, data: rowToAgent(rows[0]) } as ApiResponse<Agent>);
  });

  router.post('/:id/input', async (req, res) => {
    try {
      await requireAgentAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const { input } = req.body as { input: string };
    agentService.sendInput(req.params.id, input);

    await db
      .update(agentsTable)
      .set({ lastActivity: new Date() })
      .where(eq(agentsTable.id, req.params.id));

    res.json({ success: true } as ApiResponse<void>);
  });

  router.post('/:id/stop', async (req, res) => {
    try {
      await requireAgentAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();

    await db
      .update(agentsTable)
      .set({ status: 'idle', lastActivity: new Date() })
      .where(eq(agentsTable.id, req.params.id));

    const updated = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToAgent(updated[0]) } as ApiResponse<Agent>);
  });

  router.delete('/:id', async (req, res) => {
    try {
      await requireAgentAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const result = await db
      .delete(agentsTable)
      .where(eq(agentsTable.id, req.params.id))
      .returning({ id: agentsTable.id });
    if (result.length === 0) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}

function rowToAgent(row: typeof agentsTable.$inferSelect): Agent {
  return {
    id: row.id,
    environmentId: row.environmentId,
    workspaceId: row.workspaceId,
    status: row.status as AgentStatus,
    attention: row.attention as AgentAttention,
    currentTaskId: row.currentTaskId ?? undefined,
    terminalOutput: row.terminalOutput,
    lastActivity: row.lastActivity.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
