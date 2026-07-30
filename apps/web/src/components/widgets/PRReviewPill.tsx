import React from 'react';
import { CheckCircle2, AlertTriangle, Eye, HelpCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { PRReviewDecision, PRState } from '../../lib/api';

/**
 * Approval/review status for a PR — the "does this still need a human
 * sign-off?" dimension, split out from the conflicts/CI rollup in
 * PRStatusPill. Driven by the PR's *effective* review decision (GitHub's
 * `reviewDecision` when the base branch enforces required reviews, otherwise
 * one derived from the actual reviews — see `deriveEffectiveReviewDecision`).
 *
 *   APPROVED          → green, "Approved"
 *   CHANGES_REQUESTED → amber, "Changes requested"
 *   REVIEW_REQUIRED   → amber, "Needs approval"
 *   null / terminal   → grey, "—"
 */
interface PRReviewPillProps {
  reviewDecision: PRReviewDecision;
  /** Merged/closed PRs don't carry a meaningful pending-review state. */
  state?: PRState;
  /**
   * Icon-only badge (no label) — for sitting alongside the status pill
   * in a single column. Renders nothing when there's no actionable
   * review state (no decision yet, or a terminal PR).
   */
  minimal?: boolean;
  className?: string;
}

interface ReviewVariant {
  icon: React.ElementType;
  label: string;
  tone: 'green' | 'amber' | 'grey';
  title: string;
}

export function PRReviewPill({
  reviewDecision,
  state,
  minimal = false,
  className,
}: PRReviewPillProps) {
  const variant = pickVariant(reviewDecision, state);
  const Icon = variant.icon;

  // Nothing actionable to show in minimal mode — keep the cell calm.
  if (minimal && variant.tone === 'grey') return null;

  if (minimal) {
    return (
      <span
        title={variant.title}
        className={cn(
          'inline-flex items-center rounded-md border p-1',
          toneClass(variant.tone),
          className
        )}
      >
        <Icon className="w-3.5 h-3.5 shrink-0" />
      </span>
    );
  }

  return (
    <span
      title={variant.title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium',
        toneClass(variant.tone),
        className
      )}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{variant.label}</span>
    </span>
  );
}

function pickVariant(
  reviewDecision: PRReviewDecision,
  state?: PRState
): ReviewVariant {
  // A merged/closed PR's pending-review state is no longer actionable.
  if (state === 'merged' || state === 'closed') {
    return { icon: HelpCircle, label: '—', tone: 'grey', title: 'No longer open' };
  }
  switch (reviewDecision) {
    case 'APPROVED':
      return { icon: CheckCircle2, label: 'Approved', tone: 'green', title: 'Approved by a reviewer' };
    case 'CHANGES_REQUESTED':
      return {
        icon: AlertTriangle,
        label: 'Changes requested',
        tone: 'amber',
        title: 'A reviewer requested changes',
      };
    case 'REVIEW_REQUIRED':
      return {
        icon: Eye,
        label: 'Needs approval',
        tone: 'amber',
        title: 'Waiting on a required review/approval',
      };
    default:
      return {
        icon: HelpCircle,
        label: '—',
        tone: 'grey',
        title: 'No review decision yet',
      };
  }
}

function toneClass(tone: ReviewVariant['tone']): string {
  switch (tone) {
    case 'green':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
    case 'amber':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400';
    case 'grey':
    default:
      return 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}
