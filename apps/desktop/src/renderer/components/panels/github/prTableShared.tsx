import React, { useMemo, useState } from 'react';
import {
  ExternalLink,
  GitMerge,
  Loader2,
  Copy,
  Check,
  Bot,
  MessageSquare,
  Users,
  AtSign,
  Eye,
  AlertTriangle,
  ListChecks,
  Settings,
  Wand2,
  Zap,
  Clock,
  Layers,
} from 'lucide-react';
import type { PRRow, PRSummaryShape } from '../../../lib/api';
import { copyRich, prMarkdownLink } from '../../../lib/prClipboard';
import { stackAncestors, stackWithDescendants, type StackMeta } from './stacks';
import {
  type TaskStatus,
  type AnyCloudProviderType,
  type SkillSummary,
  externalQueueProviderLabel,
  externalQueueStateLabel,
  externalQueueStatusFromLabels,
  prHasFixableIssues,
} from '@talyn/shared';
import { SkillPickerModal } from './SkillPickerModal';
import { ProviderIcon } from '../../../lib/providerMeta';
import { PRStatusPill } from '../../widgets/PRStatusPill';
import { PRReviewPill } from '../../widgets/PRReviewPill';
import { cn } from '../../../lib/utils';
import { openExternal, isOpenInBrowserClick } from '../../../lib/openExternal';
import { toast } from '../../../stores/toast';
import { useBillingStore } from '../../../stores/billing';

/**
 * Shared PR table used by all three GitHub pages. The `variant` picks the
 * second column:
 *   - 'mine'   → CI/review status pills (My PRs)
 *   - 'review' → who requested your review (Reviews)
 *   - 'queue'  → queue position + status (Merge Queue)
 * Extracted from the old single GitHubPanel so the pages share one row layout.
 */
export type PRTableVariant = 'mine' | 'review' | 'queue';

/** Pixels of indentation per stack depth level. */
const STACK_INDENT_PX = 16;

interface PRTableProps {
  rows: PRRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onMerge: (row: PRRow) => Promise<void>;
  onSetMergeQueue: (row: PRRow, enabled: boolean) => Promise<void>;
  /** Queue/dequeue a whole stack of dependent PRs. Enabling takes everything
   *  `row` is based on; disabling takes `row` and everything stacked on it. */
  onSetMergeQueueStack?: (row: PRRow, enabled: boolean) => Promise<void>;
  /** Create a cloud task for the row. Resolves true when a task was actually
   *  created (false when nothing's connected / the user dismissed the picker),
   *  so the button only flashes its confirmation on a real start. An explicit
   *  `providerType` is passed from the per-task dropdown. */
  onCreatePostHogTask: (row: PRRow, providerType?: string) => Promise<boolean>;
  /** Run an agent skill on the row as a cloud task (see useGitHubActions.runSkillTask).
   *  Presence enables the per-row skill button + picker modal. */
  onRunSkill?: (
    row: PRRow,
    skill: SkillSummary,
    opts: { providerType?: string; localContent?: string }
  ) => Promise<boolean>;
  /** Default is "Ask every time" with >1 provider connected → the Task button
   *  opens a provider dropdown instead of dispatching to the default. */
  taskAsk?: boolean;
  /** Connected providers offered in the "ask" dropdown. */
  taskProviders?: { type: string; displayName: string }[];
  /** Navigate to Settings → Integrations (the dropdown's "Set default" item). */
  onOpenIntegrations?: () => void;
  /** Live status of each linked task, keyed by task id. */
  taskStatusById: Map<string, TaskStatus>;
  /** Cloud provider of each linked task, keyed by task id (null until dispatched). */
  taskProviderById?: Map<string, AnyCloudProviderType | null>;
  variant: PRTableVariant;
  viewerLogin: string | null;
  /** Stacked-PR placement per row id (My PRs only) — drives indent + accent. */
  stackMeta?: Map<string, StackMeta>;
}

export function PRTable({
  rows,
  selectedId,
  onSelect,
  onOpenTask,
  onMerge,
  onSetMergeQueue,
  onSetMergeQueueStack,
  onCreatePostHogTask,
  onRunSkill,
  taskAsk,
  taskProviders,
  onOpenIntegrations,
  taskStatusById,
  taskProviderById,
  variant,
  viewerLogin,
  stackMeta,
}: PRTableProps) {
  // The queue tab splits its second column into Queue (position/state) + Status
  // (PR readiness pill); every other variant keeps a single second column.
  const secondColLabel = variant === 'review' ? 'Requested' : 'Status';
  // The skill picker is hoisted here so one dialog mounts per table, not one
  // per row — a row just records its id as "open".
  const [skillPickerRowId, setSkillPickerRowId] = useState<string | null>(null);
  const skillPickerRow = skillPickerRowId ? rows.find((r) => r.id === skillPickerRowId) : null;
  // A parked stack member reads differently when the PR BELOW it is stuck, so
  // each row needs its parent's queue status. Resolved once per table, keyed by
  // repo + PR number — subscribing to the store inside every cell would
  // re-render the whole table on any PR change.
  const queueStatusByNumber = useMemo(() => {
    const m = new Map<string, NonNullable<PRRow['mergeQueue']>['status']>();
    for (const r of rows) {
      if (r.mergeQueue) m.set(`${r.repositoryId}|${r.number}`, r.mergeQueue.status);
    }
    return m;
  }, [rows]);
  return (
    <>
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-background text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-4 py-2 text-left font-medium">Title</th>
          {variant === 'queue' && (
            <th className="min-w-[190px] px-2 py-2 text-left font-medium">Queue</th>
          )}
          <th className="px-2 py-2 text-left font-medium">{secondColLabel}</th>
          <th className="px-2 py-2 text-left font-medium">Updated</th>
          {/* Extra right padding: the list scrolls under an 8px overlay-ish
              scrollbar and an auto-layout table can exceed the viewport by
              that much — the gutter keeps the row actions clear of it. */}
          <th className="w-10 py-2 pl-2 pr-4"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <PRTableRow
            key={row.id}
            row={row}
            allRows={rows}
            variant={variant}
            stack={stackMeta?.get(row.id)}
            parentStatus={
              row.mergeQueue?.stackParentNumber != null
                ? queueStatusByNumber.get(
                    `${row.repositoryId}|${row.mergeQueue.stackParentNumber}`
                  )
                : undefined
            }
            viewerLogin={viewerLogin}
            isSelected={row.id === selectedId}
            onSelect={() => onSelect(row.id)}
            onOpenTask={onOpenTask}
            onMerge={onMerge}
            onSetMergeQueue={onSetMergeQueue}
            onSetMergeQueueStack={onSetMergeQueueStack}
            onCreatePostHogTask={onCreatePostHogTask}
            onOpenSkillPicker={onRunSkill ? () => setSkillPickerRowId(row.id) : undefined}
            taskAsk={taskAsk}
            taskProviders={taskProviders}
            onOpenIntegrations={onOpenIntegrations}
            taskStatus={row.taskId ? taskStatusById.get(row.taskId) : undefined}
            taskProvider={row.taskId ? taskProviderById?.get(row.taskId) ?? null : null}
          />
        ))}
      </tbody>
    </table>
    {onRunSkill && skillPickerRow && (
      <SkillPickerModal
        row={skillPickerRow}
        open
        onClose={() => setSkillPickerRowId(null)}
        onLaunch={onRunSkill}
        taskAsk={taskAsk}
        taskProviders={taskProviders}
        onOpenIntegrations={onOpenIntegrations}
      />
    )}
    </>
  );
}

function PRTableRow({
  row,
  allRows,
  variant,
  stack,
  parentStatus,
  viewerLogin,
  isSelected,
  onSelect,
  onOpenTask,
  onMerge,
  onSetMergeQueue,
  onSetMergeQueueStack,
  onCreatePostHogTask,
  onOpenSkillPicker,
  taskAsk,
  taskProviders,
  onOpenIntegrations,
  taskStatus,
  taskProvider,
}: {
  row: PRRow;
  /** Every row on the page — the set this row's stack is derived from. */
  allRows: PRRow[];
  variant: PRTableVariant;
  /** Queue status of the PR below this one in its stack, when it has one. */
  parentStatus?: NonNullable<PRRow['mergeQueue']>['status'];
  /** Stacked-PR placement for this row, when it belongs to a stack. */
  stack?: StackMeta;
  viewerLogin: string | null;
  isSelected: boolean;
  onSelect: () => void;
  onOpenTask: (taskId: string) => void;
  onMerge: (row: PRRow) => Promise<void>;
  onSetMergeQueue: (row: PRRow, enabled: boolean) => Promise<void>;
  /** Queue/dequeue a whole stack of dependent PRs. Enabling takes everything
   *  `row` is based on; disabling takes `row` and everything stacked on it. */
  onSetMergeQueueStack?: (row: PRRow, enabled: boolean) => Promise<void>;
  onCreatePostHogTask: (row: PRRow, providerType?: string) => Promise<boolean>;
  /** Open the table-level skill picker for this row (absent → no skill button). */
  onOpenSkillPicker?: () => void;
  taskAsk?: boolean;
  taskProviders?: { type: string; displayName: string }[];
  onOpenIntegrations?: () => void;
  /** Live status of the row's linked task, if any is loaded. */
  taskStatus?: TaskStatus;
  /** Cloud provider of the row's linked task, if known. */
  taskProvider?: AnyCloudProviderType | null;
}) {
  const summary = row.summary;
  const updatedTooltip = new Date(summary.updatedAt || row.lastPolledAt).toLocaleString();
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [busy, setBusy] = useState<null | 'merge' | 'posthog' | 'queue' | 'stack'>(null);
  // Queuing several PRs at once is worth a second click, and it may publish
  // drafts on the way — same two-step shape as the merge confirm.
  const [confirmStack, setConfirmStack] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Brief confirmation flash after a cloud run is kicked off — we stay on the
  // GitHub page, so this is the only signal it started.
  const [posthogStarted, setPosthogStarted] = useState(false);
  // "Ask every time" → the Task button opens this provider dropdown instead of
  // dispatching to the default.
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  // Free-plan annotation only — the button stays enabled (the server is the
  // authority; a click at the limit gets the 402 → upgrade modal flow).
  const billingStatus = useBillingStore((s) => s.status);
  const atTaskLimit =
    billingStatus?.billingEnabled === true &&
    billingStatus.plan === 'free' &&
    billingStatus.activeTaskLimit != null &&
    billingStatus.activeTasks >= billingStatus.activeTaskLimit;
  // The PRs this one is based on, root-first, including itself. >1 means the
  // row opens a stack worth offering "merge the whole thing" on. Derived from
  // the rows on screen; the server re-resolves the chain on the actual call, so
  // this only decides whether to show a button, never what gets queued.
  const stackBelow = useMemo(
    () =>
      onSetMergeQueueStack && variant !== 'review' && row.state === 'open'
        ? stackAncestors(allRows, row.id)
        : [],
    [onSetMergeQueueStack, variant, row.state, allRows, row.id]
  );
  const stackable = stackBelow.length > 1;
  // Every member of this row's stack, in merge order. From any member, walking
  // down then up covers the whole chain — a root has no ancestors, so the chip
  // below cannot be derived from `stackBelow` alone.
  const stackAll = useMemo(() => {
    if (variant === 'review' || row.state !== 'open') return [];
    const below = stackAncestors(allRows, row.id);
    const above = stackWithDescendants(allRows, row.id).slice(1);
    return [...below, ...above];
  }, [variant, row.state, allRows, row.id]);
  const draftsInStack = stackBelow.filter((r) => r.summary.draft === true).length;
  const unqueuedInStack = stackBelow.filter((r) => !r.mergeQueued).length;
  // A dequeue has to cascade whenever anything is parked on this PR.
  const stackDequeue =
    !!onSetMergeQueueStack && stackWithDescendants(allRows, row.id).length > 1;
  const stackAbove = stackDequeue ? stackWithDescendants(allRows, row.id).length - 1 : 0;
  // Free-plan annotation only, same as atTaskLimit: the button stays enabled and
  // the server stays the authority, but the tooltip can name the exact shortfall
  // because BillingStatus already carries both numbers.
  const stackWontFit =
    billingStatus?.billingEnabled === true &&
    billingStatus.plan === 'free' &&
    billingStatus.mergeQueueLimit != null &&
    billingStatus.queuedPrs + unqueuedInStack > billingStatus.mergeQueueLimit;
  // Mergeable covers the clean case AND "mergeable, but only non-required
  // checks are failing" — GitHub lets you merge both. `blocked` normally means
  // don't offer it, with ONE exception: a branch behind an external merge queue
  // reports BLOCKED for every PR (the ruleset forbids updating the ref), so an
  // approved, green, conflict-free PR reads `blocked` too. Hiding the button
  // there would hide it on every PR in the repo — instead offer it, and let the
  // backend either merge or submit the PR to that queue.
  const canMerge =
    row.state === 'open' &&
    (summary.blockingReason === 'mergeable' ||
      summary.blockingReason === 'checks_failed_optional' ||
      isHeldOnlyByBranchProtection(summary));
  const unresolved = summary.unresolvedReviewThreads ?? 0;
  const requested = variant === 'review' ? reviewRequestLabel(summary, viewerLogin) : null;

  // Stacked-PR visual: left indentation by depth so dependents nest under
  // their base PR. Indentation alone conveys the grouping while a stack is just
  // sitting there — a permanent accent bar on every stack would be noise.
  const stackIndent = (stack?.depth ?? 0) * STACK_INDENT_PX;
  // The exception: once EVERY member is queued, the stack is one unit that is
  // actively draining, and that is worth seeing at a glance.
  const stackDraining = stackAll.length > 1 && stackAll.every((r) => r.mergeQueued);

  // A linked task is "active" while it's queued or running — i.e. not yet
  // fully done. Drives the spinner/label and suppresses the start-task
  // buttons so you can't double-launch.
  const taskRunning =
    taskStatus === 'pending' || taskStatus === 'queued' || taskStatus === 'in_progress';
  // A task is failed/cancelled — distinct from a clean completion so the
  // badge can flag it (and a follow-up run still makes sense).
  const taskFailed = taskStatus === 'failed' || taskStatus === 'cancelled';
  // The badge only shows while there's something actionable: a run in
  // flight or a failure to look at. A cleanly completed task (or one not
  // loaded in the store, which in practice means it's long done) renders
  // nothing — the result is visible on the PR itself.

  // A follow-up run only makes sense on an open PR with something to fix, and
  // not while one is already working it (a completed/failed task can be re-run).
  // Failing NON-required checks count here (the manual button, unlike the
  // auto-watcher, lets the user choose to spend a run on them — they block
  // Talyn's own App-token merge even though a human could merge past them).
  const canFollowUp =
    row.state === 'open' && prHasFixableIssues(summary) && !taskRunning;

  async function copyMarkdownLink(e: React.MouseEvent) {
    e.stopPropagation();
    const { markdown, html } = prMarkdownLink(summary.title, summary.url);
    try {
      await copyRich(html, markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

  async function runMerge(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy('merge');
    setRowError(null);
    try {
      await onMerge(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Merge failed';
      setRowError(message);
      // Surface *why* it failed — GitHub's message (e.g. "Pull Request is
      // not mergeable", "At least 1 approving review is required") is the
      // useful part. Previously this only lived in a hover tooltip.
      toast.error(
        `Couldn't merge ${row.owner}/${row.repo}#${row.number}`,
        friendlyMergeError(message)
      );
      setConfirmMerge(false);
    } finally {
      setBusy(null);
    }
  }

  async function runStackQueue(e: React.MouseEvent) {
    e.stopPropagation();
    setConfirmStack(false);
    setBusy('stack');
    setRowError(null);
    try {
      await onSetMergeQueueStack!(row, true);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not queue the stack');
    } finally {
      setBusy(null);
    }
  }

  async function runToggleQueue(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy('queue');
    setRowError(null);
    try {
      // Dequeuing one member of a live stack would strand every PR above it in
      // `awaiting_stack` forever, so route that through the stack endpoint,
      // which takes this PR and its dependents together. Queuing stays
      // single-PR: "add just this one" is a real thing to want.
      if (row.mergeQueued && stackDequeue) await onSetMergeQueueStack!(row, false);
      else await onSetMergeQueue(row, !row.mergeQueued);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not update merge queue');
    } finally {
      setBusy(null);
    }
  }

  // Dispatch the task. Only flash the confirmation tick when a task was actually
  // created — `onCreatePostHogTask` resolves false if nothing's connected or the
  // user backed out, so closing the picker no longer leaves a stuck tick.
  async function startTask(providerType?: string) {
    setBusy('posthog');
    setRowError(null);
    try {
      const created = await onCreatePostHogTask(row, providerType);
      if (created) {
        setPosthogStarted(true);
        setTimeout(() => setPosthogStarted(false), 2000);
      }
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not start cloud task');
    } finally {
      setBusy(null);
    }
  }

  // Left-click opens the menu only in "Ask every time" mode; right-click
  // opens it whenever there's any provider to pick — the escape hatch for
  // running a one-off task on a non-default agent.
  const taskMenuAvailable = (taskProviders?.length ?? 0) > 0;
  const taskMenuEnabled = Boolean(taskAsk && taskMenuAvailable);

  function runCreatePostHogTask(e: React.MouseEvent) {
    e.stopPropagation();
    // "Ask every time" with a real choice → open the provider dropdown rather
    // than dispatching. Otherwise dispatch to the resolved default immediately.
    if (taskMenuEnabled) {
      setTaskMenuOpen((open) => !open);
      return;
    }
    void startTask();
  }

  function openTaskMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (taskMenuAvailable && canFollowUp && busy === null) {
      setTaskMenuOpen((open) => !open);
    }
  }
  return (
    <tr
      className={cn(
        'group cursor-pointer border-b transition-colors hover:bg-muted/40 focus:bg-muted/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isSelected && 'bg-muted/40'
      )}
      tabIndex={0}
      onMouseDown={(e) => {
        // Stop the OS autoscroll cursor from kicking in on middle-click; the
        // open-in-browser action happens on the corresponding onAuxClick.
        if (e.button === 1) e.preventDefault();
      }}
      onClick={(e) => {
        // cmd/ctrl-click opens the PR in the browser instead of selecting it.
        if (isOpenInBrowserClick(e)) {
          e.preventDefault();
          void openExternal(summary.url);
          return;
        }
        onSelect();
      }}
      onAuxClick={(e) => {
        // Middle/scroll-click also opens the PR in the browser.
        if (e.button === 1) {
          e.preventDefault();
          void openExternal(summary.url);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* w-full + max-w-0: the title column takes all leftover width but is
          excluded from the table's min-content sizing, so a long title can't
          widen the table past the viewport (pushing the other columns out) —
          it truncates to one line instead. Without max-w-0 an auto-layout
          table refuses to shrink below the full text width and `truncate`
          never engages. */}
      <td className="w-full max-w-0 px-4 py-2">
        <div
          className={cn(
            'flex min-w-0 flex-col gap-0.5',
            stackDraining && 'border-l-2 border-indigo-500/60 pl-2'
          )}
          style={stackIndent ? { marginLeft: stackIndent } : undefined}
        >
          <span className="flex items-center gap-1.5 truncate font-medium">
            <span className="truncate" title={summary.title || undefined}>
              {summary.title || '(no title)'}
            </span>
          </span>
          {/* Width priority, highest first: badges and #number never shrink,
              owner/repo truncates next, author/opened collapses first. */}
          <span className="grid grid-cols-[auto_minmax(0,max-content)_auto_minmax(0,1fr)] items-center overflow-hidden text-xs text-muted-foreground">
            <span className="mr-2 flex items-center gap-2 whitespace-nowrap empty:mr-0">
              {summary.draft && (
                <span className="rounded bg-zinc-200 px-1 py-0.5 text-[10px] uppercase text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300">
                  Draft
                </span>
              )}
              {row.reviewRequested && (
                <span
                  className="rounded bg-purple-200 px-1 py-0.5 text-[10px] uppercase text-purple-800 dark:bg-purple-900 dark:text-purple-200"
                  title="You're a requested reviewer on this PR"
                >
                  Review
                </span>
              )}
              {/* Linked-task indicator — "Working" (spinner) while running,
                  "Failed" if it errored/was cancelled. Hidden once the task
                  completes cleanly. Deep-links to the run. */}
              {row.taskId && (taskRunning || taskFailed) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTask(row.taskId!);
                  }}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] uppercase',
                    taskFailed
                      ? 'bg-red-200 text-red-800 hover:bg-red-300 dark:bg-red-900 dark:text-red-200 dark:hover:bg-red-800'
                      : 'bg-blue-200 text-blue-800 hover:bg-blue-300 dark:bg-blue-900 dark:text-blue-200 dark:hover:bg-blue-800'
                  )}
                  title={
                    taskRunning
                      ? 'A task is working this PR — click to open it'
                      : 'The linked task failed — click to open it'
                  }
                >
                  <ProviderIcon provider={taskProvider} className="h-2.5 w-2.5" />
                  {taskRunning ? (
                    <>
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      Working
                    </>
                  ) : (
                    'Failed'
                  )}
                </button>
              )}
              {/* Auto-keep-mergeable watcher indicator. "Watching" while armed,
                  "Paused" once it's given up after 3 attempts. */}
              {row.autoKeepMergeable &&
                (row.autoMergeState?.paused ? (
                  <span
                    className="inline-flex items-center gap-1 rounded bg-amber-200 px-1 py-0.5 text-[10px] uppercase text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                    title="Auto-keep-mergeable paused after 3 attempts — needs attention"
                  >
                    <AlertTriangle className="h-2.5 w-2.5" />
                    Paused
                  </span>
                ) : (
                  <span
                    className="inline-flex items-center gap-1 rounded bg-emerald-200 px-1 py-0.5 text-[10px] uppercase text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                    title="Auto-keep-mergeable is on — keeping this PR in a mergeable state"
                  >
                    <Eye className="h-2.5 w-2.5" />
                    Watching
                  </span>
                ))}
              {/* Stack indicator on the bottom PR of a chain — the members merge one
                  at a time from here up. No `ml-*`: the badge group's `gap-2`
                  spaces every chip. */}
              {variant !== 'queue' && stack?.depth === 0 && stackAll.length > 1 && (
                <span
                  className="inline-flex items-center gap-1 rounded bg-indigo-200 px-1 py-0.5 text-[10px] uppercase text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
                  title={`This PR is the bottom of a stack of ${stackAll.length}. They merge one at a time from here up, each waiting a full CI cycle after the one below it lands.`}
                >
                  <Layers className="h-2.5 w-2.5" />
                  Stack of {stackAll.length}
                </span>
              )}
              {/* Merge-queue indicator. The membership badge ("Queued #N") stays
                  visible the whole time the PR is in the queue; an activity badge
                  (Merging / Blocked) sits alongside it. We deliberately DON'T show
                  a "Fixing" badge — when a cloud run is clearing blockers the
                  linked-task "Working" badge above already says so, so a separate
                  Fixing chip would be redundant. On the Merge Queue page the
                  Queue column carries this, so we skip the title badge there. */}
              {variant !== 'queue' &&
                row.mergeQueued &&
                (() => {
                  const qs = row.mergeQueueState?.status ?? 'waiting';
                  const pos = row.mergeQueueState?.position ?? 0;
                  const reason = row.mergeQueueState?.reason;
                  return (
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="inline-flex items-center gap-1 rounded bg-indigo-200 px-1 py-0.5 text-[10px] uppercase text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
                        title="In the merge queue — merges automatically when it's its turn and clean"
                      >
                        <GitMerge className="h-2.5 w-2.5" />
                        {pos > 0 ? `Queued #${pos}` : 'Queued'}
                      </span>
                      {qs === 'merging' && (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-blue-200 px-1 py-0.5 text-[10px] uppercase text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                          title="Merging this PR now"
                        >
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          Merging
                        </span>
                      )}
                      {qs === 'blocked' && (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-amber-200 px-1 py-0.5 text-[10px] uppercase text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                          title={
                            reason
                              ? `Merge queue gave up after 3 attempts — ${reason}. Needs manual intervention.`
                              : 'Merge queue gave up after 3 attempts — needs manual intervention'
                          }
                        >
                          <AlertTriangle className="h-2.5 w-2.5" />
                          Blocked
                        </span>
                      )}
                    </span>
                  );
                })()}
            </span>
            <span className="truncate">
              {row.owner}/{row.repo}
            </span>
            <span>#{row.number}</span>
            <span className="truncate pl-1">
              · @{summary.author || 'unknown'}
              {(summary.createdAt || row.createdAt) && (
                <span title={`Opened ${new Date(summary.createdAt || row.createdAt).toLocaleString()}`}>
                  {' · opened '}
                  {formatRelative(summary.createdAt || row.createdAt)}
                </span>
              )}
            </span>
          </span>
        </div>
      </td>
      {variant === 'review' ? (
        <td className="px-2 py-2 text-xs">
          {requested ? (
            <span
              className="inline-flex items-center gap-1 text-muted-foreground"
              title={
                requested.direct
                  ? 'You were asked to review directly'
                  : `Requested via team ${requested.label.slice(1)}${
                      requested.extra > 0 ? ` (+${requested.extra} more)` : ''
                    }`
              }
            >
              {requested.direct ? (
                <AtSign className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Users className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{requested.label}</span>
              {requested.extra > 0 && <span className="opacity-70">+{requested.extra}</span>}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
      ) : variant === 'queue' ? (
        <>
          <QueueCell row={row} parentStatus={parentStatus} />
          <td className="px-2 py-2">
            <PRStatusPill
              blockingReason={summary.blockingReason}
              checks={summary.checks}
              mergeStateStatus={summary.mergeStateStatus}
              state={row.state}
              // The queue page has no separate review column, so this pill
              // carries the review verdict too — the decision disambiguates
              // 'blocked' (approved-but-protected must not read "Review").
              reviewDecision={summary.effectiveReviewDecision ?? summary.reviewDecision}
              labels={summary.labels}
              externalQueueState={row.mergeQueue?.external?.state}
            />
          </td>
        </>
      ) : (
        <td className="px-2 py-2">
          <div className="flex items-center gap-1.5">
            <PRReviewPill
              reviewDecision={summary.effectiveReviewDecision ?? summary.reviewDecision}
              state={row.state}
              minimal
            />
            <PRStatusPill
              blockingReason={summary.blockingReason}
              checks={summary.checks}
              mergeStateStatus={summary.mergeStateStatus}
              state={row.state}
              hideReviewState
              labels={summary.labels}
              externalQueueState={row.mergeQueue?.external?.state}
            />
            {row.state === 'open' && unresolved > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
                title={`${unresolved} unresolved review ${unresolved === 1 ? 'comment' : 'comments'}`}
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                {unresolved}
              </span>
            )}
          </div>
        </td>
      )}
      <td className="px-2 py-2 text-xs text-muted-foreground" title={updatedTooltip}>
        {formatRelative(summary.updatedAt || row.lastPolledAt)}
      </td>
      <td className="py-2 pl-2 pr-4" title={rowError ?? undefined}>
        <div className="flex items-center justify-end gap-1">
          {/* Row actions reveal on hover/focus to keep the table calm.
              Merge, merge-queue, and "get mergeable" are owner actions, so
              they're hidden on the Reviews page (you're reviewing someone
              else's PR there). */}
          {stackable &&
            (confirmStack ? (
              <button
                type="button"
                data-attr="pr-row-merge-stack-confirm"
                onClick={runStackQueue}
                disabled={busy !== null}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase text-indigo-700 hover:bg-indigo-500/10 dark:text-indigo-400"
                title={`Queue all ${stackBelow.length} PRs in this stack`}
              >
                {busy === 'stack' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  `Queue ${stackBelow.length}`
                )}
              </button>
            ) : (
              <button
                type="button"
                data-attr="pr-row-merge-stack-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmStack(true);
                }}
                disabled={busy !== null}
                className="rounded p-1 text-muted-foreground opacity-0 transition-colors hover:bg-indigo-500/10 hover:text-indigo-600 focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-indigo-400"
                title={
                  stackWontFit
                    ? `This stack needs ${unqueuedInStack} merge-queue slots; your free plan allows ${billingStatus?.mergeQueueLimit} and ${billingStatus?.queuedPrs} are in use`
                    : `Merge the whole stack — queues all ${stackBelow.length} PRs and merges them into ${summary.baseBranch || 'the base'} one at a time, retargeting each as its parent lands` +
                      (draftsInStack > 0
                        ? `. Marks ${draftsInStack} draft ${draftsInStack === 1 ? 'PR' : 'PRs'} ready for review.`
                        : '')
                }
              >
                <Layers className="h-3.5 w-3.5" />
              </button>
            ))}
          {variant !== 'review' && row.state === 'open' && (
            <button
              type="button"
              data-attr="pr-row-merge-queue-toggle"
              onClick={runToggleQueue}
              disabled={busy !== null}
              className={cn(
                'rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                row.mergeQueued
                  ? 'text-indigo-600 hover:bg-indigo-500/10 dark:text-indigo-400'
                  : 'text-muted-foreground opacity-0 hover:bg-indigo-500/10 hover:text-indigo-600 focus:opacity-100 group-hover:opacity-100 dark:hover:text-indigo-400'
              )}
              title={
                row.mergeQueued
                  ? stackAbove > 0
                    ? `Remove this PR and the ${stackAbove} stacked on it from the merge queue`
                    : 'Remove from the merge queue'
                  : 'Add to the merge queue — merges automatically when clean, auto-fixing conflicts'
              }
            >
              {busy === 'queue' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListChecks className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {variant !== 'review' &&
            canMerge &&
            (confirmMerge ? (
              <button
                type="button"
                data-attr="pr-row-merge-confirm"
                onClick={runMerge}
                disabled={busy !== null}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400"
                title="Confirm squash-merge"
              >
                {busy === 'merge' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  'Confirm'
                )}
              </button>
            ) : (
              <button
                type="button"
                data-attr="pr-row-merge"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmMerge(true);
                }}
                className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-emerald-500/10 hover:text-emerald-600 focus:opacity-100 group-hover:opacity-100"
                title="Merge this PR — or, when an external merge queue owns the base branch, submit it to that queue"
              >
                <GitMerge className="h-3.5 w-3.5" />
              </button>
            ))}
          {variant !== 'review' && row.state === 'open' && (
            <div className="relative inline-flex">
              <button
                type="button"
                data-attr="pr-row-fix-with-posthog"
                onClick={runCreatePostHogTask}
                onContextMenu={openTaskMenu}
                disabled={!canFollowUp || busy !== null}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-violet-500/10 hover:text-violet-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground dark:hover:text-violet-400"
                title={
                  posthogStarted
                    ? 'Cloud run started — see the Tasks panel'
                    : taskRunning
                    ? 'A task is already working this PR — open it from the Working badge'
                    : !canFollowUp
                    ? 'Nothing to fix — no conflicts, failing checks, or unresolved review comments'
                    : atTaskLimit
                    ? `Free plan limit reached (${billingStatus.activeTasks}/${billingStatus.activeTaskLimit} active tasks) — upgrade for unlimited`
                    : taskMenuEnabled
                    ? 'Get this PR mergeable — choose a cloud provider'
                    : `Get this PR mergeable with a cloud agent (resolve comments, fix CI, resolve conflicts)${
                        taskMenuAvailable ? ' — right-click to pick a different agent' : ''
                      }`
                }
              >
                {busy === 'posthog' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : posthogStarted ? (
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <Bot className="h-3.5 w-3.5" />
                )}
              </button>

              {taskMenuOpen && taskMenuAvailable && (
                <>
                  {/* Click-away layer — closes the menu without selecting. */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTaskMenuOpen(false);
                    }}
                  />
                  <div
                    className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border bg-background p-1 shadow-md"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="px-2 py-1 text-xs text-muted-foreground">Run task with…</div>
                    {taskProviders?.map((p) => (
                      <button
                        key={p.type}
                        type="button"
                        onClick={() => {
                          setTaskMenuOpen(false);
                          void startTask(p.type);
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                        {p.displayName}
                      </button>
                    ))}
                    <div className="my-1 border-t" />
                    <button
                      type="button"
                      onClick={() => {
                        setTaskMenuOpen(false);
                        onOpenIntegrations?.();
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
                    >
                      <Settings className="h-3.5 w-3.5" />
                      Set default…
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {/* Run a skill on this PR. Unlike the fix button this shows on the
              Reviews page too — running a review skill on a PR you were asked
              to review is the headline use case — and doesn't require the PR
              to "need" anything. */}
          {onOpenSkillPicker && row.state === 'open' && (
            <button
              type="button"
              data-attr="pr-row-run-skill"
              onClick={(e) => {
                e.stopPropagation();
                onOpenSkillPicker();
              }}
              disabled={taskRunning || busy !== null}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-violet-500/10 hover:text-violet-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground dark:hover:text-violet-400"
              title={
                taskRunning
                  ? 'A task is already working this PR — open it from the Working badge'
                  : 'Run a skill on this PR with a cloud agent'
              }
            >
              <Wand2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            data-attr="pr-row-copy-link"
            onClick={copyMarkdownLink}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title={copied ? 'Copied!' : 'Copy as Markdown link'}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <a
            href={summary.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title="Open on GitHub"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </td>
    </tr>
  );
}

/**
 * The Merge Queue page's second column: position + status + reason. Renders
 * the v2 payload's full vocabulary (auto-merge armed, awaiting CI/review,
 * per-head budgets) and falls back to the legacy 4-status shape for rows the
 * v2 echo hasn't reached yet.
 */
function QueueCell({
  row,
  parentStatus,
}: {
  row: PRRow;
  parentStatus?: NonNullable<PRRow['mergeQueue']>['status'];
}) {
  const v2 = row.mergeQueue;
  const legacy = row.mergeQueueState;
  const pos = v2?.position ?? legacy?.position ?? 0;
  const chip = (() => {
    if (v2) {
      const budgets = v2.budgets;
      switch (v2.status) {
        case 'automerge_armed':
          return (
            <span
              className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"
              title={
                v2.autoMerge?.armedBy === 'user'
                  ? 'GitHub auto-merge is armed (by you) — GitHub merges the instant checks pass'
                  : 'GitHub auto-merge armed — GitHub merges the instant checks pass'
              }
            >
              <Zap className="h-3 w-3" />
              Auto-merge armed
            </span>
          );
        case 'awaiting_external': {
          // Submitted to the external queue. Its progress comes from the
          // backend, which reads the provider's own PR comment (`external.
          // state`); the PR's labels are the fallback channel, since trunk
          // applies them in some repo configurations and not others.
          const state = v2.external?.state;
          const ext = externalQueueStatusFromLabels(row.summary.labels);
          const provider = externalQueueProviderLabel(ext?.provider ?? 'trunk');
          const where = state ?? ext?.state ?? null;
          const [submits, maxSubmits] = v2.external?.submits ?? [0, 3];
          const via =
            v2.external?.via === 'label'
              ? 'by applying its submit label'
              : v2.external?.via === 'comment'
                ? 'by posting its submit command'
                : v2.external?.via === 'auto_merge'
                  ? 'by arming GitHub auto-merge'
                  : null;
          return (
            <span
              className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"
              title={
                `In ${provider}'s merge queue` +
                (where
                  ? ` — ${externalQueueStateLabel(where).toLowerCase()}`
                  : ' — waiting for it to pick the PR up') +
                (via
                  ? `. Talyn submitted it ${via} (submission ${submits}/${maxSubmits} on this ` +
                    'commit) and takes it back to fix if the queue rejects it.'
                  : '.')
              }
            >
              <GitMerge className="h-3 w-3" />
              {where ? `Queue: ${externalQueueStateLabel(where).toLowerCase()}` : 'Submitted to queue'}
            </span>
          );
        }
        case 'awaiting_ci':
          return (
            <span
              className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-400"
              title="Waiting for checks to finish — merges (or arms auto-merge) when they pass"
            >
              <Clock className="h-3 w-3" />
              Waiting for CI
            </span>
          );
        case 'awaiting_review': {
          // A PR that was RETARGETED off a stack and is now waiting on review is
          // very often waiting because of the retarget: bringing the new base in
          // pushes a merge commit, and a repo with "dismiss stale approvals on
          // new commits" drops the approval it already had. Nothing can fix that
          // but a human, and without saying so this reads as though the PR was
          // never approved at all.
          const restacked = v2.stackParentNumber != null;
          return (
            <span
              className="inline-flex items-center gap-1 text-muted-foreground"
              title={
                restacked
                  ? `A required review is the only thing missing — merges once approved. This PR was retargeted after #${v2.stackParentNumber} merged, so if the repo dismisses approvals on new commits, an earlier approval was dropped and needs re-requesting.`
                  : 'A required review is the only thing missing — merges once approved'
              }
            >
              <Eye className="h-3 w-3" />
              {restacked ? 'Waiting for review (re-approve)' : 'Waiting for review'}
            </span>
          );
        }
        case 'awaiting_stack': {
          // Parked behind the PR this one is stacked on. Ordinarily a quiet
          // wait that needs nothing from anyone — but if the PR below it is
          // stuck, this one is stuck too, and rendering that as a passive
          // "waiting" is how a whole stack sits dead looking healthy.
          const below = v2.stackParentNumber;
          const stuck = parentStatus === 'blocked' || parentStatus === 'blocked_manual';
          return (
            <span
              className={
                stuck
                  ? 'inline-flex items-center gap-1 text-amber-700 dark:text-amber-400'
                  : 'inline-flex items-center gap-1 text-muted-foreground'
              }
              title={
                stuck
                  ? `The PR below this one in the stack${below ? ` (#${below})` : ''} is blocked, so this one can't proceed either — clear that one first`
                  : `Stacked on${below ? ` #${below}` : ' another PR'} — merges once that lands, and Talyn retargets this PR onto the real base for you`
              }
            >
              <Layers className="h-3 w-3" />
              {stuck
                ? `Blocked below${below ? ` #${below}` : ''}`
                : below
                  ? `Waiting for #${below}`
                  : 'Waiting for its stack'}
            </span>
          );
        }
        case 'fixing': {
          // Budgets count attempts SPENT (a run only burns budget when it
          // ends without fixing the PR), so show the in-progress attempt as
          // spent+1 — "Fixing (1/3)" during the first run, not (0/3).
          // Re-sign runs already count at dispatch; show their budget as-is.
          const resign = v2.fixKind === 'resign';
          const [used, max] = resign
            ? (budgets?.resigns ?? [0, 3])
            : (budgets?.fixRuns ?? [0, 3]);
          const attempt = resign ? Math.max(used, 1) : Math.min(used + 1, max);
          return (
            <span
              className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-400"
              title={`A cloud ${resign ? 're-sign' : 'fix'} run is working this PR — attempt ${attempt} of ${max} on the current head`}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              {resign ? 'Re-signing' : 'Fixing'} ({attempt}/{max})
            </span>
          );
        }
        case 'merging':
          return (
            <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              Merging
            </span>
          );
        case 'blocked':
          return (
            <span
              className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"
              title={
                (v2.reason ?? 'Blocked — will retry automatically.') +
                ' Self-heals on a new push; re-queue to retry immediately.'
              }
            >
              <AlertTriangle className="h-3 w-3" />
              Blocked
            </span>
          );
        case 'blocked_manual':
          return (
            <span
              className="inline-flex items-center gap-1 text-red-700 dark:text-red-400"
              title={v2.reason ?? 'GitHub refuses the App merge — merge manually or re-queue.'}
            >
              <AlertTriangle className="h-3 w-3" />
              Needs you
            </span>
          );
        default:
          return <span className="text-muted-foreground">Waiting</span>;
      }
    }
    // Legacy fallback (pre-v2 echo).
    const qs = legacy?.status ?? 'waiting';
    if (qs === 'merging')
      return (
        <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Merging
        </span>
      );
    if (qs === 'blocked')
      return (
        <span
          className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"
          title={legacy?.reason ?? 'Blocked — needs attention'}
        >
          <AlertTriangle className="h-3 w-3" />
          Blocked
        </span>
      );
    if (qs === 'fixing')
      return (
        <span className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Fixing
        </span>
      );
    return <span className="text-muted-foreground">Waiting</span>;
  })();
  return (
    <td className="whitespace-nowrap px-2 py-2 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-foreground">{pos > 0 ? `#${pos}` : '—'}</span>
        {chip}
      </div>
    </td>
  );
}

/**
 * How the viewer was asked to review, for the Review tab's "Requested"
 * column. A direct request wins over a team one. Returns the primary label
 * (your @handle, or the first team's `@org/team`) plus the count of any
 * additional teams, or null when we have no request info (older cached rows).
 */
export function reviewRequestLabel(
  summary: PRSummaryShape,
  viewerLogin: string | null
): { label: string; extra: number; direct: boolean } | null {
  const via = summary.reviewRequestVia;
  if (!via) return null;
  if (via.direct) return { label: `@${viewerLogin ?? 'you'}`, extra: 0, direct: true };
  if (via.teams.length > 0)
    return { label: `@${via.teams[0]}`, extra: via.teams.length - 1, direct: false };
  return null;
}

/**
 * Searchable text for a row's review request, so the search box can filter
 * the Review tab by team name or "direct"/your handle.
 */
export function reviewRequestSearchText(
  summary: PRSummaryShape,
  viewerLogin: string | null
): string {
  const via = summary.reviewRequestVia;
  if (!via) return '';
  const parts: string[] = [];
  if (via.direct) parts.push('direct', 'you', viewerLogin ?? '');
  parts.push(...via.teams);
  return parts.join(' ').toLowerCase();
}

/** A PR has a blocking issue the user should act on. */
export function isNeedsAttention(r: PRRow): boolean {
  return (
    r.summary.blockingReason === 'changes_requested' ||
    r.summary.blockingReason === 'checks_failed' ||
    r.summary.blockingReason === 'merge_conflicts'
  );
}

/**
 * A (non-draft) PR you authored that's still waiting on a review from others —
 * GitHub says a review is required and one hasn't landed yet. Uses the same
 * effective-vs-raw decision the table badge shows.
 */
export function isAwaitingReview(r: PRRow): boolean {
  if (r.summary.draft) return false;
  const decision = r.summary.effectiveReviewDecision ?? r.summary.reviewDecision;
  return decision === 'REVIEW_REQUIRED';
}

/**
 * A (non-draft) PR that's fully ready for the user to merge: GitHub reports
 * it mergeable (only non-required check failures allowed — same verdict as
 * the backend's became-merge-ready notification), no checks still running,
 * and no outstanding review request. `blockingReason` already rules out
 * conflicts, requested changes, failing required checks, and branch-protection
 * blocks; the explicit review check covers repos without protection, where
 * an outstanding request never reaches `blockingReason`.
 */
export function isReadyToMerge(r: PRRow): boolean {
  if (r.summary.draft) return false;
  // Already in an external merge queue → nothing for you to do; it isn't
  // waiting on a merge click. The queue entry's own reading of the provider
  // (off its PR comment) outranks the labels, which many repos never apply.
  const state = r.mergeQueue?.external?.state ?? externalQueueStatusFromLabels(r.summary.labels)?.state;
  if (state && !['failed', 'cancelled', 'not_submitted'].includes(state)) return false;
  const reason = r.summary.blockingReason;
  if (
    reason !== 'mergeable' &&
    reason !== 'checks_failed_optional' &&
    !isHeldOnlyByBranchProtection(r.summary)
  ) {
    return false;
  }
  if (r.summary.checks.inProgress > 0) return false;
  const decision = r.summary.effectiveReviewDecision ?? r.summary.reviewDecision;
  return decision !== 'REVIEW_REQUIRED';
}

/**
 * The PR is otherwise ready and the ONLY thing GitHub reports is a bare
 * `blocked`. That's what a branch behind an external merge queue reports for
 * EVERY PR — its ruleset forbids updating the ref, so approved, green,
 * conflict-free PRs read `blocked` alongside genuinely stuck ones. Without this,
 * such a repo's "Ready to merge" bucket and every row's Merge button would go
 * permanently empty.
 */
export function isHeldOnlyByBranchProtection(s: PRSummaryShape): boolean {
  return (
    s.blockingReason === 'blocked' &&
    s.mergeable === 'MERGEABLE' &&
    (s.checks?.failed ?? 0) === 0 &&
    (s.checks?.inProgress ?? 0) === 0 &&
    !['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(
      s.effectiveReviewDecision ?? s.reviewDecision ?? ''
    )
  );
}

/**
 * Make a GitHub merge error readable in a toast. Strips the noisy
 * "GitHub API error 405 Method Not Allowed:" prefix the backend prepends,
 * and adds a nudge for the most common (and most cryptic) case.
 */
function friendlyMergeError(message: string): string {
  const cleaned = message.replace(/^GitHub API error \d+[^:]*:\s*/i, '').trim() || message;
  if (/not mergeable/i.test(cleaned)) {
    return `${cleaned}. The PR may have new conflicts, failing required checks, or pending required reviews — refresh and check its status.`;
  }
  return cleaned;
}

/** Small relative-time helper; no dependency on date-fns. */
export function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
