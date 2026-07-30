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
      // Session replay is on by default but respects the opt-out toggle
      // (Settings → Account → Privacy).
      if (!getAnalyticsOptOut()) ph.startSessionRecording();
    },
  });

  // Super properties on every event. Registered synchronously BEFORE the
  // first capture — app_version segments by release, environment separates
  // dev-server sessions from packaged usage in the same project.
  posthog.register({
    ...(APP_VERSION ? { app_version: APP_VERSION } : {}),
    environment: IS_DEV ? 'development' : 'production',
  });
  // No version fallback: APP_VERSION is always set here (derived from the
  // commit SHA at build time), and there is no main process to ask.

  trackEvent('app_opened');
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

/** Clear identity + start a fresh session. Call on logout. */
export function resetAnalyticsUser(): void {
  if (initialized) posthog.reset();
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
