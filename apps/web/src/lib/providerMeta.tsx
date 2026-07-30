import { readCloudTaskProvider, type CloudProviderType } from '@talyn/shared';
import { cn } from './utils';
import { POSTHOG_LOGO, CLAUDE_LOGO, CODEX_LOGO } from '../assets/providers/logos';

// One canonical place mapping a cloud provider to its display name + brand logo,
// so the Tasks panel, task detail, PR-row task badge, and Settings all show the
// same thing. Logos are the official marks (logo.dev), inlined as data URIs.

interface ProviderMeta {
  label: string;
  /** Brand logo as a data URI (see assets/providers/logos.ts). */
  src: string;
}

export const PROVIDER_META: Record<CloudProviderType, ProviderMeta> = {
  posthog_code: { label: 'PostHog Code', src: POSTHOG_LOGO },
  claude_code: { label: 'Claude Code', src: CLAUDE_LOGO },
  codex_cloud: { label: 'Codex Cloud', src: CODEX_LOGO },
};

/** Display name for a provider, or null when there's no resolved provider. */
export function providerLabel(provider: CloudProviderType | null | undefined): string | null {
  return provider ? PROVIDER_META[provider]?.label ?? null : null;
}

/**
 * Which cloud provider a task runs on. The task's **assigned environment** is
 * authoritative — its `type` is set at creation and is how the queue routes
 * dispatch, so it reflects where the run actually happens and never gets lost.
 * Task metadata (`cloudTask.provider`) is only a fallback for when the env isn't
 * in the store yet. (Earlier we read metadata first; partial WS updates from the
 * pollers can strip the provider marker, which mis-showed Claude runs as PostHog.)
 */
export function taskCloudProvider(
  task: { metadata?: Record<string, unknown> | null; assignedEnvironmentId?: string },
  environments: ReadonlyArray<{ id: string; type: string }>,
): CloudProviderType | null {
  const envType = environments.find((e) => e.id === task.assignedEnvironmentId)?.type;
  if (envType && envType in PROVIDER_META) return envType as CloudProviderType;
  return readCloudTaskProvider(task);
}

/**
 * The cloud provider's brand logo, with a hover tooltip naming it. Renders
 * nothing for a task with no resolved provider (e.g. a queued task not yet
 * dispatched), so callers can drop it in unconditionally. Size defaults to
 * 3.5 (14px); pass `className` (e.g. `h-3 w-3`) to override.
 */
export function ProviderIcon({
  provider,
  className,
  label,
}: {
  provider: CloudProviderType | null | undefined;
  className?: string;
  /** Override the tooltip; defaults to the provider's display name. */
  label?: string;
}) {
  if (!provider) return null;
  const meta = PROVIDER_META[provider];
  if (!meta) return null;
  return (
    <img
      src={meta.src}
      alt={label ?? meta.label}
      title={label ?? meta.label}
      draggable={false}
      className={cn('inline-block h-3.5 w-3.5 shrink-0 rounded-[3px] object-contain', className)}
    />
  );
}
