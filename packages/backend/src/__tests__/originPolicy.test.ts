import { describe, it, expect } from 'vitest';
import {
  createOriginPolicy,
  parseAllowedOrigins,
} from '../services/originPolicy.js';

/**
 * The CORS / WS-upgrade allowlist. Untested until app.talyn.dev needed a real
 * browser origin — and the exact place a "just make it work" edit (a prefix
 * match, a wildcard, adding isDesktop to the REST gate) turns into a bypass.
 */

const policy = (env: Record<string, string | undefined>) =>
  createOriginPolicy(env as NodeJS.ProcessEnv);

describe('parseAllowedOrigins', () => {
  it.each([
    [undefined, []],
    ['', []],
    ['  ', []],
    ['https://app.talyn.dev', ['https://app.talyn.dev']],
    [
      'https://app.talyn.dev, https://staging.talyn.dev',
      ['https://app.talyn.dev', 'https://staging.talyn.dev'],
    ],
    ['a,,b, ,c', ['a', 'b', 'c']],
  ])('parses %s', (raw, expected) => {
    expect(parseAllowedOrigins(raw)).toEqual(expected);
  });
});

describe('isAllowed', () => {
  it('allows a missing Origin — native clients send none', () => {
    // Desktop main process, CLI, MCP server.
    expect(policy({}).isAllowed(undefined)).toBe(true);
    expect(policy({}).isAllowed('')).toBe(true);
  });

  it.each([
    'http://localhost',
    'http://localhost:3000',
    'https://localhost:5173',
    'http://127.0.0.1:4747',
    'http://[::1]:8080',
  ])('allows loopback origin %s', (origin) => {
    expect(policy({}).isAllowed(origin)).toBe(true);
  });

  it('denies an arbitrary origin when the allowlist is empty', () => {
    expect(policy({}).isAllowed('https://app.talyn.dev')).toBe(false);
    expect(policy({}).isAllowed('https://evil.example.com')).toBe(false);
  });

  it('allows exactly what ALLOWED_ORIGINS lists', () => {
    const p = policy({ ALLOWED_ORIGINS: 'https://app.talyn.dev' });
    expect(p.isAllowed('https://app.talyn.dev')).toBe(true);
    expect(p.isAllowed('https://evil.example.com')).toBe(false);
  });

  // The reason the match is exact rather than pattern-based. Every one of
  // these passes a naive prefix/suffix/substring rule.
  it.each([
    'https://app.talyn.dev.evil.com',
    'https://evil.com/https://app.talyn.dev',
    'https://app.talyn.dev:8443',
    'http://app.talyn.dev',
    'https://APP.talyn.dev',
    'https://app.talyn.dev/',
  ])('does not allow look-alike origin %s', (origin) => {
    const p = policy({ ALLOWED_ORIGINS: 'https://app.talyn.dev' });
    expect(p.isAllowed(origin)).toBe(false);
  });

  it('does not treat file:// or null as allowed for REST', () => {
    // isDesktop is a WS-upgrade concession only. Wiring it into the REST gate
    // with credentials:true would echo `Access-Control-Allow-Origin: null`.
    const p = policy({ ALLOWED_ORIGINS: 'https://app.talyn.dev' });
    expect(p.isAllowed('null')).toBe(false);
    expect(p.isAllowed('file:///Users/x/app.asar/index.html')).toBe(false);
  });
});

describe('isDesktop (WebSocket upgrade only)', () => {
  it.each(['file://', 'file:///Users/x/index.html'])('recognises %s', (origin) => {
    expect(policy({}).isDesktop(origin)).toBe(true);
  });

  it('recognises the opaque null origin by default', () => {
    expect(policy({}).isDesktop('null')).toBe(true);
  });

  it('drops the null-origin concession when the kill switch is set', () => {
    // The switch exists because `null` is forgeable by any page via a
    // sandboxed iframe. Harmless while WS auth is a Bearer JWT in the first
    // frame; a live CSWSH the day anything moves to cookies.
    const p = policy({ TALYN_ALLOW_NULL_ORIGIN_WS: '0' });
    expect(p.isDesktop('null')).toBe(false);
    expect(p.isDesktop('file://')).toBe(true);
  });

  it.each(['https://app.talyn.dev', 'https://evil.example.com', undefined])(
    'does not treat %s as desktop',
    (origin) => {
      expect(policy({}).isDesktop(origin)).toBe(false);
    }
  );
});
