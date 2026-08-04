import type React from 'react';
import { readCloudTaskProvider, type AnyCloudProviderType, type CloudProviderType } from '@talyn/shared';
import { cn } from './utils';
import {
  POSTHOG_LOGO,
  CLAUDE_LOGO,
  CODEX_LOGO,
  SELFHOSTED_LOGO,
  GENERIC_PROVIDER_LOGO,
} from '../assets/providers/logos';
import { TalynOwlMark } from '../assets/providers/TalynMark';

// One canonical place mapping a cloud provider to its display name + brand logo,
// so the Tasks panel, task detail, PR-row task badge, and Settings all show the
// same thing. Logos are the official marks (logo.dev), inlined as data URIs.
//
// Everything here tolerates a provider id this build has never heard of. The
// desktop app is a released Electron binary and users run old versions against
// a newer backend indefinitely, so an unknown provider is a normal runtime
// state, not a bug. It must degrade to a readable label and a neutral mark —
// never to a blank badge, which is what a task on an unknown provider used to
// render as.

interface ProviderMeta {
  label: string;
  /** Brand logo as a data URI (see assets/providers/logos.ts). */
  src: string;
  /**
   * An inline mark, preferred over `src` when present.
   *
   * Only Talyn Fleet has one, and only because it is the one provider whose
   * mark is OURS: it has to follow the theme rather than carry a vendor's fixed
   * colours, and an `<img>` cannot inherit `currentColor`. `src` stays populated
   * for both so every provider still has a URL form.
   */
  Mark?: (props: { className?: string }) => React.ReactElement;
}

/**
 * The providers this build ships branding for. Deliberately exhaustive over
 * `CloudProviderType`: adding a provider to the union should stop this file
 * compiling until someone gives it a name and a logo. Unknown ids never index
 * this map directly — go through {@link providerMeta}.
 */
export const PROVIDER_META: Record<CloudProviderType, ProviderMeta> = {
  posthog_code: { label: 'PostHog Code', src: POSTHOG_LOGO },
  claude_code: { label: 'Claude Code', src: CLAUDE_LOGO },
  codex_cloud: { label: 'Codex Cloud', src: CODEX_LOGO },
  // The wire/DB value stays 'selfhosted' — it is persisted in environments.type
  // and integrations.type. Only the label is the product's name for it.
  selfhosted: { label: 'Talyn Fleet', src: SELFHOSTED_LOGO, Mark: TalynOwlMark },
};

/** `some_new_provider` -> `Some New Provider`. */
function humanise(type: string): string {
  return type
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Branding for any provider id, known or not. An unknown id gets its own name
 * back, title-cased, and the neutral mark — so a user on an older client still
 * sees *which* agent ran their task even if this build cannot brand it.
 */
export function providerMeta(provider: AnyCloudProviderType): ProviderMeta {
  return (
    PROVIDER_META[provider as CloudProviderType] ?? {
      label: humanise(provider),
      src: GENERIC_PROVIDER_LOGO,
    }
  );
}

/** Display name for a provider, or null when there's no resolved provider. */
export function providerLabel(provider: AnyCloudProviderType | null | undefined): string | null {
  return provider ? providerMeta(provider).label : null;
}

/**
 * Which cloud provider a task runs on. The task's **assigned environment** is
 * authoritative — its `type` is set at creation and is how the queue routes
 * dispatch, so it reflects where the run actually happens and never gets lost.
 * Task metadata (`cloudTask.provider`) is only a fallback for when the env isn't
 * in the store yet. (Earlier we read metadata first; partial WS updates from the
 * pollers can strip the provider marker, which mis-showed Claude runs as PostHog.)
 *
 * An environment type this build does not recognise is returned as-is rather
 * than discarded. It used to be filtered through `in PROVIDER_META`, so a task
 * on a newer provider fell through to metadata, failed the same check there,
 * and came back null — indistinguishable from a task that had never been
 * dispatched.
 */
export function taskCloudProvider(
  task: { metadata?: Record<string, unknown> | null; assignedEnvironmentId?: string },
  environments: ReadonlyArray<{ id: string; type: string }>,
): AnyCloudProviderType | null {
  const envType = environments.find((e) => e.id === task.assignedEnvironmentId)?.type;
  // Local/remote environments are not cloud providers; everything else is a
  // provider id, whether or not this build knows it.
  if (envType && envType !== 'local' && envType !== 'remote') return envType;
  return readCloudTaskProvider(task);
}

/**
 * The cloud provider's brand logo, with a hover tooltip naming it. Renders
 * nothing for a task with no resolved provider (e.g. a queued task not yet
 * dispatched), so callers can drop it in unconditionally. An unrecognised
 * provider gets a neutral mark rather than nothing, so the badge never
 * collapses to an empty box. Size defaults to 3.5 (14px); pass `className`
 * (e.g. `h-3 w-3`) to override.
 */
export function ProviderIcon({
  provider,
  className,
  label,
}: {
  provider: AnyCloudProviderType | null | undefined;
  className?: string;
  /** Override the tooltip; defaults to the provider's display name. */
  label?: string;
}) {
  if (!provider) return null;
  const meta = providerMeta(provider);
  if (meta.Mark) {
    // Black on light, brand clay on dark — the two ways this mark is meant to
    // be seen. `text-foreground` rather than a literal `#000` so it tracks the
    // theme's own ink instead of drifting from it.
    //
    // The dark value is clay.400 (#cf7553), not clay DEFAULT (#c25e3a). Both
    // are the brand accent; the default is tuned for the light surfaces
    // marketing uses, and at 14px on a near-black badge it loses the eyes.
    // Lightening an accent for a dark surface is the ordinary move, and .400 is
    // the palette's own step for it rather than a colour invented here.
    // Compared against .600/.DEFAULT/.300 at 14/20/32px on the real badge.
    //
    // A caller passing its own text-* class still wins — cn() puts it last.
    return (
      <span
        title={label ?? meta.label}
        aria-label={label ?? meta.label}
        role="img"
        className={cn(
          'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center',
          'text-foreground dark:text-[#cf7553]',
          className,
        )}
      >
        <meta.Mark className="h-full w-full" />
      </span>
    );
  }
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
