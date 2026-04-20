import { EventEmitter } from 'events';
import { eq, and, ne } from 'drizzle-orm';
import type {
  Environment,
  EnvironmentConfig,
  EnvironmentStatus,
  SSHEnvironmentConfig,
} from '@fastowl/shared';
import { sshService } from './ssh.js';
import { daemonRegistry } from './daemonRegistry.js';
import { getDbClient, type Database } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';
import { spawn, ChildProcess } from 'child_process';
import { emitEnvironmentStatus } from './websocket.js';

interface LocalProcess {
  id: string;
  process: ChildProcess;
}

/**
 * Non-PTY local child spawned for structured-renderer runs. Tracked
 * in a map so `writeToSession` / `killSession` / `closeStreamInput`
 * can address it by sessionId.
 */
interface LocalStreamProcess {
  id: string;
  process: ChildProcess;
}

class EnvironmentService extends EventEmitter {
  private localProcesses: Map<string, LocalProcess> = new Map();
  private localStreams: Map<string, LocalStreamProcess> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;

  private get db(): Database {
    return getDbClient();
  }

  /**
   * Initialize the service: fix stale local statuses, start the health-check
   * loop, and subscribe to SSH status changes.
   */
  async init(): Promise<void> {
    await this.fixLocalEnvironmentStatus();

    this.healthCheckInterval = setInterval(() => {
      this.checkAllEnvironments();
    }, 30000);

    sshService.on('status', (environmentId, status, error) => {
      this.updateEnvironmentStatus(environmentId, status, error).catch((err) =>
        console.error('Failed to update environment status:', err)
      );
    });

    // Forward daemon session events under the same names the rest of
    // the backend (agent service, git service) already listens for.
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

    // Forward SSH streaming-exec events under the same session:*
    // names so the structured renderer sees one unified stream
    // regardless of transport.
    sshService.on('stream:data', (sessionId: string, data: Buffer) => {
      this.emit('session:data', sessionId, data);
    });
    sshService.on('stream:stderr', (sessionId: string, data: Buffer) => {
      this.emit('session:stderr', sessionId, data);
    });
    sshService.on('stream:close', (sessionId: string, exitCode: number) => {
      this.emit('session:close', sessionId, exitCode);
    });
  }

  private async fixLocalEnvironmentStatus(): Promise<void> {
    const result = await this.db
      .update(environmentsTable)
      .set({ status: 'connected' })
      .where(and(eq(environmentsTable.type, 'local'), ne(environmentsTable.status, 'connected')))
      .returning({ id: environmentsTable.id });
    if (result.length > 0) {
      console.log(`Fixed ${result.length} local environment(s) status to connected`);
    }
  }

  shutdown(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Disconnect every SSH connection the service still knows about.
    // We ask sshService directly instead of querying the DB — a DB query
    // here would spawn a fire-and-forget promise that outlives shutdown
    // and can hang subsequent work (notably: tests swapping DB clients).
    for (const id of sshService.getConnectedEnvironmentIds()) {
      sshService.disconnect(id);
    }

    for (const [id, proc] of this.localProcesses) {
      proc.process.kill();
      this.localProcesses.delete(id);
    }
    for (const [id, stream] of this.localStreams) {
      try { stream.process.kill('SIGTERM'); } catch {
        // Already dead.
      }
      this.localStreams.delete(id);
    }
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

  async connect(environmentId: string): Promise<void> {
    const env = await this.getEnvironment(environmentId);
    if (!env) throw new Error(`Environment ${environmentId} not found`);

    switch (env.type) {
      case 'local':
        await this.updateEnvironmentStatus(environmentId, 'connected');
        break;
      case 'ssh':
        await sshService.connect(environmentId, env.config as SSHEnvironmentConfig);
        break;
      case 'daemon':
        // "Connect" on a daemon env is a DB-level op — the daemon itself
        // maintains its outbound WS connection independently. We just
        // mark the status; the registry updates last_seen_at as messages
        // flow.
        if (daemonRegistry.isConnected(environmentId)) {
          await this.updateEnvironmentStatus(environmentId, 'connected');
        } else {
          await this.updateEnvironmentStatus(
            environmentId,
            'disconnected',
            'daemon not connected'
          );
        }
        break;
      case 'coder':
        throw new Error('Coder environments not yet implemented');
      default:
        throw new Error(`Unknown environment type: ${env.type}`);
    }
  }

  async disconnect(environmentId: string): Promise<void> {
    const env = await this.getEnvironment(environmentId);
    if (!env) return;

    switch (env.type) {
      case 'ssh':
        sshService.disconnect(environmentId);
        break;
      case 'local':
        for (const [id, proc] of this.localProcesses) {
          if (id.startsWith(`${environmentId}:`)) {
            proc.process.kill();
            this.localProcesses.delete(id);
          }
        }
        for (const [id, stream] of this.localStreams) {
          if (id.startsWith(`${environmentId}:`)) {
            try { stream.process.kill('SIGTERM'); } catch {
              // Already dead.
            }
            this.localStreams.delete(id);
          }
        }
        await this.updateEnvironmentStatus(environmentId, 'disconnected');
        break;
    }
  }

  async exec(
    environmentId: string,
    command: string,
    options: { cwd?: string } = {}
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const env = await this.getEnvironment(environmentId);
    if (!env) throw new Error(`Environment ${environmentId} not found`);

    switch (env.type) {
      case 'local':
        return this.execLocal(command, options.cwd);
      case 'ssh': {
        const fullCommand = options.cwd ? `cd ${options.cwd} && ${command}` : command;
        return sshService.exec(environmentId, fullCommand);
      }
      case 'daemon': {
        return daemonRegistry.request<{ stdout: string; stderr: string; code: number }>(
          environmentId,
          { op: 'exec', command, cwd: options.cwd }
        );
      }
      default:
        throw new Error(`Cannot exec on environment type: ${env.type}`);
    }
  }

  /**
   * Non-PTY spawn for structured-renderer runs. Routes to local
   * `child_process.spawn` or the daemon's `stream_spawn` wire op
   * depending on env type. Emits `session:data` / `session:stderr` /
   * `session:close` on this service.
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
    }
  ): Promise<void> {
    const env = await this.getEnvironment(environmentId);
    if (!env) throw new Error(`Environment ${environmentId} not found`);

    switch (env.type) {
      case 'local':
        this.spawnLocalStreaming(sessionId, binary, args, options);
        return;
      case 'daemon': {
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
        return;
      }
      case 'ssh': {
        await sshService.execStream(environmentId, sessionId, binary, args, {
          cwd: options.cwd,
          env: options.env,
          keepStdinOpen: options.keepStdinOpen,
          initialStdin: options.initialStdin,
        });
        return;
      }
      default:
        throw new Error(`Cannot spawn streaming on environment type: ${env.type}`);
    }
  }

  /**
   * Gracefully half-close stdin on a structured session. Mirrors
   * `killSession`'s "try local first, then broadcast to daemons"
   * pattern — callers don't need to know which env owns the session.
   */
  async closeStreamInput(sessionId: string): Promise<void> {
    const proc = this.localStreams.get(sessionId);
    if (proc && !proc.process.stdin?.destroyed) {
      proc.process.stdin?.end();
      return;
    }
    if (sshService.hasStream(sessionId)) {
      sshService.closeStreamInput(sessionId);
      return;
    }
    await Promise.all(
      daemonRegistry.listConnected().map((envId) =>
        daemonRegistry
          .request(envId, { op: 'close_stream_input', sessionId })
          .catch(() => {})
      )
    );
  }

  writeToSession(sessionId: string, data: string): void {
    const localStream = this.localStreams.get(sessionId);
    if (localStream) {
      localStream.process.stdin?.write(data);
      return;
    }
    const localProc = this.localProcesses.get(sessionId);
    if (localProc) {
      localProc.process.stdin?.write(data);
      return;
    }
    if (sshService.hasStream(sessionId)) {
      sshService.writeToStream(sessionId, data);
      return;
    }
    // Try any connected daemon — sessions are keyed globally, so we
    // look for the one that actually owns this session id.
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
    const localStream = this.localStreams.get(sessionId);
    if (localStream) {
      try { localStream.process.kill('SIGTERM'); } catch {
        // already dead
      }
      // Map entry cleared via the exit handler installed in
      // `spawnLocalStreaming` so event listeners on session:close
      // still fire.
      return;
    }
    const localProc = this.localProcesses.get(sessionId);
    if (localProc) {
      localProc.process.kill('SIGTERM');
      this.localProcesses.delete(sessionId);
      return;
    }
    if (sshService.hasStream(sessionId)) {
      sshService.killStream(sessionId);
      return;
    }
    for (const envId of daemonRegistry.listConnected()) {
      void daemonRegistry
        .request(envId, { op: 'kill_session', sessionId })
        .catch(() => {});
    }
  }

  async testConnection(config: EnvironmentConfig): Promise<{ success: boolean; error?: string }> {
    switch (config.type) {
      case 'local':
        return { success: true };
      case 'ssh':
        return sshService.testConnection(config as SSHEnvironmentConfig);
      default:
        return { success: false, error: `Unknown environment type: ${config.type}` };
    }
  }

  async getStatus(environmentId: string): Promise<EnvironmentStatus> {
    const env = await this.getEnvironment(environmentId);
    if (!env) return 'disconnected';
    if (env.type === 'local') return 'connected';
    if (env.type === 'ssh') return sshService.getStatus(environmentId);
    if (env.type === 'daemon') {
      return daemonRegistry.isConnected(environmentId) ? 'connected' : 'disconnected';
    }
    return 'disconnected';
  }

  private execLocal(
    command: string,
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('bash', ['-c', command], {
        cwd: cwd || process.cwd(),
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('close', (code) => {
        resolve({ stdout, stderr, code: code || 0 });
      });
      proc.on('error', reject);
    });
  }

  /**
   * Local (in-backend) streaming spawn. No PTY — stdin / stdout /
   * stderr are plain pipes. Emits via the service's event bus so the
   * agent service + structured renderer code consume identically for
   * local and daemon envs.
   */
  private spawnLocalStreaming(
    sessionId: string,
    binary: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      keepStdinOpen: boolean;
      initialStdin?: Buffer | string;
    }
  ): void {
    const childEnv = { ...process.env, ...(options.env ?? {}) };
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.localStreams.set(sessionId, { id: sessionId, process: child });

    if (options.initialStdin && child.stdin) {
      const buf = Buffer.isBuffer(options.initialStdin)
        ? options.initialStdin
        : Buffer.from(options.initialStdin, 'utf-8');
      child.stdin.write(buf);
    }
    if (!options.keepStdinOpen && child.stdin) {
      child.stdin.end();
    }

    child.stdout?.on('data', (b: Buffer) => {
      this.emit('session:data', sessionId, b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      this.emit('session:stderr', sessionId, b);
    });
    child.on('exit', (code) => {
      this.localStreams.delete(sessionId);
      this.emit('session:close', sessionId, code ?? 0);
    });
    child.on('error', (err) => {
      this.emit('session:stderr', sessionId, Buffer.from(err.message, 'utf-8'));
      this.localStreams.delete(sessionId);
      this.emit('session:close', sessionId, 1);
    });
  }

  private async updateEnvironmentStatus(
    environmentId: string,
    status: EnvironmentStatus,
    error?: string
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

  private async checkAllEnvironments(): Promise<void> {
    const envs = await this.getAllEnvironments();
    for (const env of envs) {
      if (env.type === 'ssh' && env.status === 'connected') {
        try {
          await sshService.exec(env.id, 'true');
        } catch {
          // SSH service handles reconnect
        }
      }
    }
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
  };
}

export const environmentService = new EnvironmentService();
