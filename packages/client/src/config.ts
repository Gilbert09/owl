/**
 * The host-application seam.
 *
 * This package is the ONE definition of the backend contract — every route
 * signature, every WS event, the 401-retry choreography, the reconnect
 * backoff — shared by the desktop renderer and the browser app so a backend
 * change can't be applied to one client and forgotten in the other.
 *
 * To stay shared it can't know how any particular host stores a session or
 * where its build-time env came from. The desktop reads `process.env.TALYN_*`
 * baked in by webpack and holds its session in Electron `safeStorage`; the
 * web app reads Vite `define` values and uses `localStorage`. Both inject
 * that here instead of this package importing either.
 */
export interface ApiClientConfig {
  /** Backend origin, e.g. `https://prod.talyn.dev`. No trailing slash. */
  baseUrl: string;
  /**
   * Sent as `X-Talyn-Client-Version` on every request, for logs and support.
   * Nothing branches on it: the free-plan gates once exempted builds below a
   * version floor, and that exemption is deleted. Still namespace non-desktop
   * clients (`web/<sha>`) so the value says which client it came from.
   */
  clientVersion: string;
  /** Current access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /**
   * Invoked when the backend 401s a request we DID send a token with.
   * Resolve true if the session was refreshed and the request should be
   * replayed once; false to let the 401 surface.
   *
   * A 401 is NOT proof the session is dead — the 2026-07-07 mass logout was
   * the backend 401ing perfectly valid tokens while its Supabase check was
   * down. Implementations should sign out ONLY when the auth server
   * explicitly rejects the refresh token, and treat offline/5xx/timeout as
   * transient. Concurrent calls are deduped here, so implementations don't
   * need their own guard against a refresh-token stampede.
   */
  recoverSession: () => Promise<boolean>;
}

let config: ApiClientConfig | null = null;

/**
 * Must be called once, before any request. Both front ends do it at module
 * scope in their `lib/api` entrypoint so importing the API implies a
 * configured client.
 */
export function configureApiClient(next: ApiClientConfig): void {
  config = { ...next, baseUrl: next.baseUrl.replace(/\/+$/, '') };
}

export function getConfig(): ApiClientConfig {
  if (!config) {
    throw new Error(
      'configureApiClient() has not been called — the host app must configure ' +
        '@talyn/client before issuing requests.'
    );
  }
  return config;
}

/** Backend base URL (e.g. for building the hosted MCP endpoint command). */
export function getApiBaseUrl(): string {
  return getConfig().baseUrl;
}

/** Everything REST hangs off this. */
export function getApiRoot(): string {
  return `${getConfig().baseUrl}/api/v1`;
}

/** The hosted MCP endpoint a Claude client connects to. */
export function getMcpEndpoint(): string {
  return `${getApiRoot()}/mcp`;
}

/** `wss://…/ws` derived from the configured origin. */
export function getWebSocketUrl(): string {
  return `${getConfig().baseUrl.replace(/^http/, 'ws')}/ws`;
}
