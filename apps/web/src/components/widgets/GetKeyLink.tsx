import { openExternal } from '../../lib/openExternal';

export const POSTHOG_API_KEYS_URL =
  'https://app.posthog.com/settings/user-api-keys';
export const ANTHROPIC_API_KEYS_URL =
  'https://console.anthropic.com/settings/keys';
// The PostHog Code client only calls the tasks API (create/run/read/patch
// tasks + runs — see packages/backend/src/services/posthogCode/client.ts),
// so that's all the personal API key needs access to.
export const POSTHOG_KEY_SCOPE_NOTE =
  'the key needs read + write access to Tasks for your project.';

/**
 * "Get a key ↗" helper line shown under credential inputs — opens the
 * provider's API-key settings page in the browser, with an optional note
 * (e.g. which scopes the key needs).
 */
export function GetKeyLink({
  url,
  label = 'Get a key',
  note,
}: {
  url: string;
  label?: string;
  note?: string;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => void openExternal(url)}
        className="underline underline-offset-2 hover:text-foreground"
      >
        {label} ↗
      </button>
      {note ? <> — {note}</> : null}
    </p>
  );
}
