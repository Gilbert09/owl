/**
 * PostHog analytics for the operator console.
 *
 * A fork of apps/web's with three DELIBERATE differences, all of them about
 * what an admin console is allowed to record:
 *
 *   - `disable_session_recording: true`, and no `startSessionRecording()`.
 *     Session-replaying this app would ship every customer email, workspace
 *     name, task prompt and agent transcript it renders into PostHog. The
 *     replay would be a more complete copy of the production database than
 *     anything else we hold, sitting in a third-party tool with a different
 *     access model. Not worth any amount of product insight.
 *   - `autocapture: false`. Same reason at lower volume: autocaptured element
 *     text on a cross-tenant table is customer data.
 *   - `capture_pageview: true`, unlike both other clients. They are
 *     single-surface apps that track panels as events; this one is a genuine
 *     multi-page router, so pageviews are the right primitive.
 *
 * The `module.full.no-external` import stays even though replay is off: it is
 * what lets `script-src 'self'` hold with no CDN exemption (see vercel.json).
 * Swapping to the lazy-loading bundle would break silently under the CSP.
 */
import posthog from 'posthog-js/dist/module.full.no-external';
// Inlined for the CSP reason above, not because replay is used.
import 'posthog-js/dist/posthog-recorder';
import { POSTHOG_KEY, POSTHOG_HOST, IS_DEV_BUILD, APP_VERSION } from './env';

const KEY = POSTHOG_KEY;
const HOST = POSTHOG_HOST;
const IS_DEV = IS_DEV_BUILD;

/**
 * Super properties describing the BUILD rather than the user, so they must
 * survive a reset. `client` is the load-bearing one: three front ends now
 * report into one project, and without it every funnel silently merges them.
 */
const BUILD_SUPER_PROPERTIES: Record<string, unknown> = {
  ...(APP_VERSION ? { app_version: APP_VERSION } : {}),
  environment: IS_DEV ? 'development' : 'production',
  client: 'admin',
};

let initialized = false;

/** Whether a PostHog project key was baked into this build. */
export function isAnalyticsConfigured(): boolean {
  return Boolean(KEY);
}

/** Initialise PostHog once. No-op without a key. Call once at app startup. */
export function initAnalytics(): void {
  if (initialized || !KEY) return;
  initialized = true;

  posthog.init(KEY, {
    api_host: HOST,
    ui_host: uiHostFor(HOST),
    persistence: 'localStorage',
    person_profiles: 'identified_only',
    // A real multi-page router, unlike the product apps.
    capture_pageview: true,
    // See the module docblock: element text on a cross-tenant table is
    // customer data.
    autocapture: false,
    disable_session_recording: true,
    capture_exceptions: IS_DEV
      ? false
      : {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: true,
        },
    // Enrich exceptions with connectivity context, so a transport failure
    // against the backend is separable from a real bug — this console fans
    // out over fleet hosts, so "failed to fetch" is its commonest exception.
    before_send: (event) => {
      if (event && event.event === '$exception') {
        const list = event.properties?.$exception_list as
          | Array<{ value?: string }>
          | undefined;
        const message = list?.map((e) => e?.value ?? '').join(' ') ?? '';
        const connectivity =
          /failed to fetch|could not reach backend|networkerror|load failed/i.test(message);
        event.properties = {
          ...event.properties,
          online: typeof navigator !== 'undefined' ? navigator.onLine : null,
          connectivity_error: connectivity,
        };
      }
      return event;
    },
    loaded: (ph) => {
      // Registered HERE rather than straight after init(): posthog-js only has
      // its persistence layer ready by the time `loaded` fires, and props
      // registered before that are silently dropped when it initialises.
      ph.register(BUILD_SUPER_PROPERTIES);
      trackEvent('admin_opened');
    },
  });
}

/** Link subsequent events to a known operator. */
export function identifyAnalyticsUser(
  distinctId: string,
  properties?: Record<string, unknown>
): void {
  if (initialized) posthog.identify(distinctId, properties);
}

/**
 * Clear identity + start a fresh session. Call on logout.
 *
 * `posthog.reset()` also clears SUPER PROPERTIES, so the build-time ones are
 * re-registered immediately. Without this they vanish on the very first
 * render: the Analytics component runs its identify effect before auth
 * resolves, sees no user, and calls this — silently wiping app_version,
 * environment and client from every subsequent event.
 */
export function resetAnalyticsUser(): void {
  if (!initialized) return;
  posthog.reset();
  posthog.register(BUILD_SUPER_PROPERTIES);
}

/** Capture a custom event. */
export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (initialized) posthog.capture(event, properties);
}

/** Manually capture a caught exception. */
export function captureAnalyticsException(
  error: unknown,
  properties?: Record<string, unknown>
): void {
  if (initialized) posthog.captureException(error, properties);
}

/** Ingestion host → app host, for deep links. */
function uiHostFor(host: string): string {
  return host
    .replace('us.i.posthog.com', 'us.posthog.com')
    .replace('eu.i.posthog.com', 'eu.posthog.com');
}
