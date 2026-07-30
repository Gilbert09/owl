/**
 * PostHog analytics for the browser app.
 *
 * Imports the `module.full.no-external` bundle plus `posthog-recorder`, so the
 * SDK *and* the session-replay recorder are fully inlined. The desktop does
 * this because its renderer is served from `file://` under a strict CSP; the
 * web app keeps it because that same choice is what lets `script-src 'self'`
 * hold here with no CDN exemption (see vercel.json). Lazily fetching the
 * recorder from PostHog's CDN would be blocked and replay would silently
 * never start.
 *
 * A small guarded helper module rather than the React provider, so calls are
 * safe no-ops until PostHog is initialised. Analytics is disabled entirely
 * until VITE_TALYN_POSTHOG_KEY is set at build time.
 */
import posthog from 'posthog-js/dist/module.full.no-external';
// Inlines the session-replay recorder so it never needs to load from the CDN.
import 'posthog-js/dist/posthog-recorder';
import {
  POSTHOG_KEY,
  POSTHOG_HOST,
  IS_DEV_BUILD,
  APP_VERSION as BUILD_VERSION,
} from './env';

const KEY = POSTHOG_KEY;
const HOST = POSTHOG_HOST;
const IS_DEV = IS_DEV_BUILD;
// Always present here — vite.config.ts derives it from the commit SHA — so it
// can be registered synchronously. The desktop needed an IPC fallback for the
// case where nothing was baked in; that fallback silently never landed on any
// event, and there is nothing to fall back to in a browser anyway.
const APP_VERSION = BUILD_VERSION;

/**
 * Super properties that describe the BUILD rather than the user, so they must
 * survive a reset. app_version segments by release; environment separates
 * dev-server sessions from real usage in the same project; client
 * distinguishes the two front ends now reporting into it — without it every
 * funnel silently merges web and desktop, and "web users don't convert"
 * becomes indistinguishable from "we can't tell them apart".
 */
const BUILD_SUPER_PROPERTIES: Record<string, unknown> = {
  ...(APP_VERSION ? { app_version: APP_VERSION } : {}),
  environment: IS_DEV ? 'development' : 'production',
  client: 'web',
};

let initialized = false;

// Mirror of the user's analytics opt-out. posthog-js persists its own
// opt-out flag, but we keep this app-owned copy so the Settings toggle can
// render synchronously (and before analytics is even initialised).
const OPT_OUT_KEY = 'fastowl-analytics-opt-out';

/** Whether the user opted out of usage analytics + session replay. */
export function getAnalyticsOptOut(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(OPT_OUT_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Toggle analytics + session replay. Persists the choice and applies it to
 * the live PostHog client immediately (stop/start recording, opt in/out of
 * event capture).
 */
export function setAnalyticsOptOut(optedOut: boolean): void {
  try {
    localStorage.setItem(OPT_OUT_KEY, String(optedOut));
  } catch {
    // Privacy mode — the in-memory client state below still applies.
  }
  if (!initialized) return;
  if (optedOut) {
    posthog.stopSessionRecording();
    posthog.opt_out_capturing();
  } else {
    posthog.opt_in_capturing();
    posthog.startSessionRecording();
  }
}

/** Whether a PostHog project key was baked into this build. */
export function isAnalyticsConfigured(): boolean {
  return Boolean(KEY);
}

/** Initialise PostHog once. No-op without a key. Call once at app startup. */
export function initAnalytics(): void {
  if (initialized || !KEY) return;
  initialized = true;

  const optedOut = getAnalyticsOptOut();

  posthog.init(KEY, {
    api_host: HOST,
    ui_host: uiHostFor(HOST),
    // A packaged renderer loads from file://, which has no cookies — keep all
    // persistence in localStorage.
    persistence: 'localStorage',
    // Don't materialise person profiles for anonymous usage.
    person_profiles: 'identified_only',
    // A desktop app has no page navigations; panels are tracked as events.
    capture_pageview: false,
    autocapture: true,
    disable_session_recording: false,
    // Honour a previously-persisted opt-out from the very first event —
    // don't wait for the Settings toggle to mount.
    opt_out_capturing_by_default: optedOut,
    // Exception autocapture is noisy against a dev server; enable it in
    // packaged builds only.
    capture_exceptions: IS_DEV
      ? false
      : {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: true,
        },
    // Enrich every captured exception with connectivity context. The renderer's
    // most common exception is a transport-level "Failed to fetch" against the
    // hosted backend; tagging each with the online state and a connectivity flag
    // makes that noise separable from real bugs in PostHog — online:false ⇒ the
    // machine was offline, online:true + connectivity_error ⇒ the backend itself
    // was unreachable (down / cold-starting).
    before_send: (event) => {
      if (event && event.event === '$exception') {
        const list = event.properties?.$exception_list as
          | Array<{ value?: string }>
          | undefined;
        const message = list?.map((e) => e?.value ?? '').join(' ') ?? '';
        const connectivity =
          /failed to fetch|could not reach backend|networkerror|load failed/i.test(
            message,
          );
        event.properties = {
          ...event.properties,
          online: typeof navigator !== 'undefined' ? navigator.onLine : null,
          connectivity_error: connectivity,
        };
      }
      return event;
    },
    loaded: (ph) => {
      // Super properties on every event, registered HERE rather than straight
      // after init(). posthog-js only has its persistence layer ready by the
      // time `loaded` fires, and props registered before that are dropped when
      // it initialises — verified in the browser: `workspace_id` (registered
      // later, from components/Analytics) persisted while these did not.
      //
      // app_version segments by release; environment separates dev-server
      // sessions from real usage in the same project; client distinguishes the
      // two front ends now reporting into it — without it every funnel
      // silently merges web and desktop, and "web users don't convert" becomes
      // indistinguishable from "we can't tell them apart".
      ph.register(BUILD_SUPER_PROPERTIES);

      // Session replay is on by default but respects the opt-out toggle
      // (Settings → Account → Privacy).
      if (!getAnalyticsOptOut()) ph.startSessionRecording();

      // After register, so the first event carries the super properties.
      trackEvent('app_opened');
    },
  });
}

/**
 * Register additional super properties (attached to every subsequent
 * event). Used for slow-changing app context like the active workspace.
 */
export function registerSuperProperties(
  properties: Record<string, unknown>,
): void {
  if (initialized) posthog.register(properties);
}

/** Link subsequent events to a known user. */
export function identifyAnalyticsUser(
  distinctId: string,
  properties?: Record<string, unknown>,
): void {
  if (initialized) posthog.identify(distinctId, properties);
}

/**
 * Clear identity + start a fresh session. Call on logout.
 *
 * `posthog.reset()` also clears SUPER PROPERTIES, so the build-time ones are
 * re-registered immediately. Without this they vanish on the very first
 * render: Analytics runs its identify effect before auth resolves, sees no
 * user, and calls this — silently wiping app_version, environment and client
 * from every subsequent event. Confirmed in the browser by finding
 * `$last_posthog_reset` set and those three properties absent while
 * `workspace_id` (registered later) survived.
 */
export function resetAnalyticsUser(): void {
  if (!initialized) return;
  posthog.reset();
  posthog.register(BUILD_SUPER_PROPERTIES);
}

/** Capture a custom product-analytics event. */
export function trackEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (initialized) posthog.capture(event, properties);
}

/** Manually capture a caught exception. */
export function captureAnalyticsException(
  error: unknown,
  properties?: Record<string, unknown>,
): void {
  if (initialized) posthog.captureException(error, properties);
}

/** Ingestion host → app host, for "view recording" deep links. */
function uiHostFor(host: string): string {
  return host
    .replace('us.i.posthog.com', 'us.posthog.com')
    .replace('eu.i.posthog.com', 'eu.posthog.com');
}
