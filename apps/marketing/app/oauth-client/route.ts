import { site } from "@/lib/content";

/**
 * Talyn's OAuth Client ID Metadata Document (CIMD).
 *
 * PostHog is an OAuth 2.0 authorization server that supports CIMD
 * (draft-ietf-oauth-client-id-metadata-document), which means Talyn's
 * `client_id` IS this URL: there is no client registration step and no client
 * secret to hold. When a user starts "Connect with PostHog", PostHog fetches
 * this document to learn who is asking, what to show on the consent screen, and
 * which redirect URIs are legitimate.
 *
 * Three things here are load-bearing, in the sense that getting them wrong
 * breaks the flow with an error only visible on PostHog's side:
 *
 * 1. `client_id` MUST equal the URL this is served from, byte for byte —
 *    PostHog compares them as strings. The apex domain 308-redirects to www
 *    (see `site.url`), so the canonical `https://www.talyn.dev/oauth-client` is
 *    the only form that can be used as the client_id.
 * 2. `redirect_uris` must contain the backend callback exactly as the backend
 *    sends it in `POSTHOG_OAUTH_REDIRECT_URI`. These are two copies of one fact
 *    and they have to agree; the whole point of the pair is that neither the
 *    client nor the user can nominate a different destination for an
 *    authorization code.
 * 3. No `token_endpoint_auth_method` is declared, so it defaults to `none`:
 *    Talyn is a public client and PKCE (which PostHog requires of every client)
 *    is what protects the exchange. CIMD cannot deliver a shared secret, and
 *    PostHog's production metadata advertises no `private_key_jwt`, so this is
 *    the only correct posture today.
 *
 * Served dynamically rather than as a static file in `public/` so the URLs stay
 * derived from `lib/content.ts` and the reasoning above lives next to them.
 */

const BACKEND_ORIGIN = "https://prod.talyn.dev";

export const dynamic = "force-static";

export function GET(): Response {
  const body = {
    client_id: `${site.url}/oauth-client`,
    client_name: site.name,
    client_uri: site.url,
    logo_uri: `${site.url}/apple-touch-icon.png`,
    redirect_uris: [`${BACKEND_ORIGIN}/api/v1/posthog/oauth/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // PostHog caches the document for as long as we say, clamped to
      // 5 minutes–24 hours. An hour keeps a redirect-URI change from taking a
      // day to take effect, without making it re-fetch on every connect.
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
