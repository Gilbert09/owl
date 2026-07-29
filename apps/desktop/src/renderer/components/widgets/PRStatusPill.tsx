import React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  GitMerge,
  Eye,
  HelpCircle,
  ShieldAlert,
  Clock,
} from 'lucide-react';
import {
  externalQueueProviderLabel,
  externalQueueStateLabel,
  externalQueueStatusFromLabels,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import type { PRBlockingReason, PRChecks, PRState } from '../../lib/api';

/**
 * One-glance status badge for a task's PR. Mirrors supacode's
 * `PullRequestMergeReadiness` rollup — blocking reason picks the
 * shape, the 5-segment check bar shows progress at a glance.
 *
 * State priority (top wins):
 *   merge_conflicts        → red, "Conflicts"
 *   changes_requested      → amber, "N changes requested" (use review count)
 *   checks_failed          → red, "N/M failing"
 *   checks_failed_optional → green, "N non-required" (mergeable; the failures
 *                            don't block, so it reads as ready — the rollup bar
 *                            still shows the non-required reds in amber)
 *   checks running         → blue spinner, "N/M running"
 *   mergeable              → green, "Ready"
 *   blocked                → amber, "Blocked"
 *   unknown                → grey, "—"
 */

interface PRStatusPillProps {
  blockingReason: PRBlockingReason;
  checks: PRChecks;
  /**
   * GitHub's mergeStateStatus. Only used to tell required from
   * non-required check failures when review verdicts are stripped
   * (see `hideReviewState`); UNSTABLE ⇒ the failing checks aren't
   * required.
   */
  mergeStateStatus?: string;
  /**
   * PR lifecycle state. When merged/closed it overrides blockingReason
   * — a terminal PR shows "Merged"/"Closed", not its last open verdict
   * (which would otherwise leave a merged PR stuck on a green "Ready").
   */
  state?: PRState;
  /** Click target — usually opens the side-sheet detail panel. */
  onClick?: () => void;
  /** Hide the inline rollup bar; shrinks the pill for tight headers. */
  compact?: boolean;
  /**
   * Drop review-related verdicts (changes_requested, blocked-on-review)
   * so this pill reflects only conflicts / CI / mergeability. Used where
   * approval state lives in its own column (the GitHub table's Review
   * column via PRReviewPill). Off elsewhere so the task-screen pill keeps
   * its all-in-one rollup.
   */
  hideReviewState?: boolean;
  /**
   * The PR's review decision (effective preferred). Disambiguates the
   * 'blocked' verdict: GitHub reports mergeStateStatus BLOCKED both for a
   * missing required review AND for other branch-protection holds (required
   * signatures, merge restrictions). On an APPROVED PR the "Review" label
   * would be a lie — it renders as "Protected" instead.
   */
  reviewDecision?: string | null;
  /**
   * The PR's labels. An external merge queue (trunk.io) publishes a submitted
   * PR's state as labels, and once it holds the PR that state is what the
   * reader actually wants — "Queue: testing" beats "Ready" on a PR nobody but
   * the queue can merge. Ranked below merged/closed, above every open verdict.
   */
  labels?: string[];
  className?: string;
}

interface PillVariant {
  icon: React.ElementType;
  label: string;
  /** Tailwind class fragment. */
  tone: 'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple';
  spin?: boolean;
  /** Failing checks are non-required → draw the rollup's fail bar amber. */
  optionalFailures?: boolean;
}

export function PRStatusPill({
  blockingReason,
  checks,
  mergeStateStatus,
  state,
  onClick,
  compact = false,
  hideReviewState = false,
  reviewDecision,
  labels,
  className,
}: PRStatusPillProps) {
  const terminal = terminalVariant(state);
  const external = terminal || state !== 'open' ? null : externalQueueVariant(labels);
  const variant =
    terminal ??
    external?.variant ??
    pickVariant(blockingReason, checks, hideReviewState, mergeStateStatus, reviewDecision);
  const Icon = variant.icon;
  // A merged/closed PR's check rollup is no longer meaningful.
  const showRollup = !terminal && !compact && checks.total > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        terminal
          ? terminal.label
          : (external?.title ?? titleFor(blockingReason, checks, reviewDecision))
      }
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
        toneClass(variant.tone),
        onClick ? 'cursor-pointer hover:opacity-90' : 'cursor-default',
        className
      )}
    >
      <Icon
        className={cn('w-3.5 h-3.5 shrink-0', variant.spin && 'animate-spin')}
      />
      <span className="truncate">{variant.label}</span>
      {showRollup && (
        <CheckRollupBar checks={checks} optionalFailures={variant.optionalFailures} />
      )}
    </button>
  );
}

/**
 * Terminal-state override. Returns a variant for merged/closed PRs;
 * null for open PRs (fall through to the blocking-reason logic).
 */
function terminalVariant(state?: PRState): PillVariant | null {
  if (state === 'merged') {
    return { icon: GitMerge, label: 'Merged', tone: 'purple' };
  }
  if (state === 'closed') {
    return { icon: XCircle, label: 'Closed', tone: 'grey' };
  }
  return null;
}

/**
 * An external merge queue (trunk.io) holding the PR outranks every open-state
 * verdict: on a branch only that system can merge, "Ready" is misleading and
 * "Queue: testing" is the answer. An ejected PR (failed/cancelled) reads red or
 * amber so it stands out — it's back in the author's court.
 */
function externalQueueVariant(
  labels: string[] | undefined
): { variant: PillVariant; title: string } | null {
  const ext = externalQueueStatusFromLabels(labels);
  if (!ext) return null;
  const provider = externalQueueProviderLabel(ext.provider);
  const state = externalQueueStateLabel(ext.state);
  const base = { label: `Queue: ${state.toLowerCase()}`, tone: 'blue' as const };
  switch (ext.state) {
    case 'failed':
      return {
        variant: { ...base, icon: XCircle, tone: 'red' },
        title: `${provider}'s merge queue rejected this PR (${ext.label}) — its tests fail merging with the base.`,
      };
    case 'cancelled':
      return {
        variant: { ...base, icon: AlertTriangle, tone: 'amber' },
        title: `This PR was cancelled in ${provider}'s merge queue (${ext.label}).`,
      };
    case 'merged':
      return {
        variant: { icon: GitMerge, label: 'Merged', tone: 'purple' },
        title: `${provider} merged this PR.`,
      };
    case 'not_ready':
      return {
        variant: { ...base, icon: Clock, tone: 'amber' },
        title: `${provider}'s merge queue is holding this PR until it meets the merge requirements (${ext.label}).`,
      };
    case 'passed':
      return {
        variant: { ...base, icon: CheckCircle2, tone: 'green' },
        title: `${provider}'s merge queue passed this PR (${ext.label}) — merging shortly.`,
      };
    default:
      return {
        variant: { ...base, icon: Loader2, spin: ext.state === 'testing' },
        title: `This PR is in ${provider}'s merge queue (${ext.label}) — it merges when the queue's tests pass.`,
      };
  }
}

/**
 * 5-segment progress bar — passed / failed / in-progress / skipped /
 * remaining. Rendered next to the pill so the user sees the
 * breakdown at a glance without opening the detail panel.
 *
 * Segments are proportional to `checks.total`. Zero-width segments
 * collapse so e.g. an all-passing PR shows a single solid green bar.
 */
function CheckRollupBar({
  checks,
  optionalFailures = false,
}: {
  checks: PRChecks;
  optionalFailures?: boolean;
}) {
  const total = Math.max(checks.total, 1);
  // Skipped checks count as green — a PR with everything passing or
  // skipped should read as a solid green bar, not a partly-grey one.
  const segments: Array<{ width: number; bg: string; title: string }> = [
    {
      width: ((checks.passed + checks.skipped) / total) * 100,
      bg: 'bg-emerald-500',
      title:
        `${checks.passed} passed` +
        (checks.skipped ? ` · ${checks.skipped} skipped` : ''),
    },
    {
      width: (checks.failed / total) * 100,
      // Non-required failures read amber, not red — they don't block.
      bg: optionalFailures ? 'bg-amber-500' : 'bg-red-500',
      title: `${checks.failed} failed${optionalFailures ? ' (not required)' : ''}`,
    },
    {
      width: (checks.inProgress / total) * 100,
      bg: 'bg-blue-500',
      title: `${checks.inProgress} in progress`,
    },
  ];
  return (
    <div
      className="ml-1 flex h-1.5 w-12 overflow-hidden rounded-sm bg-zinc-200 dark:bg-zinc-700"
      aria-label="check status breakdown"
    >
      {segments.map((seg, i) =>
        seg.width > 0 ? (
          <div
            key={i}
            className={seg.bg}
            style={{ width: `${seg.width}%` }}
            title={seg.title}
          />
        ) : null
      )}
    </div>
  );
}

function pickVariant(
  blockingReason: PRBlockingReason,
  checks: PRChecks,
  hideReviewState = false,
  mergeStateStatus?: string,
  reviewDecision?: string | null
): PillVariant {
  // When approval lives in its own column, the review-related verdicts
  // ('changes_requested', 'blocked'-on-review) shouldn't drive this pill
  // — fall back to the conflicts/CI/mergeability picture instead.
  if (
    hideReviewState &&
    (blockingReason === 'changes_requested' || blockingReason === 'blocked')
  ) {
    let ciReason: PRBlockingReason;
    if (checks.failed === 0) {
      ciReason = 'mergeable';
    } else if (blockingReason === 'blocked') {
      // 'blocked' is only returned once we've ruled out a failing *required*
      // check (checks_failed is decided first), so any failure here is
      // non-required — e.g. a PR held on a pending review with one
      // non-required check red. Don't paint it as a blocking CI failure.
      ciReason = 'checks_failed_optional';
    } else {
      // changes_requested masks the CI verdict (it short-circuits before
      // checks are weighed), so we can't tell required from not — fall back
      // to the mergeStateStatus heuristic (UNSTABLE ⇒ non-required).
      ciReason =
        mergeStateStatus?.toUpperCase() === 'UNSTABLE'
          ? 'checks_failed_optional'
          : 'checks_failed';
    }
    return pickVariant(ciReason, checks);
  }
  switch (blockingReason) {
    case 'merge_conflicts':
      return { icon: AlertTriangle, label: 'Conflicts', tone: 'red' };
    case 'changes_requested':
      return { icon: AlertTriangle, label: 'Changes requested', tone: 'amber' };
    case 'checks_failed':
      // 'checks_failed' means at least one check is failing. If the failing
      // count is 0 the verdict is stale relative to the counts — the last
      // failing check re-ran green and a partial summary update refreshed
      // `checks` before `blockingReason` caught up (the row store shallow-merges
      // summaries). A red "0/N failing" pill is self-contradictory; render the
      // mergeable picture (Ready, or a running spinner) so label and tone agree.
      if (checks.failed === 0) {
        return pickVariant('mergeable', checks);
      }
      return {
        icon: XCircle,
        label: `${checks.failed}/${checks.total} failing`,
        tone: 'red',
      };
    case 'checks_failed_optional':
      // Mergeable despite failing checks — none are required. A running spinner
      // still wins if some checks haven't finished; otherwise it reads green
      // (the PR can merge), with the label noting the non-required failures and
      // the rollup bar drawing those reds in amber so the detail isn't lost.
      if (checks.inProgress > 0) {
        return {
          icon: Loader2,
          label: `${checks.inProgress}/${checks.total} running`,
          tone: 'blue',
          spin: true,
          optionalFailures: true,
        };
      }
      return {
        icon: CheckCircle2,
        label: `${checks.failed} non-required`,
        tone: 'green',
        optionalFailures: true,
      };
    case 'mergeable':
      // A 'mergeable' verdict implies zero failing checks — the backend never
      // derives 'mergeable' with failures. So `failed > 0` here is a stale
      // verdict: an incremental {checks}-only update advanced the counts before
      // the verdict caught up (mirror of the checks_failed/0-failing guard
      // above). The backend reconciles this at the source; this is the render
      // backstop so an already-loaded row can't flash a green "Ready" beside
      // failing checks. UNSTABLE ⇒ the failures aren't required.
      if (checks.failed > 0) {
        return pickVariant(
          mergeStateStatus?.toUpperCase() === 'UNSTABLE'
            ? 'checks_failed_optional'
            : 'checks_failed',
          checks,
          hideReviewState,
          mergeStateStatus
        );
      }
      // Special-case in-progress checks even when overall verdict is
      // mergeable — the user wants to see "still running".
      if (checks.inProgress > 0) {
        return {
          icon: Loader2,
          label: `${checks.inProgress}/${checks.total} running`,
          tone: 'blue',
          spin: true,
        };
      }
      return { icon: CheckCircle2, label: 'Ready', tone: 'green' };
    case 'blocked':
      // Held by branch protection. If required checks are still running, that's
      // the immediate gate — GitHub reports mergeStateStatus BLOCKED while the
      // rollup is PENDING even on an already-approved PR — so show the running
      // spinner rather than a misleading "Review". Once checks finish, a genuine
      // review/approval hold falls through to "Review".
      if (checks.inProgress > 0) {
        return {
          icon: Loader2,
          label: `${checks.inProgress}/${checks.total} running`,
          tone: 'blue',
          spin: true,
        };
      }
      // BLOCKED covers every branch-protection hold, not just reviews. On an
      // already-APPROVED PR the hold is something else (required signatures,
      // merge restrictions, GitHub's own merge queue) — "Review" would be a
      // lie there (the 2026-07-17 merge-queue-page report). Say "Protected".
      if (reviewDecision === 'APPROVED') {
        return { icon: ShieldAlert, label: 'Protected', tone: 'amber' };
      }
      return { icon: Eye, label: 'Review', tone: 'amber' };
    case 'unknown':
    default:
      return { icon: HelpCircle, label: '—', tone: 'grey' };
  }
}

function titleFor(
  blockingReason: PRBlockingReason,
  checks: PRChecks,
  reviewDecision?: string | null
): string {
  const checkSummary =
    checks.total === 0
      ? 'no checks'
      : `${checks.passed} passed · ${checks.failed} failed · ${checks.inProgress} running · ${checks.skipped} skipped`;
  const reason =
    blockingReason === 'blocked' && reviewDecision === 'APPROVED'
      ? 'Approved, but held by branch protection (required signatures / merge restrictions)'
      : humanReason(blockingReason);
  return `${reason} · ${checkSummary}`;
}

function humanReason(b: PRBlockingReason): string {
  switch (b) {
    case 'mergeable':
      return 'Ready to merge';
    case 'merge_conflicts':
      return 'Merge conflicts with base';
    case 'changes_requested':
      return 'Reviewer requested changes';
    case 'checks_failed':
      return 'Required CI checks failing';
    case 'checks_failed_optional':
      return 'Mergeable — only non-required checks failing';
    case 'blocked':
      return 'Waiting on required review';
    case 'unknown':
    default:
      return 'Status pending';
  }
}

function toneClass(tone: PillVariant['tone']): string {
  switch (tone) {
    case 'green':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
    case 'red':
      return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400';
    case 'amber':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400';
    case 'blue':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400';
    case 'purple':
      return 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400';
    case 'grey':
    default:
      return 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}
