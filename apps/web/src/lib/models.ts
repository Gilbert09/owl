// PostHog Code model options offered when creating a cloud task. The API
// requires a concrete model on every run, so there's no "let it decide"
// option — the desktop always sends one of these.
export const DEFAULT_MODEL = 'claude-opus-4-8';

export const MODEL_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
];
