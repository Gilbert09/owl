import { Router } from 'express';
import type { PermissionDecision } from '@fastowl/shared';
import { permissionService } from '../services/permissionService.js';
import { assertUser } from '../middleware/auth.js';
import { getDbClient } from '../db/client.js';
import { tasks as tasksTable, environments as environmentsTable } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Public (unauthenticated-by-JWT) endpoint the CLI's PreToolUse hook
 * posts to. Auth is a per-run token presented as a header — only the
 * child process we spawned knows it, so random processes on the same
 * host can't inject permission prompts.
 */
export function permissionHookRoutes(): Router {
  const router = Router();

  router.post('/permission-hook', async (req, res) => {
    const token = req.header('x-fastowl-permission-token');
    if (!token) {
      return res.status(401).json({ success: false, error: 'missing permission token' });
    }
    const ctx = permissionService.verifyRunToken(token);
    if (!ctx) {
      return res.status(401).json({ success: false, error: 'invalid permission token' });
    }

    const body = req.body as {
      tool_name?: string;
      tool_input?: unknown;
      tool_use_id?: string;
      session_id?: string;
    };
    if (!body?.tool_name || typeof body.tool_name !== 'string') {
      return res.status(400).json({ success: false, error: 'tool_name required' });
    }

    const { decision, reason } = await permissionService.requestDecision(
      token,
      body.tool_name,
      body.tool_input ?? null,
      body.tool_use_id,
      body.session_id
    );
    res.json({ decision, reason });
  });

  return router;
}

/**
 * Authenticated endpoint the desktop UI POSTs to when the user clicks
 * Approve / Deny. Owner-scoped via a task ownership check.
 */
export function permissionDesktopRoutes(): Router {
  const router = Router();

  router.post('/tasks/:taskId/permission', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();

    // Owner check — join task → environment → owner. The env id on the
    // task is the authoritative scope.
    const rows = await db
      .select({ envId: tasksTable.assignedEnvironmentId })
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.taskId))
      .limit(1);
    if (!rows[0]?.envId) {
      return res.status(404).json({ success: false, error: 'task not found' });
    }
    const envRows = await db
      .select({ ownerId: environmentsTable.ownerId })
      .from(environmentsTable)
      .where(eq(environmentsTable.id, rows[0].envId))
      .limit(1);
    if (envRows[0]?.ownerId !== user.id) {
      return res.status(403).json({ success: false, error: 'not your task' });
    }

    const body = req.body as {
      requestId?: string;
      decision?: PermissionDecision;
      persist?: boolean;
      reason?: string;
    };
    if (!body?.requestId || (body.decision !== 'allow' && body.decision !== 'deny')) {
      return res.status(400).json({ success: false, error: 'requestId + decision required' });
    }
    const ok = await permissionService.respond(body.requestId, body.decision, {
      persist: body.persist,
      reason: body.reason,
    });
    if (!ok) {
      return res
        .status(410)
        .json({ success: false, error: 'request already resolved or expired' });
    }
    res.json({ success: true });
  });

  // Replay endpoint — desktop calls on reconnect to rebuild any pending
  // permission cards that fired during the disconnect window.
  router.get('/tasks/:taskId/permission/pending', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const rows = await db
      .select({ envId: tasksTable.assignedEnvironmentId })
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.taskId))
      .limit(1);
    if (!rows[0]?.envId) {
      return res.status(404).json({ success: false, error: 'task not found' });
    }
    const envRows = await db
      .select({ ownerId: environmentsTable.ownerId })
      .from(environmentsTable)
      .where(eq(environmentsTable.id, rows[0].envId))
      .limit(1);
    if (envRows[0]?.ownerId !== user.id) {
      return res.status(403).json({ success: false, error: 'not your task' });
    }
    const pending = permissionService.listPendingForTask(req.params.taskId).map((p) => ({
      requestId: p.requestId,
      agentId: p.agentId,
      taskId: p.taskId,
      toolName: p.toolName,
      toolInput: p.toolInput,
      toolUseId: p.toolUseId,
      sessionId: p.sessionId,
      requestedAt: p.requestedAt,
    }));
    res.json({ success: true, data: { pending } });
  });

  return router;
}
