import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ProxyHttpRequest, ProxyHttpResult } from '@fastowl/shared';

import { DaemonProxyServer } from '../proxyServer.js';

describe('DaemonProxyServer', () => {
  let server: DaemonProxyServer | null = null;

  afterEach(() => {
    server?.shutdown();
    server = null;
    vi.restoreAllMocks();
  });

  it('throws from getPort / getChildApiUrl before start()', () => {
    server = new DaemonProxyServer(async () => {
      throw new Error('unused');
    });
    expect(() => server!.getPort()).toThrow(/not started/);
    expect(() => server!.getChildApiUrl()).toThrow(/not started/);
  });

  it('serves a child URL shape after start (127.0.0.1:<port>)', async () => {
    server = new DaemonProxyServer(async () => ({
      op: 'proxy_http_result',
      status: 200,
      headers: { 'content-type': 'text/plain' },
      bodyBase64: Buffer.from('ok').toString('base64'),
    }));
    await server.start();
    expect(server.getPort()).toBeGreaterThan(0);
    expect(server.getChildApiUrl()).toBe(`http://127.0.0.1:${server.getPort()}`);
  });

  it('forwards method/path/headers/body into the ProxyHttpRequest envelope', async () => {
    const captured: ProxyHttpRequest[] = [];
    server = new DaemonProxyServer(async (req) => {
      captured.push(req);
      return {
        op: 'proxy_http_result',
        status: 201,
        headers: {},
        bodyBase64: '',
      };
    });
    await server.start();

    await fetch(`${server.getChildApiUrl()}/v1/tasks?x=1`, {
      method: 'POST',
      headers: { 'x-fastowl-test': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.op).toBe('proxy_http_request');
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/tasks?x=1');
    expect(req.headers['x-fastowl-test']).toBe('yes');
    expect(req.headers['content-type']).toBe('application/json');
    // Body is base64-encoded on the wire so binary payloads survive the
    // JSON framing over WS.
    const body = Buffer.from(req.bodyBase64, 'base64').toString('utf-8');
    expect(JSON.parse(body)).toEqual({ hello: 'world' });
  });

  it('echoes the status code and headers from the backend response', async () => {
    server = new DaemonProxyServer(async () => ({
      op: 'proxy_http_result',
      status: 418,
      headers: {
        'content-type': 'application/json',
        'x-backend-marker': 'teapot',
      },
      bodyBase64: Buffer.from(JSON.stringify({ ok: false })).toString('base64'),
    }));
    await server.start();

    const res = await fetch(`${server.getChildApiUrl()}/anything`);
    expect(res.status).toBe(418);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-backend-marker')).toBe('teapot');
    const body = await res.json();
    expect(body).toEqual({ ok: false });
  });

  it('strips backend-supplied content-length and transfer-encoding headers', async () => {
    // Node sets content-length itself from the response body length. If
    // we blindly forwarded a lying content-length the response body
    // would get truncated (or worse, stall). The proxy is supposed to
    // drop both.
    const body = Buffer.from('abcdefghij'); // 10 bytes
    server = new DaemonProxyServer(async () => ({
      op: 'proxy_http_result',
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '999', // wrong; would break fetch if passed through
        'transfer-encoding': 'chunked', // also skipped
      },
      bodyBase64: body.toString('base64'),
    }));
    await server.start();

    const res = await fetch(`${server.getChildApiUrl()}/bytes`);
    const received = Buffer.from(await res.arrayBuffer());
    expect(received.length).toBe(10);
    expect(received.toString()).toBe('abcdefghij');
    // Content-length as observed by the client should match reality (10),
    // not the bogus value the backend sent.
    expect(res.headers.get('content-length')).toBe('10');
  });

  it('returns 502 with a JSON error body when the round-trip throws', async () => {
    server = new DaemonProxyServer(async () => {
      throw new Error('ws gone');
    });
    await server.start();

    const res = await fetch(`${server.getChildApiUrl()}/anything`);
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/proxy round-trip failed/);
  });

  it('round-trips a PUT with a binary body base64-clean', async () => {
    let echoed: ProxyHttpRequest | null = null;
    server = new DaemonProxyServer(async (req) => {
      echoed = req;
      // Echo body back unchanged so we can assert no corruption.
      return {
        op: 'proxy_http_result',
        status: 200,
        headers: {},
        bodyBase64: req.bodyBase64,
      };
    });
    await server.start();

    const binary = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const res = await fetch(`${server.getChildApiUrl()}/upload`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: binary,
    });
    const received = Buffer.from(await res.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(binary));
    expect(echoed!.method).toBe('PUT');
  });

  it('shutdown() lets the server stop serving requests', async () => {
    server = new DaemonProxyServer(async () => ({
      op: 'proxy_http_result',
      status: 200,
      headers: {},
      bodyBase64: '',
    }));
    await server.start();
    const port = server.getPort();
    server.shutdown();
    // After shutdown, fetching the old port should fail connection —
    // don't hang on keep-alive waits; use AbortSignal with 500ms.
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 500);
    await expect(
      fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal }),
    ).rejects.toThrow();
    clearTimeout(timeout);
    // Subsequent accessor calls throw.
    expect(() => server!.getPort()).toThrow(/not started/);
  });

  it('handler error path: returns 500 when sendProxyRequest succeeds but then body write fails', async () => {
    // Force the handler's inner `catch` to fire — easiest is to make
    // `sendProxyRequest` synthesise a value that throws when Node
    // tries to write the response (non-string header value). Setting a
    // header to a control-char value does that. res.end() then fails.
    server = new DaemonProxyServer(async (): Promise<ProxyHttpResult> => ({
      op: 'proxy_http_result',
      status: 200,
      headers: { 'x-bad\x00header': 'v' }, // invalid header name triggers throw
      bodyBase64: '',
    }));
    await server.start();

    const res = await fetch(`${server.getChildApiUrl()}/`);
    // Either 500 from the outer catch (setHeader throw before
    // headersSent) OR an aborted connection (headers already sent).
    // Assert the non-success case.
    expect(res.ok).toBe(false);
  });
});
