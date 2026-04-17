import { eq } from 'drizzle-orm';
import type {
  ProxyHttpRequest,
  ProxyHttpResult,
} from '@fastowl/shared';
import { getDbClient } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';
import { internalProxyHeaders } from '../middleware/auth.js';

/**
 * Fulfill a `proxy_http_request` the daemon sent up over its WS. The
 * daemon has already been authenticated by device token, so this is
 * trust territory: we resolve the env's owner, then re-issue the call
 * against our own HTTP server with the internal auth headers set.
 *
 * Keeping the dispatch local (localhost fetch) means every REST route
 * is automatically available to daemon children — no second routing
 * table, no typed RPC surface to keep in sync.
 *
 * Headers passed through:
 *   - content-type / accept / content-length — ordinary HTTP plumbing
 *   - x-fastowl-internal-* — injected here, not forwardable from the VM
 *
 * Headers dropped:
 *   - authorization — the CLI on the VM might set it; the backend
 *     re-authenticates by internal header and ignoring the CLI's token
 *     is a feature (no JWT ever lives on the VM in this model)
 *   - cookie, host, upgrade — hop-by-hop / wouldn't round-trip anyway
 */
export async function handleProxyHttpRequest(
  environmentId: string,
  req: ProxyHttpRequest
): Promise<ProxyHttpResult> {
  const db = getDbClient();
  const rows = await db
    .select({ ownerId: environmentsTable.ownerId })
    .from(environmentsTable)
    .where(eq(environmentsTable.id, environmentId))
    .limit(1);
  if (!rows[0]) {
    return errorResult(404, 'environment not found');
  }

  const url = `http://127.0.0.1:${process.env.PORT || 4747}${req.path}`;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lc = k.toLowerCase();
    if (DROPPED_HEADERS.has(lc)) continue;
    headers[lc] = v;
  }
  Object.assign(headers, internalProxyHeaders(rows[0].ownerId));

  const bodyBuf = req.bodyBase64 ? Buffer.from(req.bodyBase64, 'base64') : undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method: req.method,
      headers,
      // Only send a body for methods that actually carry one.
      body: methodTakesBody(req.method) ? bodyBuf : undefined,
    });
  } catch (err) {
    console.error('daemon proxy: fetch to self failed:', err);
    return errorResult(502, 'proxy fetch failed');
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    const lc = k.toLowerCase();
    // Drop hop-by-hop headers + content-length (we re-derive it from
    // the payload on the daemon side).
    if (lc === 'content-length' || lc === 'transfer-encoding') return;
    responseHeaders[lc] = v;
  });

  const bodyBytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: responseHeaders,
    bodyBase64: bodyBytes.toString('base64'),
  };
}

const DROPPED_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'connection',
  'upgrade',
  'proxy-authorization',
  'x-fastowl-internal-user',
  'x-fastowl-internal-token',
]);

function methodTakesBody(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

function errorResult(status: number, message: string): ProxyHttpResult {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    bodyBase64: Buffer.from(
      JSON.stringify({ success: false, error: message })
    ).toString('base64'),
  };
}
