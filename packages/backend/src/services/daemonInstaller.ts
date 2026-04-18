import { Client, ConnectConfig } from 'ssh2';

/**
 * Provisions the FastOwl daemon on a remote host over SSH by running
 * the public install script (`GET /daemon/install.sh`) via a curl|bash
 * pipe. Credentials are used once and never persisted — the daemon
 * itself only knows a device token after pairing.
 *
 * This is intentionally separate from `sshService` which owns long-lived
 * SSH connections for `type: 'ssh'` environments. Installs are a
 * one-shot: open → exec → close.
 */

export interface DaemonInstallOptions {
  host: string;
  port?: number;
  username: string;
  /** "password" | "privateKey" — the two auth modes we accept. */
  authMethod: 'password' | 'privateKey';
  password?: string;
  /** Raw PEM-encoded private key content (pasted by the user). */
  privateKey?: string;
  /** Passphrase for the private key, if encrypted. */
  passphrase?: string;
  /** Backend URL the daemon should dial. Always the hosted backend. */
  backendUrl: string;
  /** One-shot pairing token minted by the caller. */
  pairingToken: string;
  /** Timeout for the whole install. Default 5 minutes. */
  timeoutMs?: number;
}

export interface DaemonInstallResult {
  success: boolean;
  /** Combined stdout+stderr from the install script. */
  log: string;
  exitCode: number;
  error?: string;
}

export async function installDaemonOverSsh(
  options: DaemonInstallOptions
): Promise<DaemonInstallResult> {
  const client = new Client();
  const connectConfig: ConnectConfig = {
    host: options.host,
    port: options.port ?? 22,
    username: options.username,
    readyTimeout: 30_000,
  };

  if (options.authMethod === 'password') {
    if (!options.password) {
      return {
        success: false,
        log: '',
        exitCode: -1,
        error: 'password required when authMethod=password',
      };
    }
    connectConfig.password = options.password;
    // ssh2 needs `tryKeyboard: true` for servers that negotiate
    // keyboard-interactive instead of plain password. Safe to set either way.
    connectConfig.tryKeyboard = true;
  } else {
    if (!options.privateKey) {
      return {
        success: false,
        log: '',
        exitCode: -1,
        error: 'privateKey required when authMethod=privateKey',
      };
    }
    connectConfig.privateKey = options.privateKey;
    if (options.passphrase) connectConfig.passphrase = options.passphrase;
  }

  return new Promise<DaemonInstallResult>((resolve) => {
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    let log = '';
    let finished = false;

    const finish = (result: DaemonInstallResult): void => {
      if (finished) return;
      finished = true;
      try { client.end(); } catch { /* ignore */ }
      resolve(result);
    };

    const overallTimeout = setTimeout(() => {
      finish({
        success: false,
        log,
        exitCode: -1,
        error: `install timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish2) => {
      // Some servers prefer keyboard-interactive over password. Respond
      // with the same password for every prompt. Harmless if unused.
      finish2([options.password ?? '']);
    });

    client.on('error', (err) => {
      clearTimeout(overallTimeout);
      finish({
        success: false,
        log,
        exitCode: -1,
        error: `ssh connect failed: ${err.message}`,
      });
    });

    client.on('ready', () => {
      const scriptUrl = options.backendUrl.replace(/\/$/, '') + '/daemon/install.sh';
      // Pass backend-url + pairing-token as script args via `bash -s --`.
      // The `|| true` in front of `echo` ensures we always exit 0 from
      // the outer shell — inner exit code is captured via `$?` below.
      const escapedUrl = shellEscape(options.backendUrl);
      const escapedToken = shellEscape(options.pairingToken);
      const command =
        `set -o pipefail; ` +
        `curl -fsSL ${shellEscape(scriptUrl)} ` +
        `| bash -s -- --backend-url ${escapedUrl} --pairing-token ${escapedToken}`;

      client.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          clearTimeout(overallTimeout);
          finish({
            success: false,
            log,
            exitCode: -1,
            error: `exec failed: ${err.message}`,
          });
          return;
        }

        stream.on('data', (buf: Buffer) => {
          log += buf.toString('utf-8');
        });
        stream.stderr.on('data', (buf: Buffer) => {
          log += buf.toString('utf-8');
        });

        stream.on('close', (code: number | null) => {
          clearTimeout(overallTimeout);
          const exitCode = code ?? -1;
          finish({
            success: exitCode === 0,
            log,
            exitCode,
            error: exitCode === 0 ? undefined : `install script exited ${exitCode}`,
          });
        });
      });
    });

    try {
      client.connect(connectConfig);
    } catch (err: unknown) {
      clearTimeout(overallTimeout);
      finish({
        success: false,
        log,
        exitCode: -1,
        error: `ssh connect threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

/**
 * Quote a string so it survives being interpolated into a single-quoted
 * shell command. Every embedded `'` becomes `'\''`.
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
