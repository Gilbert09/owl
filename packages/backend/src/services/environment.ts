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
import * as pty from 'node-pty';
import { emitEnvironmentStatus } from './websocket.js';

interface LocalProcess {
  id: string;
  process: ChildProcess;
}

interface LocalPTY {
  id: string;
  pty: pty.IPty;
}

class EnvironmentService extends EventEmitter {
  private localProcesses: Map<string, LocalProcess> = new Map();
  private localPTYs: Map<string, LocalPTY> = new Map();
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
    daemonRegistry.on('session.close', (_envId, event) => {
      this.emit('session:close', event.sessionId, event.exitCode);
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
    for (const [id, ptyProc] of this.localPTYs) {
      ptyProc.pty.kill();
      this.localPTYs.delete(id);
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
        for (const [id, ptyProc] of this.localPTYs) {
          if (id.startsWith(`${environmentId}:`)) {
            ptyProc.pty.kill();
            this.localPTYs.delete(id);
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

  async spawnInteractive(
    environmentId: string,
    sessionId: string,
    command: string,
    options: { cwd?: string; rows?: number; cols?: number } = {}
  ): Promise<void> {
    const env = await this.getEnvironment(environmentId);
    if (!env) throw new Error(`Environment ${environmentId} not found`);

    switch (env.type) {
      case 'local':
        await this.spawnLocalInteractive(environmentId, sessionId, command, options);
        break;
      case 'ssh': {
        await sshService.createPTY(
          environmentId,
          sessionId,
          options.rows || 24,
          options.cols || 80
        );
        if (options.cwd) sshService.writeToPTY(sessionId, `cd ${options.cwd}\n`);
        sshService.writeToPTY(sessionId, `${command}\n`);
        break;
      }
      case 'daemon': {
        await daemonRegistry.request(environmentId, {
          op: 'spawn_interactive',
          sessionId,
          command,
          cwd: options.cwd,
          rows: options.rows,
          cols: options.cols,
        });
        break;
      }
      default:
        throw new Error(`Cannot spawn interactive on environment type: ${env.type}`);
    }
  }

  writeToSession(sessionId: string, data: string): void {
    const localPty = this.localPTYs.get(sessionId);
    if (localPty) {
      localPty.pty.write(data);
      return;
    }
    const localProc = this.localProcesses.get(sessionId);
    if (localProc) {
      localProc.process.stdin?.write(data);
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
    // Fall back to SSH if no daemon claimed it. Idempotent: ssh will
    // no-op for unknown session ids.
    sshService.writeToPTY(sessionId, data);
  }

  killSession(sessionId: string): void {
    const localPty = this.localPTYs.get(sessionId);
    if (localPty) {
      localPty.pty.kill();
      this.localPTYs.delete(sessionId);
      return;
    }
    const localProc = this.localProcesses.get(sessionId);
    if (localProc) {
      localProc.process.kill('SIGTERM');
      this.localProcesses.delete(sessionId);
      return;
    }
    for (const envId of daemonRegistry.listConnected()) {
      void daemonRegistry
        .request(envId, { op: 'kill_session', sessionId })
        .catch(() => {});
    }
    sshService.closePTY(sessionId);
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

  private async spawnLocalInteractive(
    _environmentId: string,
    sessionId: string,
    command: string,
    options: { cwd?: string; rows?: number; cols?: number }
  ): Promise<void> {
    const isNonInteractive = command.startsWith('claude --print') || command.startsWith('claude -p');
    let ptyProcess: pty.IPty;

    if (isNonInteractive) {
      console.log(`Spawning local PTY (non-interactive): bash -c "${command}"`);
      ptyProcess = pty.spawn('/bin/bash', ['-c', command], {
        name: 'xterm-256color',
        cols: options.cols || 120,
        rows: options.rows || 40,
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color' } as { [key: string]: string },
      });
    } else {
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      console.log(`Spawning local PTY (interactive): ${shell} (will run: ${command})`);
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: options.cols || 120,
        rows: options.rows || 40,
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color' } as { [key: string]: string },
      });
      setTimeout(() => { ptyProcess.write(command + '\n'); }, 100);
    }

    this.localPTYs.set(sessionId, { id: sessionId, pty: ptyProcess });
    ptyProcess.onData((data) => {
      this.emit('session:data', sessionId, Buffer.from(data));
    });
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`PTY exited with code ${exitCode}`);
      this.localPTYs.delete(sessionId);
      this.emit('session:close', sessionId, exitCode);
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
  };
}

export const environmentService = new EnvironmentService();
