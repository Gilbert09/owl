import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';
import { assertUser } from '../middleware/auth.js';
import { daemonRegistry } from '../services/daemonRegistry.js';
import type {
  Environment,
  EnvironmentConfig,
  EnvironmentRenderer,
  EnvironmentStatus,
  CreateEnvironmentRequest,
  ApiResponse,
} from '@fastowl/shared';

export function environmentRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const rows = await db
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.ownerId, user.id))
      .orderBy(environmentsTable.name);
    res.json({ success: true, data: rows.map(rowToEnvironment) } as ApiResponse<Environment[]>);
  });

  router.get('/:id', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const rows = await db
      .select()
      .from(environmentsTable)
      .where(and(eq(environmentsTable.id, req.params.id), eq(environmentsTable.ownerId, user.id)))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    res.json({ success: true, data: rowToEnvironment(rows[0]) } as ApiResponse<Environment>);
  });

  router.post('/', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const body = req.body as CreateEnvironmentRequest & { autonomousBypassPermissions?: boolean };
    const id = uuid();
    const now = new Date();
    // Both local and remote envs are now daemon-backed. Status starts
    // at 'disconnected' until the daemon dials in and pairs; the
    // registry flips it to 'connected' on register().
    const initialStatus = 'disconnected';

    // Remote envs are typically throwaway VMs — default them to
    // bypass permissions so autonomous tasks run without prompts.
    // Local envs ("This Mac") are the user's own hardware — default
    // to strict. Either default is overridable via the body flag.
    const autonomousBypass =
      body.autonomousBypassPermissions ?? body.type === 'remote';

    // Slice 4: structured renderer supported on every env type
    // (local = in-process spawn, daemon = stream_spawn wire op,
    // ssh = ssh2 exec channel). Still gated by an explicit opt-in
    // until Slice 4c flips the default.
    const renderer: EnvironmentRenderer = body.renderer ?? 'pty';

    await db.insert(environmentsTable).values({
      id,
      ownerId: user.id,
      name: body.name,
      type: body.type,
      status: initialStatus,
      config: body.config,
      autonomousBypassPermissions: autonomousBypass,
      renderer,
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
    const user = assertUser(req);
    const db = getDbClient();
    const body = req.body as {
      name?: string;
      config?: EnvironmentConfig;
      status?: EnvironmentStatus;
      autonomousBypassPermissions?: boolean;
      renderer?: EnvironmentRenderer;
      toolAllowlist?: string[];
    };
    const existing = await db
      .select()
      .from(environmentsTable)
      .where(and(eq(environmentsTable.id, req.params.id), eq(environmentsTable.ownerId, user.id)))
      .limit(1);
    if (!existing[0]) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.config !== undefined) updates.config = body.config;
    if (body.status !== undefined) updates.status = body.status;
    if (body.autonomousBypassPermissions !== undefined) {
      updates.autonomousBypassPermissions = body.autonomousBypassPermissions;
    }
    if (body.renderer !== undefined) {
      updates.renderer = body.renderer;
    }
    if (body.toolAllowlist !== undefined) {
      // Normalise to a deduped list of trimmed tool names.
      const seen = new Set<string>();
      const normalised: string[] = [];
      for (const raw of body.toolAllowlist) {
        const t = typeof raw === 'string' ? raw.trim() : '';
        if (!t || seen.has(t)) continue;
        seen.add(t);
        normalised.push(t);
      }
      updates.toolAllowlist = normalised;
    }

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
    const user = assertUser(req);
    const db = getDbClient();
    const result = await db
      .delete(environmentsTable)
      .where(and(eq(environmentsTable.id, req.params.id), eq(environmentsTable.ownerId, user.id)))
      .returning({ id: environmentsTable.id });
    if (result.length === 0) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  router.post('/:id/test', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const rows = await db
      .select({ id: environmentsTable.id })
      .from(environmentsTable)
      .where(and(eq(environmentsTable.id, req.params.id), eq(environmentsTable.ownerId, user.id)))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    res.json({ success: true, data: { connected: true } });
  });

  // Mint a one-time pairing token for an env. The UI shows the token +
  // backend URL; user runs `fastowl-daemon --pairing-token X
  // --backend-url Y` on the target machine (or the desktop app's
  // useLocalDaemon hook hands it to the bundled daemon). Tokens expire
  // in 10m.
  router.post('/:id/pairing-token', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const rows = await db
      .select({ id: environmentsTable.id })
      .from(environmentsTable)
      .where(and(eq(environmentsTable.id, req.params.id), eq(environmentsTable.ownerId, user.id)))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }

    const token = daemonRegistry.createPairingToken(req.params.id, user.id);
    res.json({
      success: true,
      data: { pairingToken: token, expiresInSeconds: 600 },
    });
  });

  // Trigger a self-update on the env's daemon. Only meaningful for
  // `remote` envs — local daemons update with the Electron app. The
  // daemon pulls latest from origin, rebuilds, stamps version.json,
  // replies ok, then exits so systemd/launchd restarts it.
  router.post('/:id/update-daemon', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const rows = await db
      .select()
      .from(environmentsTable)
      .where(and(eq(environmentsTable.id, req.params.id), eq(environmentsTable.ownerId, user.id)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    if (row.type === 'local') {
      return res.status(400).json({
        success: false,
        error:
          'Local daemon updates ship with the Electron app — check for a new FastOwl desktop release instead.',
      });
    }
    if (!daemonRegistry.isConnected(row.id)) {
      return res.status(400).json({
        success: false,
        error: 'Daemon is not connected; cannot trigger an update.',
      });
    }

    try {
      // Use a longer request timeout than the default — install +
      // build can legitimately take 1–2 minutes on a small VM.
      const result = await daemonRegistry.request<{ newSha: string; message: string }>(
        row.id,
        { op: 'update_daemon', drainTimeoutSeconds: 30 },
        5 * 60 * 1000
      );
      res.json({ success: true, data: result } as ApiResponse<{
        newSha: string;
        message: string;
      }>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: `Update failed: ${msg}` });
    }
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
    autonomousBypassPermissions: row.autonomousBypassPermissions,
    renderer: (row.renderer as EnvironmentRenderer) ?? 'pty',
    toolAllowlist: (row.toolAllowlist as string[]) ?? [],
  };
}
