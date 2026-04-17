import http from 'http';
import { AddressInfo } from 'net';
import type {
  ProxyHttpRequest,
  ProxyHttpResult,
} from '@fastowl/shared';

/**
 * Local HTTP server that fronts the daemon's proxy path. The daemon
 * sets `FASTOWL_API_URL=http://127.0.0.1:<port>` in the env of every
 * task process it spawns — `fastowl` CLI and `@fastowl/mcp-server`
 * call through transparently. Each request is serialized into a
 * `proxy_http_request` and sent over the daemon's WS to the backend;
 * the backend authenticates the call via its own in-memory internal
 * secret and re-issues it against its own REST surface.
 *
 * Binds to 127.0.0.1 only. On a shared VM, any process running as
 * this user already has access to `~/.fastowl/daemon.json` anyway —
 * the threat model mirrors the on-disk token file.
 */
export class DaemonProxyServer {
  private server: http.Server | null = null;
  private port = 0;

  constructor(
    private sendProxyRequest: (req: ProxyHttpRequest) => Promise<ProxyHttpResult>
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('daemon proxy: handler failed:', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: 'proxy handler failed' }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as AddressInfo;
        this.port = addr.port;
        console.log(`daemon proxy: listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  getPort(): number {
    if (!this.port) throw new Error('proxy server not started');
    return this.port;
  }

  /** Base URL to inject into spawned children via FASTOWL_API_URL. */
  getChildApiUrl(): string {
    return `http://127.0.0.1:${this.getPort()}`;
  }

  shutdown(): void {
    this.server?.close();
    this.server = null;
    this.port = 0;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await drain(req);
    const proxyReq: ProxyHttpRequest = {
      op: 'proxy_http_request',
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: flattenHeaders(req.headers),
      bodyBase64: body.toString('base64'),
    };

    let result: ProxyHttpResult;
    try {
      result = await this.sendProxyRequest(proxyReq);
    } catch (err) {
      console.error('daemon proxy: round-trip failed:', err);
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: false, error: 'proxy round-trip failed' }));
      return;
    }

    res.statusCode = result.status;
    for (const [k, v] of Object.entries(result.headers)) {
      // Skip anything Node sets for us automatically.
      if (k === 'content-length' || k === 'transfer-encoding') continue;
      res.setHeader(k, v);
    }
    res.end(Buffer.from(result.bodyBase64, 'base64'));
  }
}

function flattenHeaders(
  headers: http.IncomingHttpHeaders
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

async function drain(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
