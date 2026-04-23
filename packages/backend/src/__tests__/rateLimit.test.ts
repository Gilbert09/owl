import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * Stand up a real Express app with the limiter attached to `/probe`.
 * Talking to it over real HTTP exercises the request.ip resolution,
 * header writing, and status path just like production would.
 */
async function makeServer(opts: {
  windowMs: number;
  max: number;
  keyFn?: (req: express.Request) => string;
  message?: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.get('/probe', rateLimit(opts), (_req, res) => {
    res.json({ ok: true });
  });
  // A second endpoint without the limiter — sanity check the limiter
  // doesn't leak into sibling routes.
  app.get('/unlimited', (_req, res) => res.json({ ok: true }));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        // Node's fetch holds HTTP keep-alive sockets open for 5s by
        // default; closeAllConnections hangs them up so server.close
        // resolves immediately rather than stalling the test suite.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function hitN(url: string, n: number, headers?: Record<string, string>) {
  const results: Array<{ status: number; retryAfter: string | null }> = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(url, { headers });
    results.push({
      status: res.status,
      retryAfter: res.headers.get('Retry-After'),
    });
  }
  return results;
}

describe('rateLimit middleware', () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('allows up to `max` requests within the window then 429s', async () => {
    const s = await makeServer({ windowMs: 60_000, max: 3 });
    close = s.close;

    const results = await hitN(`${s.url}/probe`, 5);
    expect(results.slice(0, 3).every((r) => r.status === 200)).toBe(true);
    expect(results[3].status).toBe(429);
    expect(results[4].status).toBe(429);
  });

  it('sets Retry-After on the 429 response', async () => {
    const s = await makeServer({ windowMs: 60_000, max: 1 });
    close = s.close;

    await fetch(`${s.url}/probe`); // consume the single allowed hit
    const res = await fetch(`${s.url}/probe`);
    expect(res.status).toBe(429);
    // 60_000ms → ceil to 60s
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('returns the custom message in the 429 body', async () => {
    const s = await makeServer({
      windowMs: 60_000,
      max: 1,
      message: 'Too many OAuth requests — slow down.',
    });
    close = s.close;

    await fetch(`${s.url}/probe`);
    const res = await fetch(`${s.url}/probe`);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      error: 'Too many OAuth requests — slow down.',
    });
  });

  it('releases the quota after the window rolls over', async () => {
    // Short window so the test doesn't need fake timers.
    const s = await makeServer({ windowMs: 250, max: 2 });
    close = s.close;

    const first = await hitN(`${s.url}/probe`, 2);
    expect(first.every((r) => r.status === 200)).toBe(true);

    // Immediately over the limit.
    expect((await fetch(`${s.url}/probe`)).status).toBe(429);

    // Wait for the window to expire, then the next hit should pass.
    await new Promise((r) => setTimeout(r, 300));
    expect((await fetch(`${s.url}/probe`)).status).toBe(200);
  });

  it('keys different users independently via keyFn', async () => {
    const s = await makeServer({
      windowMs: 60_000,
      max: 2,
      keyFn: (req) => (req.headers['x-test-user'] as string | undefined) ?? 'anon',
    });
    close = s.close;

    const a = { 'x-test-user': 'alice' };
    const b = { 'x-test-user': 'bob' };

    // Exhaust Alice's quota.
    await hitN(`${s.url}/probe`, 2, a);
    expect((await fetch(`${s.url}/probe`, { headers: a })).status).toBe(429);
    // Bob is untouched.
    expect((await fetch(`${s.url}/probe`, { headers: b })).status).toBe(200);
    expect((await fetch(`${s.url}/probe`, { headers: b })).status).toBe(200);
    expect((await fetch(`${s.url}/probe`, { headers: b })).status).toBe(429);
    // Alice still blocked.
    expect((await fetch(`${s.url}/probe`, { headers: a })).status).toBe(429);
  });

  it('does not limit requests to sibling routes', async () => {
    const s = await makeServer({ windowMs: 60_000, max: 1 });
    close = s.close;

    // Blow through the limit on /probe.
    await fetch(`${s.url}/probe`);
    expect((await fetch(`${s.url}/probe`)).status).toBe(429);
    // /unlimited has no limiter attached — all good.
    expect((await fetch(`${s.url}/unlimited`)).status).toBe(200);
    expect((await fetch(`${s.url}/unlimited`)).status).toBe(200);
  });
});
