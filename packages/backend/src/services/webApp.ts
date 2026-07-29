/**
 * Where the browser app lives (app.talyn.dev), when one is deployed.
 *
 * Only ever read from the environment — never from a request. Any flow that
 * sends a browser back to us (the GitHub App callback) redirects to a path
 * built on top of THIS constant, so a caller can't steer the redirect. An
 * open redirect inside an OAuth callback is how you turn a login flow into a
 * credential-phishing hop.
 *
 * Unset (the default, and the case for a desktop-only deployment) means every
 * such flow falls back to rendering a "you can close this tab" page.
 */
let cached: string | null | undefined;

export function getWebAppUrl(): string | null {
  if (cached !== undefined) return cached;
  const raw = (process.env.WEB_APP_URL ?? '').trim();
  if (!raw) {
    cached = null;
    return cached;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(`WEB_APP_URL is not a valid URL (${raw}) — ignoring.`);
    cached = null;
    return cached;
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    console.warn(`WEB_APP_URL must be https (or localhost), got ${raw} — ignoring.`);
    cached = null;
    return cached;
  }
  // Normalise to an origin with no trailing slash so callers can append paths.
  cached = parsed.origin;
  return cached;
}

/**
 * Build an absolute URL into the web app. `path` must be a single-slash
 * absolute path ('/settings').
 *
 * The path is validated rather than trusted even though every call site
 * passes a literal today. `new URL(path, base)` happily resolves '//evil.com'
 * and 'https://evil.com' to another origin, so a future caller threading a
 * request value through here would silently turn the GitHub App callback into
 * an open redirect. Refusing the shape closes that off permanently.
 */
export function webAppUrl(path: string, params?: Record<string, string>): string | null {
  const base = getWebAppUrl();
  if (!base) return null;
  if (!path.startsWith('/') || path.startsWith('//')) {
    console.warn(`webAppUrl: refusing non-relative path '${path}'`);
    return null;
  }
  const url = new URL(base);
  // Assigning pathname (rather than resolving) means '..' segments can't walk
  // anywhere interesting either — the origin is fixed by construction.
  url.pathname = path;
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

/** Tests: drop the memoised value between cases. */
export function resetWebAppUrlCacheForTests(): void {
  cached = undefined;
}
