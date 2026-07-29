import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  getWebAppUrl,
  webAppUrl,
  resetWebAppUrlCacheForTests,
} from '../services/webApp.js';

/**
 * WEB_APP_URL is the ONLY source of a redirect target for the GitHub App
 * callback. These tests pin that: it normalises to an origin, refuses
 * anything unsafe, and — critically — `webAppUrl()` can never be talked into
 * pointing at another host, because an open redirect inside an OAuth callback
 * turns a login flow into a credential-phishing hop.
 */

const saved = process.env.WEB_APP_URL;

beforeEach(() => resetWebAppUrlCacheForTests());
afterEach(() => {
  if (saved === undefined) delete process.env.WEB_APP_URL;
  else process.env.WEB_APP_URL = saved;
  resetWebAppUrlCacheForTests();
});

function withUrl(value: string | undefined) {
  if (value === undefined) delete process.env.WEB_APP_URL;
  else process.env.WEB_APP_URL = value;
  resetWebAppUrlCacheForTests();
}

describe('getWebAppUrl', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('%s → null (desktop-only deployment)', (_label, value) => {
    withUrl(value);
    expect(getWebAppUrl()).toBeNull();
  });

  it.each([
    ['https://app.talyn.dev', 'https://app.talyn.dev'],
    ['https://app.talyn.dev/', 'https://app.talyn.dev'],
    ['https://app.talyn.dev/some/path', 'https://app.talyn.dev'],
    ['  https://app.talyn.dev  ', 'https://app.talyn.dev'],
    ['http://localhost:5173', 'http://localhost:5173'],
  ])('%s normalises to the bare origin %s', (input, expected) => {
    withUrl(input);
    expect(getWebAppUrl()).toBe(expected);
  });

  it.each([
    ['malformed', 'app.talyn.dev'],
    ['http on a public host', 'http://app.talyn.dev'],
    ['javascript:', 'javascript:alert(1)'],
  ])('ignores an unsafe value (%s)', (_label, value) => {
    withUrl(value);
    expect(getWebAppUrl()).toBeNull();
  });

  it('memoises', () => {
    withUrl('https://app.talyn.dev');
    expect(getWebAppUrl()).toBe('https://app.talyn.dev');
    // Changing the env WITHOUT resetting must not take effect — proves the
    // value read at boot is the one used for the process's lifetime.
    process.env.WEB_APP_URL = 'https://evil.example.com';
    expect(getWebAppUrl()).toBe('https://app.talyn.dev');
  });
});

describe('webAppUrl', () => {
  it('returns null when no web app is deployed', () => {
    withUrl(undefined);
    expect(webAppUrl('/settings', { github: 'connected' })).toBeNull();
  });

  it('builds a path + query on the configured origin', () => {
    withUrl('https://app.talyn.dev');
    expect(webAppUrl('/settings', { github: 'connected' })).toBe(
      'https://app.talyn.dev/settings?github=connected'
    );
  });

  it('escapes untrusted query values', () => {
    withUrl('https://app.talyn.dev');
    const url = webAppUrl('/settings', {
      github: 'error',
      message: 'bad & ugly ?#<script>',
    });
    expect(url).toContain('message=bad+%26+ugly+%3F%23%3Cscript%3E');
    expect(new URL(url!).origin).toBe('https://app.talyn.dev');
  });

  // `new URL(path, base)` resolves every one of these to somewhere other than
  // our origin. Call sites pass literals today, but this is the GitHub App
  // callback's redirect target — if a request value ever reaches it, the
  // result is an open redirect in an OAuth flow. Refuse the shape outright.
  it.each([
    ['protocol-relative', '//evil.example.com/x'],
    ['absolute https', 'https://evil.example.com/x'],
    ['absolute with creds', 'https://user:pw@evil.example.com/'],
    ['relative (no leading slash)', 'settings'],
    ['dot-segments', '../../../etc/passwd'],
  ])('refuses a non-relative path (%s)', (_label, path) => {
    withUrl('https://app.talyn.dev');
    expect(webAppUrl(path)).toBeNull();
  });

  it('pins the origin for every path it does accept', () => {
    withUrl('https://app.talyn.dev');
    for (const path of ['/settings', '/', '/a/b/c']) {
      expect(new URL(webAppUrl(path)!).origin).toBe('https://app.talyn.dev');
    }
  });
});
