/**
 * "May this origin talk to us" — the single source of truth shared by the
 * REST CORS gate and the WebSocket upgrade.
 *
 * Lives here rather than inline in index.ts so it can be tested without
 * booting the server. It is security-relevant and, until app.talyn.dev
 * existed, had never been exercised against a real browser origin.
 */

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/**
 * Comma-separated allowlist from `ALLOWED_ORIGINS`. Exact string match only —
 * deliberately no globs or regex. A pattern-matched CORS allowlist is a
 * well-worn source of bypasses (`https://app.talyn.dev.evil.com` matching a
 * naive prefix/suffix rule), and the set of legitimate browser origins here
 * is small enough to enumerate.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface OriginPolicy {
  /** REST + WS: is this origin permitted at all? */
  isAllowed(origin: string | undefined): boolean;
  /** WS only: is this the packaged desktop renderer? */
  isDesktop(origin: string | undefined): boolean;
}

export function createOriginPolicy(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  const allowlist = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  // `origin === 'null'` is NOT desktop-exclusive: a sandboxed iframe, a
  // `data:` document, or a cross-origin redirect all report it, so any page
  // can produce one. It's inert today because WS auth is a Bearer JWT in the
  // first frame, not a cookie — a cross-site WebSocket hijack needs ambient
  // credentials and there are none. It stops being inert the moment anyone
  // moves to cookie auth (the usual answer to "localStorage is
  // XSS-exfiltratable"), so it sits behind a kill switch: set
  // TALYN_ALLOW_NULL_ORIGIN_WS=0 to drop it the same day cookies land.
  const allowNullOrigin = env.TALYN_ALLOW_NULL_ORIGIN_WS !== '0';

  return {
    // A missing Origin is allowed — native clients (the desktop main process,
    // the CLI, the MCP server) send none. Loopback on any port is allowed
    // unconditionally: the dev renderer runs there, and code already running
    // on this host has other routes to the backend anyway.
    isAllowed: (origin) =>
      !origin || LOOPBACK_ORIGIN.test(origin) || allowlist.includes(origin),
    // The packaged desktop renderer loads from file://, so — unlike a truly
    // native client — its WS handshake DOES carry an Origin, which Chromium
    // reports as `file://…` or the opaque `null`.
    isDesktop: (origin) =>
      (allowNullOrigin && origin === 'null') ||
      (origin?.startsWith('file://') ?? false),
  };
}
