import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { formatSseFrame } from '@talyn/shared';
import { adminRoutes } from '../routes/admin/index.js';
import { createTestDb } from './helpers/testDb.js';
import { fleetHosts as fleetHostsTable } from '../db/schema.js';
import { resetFleetDispatcherCache } from '../services/selfHosted/client.js';
import type { Database } from '../db/client.js';

/**
 * The transcript stream proxy.
 *
 * Three properties, each of which fails silently rather than loudly if it
 * regresses — which is why they are pinned here rather than trusted:
 *
 *  1. A keepalive goes out through idle gaps. Railway's edge reaps idle
 *     connections and our parser consumes fleetd's own `: ping` rather than
 *     forwarding it, so without ours the stream dies after ~60s of a quiet
 *     agent — indistinguishable from the run having stopped.
 *  2. A client disconnect aborts upstream. Otherwise every closed tab leaks a
 *     connection to a fleet host for the life of the run.
 *  3. A mid-stream failure travels as a FRAME. The headers left with the first
 *     byte; there is no status left to change.
 */

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let closeServer: () => Promise<void>;
let upstream: ReturnType<typeof vi.fn>;
/** The real fetch, captured before the stub so the test can call OUR server. */
let realFetch: typeof fetch;

function stubAdmin(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  req.user = { id: 'op', email: 'op@talyn.dev', isAdmin: true };
  next();
}

/** A ReadableStream that emits `chunks`, then optionally hangs or errors. */
function bodyOf(chunks: string[], opts: { hang?: boolean; error?: string } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]!));
        return;
      }
      if (opts.error) {
        controller.error(new Error(opts.error));
        return;
      }
      if (opts.hang) {
        // Never resolves: models a live run producing nothing.
        await new Promise(() => {});
        return;
      }
      controller.close();
    },
  });
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, body, headers: { get: () => null } } as unknown as Response;
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  process.env.FLEET_API_TOKEN = 'tok';
  delete process.env.FLEET_HTTP_PROXY;
  resetFleetDispatcherCache();
  await db.insert(fleetHostsTable).values({
    name: 'hetzner-64',
    apiEndpoint: 'http://10.0.0.1:8080',
    reportedAt: new Date(),
    runsLive: 1,
    runsMax: 2,
  });

  // Only the call to fleetd is mocked. Requests to our own server — the thing
  // under test — pass through, so the proxy is exercised end to end rather
  // than asserted against a stub of itself.
  realFetch = globalThis.fetch;
  upstream = vi.fn();
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === 'string' ? input : String(input);
    if (target.includes('10.0.0.')) return upstream(target, init);
    return realFetch(input, init);
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', stubAdmin, adminRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  url = `http://127.0.0.1:${addr.port}`;
  closeServer = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
});

afterEach(async () => {
  await closeServer();
  await cleanup();
  vi.unstubAllGlobals();
  delete process.env.FLEET_API_TOKEN;
});

/** Read the proxied stream to completion. */
async function readStream(path: string): Promise<string> {
  const res = await realFetch(`${url}${path}`);
  return res.text();
}

describe('SSE proxy', () => {
  it('forwards frames verbatim and ends on terminal', async () => {
    const frames = [
      formatSseFrame({ events: [{ seq: 1, at: 'now', event: { type: 'text' } }], cursor: 1, terminal: false }),
      formatSseFrame({ events: [], cursor: 1, terminal: true }),
    ];
    upstream.mockResolvedValue(sseResponse(bodyOf(frames)));

    const out = await readStream('/api/v1/admin/fleet/hosts/hetzner-64/runs/talyn-1/stream');
    expect(out).toContain('"seq":1');
    expect(out).toContain('"terminal":true');
  });

  it('reassembles a frame split across upstream chunks', async () => {
    const whole = formatSseFrame({ events: [], cursor: 7, terminal: true });
    const half = Math.floor(whole.length / 2);
    upstream.mockResolvedValue(sseResponse(bodyOf([whole.slice(0, half), whole.slice(half)])));

    const out = await readStream('/api/v1/admin/fleet/hosts/hetzner-64/runs/talyn-1/stream');
    expect(out).toContain('"cursor":7');
  });

  it('sends an error FRAME on a mid-stream upstream failure, not a status', async () => {
    // The headers went out with the first byte. A thrown error here would
    // hang the client rather than telling it anything.
    const first = formatSseFrame({ events: [], cursor: 1, terminal: false });
    upstream.mockResolvedValue(sseResponse(bodyOf([first], { error: 'upstream died' })));

    const out = await readStream('/api/v1/admin/fleet/hosts/hetzner-64/runs/talyn-1/stream');
    expect(out).toContain('"cursor":1');
    expect(out).toContain('upstream died');
  });

  it('refuses a stale host before opening a stream', async () => {
    await db.delete(fleetHostsTable);
    await db.insert(fleetHostsTable).values({
      name: 'gone',
      apiEndpoint: 'http://10.0.0.9:8080',
      reportedAt: new Date(Date.now() - 10 * 60_000),
    });
    const res = await realFetch(`${url}/api/v1/admin/fleet/hosts/gone/runs/talyn-1/stream`);
    expect(res.status).toBe(409);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('404s an unknown host', async () => {
    const res = await realFetch(`${url}/api/v1/admin/fleet/hosts/nope/runs/talyn-1/stream`);
    expect(res.status).toBe(404);
  });

  it('aborts upstream when the client disconnects', async () => {
    // Without this every closed tab leaks a connection to a fleet host for
    // the life of the run.
    let signal: AbortSignal | undefined;
    upstream.mockImplementation((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(
        sseResponse(bodyOf([formatSseFrame({ events: [], cursor: 1, terminal: false })], { hang: true }))
      );
    });

    const controller = new AbortController();
    const pending = realFetch(
      `${url}/api/v1/admin/fleet/hosts/hetzner-64/runs/talyn-1/stream`,
      { signal: controller.signal }
    ).then((r) => r.text());
    // Let the first frame land, then hang up like a closed tab.
    await new Promise((r) => setTimeout(r, 120));
    controller.abort();
    await pending.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 120));

    expect(signal, 'the upstream call was never given an abort signal').toBeDefined();
    expect(signal!.aborted).toBe(true);
  });

  it('sets the headers a proxy needs to stop buffering', async () => {
    upstream.mockResolvedValue(
      sseResponse(bodyOf([formatSseFrame({ events: [], cursor: 0, terminal: true })]))
    );
    const res = await realFetch(`${url}/api/v1/admin/fleet/hosts/hetzner-64/runs/talyn-1/stream`);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
    // Without this an edge can hold every frame until the response ends,
    // which for a stream is never.
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    await res.text();
  });
});
