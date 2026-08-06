import { DEFAULT_POSTHOG_CODE_MODEL_ID, POSTHOG_CODE_MODELS } from '@talyn/shared';

/**
 * PostHog Code model options offered when creating a cloud task. The API
 * requires a concrete model on every run, so there's no "let it decide"
 * option — the client always sends one of these.
 *
 * DERIVED from the single list in `@talyn/shared`, never hand-maintained. This
 * file used to hold its own copy, which is how the composer came to offer only
 * Claude 4 models long after Claude 5 shipped: nobody updating the Settings
 * picker had a reason to look here.
 */
export const DEFAULT_MODEL: string = DEFAULT_POSTHOG_CODE_MODEL_ID;

export const MODEL_OPTIONS: Array<{ id: string; label: string }> = POSTHOG_CODE_MODELS.map(
  ({ id, label }) => ({ id, label })
);
