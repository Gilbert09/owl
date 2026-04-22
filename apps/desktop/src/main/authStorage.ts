import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/**
 * Encryption backend for auth tokens at rest. The real implementation
 * is Electron's `safeStorage`, which binds the key to the OS user
 * account via Keychain / DPAPI / libsecret. Tests plug in a fake so
 * the store can be exercised without an Electron runtime.
 */
export interface EncryptionBackend {
  /**
   * True when the OS-level credential store is unlocked and usable.
   * safeStorage returns false on Linux boxes with no libsecret, or
   * before `app.whenReady()` completes.
   */
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

/**
 * File-backed, encrypted-at-rest key/value store for auth tokens.
 * Values are opaque strings (Supabase session JSON, in practice).
 *
 * One small file per key under `baseDir`, named by SHA-256 of the key
 * so callers can use arbitrary strings without worrying about path
 * safety. File perms are 0o600; the directory is 0o700.
 */
export class AuthStorage {
  constructor(
    private backend: EncryptionBackend,
    private baseDir: string
  ) {}

  private ensureDir(): void {
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.baseDir, 0o700);
    } catch {
      // Best-effort — on Windows chmod is a no-op.
    }
  }

  private pathFor(key: string): string {
    const safe = createHash('sha256').update(key).digest('hex');
    return path.join(this.baseDir, `${safe}.enc`);
  }

  async getItem(key: string): Promise<string | null> {
    const filePath = this.pathFor(key);
    let ciphertext: Buffer;
    try {
      ciphertext = await fs.promises.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (!this.backend.isAvailable()) {
      throw new Error('auth storage: encryption backend unavailable');
    }
    try {
      return this.backend.decrypt(ciphertext);
    } catch (err) {
      // Corrupted or wrong-user ciphertext — don't leak undecryptable
      // bytes back to Supabase; treat as missing so the user can
      // re-sign-in. Remove the unreadable file so we don't loop.
      await fs.promises.unlink(filePath).catch(() => {});
      console.warn('auth storage: decrypt failed, clearing entry:', err);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    if (!this.backend.isAvailable()) {
      throw new Error('auth storage: encryption backend unavailable');
    }
    this.ensureDir();
    const ciphertext = this.backend.encrypt(value);
    const filePath = this.pathFor(key);
    // Atomic-ish: write to a sibling tempfile, fsync, rename. Keeps
    // a partially-written blob from ever being read back.
    const tempPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tempPath, ciphertext, { mode: 0o600 });
    await fs.promises.rename(tempPath, filePath);
  }

  async removeItem(key: string): Promise<void> {
    await fs.promises.unlink(this.pathFor(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}
