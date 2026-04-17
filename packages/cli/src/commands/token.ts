import type { Command } from 'commander';
import { createInterface } from 'readline';
import { getAuthToken, setAuthToken, clearAuthToken, tokenFilePath } from '../config.js';

export function registerTokenCommands(program: Command): void {
  const token = program
    .command('token')
    .description('Manage the CLI auth token (copied from desktop app → Settings → Copy CLI token)');

  token
    .command('set [token]')
    .description('Store the auth token. Pass as arg or paste on prompt.')
    .action(async (maybeToken: string | undefined) => {
      const value = maybeToken ?? (await promptForToken());
      if (!value.trim()) {
        console.error('error: token is empty');
        process.exit(1);
      }
      setAuthToken(value);
      console.log(`ok: saved to ${tokenFilePath()}`);
    });

  token
    .command('show')
    .description('Print the currently stored token (for scripting only — do not share)')
    .action(() => {
      const t = getAuthToken();
      if (!t) {
        console.error('error: no token stored. Run `fastowl token set` first.');
        process.exit(1);
      }
      console.log(t);
    });

  token
    .command('clear')
    .description('Remove the stored token')
    .action(() => {
      clearAuthToken();
      console.log('ok: cleared');
    });

  token
    .command('whoami')
    .description('Decode the token and print the authenticated user')
    .action(() => {
      const t = getAuthToken();
      if (!t) {
        console.error('error: no token stored');
        process.exit(1);
      }
      const claims = decodeJwtPayload(t);
      if (!claims) {
        console.error('error: token is not a valid JWT');
        process.exit(1);
      }
      const { sub, email, exp } = claims as { sub?: string; email?: string; exp?: number };
      console.log(`user: ${sub ?? '<unknown>'}`);
      if (email) console.log(`email: ${email}`);
      if (exp) {
        const expiresAt = new Date(exp * 1000);
        const now = Date.now();
        const expired = expiresAt.getTime() <= now;
        console.log(`expires: ${expiresAt.toISOString()}${expired ? ' (EXPIRED)' : ''}`);
      }
    });
}

async function promptForToken(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Paste token: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Extract the JSON payload from a JWT without verifying its signature. */
function decodeJwtPayload(token: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}
