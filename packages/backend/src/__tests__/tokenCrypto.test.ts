import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  type EncryptedEnvelope,
} from '../services/tokenCrypto.js';

describe('tokenCrypto', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.FASTOWL_TOKEN_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.FASTOWL_TOKEN_KEY;
    } else {
      process.env.FASTOWL_TOKEN_KEY = originalKey;
    }
  });

  describe('isEncryptedEnvelope', () => {
    it('accepts a well-formed envelope', () => {
      const env: EncryptedEnvelope = { v: 1, iv: 'x', ct: 'y', tag: 'z' };
      expect(isEncryptedEnvelope(env)).toBe(true);
    });

    it('rejects plain values', () => {
      expect(isEncryptedEnvelope(null)).toBe(false);
      expect(isEncryptedEnvelope(undefined)).toBe(false);
      expect(isEncryptedEnvelope('string')).toBe(false);
      expect(isEncryptedEnvelope(42)).toBe(false);
      expect(isEncryptedEnvelope({})).toBe(false);
    });

    it('rejects envelopes missing required fields', () => {
      expect(isEncryptedEnvelope({ v: 1, iv: 'x', ct: 'y' })).toBe(false);
      expect(isEncryptedEnvelope({ v: 1, iv: 'x', tag: 'z' })).toBe(false);
      expect(isEncryptedEnvelope({ v: 1, ct: 'y', tag: 'z' })).toBe(false);
    });

    it('rejects wrong version byte', () => {
      expect(isEncryptedEnvelope({ v: 2, iv: 'x', ct: 'y', tag: 'z' })).toBe(false);
      expect(isEncryptedEnvelope({ v: '1', iv: 'x', ct: 'y', tag: 'z' })).toBe(false);
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    it('throws a clear error when FASTOWL_TOKEN_KEY is not set', () => {
      delete process.env.FASTOWL_TOKEN_KEY;
      expect(() => encryptString('hello')).toThrow(/FASTOWL_TOKEN_KEY/);
    });

    it('round-trips an ASCII string with a base64-32-byte key', () => {
      process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
      const plain = 'gho_abcdef1234567890';
      const env = encryptString(plain);
      expect(isEncryptedEnvelope(env)).toBe(true);
      expect(decryptString(env)).toBe(plain);
    });

    it('round-trips a UTF-8 string with the SHA-256 fallback key', () => {
      // Non-base64 key — loadKey falls back to SHA-256(key).
      process.env.FASTOWL_TOKEN_KEY = 'dev-secret';
      const plain = 'résumé · 日本語 · 🦉';
      const env = encryptString(plain);
      expect(decryptString(env)).toBe(plain);
    });

    it('accepts a base64 key shorter than 32 bytes via SHA-256 fallback', () => {
      // "short-key" base64-decodes to < 32 bytes, so loadKey falls
      // through to the SHA-256 path rather than truncating.
      process.env.FASTOWL_TOKEN_KEY = 'short-key';
      expect(() => {
        const env = encryptString('hello');
        decryptString(env);
      }).not.toThrow();
    });

    it('uses a fresh random IV on each call (no ciphertext reuse)', () => {
      process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
      const a = encryptString('same plaintext');
      const b = encryptString('same plaintext');
      expect(a.iv).not.toBe(b.iv);
      expect(a.ct).not.toBe(b.ct);
      // Both decrypt back to the original.
      expect(decryptString(a)).toBe('same plaintext');
      expect(decryptString(b)).toBe('same plaintext');
    });

    it('handles empty string round-trip', () => {
      process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
      const env = encryptString('');
      expect(decryptString(env)).toBe('');
    });

    it('refuses to decrypt a tampered ciphertext (auth tag check)', () => {
      process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
      const env = encryptString('secret');
      // Flip the first byte of the ciphertext.
      const ctBytes = Buffer.from(env.ct, 'base64');
      ctBytes[0] ^= 0xff;
      const tampered = { ...env, ct: ctBytes.toString('base64') };
      expect(() => decryptString(tampered)).toThrow();
    });

    it('refuses to decrypt with a different key', () => {
      process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
      const env = encryptString('secret');
      process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
      expect(() => decryptString(env)).toThrow();
    });
  });
});
