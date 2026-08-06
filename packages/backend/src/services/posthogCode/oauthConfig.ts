/**
 * Whether this deployment can offer "Connect with PostHog" — and with what
 * client identity.
 *
 * Talyn is a CIMD client (Client ID Metadata Document,
 * draft-ietf-oauth-client-id-metadata-document): our `client_id` IS an https URL
 * we host, and PostHog fetches the document there to learn our name, logo and
 * redirect URIs. There is no registration step and no client secret, which is
 * also why prod only advertises `token_endpoint_auth_method: none` — we are a
 * public client and PKCE is what protects the exchange (PostHog sets
 * `PKCE_REQUIRED` for every client, confidential ones included).
 *
 * Both variables are read ONLY from the environment, never from a request: the
 * redirect URI is the one value that decides where an authorization code is
 * delivered, so a caller-supplied one is a credential-theft primitive. They are
 * all-or-nothing (the `POLAR_*` pattern): with either missing, OAuth is simply
 * not offered and the personal-API-key path is the only way to connect. That is
 * the dev default, and the prod kill switch.
 */

export interface PostHogOAuthConfig {
  /** The CIMD document URL, used verbatim as `client_id`. */
  clientId: string;
  /** Where PostHog sends the browser back. Must be registered in the CIMD doc. */
  redirectUri: string;
}

let cached: PostHogOAuthConfig | null | undefined;

function readUrl(name: string, value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    console.warn(`${name} is not a valid URL (${value}) — PostHog OAuth disabled.`);
    return null;
  }
  // localhost is allowed so the flow can be exercised end-to-end in dev; PostHog
  // itself only permits http redirect URIs for loopback addresses.
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    console.warn(`${name} must be https (or loopback), got ${value} — PostHog OAuth disabled.`);
    return null;
  }
  return parsed;
}

export function getPostHogOAuthConfig(): PostHogOAuthConfig | null {
  if (cached !== undefined) return cached;

  const rawClientId = (process.env.POSTHOG_OAUTH_CLIENT_ID ?? '').trim();
  const rawRedirectUri = (process.env.POSTHOG_OAUTH_REDIRECT_URI ?? '').trim();
  if (!rawClientId || !rawRedirectUri) {
    // Not a warning: an unset pair is the documented "personal API key only"
    // deployment, which is every local dev environment.
    cached = null;
    return cached;
  }

  const clientId = readUrl('POSTHOG_OAUTH_CLIENT_ID', rawClientId);
  const redirectUri = readUrl('POSTHOG_OAUTH_REDIRECT_URI', rawRedirectUri);
  if (!clientId || !redirectUri) {
    cached = null;
    return cached;
  }

  // The client_id must be byte-identical to the URL PostHog fetched it from —
  // it compares the document's own `client_id` field against the request URL
  // (posthog/api/oauth/cimd.py). A normalising URL round-trip that adds or drops
  // a trailing slash fails that comparison with a confusing error at /authorize
  // time, so keep the raw string and only use the parse as validation.
  cached = { clientId: rawClientId, redirectUri: redirectUri.toString() };
  return cached;
}

/** Whether the connect-with-PostHog path is available on this deployment. */
export function isPostHogOAuthEnabled(): boolean {
  return getPostHogOAuthConfig() !== null;
}

/** Tests: drop the memoised value between cases. */
export function resetPostHogOAuthConfigForTests(): void {
  cached = undefined;
}
