import { EventEmitter } from 'events';
import type {
  Environment,
  EnvironmentConfig,
  EnvironmentStatus,
  SSHEnvironmentConfig,
} from '@fastowl/shared';
import { sshService } from './ssh.js';
import { DB } from '../db/index.js';
import { spawn, ChildProcess } from 'child_process';
import { emitEnvironmentStatus } from './websocket.js';

interface LocalProcess {
  id: string;
  process: ChildProcess;
}

class EnvironmentService extends EventEmitter {
  private db: DB | null = null;
  private localProcesses: Map<string, LocalProcess> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;

  /**
   * Initialize with database connection
   */
  init(db: DB): void {
    this.db = db;

    // Start health check loop
    this.healthCheckInterval = setInterval(() => {
      this.checkAllEnvironments();
    }, 30000); // Every 30 seconds

    // Listen for SSH status changes
    sshService.on('status', (environmentId, status, error) => {
      this.updateEnvironmentStatus(environmentId, status, error);
    });
  }

  /**
   * Shutdown service
   */
  shutdown(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Disconnect all SSH connections
    const environments = this.getAllEnvironments();
    for (const env of environments) {
      if (env.type === 'ssh') {
        sshService.disconnect(env.id);
      }
    }

    // Kill all local processes
    for (const [id, proc] of this.localProcesses) {
      proc.process.kill();
      this.localProcesses.delete(id);
    }
  }

  /**
   * Get all environments from database
   */
  getAllEnvironments(): Environment[] {
    if (!this.db) return [];

    const rows = this.db.prepare('SELECT * FROM environments').all();
    return rows.map(this.rowToEnvironment);
  }

  /**
   * Get environment by ID
   */
  getEnvironment(id: string): Environment | null {
    if (!this.db) return null;

    const row = this.db.prepare('SELECT * FROM environments WHERE id = ?').get(id);
    return row ? this.rowToEnvironment(row) : null;
  }

  /**
   * Connect to an environment
   */
  async connect(environmentId: string): Promise<void> {
    const env = this.getEnvironment(environmentId);
    if (!env) {
      throw new Error(`Environment ${environmentId} not found`);
    }

    switch (env.type) {
      case 'local':
        // Local is always "connected"
        this.updateEnvironmentStatus(environmentId, 'connected');
        break;

      case 'ssh':
        await sshService.connect(environmentId, env.config as SSHEnvironmentConfig);
        break;

      case 'coder':
        // TODO: Implement Coder connection
        throw new Error('Coder environments not yet implemented');

      default:
        throw new Error(`Unknown environment type: ${env.type}`);
    }
  }

  /**
   * Disconnect from an environment
   */
  disconnect(environmentId: string): void {
    const env = this.getEnvironment(environmentId);
    if (!env) return;

    switch (env.type) {
      case 'ssh':
        sshService.disconnect(environmentId);
        break;

      case 'local':
        // Kill any running processes
        for (const [id, proc] of this.localProcesses) {
          if (id.startsWith(`${environmentId}:`)) {
            proc.process.kill();
            this.localProcesses.delete(id);
          }
        }
        this.updateEnvironmentStatus(environmentId, 'disconnected');
        break;
    }
  }

  /**
   * Execute a command on an environment
   */
  async exec(
    environmentId: string,
    command: string,
    options: { cwd?: string } = {}
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const env = this.getEnvironment(environmentId);
    if (!env) {
      throw new Error(`Environment ${environmentId} not found`);
    }

    switch (env.type) {
      case 'local':
        return this.execLocal(command, options.cwd);

      case 'ssh': {
        const fullCommand = options.cwd ? `cd ${options.cwd} && ${command}` : command;
        return sshService.exec(environmentId, fullCommand);
      }

      default:
        throw new Error(`Cannot exec on environment type: ${env.type}`);
    }
  }

  /**
   * Spawn an interactive process on an environment
   */
  async spawnInteractive(
    environmentId: string,
    sessionId: string,
    command: string,
    options: { cwd?: string; rows?: number; cols?: number } = {}
  ): Promise<void> {
    const env = this.getEnvironment(environmentId);
    if (!env) {
      throw new Error(`Environment ${environmentId} not found`);
    }

    switch (env.type) {
      case 'local':
        await this.spawnLocalInteractive(environmentId, sessionId, command, options);
        break;

      case 'ssh': {
        // Create PTY and then run command
        await sshService.createPTY(
          environmentId,
          sessionId,
          options.rows || 24,
          options.cols || 80
        );

        // Send the command
        if (options.cwd) {
          sshService.writeToPTY(sessionId, `cd ${options.cwd}\n`);
        }
        sshService.writeToPTY(sessionId, `${command}\n`);
        break;
      }

      default:
        throw new Error(`Cannot spawn interactive on environment type: ${env.type}`);
    }
  }

  /**
   * Write to an interactive session
   */
  writeToSession(sessionId: string, data: string): void {
    // Check if it's a local process
    const localProc = this.localProcesses.get(sessionId);
    if (localProc) {
      localProc.process.stdin?.write(data);
      return;
    }

    // Otherwise assume SSH
    sshService.writeToPTY(sessionId, data);
  }

  /**
   * Kill an interactive session
   */
  killSession(sessionId: string): void {
    // Check if it's a local process
    const localProc = this.localProcesses.get(sessionId);
    if (localProc) {
      localProc.process.kill('SIGTERM');
      this.localProcesses.delete(sessionId);
      return;
    }

    // Otherwise assume SSH
    sshService.closePTY(sessionId);
  }

  /**
   * Test an environment connection
   */
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

  /**
   * Get connection status
   */
  getStatus(environmentId: string): EnvironmentStatus {
    const env = this.getEnvironment(environmentId);
    if (!env) return 'disconnected';

    if (env.type === 'local') {
      return 'connected'; // Local is always connected
    }

    if (env.type === 'ssh') {
      return sshService.getStatus(environmentId);
    }

    return 'disconnected';
  }

  /**
   * Execute locally
   */
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

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, code: code || 0 });
      });

      proc.on('error', reject);
    });
  }

  /**
   * Spawn local interactive process
   */
  private async spawnLocalInteractive(
    environmentId: string,
    sessionId: string,
    command: string,
    options: { cwd?: string; rows?: number; cols?: number }
  ): Promise<void> {
    const proc = spawn('bash', ['-c', command], {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        LINES: String(options.rows || 24),
        COLUMNS: String(options.cols || 80),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.localProcesses.set(sessionId, {
      id: sessionId,
      process: proc,
    });

    proc.stdout?.on('data', (data) => {
      this.emit('session:data', sessionId, data);
    });

    proc.stderr?.on('data', (data) => {
      this.emit('session:data', sessionId, data);
    });

    proc.on('close', (code) => {
      this.localProcesses.delete(sessionId);
      this.emit('session:close', sessionId, code);
    });

    proc.on('error', (err) => {
      this.localProcesses.delete(sessionId);
      this.emit('session:error', sessionId, err);
    });
  }

  /**
   * Update environment status in database
   */
  private updateEnvironmentStatus(
    environmentId: string,
    status: EnvironmentStatus,
    error?: string
  ): void {
    if (!this.db) return;

    const now = new Date().toISOString();
    const updates: string[] = ['status = ?', 'updated_at = ?'];
    const values: any[] = [status, now];

    if (status === 'connected') {
      updates.push('last_connected = ?');
      values.push(now);
      updates.push('error = NULL');
    } else if (error) {
      updates.push('error = ?');
      values.push(error);
    }

    values.push(environmentId);

    this.db.prepare(`UPDATE environments SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    // Emit to WebSocket
    emitEnvironmentStatus(environmentId, status, error);
  }

  /**
   * Check all environments' health
   */
  private async checkAllEnvironments(): Promise<void> {
    const environments = this.getAllEnvironments();

    for (const env of environments) {
      if (env.type === 'ssh' && env.status === 'connected') {
        try {
          // Simple ping - run 'true' command
          await sshService.exec(env.id, 'true');
        } catch (_err) {
          // Connection lost, SSH service will handle reconnect
        }
      }
    }
  }

  private rowToEnvironment(row: any): Environment {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      config: JSON.parse(row.config),
      lastConnected: row.last_connected || undefined,
      error: row.error || undefined,
    };
  }
}

// Singleton instance
export const environmentService = new EnvironmentService();
