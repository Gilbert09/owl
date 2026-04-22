import fs from 'fs';
import path from 'path';
import os from 'os';
import { AuthStorage, type EncryptionBackend } from '../main/authStorage';

/**
 * Fake encryption backend that XORs every byte with a fixed key. Not a
 * real cipher — just something that makes the on-disk bytes visibly
 * different from plaintext, so tests catch "oh we forgot to encrypt"
 * bugs without depending on Electron's safeStorage.
 */
function makeBackend(available = true): EncryptionBackend {
  return {
    isAvailable: () => available,
    encrypt: (plaintext) => {
      const buf = Buffer.from(plaintext, 'utf8');
      for (let i = 0; i < buf.length; i++) buf[i] ^= 0x5a;
      return Buffer.concat([Buffer.from('XOR1'), buf]);
    },
    decrypt: (ciphertext) => {
      if (ciphertext.slice(0, 4).toString() !== 'XOR1') {
        throw new Error('bad magic');
      }
      const body = Buffer.from(ciphertext.slice(4));
      for (let i = 0; i < body.length; i++) body[i] ^= 0x5a;
      return body.toString('utf8');
    },
  };
}

describe('AuthStorage', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastowl-auth-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('round-trips a value through the backend', async () => {
    const store = new AuthStorage(makeBackend(), baseDir);
    await store.setItem('sb-proj-auth-token', '{"access_token":"xyz"}');
    const got = await store.getItem('sb-proj-auth-token');
    expect(got).toBe('{"access_token":"xyz"}');
  });

  it('returns null for a missing key', async () => {
    const store = new AuthStorage(makeBackend(), baseDir);
    expect(await store.getItem('never-set')).toBeNull();
  });

  it('removes a key', async () => {
    const store = new AuthStorage(makeBackend(), baseDir);
    await store.setItem('k', 'v');
    await store.removeItem('k');
    expect(await store.getItem('k')).toBeNull();
  });

  it('removeItem of a missing key is a no-op', async () => {
    const store = new AuthStorage(makeBackend(), baseDir);
    await expect(store.removeItem('never-set')).resolves.toBeUndefined();
  });

  it('writes the file with 0600 permissions', async () => {
    if (process.platform === 'win32') return; // chmod semantics differ
    const store = new AuthStorage(makeBackend(), baseDir);
    await store.setItem('k', 'v');
    const files = fs.readdirSync(baseDir).filter((f) => f.endsWith('.enc'));
    expect(files.length).toBe(1);
    const stat = fs.statSync(path.join(baseDir, files[0]));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('never writes plaintext to disk', async () => {
    const store = new AuthStorage(makeBackend(), baseDir);
    const secret = 'this-should-not-be-on-disk';
    await store.setItem('k', secret);
    const files = fs.readdirSync(baseDir).filter((f) => f.endsWith('.enc'));
    const bytes = fs.readFileSync(path.join(baseDir, files[0]));
    expect(bytes.toString('utf8')).not.toContain(secret);
  });

  it('hashes the key into the filename (no raw key on disk)', async () => {
    const store = new AuthStorage(makeBackend(), baseDir);
    await store.setItem('sb-proj-auth-token', 'v');
    const files = fs.readdirSync(baseDir);
    expect(files.some((f) => f.includes('sb-proj-auth-token'))).toBe(false);
    // Filenames are sha256 hex + .enc
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.enc$/);
  });

  it('throws when the backend is unavailable on setItem', async () => {
    const store = new AuthStorage(makeBackend(false), baseDir);
    await expect(store.setItem('k', 'v')).rejects.toThrow(/unavailable/);
  });

  it('treats undecryptable entries as missing and clears them', async () => {
    const store = new AuthStorage(makeBackend(), baseDir);
    await store.setItem('k', 'v');
    // Corrupt the single on-disk entry.
    const file = fs
      .readdirSync(baseDir)
      .map((f) => path.join(baseDir, f))
      .find((p) => p.endsWith('.enc'))!;
    fs.writeFileSync(file, Buffer.from('garbage-not-ciphertext'));

    expect(await store.getItem('k')).toBeNull();
    // The corrupted file should have been cleaned up.
    expect(fs.existsSync(file)).toBe(false);
  });
});
