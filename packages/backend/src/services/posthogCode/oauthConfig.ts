/**
 * Whether this deployment can offer "Connect with PostHog" — and with what
 * client identity.
 *
 * In production Talyn is a CIMD client (Client ID Metadata Document,
 * draft-ietf-oauth-client-id-metadata-document): the `client_id` IS an https URL
 * we host, and PostHog fetches the document there to learn our name, logo and
 * redirect URIs. There is no registration step and no client secret, which is
 * also why prod only advertises `token_endpoint_auth_method: none` — we are a
 * public client and PKCE is what protects the exchange (PostHog sets
 * `PKCE_REQUIRED` for every client, confidential ones included).
 *
 * `client_id` is NOT required to be a URL, though, because CIMD is not the only
 * way PostHog issues one: `POST /oauth/register` (RFC 7591 Dynamic Client
 * Registration) hands back an opaque id and needs nothing hosted anywhere, which
 * is what makes a local backend able to run this flow at all (see
 * `docs/SETUP.md` §6b). So the value is passed through verbatim, and only
 * validated as a URL when it looks like one — which still catches the realistic
 * CIMD mistake of a typo'd or http document URL.
 *
 * The redirect URI is validated strictly either way. It is the one value that
 * decides where an authorization code gets delivered, and both variables are read
 * ONLY from the environment, never from a request, for the same reason: a
 * caller-supplied redirect target is a credential-theft primitive.
 *
 * They are all-or-nothing (the `POLAR_*` pattern): with either missing, OAuth is
 * simply not offered and the personal-API-key path is the only way to connect.
 * That is the default for a deployment that hasn't set them up, and the prod
 * kill switch.
 */

export interface PostHogOAuthConfig {
  /** The CIMD document URL, or an opaque id from DCR / a pre-registered app.
   *  Sent verbatim as `client_id`. */
  clientId: string;
  /** Where PostHog sends the browser back. Must be registered against the client
   *  (in the CIMD document, or at registration time). */
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

  // A `client_id` that looks like a URL is a CIMD document and gets checked as
  // one; anything else is an opaque id from DCR or a pre-registered app, which we
  // have no way to validate and no business rewriting.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawClientId) && !readUrl('POSTHOG_OAUTH_CLIENT_ID', rawClientId)) {
    cached = null;
    return cached;
  }
  const redirectUri = readUrl('POSTHOG_OAUTH_REDIRECT_URI', rawRedirectUri);
  if (!redirectUri) {
    cached = null;
    return cached;
  }

  // Both values are sent as the raw string. For CIMD the client_id must be
  // byte-identical to the URL PostHog fetched it from — it compares the
  // document's own `client_id` field against the request URL
  // (posthog/api/oauth/cimd.py) — and the redirect URI must match what the client
  // registered. A normalising round-trip that adds or drops a trailing slash
  // fails both comparisons with a confusing error at /authorize time, so the
  // parse above is used as validation only, never as the value.
  cached = { clientId: rawClientId, redirectUri: rawRedirectUri };
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
