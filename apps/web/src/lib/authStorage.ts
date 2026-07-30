/**
 * Supabase-compatible storage adapter that routes every get/set/remove
 * through the main-process safeStorage-backed store. The ciphertext
 * lives in `{userData}/auth-storage/*.enc` — encryption key is bound
 * to the OS user account via Keychain / DPAPI / libsecret, so readers
 * with only filesystem access (another local user, a stolen backup
 * snapshot) can't recover the session.
 *
 * The shape matches Supabase's `SupportedStorage` interface: the three
 * async methods are what `createClient({ auth: { storage } })` expects.
 */
export interface AuthStorageBridge {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function createAuthStorageAdapter(bridge: AuthStorageBridge) {
  return {
    async getItem(key: string): Promise<string | null> {
      try {
        return await bridge.getItem(key);
      } catch (err) {
        console.error('authStorage.getItem failed:', err);
        return null;
      }
    },
    async setItem(key: string, value: string): Promise<void> {
      try {
        await bridge.setItem(key, value);
      } catch (err) {
        console.error('authStorage.setItem failed:', err);
      }
    },
    async removeItem(key: string): Promise<void> {
      try {
        await bridge.removeItem(key);
      } catch (err) {
        console.error('authStorage.removeItem failed:', err);
      }
    },
  };
}

/**
 * One-shot migration: if Supabase's session key is still sitting in
 * `localStorage` from a pre-safeStorage install, copy it into the
 * encrypted store and wipe the plaintext copy. Idempotent — subsequent
 * runs are no-ops once localStorage is clear.
 *
 * The Supabase key looks like `sb-<projectRef>-auth-token`; we scan
 * rather than hard-code the project ref so this also handles custom
 * storage keys in tests.
 */
export async function migrateLegacyAuthFromLocalStorage(
  bridge: AuthStorageBridge,
  storage: Pick<Storage, 'key' | 'getItem' | 'removeItem' | 'length'>
): Promise<void> {
  const legacyKeys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
      legacyKeys.push(key);
    }
  }
  for (const key of legacyKeys) {
    const value = storage.getItem(key);
    if (!value) continue;
    try {
      await bridge.setItem(key, value);
      storage.removeItem(key);
      console.log(`authStorage: migrated ${key} from localStorage`);
    } catch (err) {
      console.error(`authStorage: failed to migrate ${key}:`, err);
    }
  }
}
