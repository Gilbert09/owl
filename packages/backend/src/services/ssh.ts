import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { EventEmitter } from 'events';
import type { SSHEnvironmentConfig, EnvironmentStatus } from '@fastowl/shared';
import { emitEnvironmentStatus } from './websocket.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface SSHConnection {
  id: string;
  client: Client;
  config: SSHEnvironmentConfig;
  status: EnvironmentStatus;
  lastActivity: Date;
}

export interface PTYSession {
  id: string;
  connectionId: string;
  stream: ClientChannel;
  rows: number;
  cols: number;
}

class SSHService extends EventEmitter {
  private connections: Map<string, SSHConnection> = new Map();
  private ptySessions: Map<string, PTYSession> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Connect to an SSH environment
   */
  async connect(environmentId: string, config: SSHEnvironmentConfig): Promise<void> {
    // If already connected, return
    const existing = this.connections.get(environmentId);
    if (existing?.status === 'connected') {
      return;
    }

    // Update status
    this.updateStatus(environmentId, 'connecting');

    const client = new Client();
    const connectConfig = await this.buildConnectConfig(config);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end();
        this.updateStatus(environmentId, 'error', 'Connection timeout');
        reject(new Error('Connection timeout'));
      }, 30000);

      client.on('ready', () => {
        clearTimeout(timeout);

        const connection: SSHConnection = {
          id: environmentId,
          client,
          config,
          status: 'connected',
          lastActivity: new Date(),
        };

        this.connections.set(environmentId, connection);
        this.updateStatus(environmentId, 'connected');

        console.log(`SSH connected to ${config.host}`);
        resolve();
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`SSH error for ${config.host}:`, err.message);
        this.updateStatus(environmentId, 'error', err.message);
        this.scheduleReconnect(environmentId, config);
        reject(err);
      });

      client.on('close', () => {
        console.log(`SSH connection closed for ${config.host}`);
        this.connections.delete(environmentId);
        this.updateStatus(environmentId, 'disconnected');
        this.scheduleReconnect(environmentId, config);
      });

      client.on('end', () => {
        this.connections.delete(environmentId);
      });

      client.connect(connectConfig);
    });
  }

  /** IDs of every environment the service is currently tracking a connection for. */
  getConnectedEnvironmentIds(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Disconnect from an environment
   */
  disconnect(environmentId: string): void {
    const timer = this.reconnectTimers.get(environmentId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(environmentId);
    }

    const connection = this.connections.get(environmentId);
    if (connection) {
      connection.client.end();
      this.connections.delete(environmentId);
      this.updateStatus(environmentId, 'disconnected');
    }
  }

  /**
   * Execute a command on an environment
   */
  async exec(environmentId: string, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const connection = this.connections.get(environmentId);
    if (!connection || connection.status !== 'connected') {
      throw new Error(`Not connected to environment ${environmentId}`);
    }

    connection.lastActivity = new Date();

    return new Promise((resolve, reject) => {
      connection.client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          resolve({ stdout, stderr, code: code || 0 });
        });

        stream.on('error', reject);
      });
    });
  }

  /**
   * Create a PTY session for interactive terminal
   */
  async createPTY(
    environmentId: string,
    sessionId: string,
    rows: number = 24,
    cols: number = 80
  ): Promise<PTYSession> {
    const connection = this.connections.get(environmentId);
    if (!connection || connection.status !== 'connected') {
      throw new Error(`Not connected to environment ${environmentId}`);
    }

    return new Promise((resolve, reject) => {
      connection.client.shell(
        {
          rows,
          cols,
          term: 'xterm-256color',
        },
        (err, stream) => {
          if (err) {
            reject(err);
            return;
          }

          const session: PTYSession = {
            id: sessionId,
            connectionId: environmentId,
            stream,
            rows,
            cols,
          };

          this.ptySessions.set(sessionId, session);

          stream.on('close', (code: number | null, _signal: string | null) => {
            this.ptySessions.delete(sessionId);
            // ssh2 reports code=null when the remote closed without an explicit
            // exit code — treat as 0 (normal close) unless we have a signal.
            this.emit('pty:close', sessionId, code ?? 0);
          });

          stream.on('data', (data: Buffer) => {
            this.emit('pty:data', sessionId, data);
          });

          resolve(session);
        }
      );
    });
  }

  /**
   * Write to a PTY session
   */
  writeToPTY(sessionId: string, data: string): void {
    const session = this.ptySessions.get(sessionId);
    if (session) {
      session.stream.write(data);
    }
  }

  /**
   * Resize a PTY session
   */
  resizePTY(sessionId: string, rows: number, cols: number): void {
    const session = this.ptySessions.get(sessionId);
    if (session) {
      session.rows = rows;
      session.cols = cols;
      session.stream.setWindow(rows, cols, 0, 0);
    }
  }

  /**
   * Close a PTY session
   */
  closePTY(sessionId: string): void {
    const session = this.ptySessions.get(sessionId);
    if (session) {
      session.stream.end();
      this.ptySessions.delete(sessionId);
    }
  }

  /**
   * Get connection status
   */
  getStatus(environmentId: string): EnvironmentStatus {
    const connection = this.connections.get(environmentId);
    return connection?.status || 'disconnected';
  }

  /**
   * Test connection without keeping it open
   */
  async testConnection(config: SSHEnvironmentConfig): Promise<{ success: boolean; error?: string }> {
    const client = new Client();
    const connectConfig = await this.buildConnectConfig(config);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        client.end();
        resolve({ success: false, error: 'Connection timeout' });
      }, 10000);

      client.on('ready', () => {
        clearTimeout(timeout);
        client.end();
        resolve({ success: true });
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      });

      client.connect(connectConfig);
    });
  }

  /**
   * Build SSH connect config from our config
   */
  private async buildConnectConfig(config: SSHEnvironmentConfig): Promise<ConnectConfig> {
    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 30000,
      keepaliveInterval: 10000,
    };

    if (config.authMethod === 'agent') {
      // Use SSH agent
      connectConfig.agent = process.env.SSH_AUTH_SOCK;
    } else if (config.authMethod === 'key') {
      // Use private key
      const keyPath = config.privateKeyPath || path.join(os.homedir(), '.ssh', 'id_rsa');
      try {
        connectConfig.privateKey = fs.readFileSync(keyPath);
      } catch (_err) {
        // Try ed25519 as fallback
        const ed25519Path = path.join(os.homedir(), '.ssh', 'id_ed25519');
        connectConfig.privateKey = fs.readFileSync(ed25519Path);
      }
    }
    // Note: password auth would need to be added if needed

    return connectConfig;
  }

  private updateStatus(environmentId: string, status: EnvironmentStatus, error?: string): void {
    const connection = this.connections.get(environmentId);
    if (connection) {
      connection.status = status;
    }

    emitEnvironmentStatus(environmentId, status, error);
    this.emit('status', environmentId, status, error);
  }

  private scheduleReconnect(environmentId: string, config: SSHEnvironmentConfig): void {
    // Clear any existing timer
    const existing = this.reconnectTimers.get(environmentId);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule reconnect in 5 seconds
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(environmentId);
      try {
        console.log(`Attempting reconnect to ${config.host}...`);
        await this.connect(environmentId, config);
      } catch (_err) {
        // Will schedule another reconnect via error handler
      }
    }, 5000);

    this.reconnectTimers.set(environmentId, timer);
  }
}

// Singleton instance
export const sshService = new SSHService();
