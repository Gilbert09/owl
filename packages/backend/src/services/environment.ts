import { EventEmitter } from 'events';
import { eq } from 'drizzle-orm';
import type {
  Environment,
  EnvironmentConfig,
  EnvironmentStatus,
} from '@fastowl/shared';
import { daemonRegistry } from './daemonRegistry.js';
import { getDbClient, type Database } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';
import { emitEnvironmentStatus } from './websocket.js';

/**
 * Environment service — the single transport surface for the backend.
 *
 * Every env (local or remote) is backed by a `@fastowl/daemon` process
 * dialling in over WS. This service just translates high-level ops
 * (exec, spawn, kill, etc.) into daemon-registry requests and forwards
 * the daemon's session events under backend-native names the rest of
 * the codebase listens for.
 *
 * Prior to the "daemon everywhere" refactor this service had three
 * code paths — in-proc child_process for `local`, ssh2 for `ssh`, and
 * WS for `daemon`. See docs/DAEMON_EVERYWHERE.md (Slice 5) for the
 * reasoning behind the collapse.
 */
class EnvironmentService extends EventEmitter {
  private get db(): Database {
    return getDbClient();
  }

  async init(): Promise<void> {
    // Forward daemon session events under the same names the rest of
    // the backend (agent service, git service) already listens for.
    // Env status transitions are persisted inside daemonRegistry itself
    // (see markEnvConnected/markEnvDisconnected) — don't wire a second
    // listener here or we'd double-write the DB on every connect.
    daemonRegistry.on('session.data', (_envId, event) => {
      const data = Buffer.from(event.dataBase64, 'base64');
      this.emit('session:data', event.sessionId, data);
    });
    daemonRegistry.on('session.stderr', (_envId, event) => {
      const data = Buffer.from(event.dataBase64, 'base64');
      this.emit('session:stderr', event.sessionId, data);
    });
    daemonRegistry.on('session.close', (_envId, event) => {
      this.emit('session:close', event.sessionId, event.exitCode);
    });
  }

  shutdown(): void {
    // Nothing to tear down here. The daemon registry owns WS lifetime.
  }

  async getAllEnvironments(): Promise<Environment[]> {
    const rows = await this.db.select().from(environmentsTable);
    return rows.map(rowToEnvironment);
  }

  async getEnvironment(id: string): Promise<Environment | null> {
    const rows = await this.db
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.id, id))
      .limit(1);
    return rows[0] ? rowToEnvironment(rows[0]) : null;
  }

  /**
   * "Connect" on a daemon-backed env is a read of the registry —
   * the daemon itself maintains the outbound WS connection. We just
   * reconcile the DB status.
   */
  async connect(environmentId: string): Promise<void> {
    const env = await this.getEnvironment(environmentId);
    if (!env) throw new Error(`Environment ${environmentId} not found`);
    if (daemonRegistry.isConnected(environmentId)) {
      await this.updateEnvironmentStatus(environmentId, 'connected');
    } else {
      await this.updateEnvironmentStatus(
        environmentId,
        'disconnected',
        'daemon not connected',
      );
    }
  }

  async disconnect(environmentId: string): Promise<void> {
    // Daemons are long-lived processes outside our control; we don't
    // forcefully stop them from the backend. Just mark the env as
    // disconnected in the DB — the next `hello` will re-reconcile.
    await this.updateEnvironmentStatus(environmentId, 'disconnected');
  }

  async exec(
    environmentId: string,
    command: string,
    options: { cwd?: string } = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return daemonRegistry.request<{ stdout: string; stderr: string; code: number }>(
      environmentId,
      { op: 'exec', command, cwd: options.cwd },
    );
  }

  /**
   * Non-PTY spawn for structured-renderer runs. Forwarded to the
   * daemon's `stream_spawn` wire op. Events flow back via
   * `session:data` / `session:stderr` / `session:close` — re-emitted
   * by the daemon-registry listeners wired up in `init()`.
   *
   * `writeToSession` / `killSession` / `closeStreamInput` know how to
   * address streaming sessions by the same `sessionId`.
   */
  async spawnStreaming(
    environmentId: string,
    sessionId: string,
    binary: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      keepStdinOpen: boolean;
      /** Bytes to write to stdin immediately on spawn. */
      initialStdin?: Buffer | string;
    },
  ): Promise<void> {
    const initialStdinBase64 = options.initialStdin
      ? Buffer.isBuffer(options.initialStdin)
        ? options.initialStdin.toString('base64')
        : Buffer.from(options.initialStdin, 'utf-8').toString('base64')
      : undefined;
    await daemonRegistry.request(environmentId, {
      op: 'stream_spawn',
      sessionId,
      binary,
      args,
      cwd: options.cwd,
      env: options.env,
      keepStdinOpen: options.keepStdinOpen,
      initialStdinBase64,
    });
  }

  async closeStreamInput(sessionId: string): Promise<void> {
    // Sessions are keyed globally — broadcast to every connected
    // daemon and let whichever owns it actually act. Errors are
    // expected from daemons that don't own the session.
    await Promise.all(
      daemonRegistry.listConnected().map((envId) =>
        daemonRegistry
          .request(envId, { op: 'close_stream_input', sessionId })
          .catch(() => {}),
      ),
    );
  }

  writeToSession(sessionId: string, data: string): void {
    for (const envId of daemonRegistry.listConnected()) {
      void daemonRegistry
        .request(envId, {
          op: 'write_session',
          sessionId,
          dataBase64: Buffer.from(data, 'utf-8').toString('base64'),
        })
        .catch(() => {
          // Session belongs to a different daemon; ignore.
        });
    }
  }

  killSession(sessionId: string): void {
    for (const envId of daemonRegistry.listConnected()) {
      void daemonRegistry
        .request(envId, { op: 'kill_session', sessionId })
        .catch(() => {});
    }
  }

  async testConnection(config: EnvironmentConfig): Promise<{ success: boolean; error?: string }> {
    // No reach-out "test" for daemon envs — connection is established
    // by the daemon dialling in, not by the backend pinging it.
    // Local and remote both return success; the real state is reflected
    // in the env's status column once pairing completes.
    if (config.type === 'local' || config.type === 'remote') {
      return { success: true };
    }
    return { success: false, error: `Unknown environment type` };
  }

  async getStatus(environmentId: string): Promise<EnvironmentStatus> {
    const env = await this.getEnvironment(environmentId);
    if (!env) return 'disconnected';
    return daemonRegistry.isConnected(environmentId) ? 'connected' : 'disconnected';
  }

  private async updateEnvironmentStatus(
    environmentId: string,
    status: EnvironmentStatus,
    error?: string,
  ): Promise<void> {
    const now = new Date();
    const updates: Record<string, unknown> = {
      status,
      updatedAt: now,
    };
    if (status === 'connected') {
      updates.lastConnected = now;
      updates.error = null;
    } else if (error) {
      updates.error = error;
    }

    await this.db
      .update(environmentsTable)
      .set(updates)
      .where(eq(environmentsTable.id, environmentId));

    emitEnvironmentStatus(environmentId, status, error);
  }
}

function rowToEnvironment(row: typeof environmentsTable.$inferSelect): Environment {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Environment['type'],
    status: row.status as EnvironmentStatus,
    config: row.config as EnvironmentConfig,
    lastConnected: row.lastConnected ? row.lastConnected.toISOString() : undefined,
    error: row.error || undefined,
    autonomousBypassPermissions: row.autonomousBypassPermissions,
    renderer: (row.renderer as Environment['renderer']) ?? 'pty',
    toolAllowlist: (row.toolAllowlist as string[]) ?? [],
    daemonVersion: row.daemonVersion ?? undefined,
    autoUpdateDaemon: row.autoUpdateDaemon,
  };
}

export const environmentService = new EnvironmentService();
