import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { githubPublicRoutes } from '../../routes/github.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { resetWebAppUrlCacheForTests } from '../../services/webApp.js';

/**
 * How the GitHub App callback ENDS, per client.
 *
 * The desktop opens the flow in the system browser, so the callback has
 * nowhere to send the user — it renders a page and the app re-polls its
 * GitHub status on focus. The browser app runs the flow in the current tab,
 * where that same page strands the user on the API origin with no way back.
 *
 * These cover the error paths specifically, because they're the ones that
 * decide before any state lookup — and because a stranded user after a failed
 * connect is exactly when a dead end hurts most.
 */

const WEB_APP = 'https://app.talyn.dev';
const savedWebAppUrl = process.env.WEB_APP_URL;

let url: string;
let close: () => Promise<void>;

beforeEach(async () => {
  process.env.WEB_APP_URL = WEB_APP;
  resetWebAppUrlCacheForTests();
  const app = express();
  app.use('/github', wrapAsyncRoutes(githubPublicRoutes()));
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  url = `http://127.0.0.1:${addr.port}`;
  close = () =>
    new Promise<void>((res) => {
      server.closeAllConnections();
      server.close(() => res());
    });
});

afterEach(async () => {
  await close();
  if (savedWebAppUrl === undefined) delete process.env.WEB_APP_URL;
  else process.env.WEB_APP_URL = savedWebAppUrl;
  resetWebAppUrlCacheForTests();
});

function callback(query: string, origin?: string) {
  return fetch(`${url}/github/app/callback${query}`, {
    redirect: 'manual',
    headers: origin ? { origin } : {},
  });
}

describe('GitHub App callback — per-client ending', () => {
  describe('browser client (Origin matches WEB_APP_URL)', () => {
    it.each([
      ['provider error', '?error=access_denied&error_description=User+said+no'],
      ['missing code/state', '?state=ws1:tok'],
      ['unknown state', '?code=c&state=ws1:nope'],
    ])('redirects home on %s instead of dead-ending', async (_label, query) => {
      const res = await callback(query, WEB_APP);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location')!);
      expect(location.origin).toBe(WEB_APP);
      expect(location.pathname).toBe('/settings');
      expect(location.searchParams.get('github')).toBe('error');
      // The message rides along so the app can surface what went wrong.
      expect(location.searchParams.get('message')).toBeTruthy();
    });

    it('never redirects off our own origin, whatever GitHub sent', async () => {
      const res = await callback(
        '?error=x&error_description=' + encodeURIComponent('https://evil.example.com'),
        WEB_APP
      );
      expect(new URL(res.headers.get('location')!).origin).toBe(WEB_APP);
    });
  });

  describe('desktop client', () => {
    it.each([
      ['no Origin header', undefined],
      ['file:// origin', 'file://'],
      ['opaque origin', 'null'],
      ['some other site', 'https://evil.example.com'],
    ])('renders the close-this-tab page for %s', async (_label, origin) => {
      const res = await callback('?error=access_denied', origin);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('<!doctype html>');
      expect(body).toContain('return to Talyn');
      expect(res.headers.get('location')).toBeNull();
    });
  });

  it('falls back to rendering when no web app is deployed', async () => {
    delete process.env.WEB_APP_URL;
    resetWebAppUrlCacheForTests();
    // Even a request whose Origin *looks* like the web app can't be
    // redirected — there is nowhere configured to send it.
    const res = await callback('?error=access_denied', WEB_APP);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('<!doctype html>');
  });
});
