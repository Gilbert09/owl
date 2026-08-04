import { describe, it, expect } from 'vitest';
import { assertUsableBuildEnv } from '../../buildEnv';

/**
 * The build guard, tested because the first version of it FAILED IN THE WAY IT
 * EXISTED TO PREVENT.
 *
 * It checked "is this env var non-empty?" and shipped admin.talyn.dev with
 * `VITE_TALYN_SUPABASE_URL` set to the literal string `[SENSITIVE]` — Vercel's
 * placeholder for a variable marked Sensitive, which `vercel pull` cannot
 * decrypt. Non-empty, so the guard passed; not a URL, so `createClient` threw
 * on first render and every visitor got the error boundary.
 *
 * That is the shape talyn-fleet's HANDOFF doc leads with: a check that passes
 * every time anyone looks at it and is wrong anyway. The instruction it implies
 * is this file — write the test that proves your check can FAIL.
 */

const GOOD: Record<string, string> = {
  VITE_TALYN_API_URL: 'https://prod.talyn.dev',
  VITE_TALYN_SUPABASE_URL: 'https://xyz.supabase.co',
  VITE_TALYN_SUPABASE_ANON_KEY: 'sb_publishable_abc123',
};

/** Build a reader over GOOD with one key overridden. */
function readerWith(overrides: Record<string, string | undefined>) {
  const merged = { ...GOOD, ...overrides };
  return (key: string) => merged[key];
}

describe('a good environment', () => {
  it('builds', () => {
    expect(() => assertUsableBuildEnv(readerWith({}))).not.toThrow();
  });

  it('accepts a localhost API for dev-pointed builds', () => {
    expect(() =>
      assertUsableBuildEnv(readerWith({ VITE_TALYN_API_URL: 'http://localhost:4747' }))
    ).not.toThrow();
  });
});

describe('the failure that actually shipped', () => {
  it.each([
    ['VITE_TALYN_SUPABASE_URL'],
    ['VITE_TALYN_SUPABASE_ANON_KEY'],
    ['VITE_TALYN_API_URL'],
  ])('refuses Vercel\'s [SENSITIVE] placeholder in %s', (key) => {
    expect(() => assertUsableBuildEnv(readerWith({ [key]: '[SENSITIVE]' }))).toThrow(/SENSITIVE/);
  });

  it('says WHAT TO DO about it, not just that it is wrong', () => {
    // The message is the whole value of catching this at build time — an
    // operator reading "invalid env" learns nothing they did not already know
    // from the white screen.
    try {
      assertUsableBuildEnv(readerWith({ VITE_TALYN_SUPABASE_URL: '[SENSITIVE]' }));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/marked Sensitive/i);
      expect((err as Error).message).toMatch(/Unmark it/i);
    }
  });
});

describe('presence is not enough', () => {
  it.each([
    ['a bare hostname', 'xyz.supabase.co'],
    ['a project ref', 'xodyzfwlwvgzezwlkrqn'],
    ['a placeholder', 'TODO'],
    ['a postgres URL', 'postgres://user@host/db'],
    ['whitespace with content', '   not a url   '],
  ])('refuses %s as a Supabase URL', (_label, value) => {
    expect(() => assertUsableBuildEnv(readerWith({ VITE_TALYN_SUPABASE_URL: value }))).toThrow(
      /not an http\(s\) URL/
    );
  });

  it('does NOT demand a URL of the anon key', () => {
    // Over-validating is its own failure: a guard that rejects correct input
    // gets disabled by whoever is trying to ship.
    expect(() =>
      assertUsableBuildEnv(readerWith({ VITE_TALYN_SUPABASE_ANON_KEY: 'sb_publishable_x' }))
    ).not.toThrow();
  });
});

describe('empties', () => {
  it.each([
    ['an empty string', ''],
    ['unset', undefined],
    ['whitespace only', '   '],
  ])('refuses %s', (_label, value) => {
    expect(() =>
      assertUsableBuildEnv(readerWith({ VITE_TALYN_SUPABASE_URL: value }))
    ).toThrow(/is empty/);
  });
});

describe('service_role', () => {
  it('still refuses a service_role key', () => {
    // The bundle is world-readable. This check predates the others and must
    // survive them.
    expect(() =>
      assertUsableBuildEnv(
        readerWith({ VITE_TALYN_SUPABASE_ANON_KEY: 'eyJ...service_role...' })
      )
    ).toThrow(/service_role/);
  });
});

describe('reporting', () => {
  it('lists EVERY problem, not just the first', () => {
    // Otherwise fixing one variable earns you another failed build instead of
    // a working one.
    try {
      assertUsableBuildEnv(
        readerWith({
          VITE_TALYN_SUPABASE_URL: '[SENSITIVE]',
          VITE_TALYN_SUPABASE_ANON_KEY: '',
          VITE_TALYN_API_URL: 'not-a-url',
        })
      );
      throw new Error('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/VITE_TALYN_SUPABASE_URL/);
      expect(message).toMatch(/VITE_TALYN_SUPABASE_ANON_KEY/);
      expect(message).toMatch(/VITE_TALYN_API_URL/);
    }
  });
});
