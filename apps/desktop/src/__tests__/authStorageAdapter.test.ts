import {
  createAuthStorageAdapter,
  migrateLegacyAuthFromLocalStorage,
  type AuthStorageBridge,
} from '../renderer/lib/authStorage';

function makeBridge(): {
  bridge: AuthStorageBridge;
  store: Map<string, string>;
  calls: Array<{ op: string; key: string; value?: string }>;
} {
  const store = new Map<string, string>();
  const calls: Array<{ op: string; key: string; value?: string }> = [];
  const bridge: AuthStorageBridge = {
    async getItem(key) {
      calls.push({ op: 'get', key });
      return store.get(key) ?? null;
    },
    async setItem(key, value) {
      calls.push({ op: 'set', key, value });
      store.set(key, value);
    },
    async removeItem(key) {
      calls.push({ op: 'remove', key });
      store.delete(key);
    },
  };
  return { bridge, store, calls };
}

/**
 * Minimal Web Storage stand-in for the migration test — Jest's jsdom
 * env technically provides localStorage, but wiring through a handful
 * of fake rows is simpler and works under node env too.
 */
function makeFakeLocalStorage(initial: Record<string, string>): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    key(i: number) {
      return Array.from(data.keys())[i] ?? null;
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
}

describe('createAuthStorageAdapter', () => {
  it('delegates get/set/remove to the bridge', async () => {
    const { bridge, store } = makeBridge();
    const adapter = createAuthStorageAdapter(bridge);

    await adapter.setItem('sb-proj-auth-token', '{"access":"x"}');
    expect(store.get('sb-proj-auth-token')).toBe('{"access":"x"}');

    expect(await adapter.getItem('sb-proj-auth-token')).toBe('{"access":"x"}');

    await adapter.removeItem('sb-proj-auth-token');
    expect(store.has('sb-proj-auth-token')).toBe(false);
  });

  it('returns null when the bridge throws on get', async () => {
    const adapter = createAuthStorageAdapter({
      async getItem() {
        throw new Error('IPC down');
      },
      async setItem() {},
      async removeItem() {},
    });
    expect(await adapter.getItem('k')).toBeNull();
  });

  it('swallows set/remove errors so the Supabase flow is not bricked', async () => {
    const adapter = createAuthStorageAdapter({
      async getItem() {
        return null;
      },
      async setItem() {
        throw new Error('disk full');
      },
      async removeItem() {
        throw new Error('perm denied');
      },
    });
    await expect(adapter.setItem('k', 'v')).resolves.toBeUndefined();
    await expect(adapter.removeItem('k')).resolves.toBeUndefined();
  });
});

describe('migrateLegacyAuthFromLocalStorage', () => {
  it('moves sb-*-auth-token entries into the bridge and wipes localStorage', async () => {
    const { bridge, store } = makeBridge();
    const ls = makeFakeLocalStorage({
      'sb-proj123-auth-token': '{"access":"old"}',
      'unrelated-setting': 'leave-me',
    });

    await migrateLegacyAuthFromLocalStorage(bridge, ls);

    expect(store.get('sb-proj123-auth-token')).toBe('{"access":"old"}');
    expect(ls.getItem('sb-proj123-auth-token')).toBeNull();
    // Non-auth entries are untouched.
    expect(ls.getItem('unrelated-setting')).toBe('leave-me');
  });

  it('is a no-op when localStorage has no auth entries', async () => {
    const { bridge, calls } = makeBridge();
    const ls = makeFakeLocalStorage({ 'some-other-key': 'x' });

    await migrateLegacyAuthFromLocalStorage(bridge, ls);

    expect(calls.length).toBe(0);
    expect(ls.getItem('some-other-key')).toBe('x');
  });

  it('handles multiple legacy entries (e.g. multiple projects)', async () => {
    const { bridge, store } = makeBridge();
    const ls = makeFakeLocalStorage({
      'sb-projA-auth-token': 'A',
      'sb-projB-auth-token': 'B',
    });

    await migrateLegacyAuthFromLocalStorage(bridge, ls);

    expect(store.get('sb-projA-auth-token')).toBe('A');
    expect(store.get('sb-projB-auth-token')).toBe('B');
    expect(ls.length).toBe(0);
  });

  it('leaves localStorage untouched when the bridge setItem throws', async () => {
    const bridge: AuthStorageBridge = {
      async getItem() {
        return null;
      },
      async setItem() {
        throw new Error('bridge unavailable');
      },
      async removeItem() {},
    };
    const ls = makeFakeLocalStorage({
      'sb-proj-auth-token': 'keep',
    });

    await migrateLegacyAuthFromLocalStorage(bridge, ls);

    // Don't delete the plaintext entry if we couldn't successfully
    // transfer it — we'd rather retry next boot than lose the session.
    expect(ls.getItem('sb-proj-auth-token')).toBe('keep');
  });
});
