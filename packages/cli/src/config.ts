import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * CLI auth lives in `$HOME/.fastowl/token` — a plain file containing the
 * Supabase access token. Mode 0600 (owner read/write only) so roommates and
 * backup syncs don't pick it up. We don't encrypt: Supabase access tokens
 * are short-lived and rotate on every sign-in.
 *
 * FASTOWL_AUTH_TOKEN env var wins when set — useful for automation (CI,
 * MCP server invoked by a parent process that already has a token).
 */
const CONFIG_DIR = path.join(os.homedir(), '.fastowl');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token');

export function getAuthToken(): string | null {
  const envToken = process.env.FASTOWL_AUTH_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();

  try {
    const contents = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    return contents || null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function setAuthToken(token: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, token.trim() + '\n', { mode: 0o600 });
}

export function clearAuthToken(): void {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function tokenFilePath(): string {
  return TOKEN_FILE;
}
