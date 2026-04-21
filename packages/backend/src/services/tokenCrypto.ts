import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope shape for an encrypted secret stored in JSONB. `v` is a
 * version byte so we can rotate schemes later without a big-bang
 * migration. `iv`, `ct`, `tag` are all base64.
 */
export interface EncryptedEnvelope {
  v: 1;
  iv: string;
  ct: string;
  tag: string;
}

export function isEncryptedEnvelope(x: unknown): x is EncryptedEnvelope {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as EncryptedEnvelope).v === 1 &&
    typeof (x as EncryptedEnvelope).iv === 'string' &&
    typeof (x as EncryptedEnvelope).ct === 'string' &&
    typeof (x as EncryptedEnvelope).tag === 'string'
  );
}

function loadKey(): Buffer {
  const raw = process.env.FASTOWL_TOKEN_KEY;
  if (!raw) {
    throw new Error(
      'FASTOWL_TOKEN_KEY is not set. Generate 32 random bytes in base64 (e.g. ' +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"`) ' +
        'and set it in the backend environment before using integration-token encryption.'
    );
  }
  // Accept either base64 (preferred, >= 32 bytes) or any other input we
  // then SHA-256 into a 32-byte key. SHA-256 fallback keeps dev ergonomic
  // (set any string) without forcing the operator to deal with base64.
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length >= 32) return buf.subarray(0, 32);
  } catch {
    // fall through
  }
  return createHash('sha256').update(raw, 'utf8').digest();
}

/**
 * AES-256-GCM encrypt a UTF-8 string. 12-byte nonce from a CSPRNG,
 * 16-byte auth tag. Returns an envelope safe to JSON-serialize.
 */
export function encryptString(plaintext: string): EncryptedEnvelope {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptString(env: EncryptedEnvelope): string {
  const key = loadKey();
  const iv = Buffer.from(env.iv, 'base64');
  const ct = Buffer.from(env.ct, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
