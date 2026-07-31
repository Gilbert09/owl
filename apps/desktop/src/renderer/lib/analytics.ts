/**
 * PostHog analytics for the renderer process.
 *
 * Mirrors the PostHog Code desktop app's Electron setup:
 *  - Imports the `module.full.no-external` bundle plus `posthog-recorder`, so
 *    the SDK *and* the session-replay recorder are fully inlined. Our renderer
 *    runs under a strict CSP (`script-src 'self'`) and is served from
 *    `file://` when packaged, so the normal posthog-js behaviour of lazily
 *    fetching the recorder/extensions from the PostHog CDN would be blocked
 *    and session replay would silently never start.
 *  - A small guarded helper module (rather than the React provider), so calls
 *    are safe no-ops until PostHog is initialised.
 *
 * Analytics is disabled entirely until `TALYN_POSTHOG_KEY` is baked in at
 * build time (see the webpack EnvironmentPlugin configs).
 */
import posthog from 'posthog-js/dist/module.full.no-external';
// Inlines the session-replay recorder so it never needs to load from the CDN.
import 'posthog-js/dist/posthog-recorder';

const KEY = process.env.TALYN_POSTHOG_KEY || '';
const HOST = process.env.TALYN_POSTHOG_HOST || 'https://us.i.posthog.com';
const IS_DEV = process.env.NODE_ENV !== 'production';
// Baked at build time from release/app/package.json (see the webpack
// renderer configs) so it can be registered synchronously — the old IPC
// getVersion round-trip silently never landed on any event.
const APP_VERSION = process.env.TALYN_APP_VERSION || '';

/**
 * Super properties describing the BUILD rather than the user: app_version
 * segments by release, environment separates dev-server sessions from
 * packaged usage in the same project.
 *
 * Held as a constant because they must be re-applied after every
 * posthog.reset() — see resetAnalyticsUser.
 */
const BUILD_SUPER_PROPERTIES: Record<string, unknown> = {
  ...(APP_VERSION ? { app_version: APP_VERSION } : {}),
  environment: IS_DEV ? 'development' : 'production',
  // Counterpart to the web app's `client: 'web'`. Without it a breakdown by
  // client reads "web vs blank" rather than "web vs desktop", and every
  // pre-existing event stays unattributed.
  client: 'desktop',
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
      // Super properties, registered here rather than after init() so they
      // land once persistence is ready. See BUILD_SUPER_PROPERTIES for why
      // they also have to survive reset().
      ph.register(BUILD_SUPER_PROPERTIES);

      // Session replay is on by default but respects the opt-out toggle
      // (Settings → Account → Privacy).
      if (!getAnalyticsOptOut()) ph.startSessionRecording();
    },
  });
  // Fallback when no version was baked (e.g. a config drift): best-effort
  // async resolve from the main process.
  if (!APP_VERSION) {
    window.electron?.app
      ?.getVersion()
      .then((version) => posthog.register({ app_version: version }))
      .catch(() => {});
  }

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
  if (!initialized) return;
  posthog.reset();
  // reset() also clears SUPER PROPERTIES. Without re-registering, app_version
  // and environment vanish from every event on a normal cold start: the
  // Analytics component runs its identify effect before auth resolves, sees no
  // user, and calls this. Diagnosed on the web port, where the same code
  // dropped them — `$last_posthog_reset` was set and the properties absent,
  // while a later-registered workspace_id survived.
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
