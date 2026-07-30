import React, { useEffect, useRef, useState, Suspense, lazy } from 'react';
import {
  ListTodo,
  Play,
  Clock,
  CheckCircle,
  AlertCircle,
  Loader2,
  RotateCw,
  MessageSquare,
  GitBranch,
  Sparkles,
  Eye,
  Hand,
  Trash2,
  ExternalLink,
  GitPullRequest,
  Wand2,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { useTaskActions, loadMoreTasks } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { TaskTerminal } from './TaskTerminal';
import { PRStatusPill } from '../widgets/PRStatusPill';
import type { PRSummaryShape, PRState } from '../../lib/api';
import {
  getCachedPRStatus,
  prime,
  subscribePRStatus,
} from '../../lib/prSummaryCache';
import { isAgentTask, readCloudTaskMeta } from '@talyn/shared';
import type { Task, TaskStatus, TaskType, TaskPriority } from '@talyn/shared';
import { ProviderIcon, providerLabel, taskCloudProvider } from '../../lib/providerMeta';

/**
 * Lazy: it only mounts when a PR row is clicked, and it is the sole importer
 * of @pierre/diffs — which drags in the syntax grammars (the emacs-lisp / cpp
 * / wasm chunks in the build output). Keeping it out of the entry chunk keeps
 * all of that off the first load.
 */
const PRDetailSheet = lazy(() =>
  import('../widgets/PRDetailSheet').then((m) => ({ default: m.PRDetailSheet }))
);


const taskTypeConfig: Record<TaskType, { label: string; icon: React.ElementType }> = {
  code_writing: { label: 'Code', icon: Sparkles },
  pr_response: { label: 'PR Response', icon: MessageSquare },
  pr_review: { label: 'PR Review', icon: Eye },
  manual: { label: 'Manual', icon: Hand },
};

const statusConfig: Record<
  TaskStatus,
  { icon: React.ElementType; label: string; color: string }
> = {
  pending: { icon: Clock, label: 'Pending', color: 'text-slate-400' },
  queued: { icon: ListTodo, label: 'Queued', color: 'text-blue-400' },
  in_progress: { icon: Loader2, label: 'In Progress', color: 'text-purple-400' },
  completed: { icon: CheckCircle, label: 'Completed', color: 'text-green-400' },
  failed: { icon: AlertCircle, label: 'Failed', color: 'text-red-400' },
  cancelled: { icon: AlertCircle, label: 'Cancelled', color: 'text-slate-400' },
};

const priorityConfig: Record<
  TaskPriority,
  { label: string; color: string; badge: string }
> = {
  low: { label: 'Low', color: 'text-slate-400', badge: 'secondary' },
  medium: { label: 'Medium', color: 'text-blue-400', badge: 'outline' },
  high: { label: 'High', color: 'text-yellow-400', badge: 'warning' },
  urgent: { label: 'Urgent', color: 'text-red-400', badge: 'destructive' },
};

/**
 * Human-readable relative time — "just now", "5m ago", "2h ago",
 * "3d ago", "4w ago" — with a flip to a month/day stamp past 60 days
 * so the display stops creeping into three-digit weeks. Paired with a
 * full-timestamp tooltip at the call site for when the user wants
 * precision.
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const deltaSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (deltaSec < 30) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.round(deltaHr / 24);
  if (deltaDay < 7) return `${deltaDay}d ago`;
  if (deltaDay < 60) return `${Math.round(deltaDay / 7)}w ago`;
  const d = new Date(iso);
  if (d.getFullYear() === new Date().getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString();
}

export function QueuePanel() {
  const { tasks, selectedTaskId, selectTask } = useWorkspaceStore();
  const tasksHasMore = useWorkspaceStore((s) => s.tasksHasMore);
  const tasksLoadingMore = useWorkspaceStore((s) => s.tasksLoadingMore);

  const queuedTasks = tasks.filter((t) =>
    ['pending', 'queued'].includes(t.status)
  );
  // In-flight: the cloud run is live.
  const inProgressTasks = tasks.filter((t) => t.status === 'in_progress');
  // Finished history, newest first — matches the server's cursor order so a
  // lazily-loaded older page slots in below without reshuffling.
  const completedTasks = tasks
    .filter((t) => ['completed', 'failed', 'cancelled'].includes(t.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Infinite scroll: observe a sentinel at the end of the history list within
  // the scroll viewport, and pull the next page as it comes into view. Only
  // mounted while more history exists; loadMoreTasks itself guards against
  // concurrent/exhausted calls, so a burst of intersection callbacks is safe.
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMoreTasks();
      },
      { root, rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [tasksHasMore, completedTasks.length]);

  return (
    <div className="flex h-full">
      {/* Task List */}
      <div className="w-80 border-r flex flex-col">
        <div className="app-region-drag flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Task Queue</h2>
        </div>

        <ScrollArea ref={scrollRef} className="flex-1">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center p-4">
              <ListTodo className="w-10 h-10 text-muted-foreground/50 mb-3" />
              <h3 className="font-medium mb-1 text-sm">No tasks</h3>
              <p className="text-xs text-muted-foreground">
                Start a task from a pull request in the GitHub panel.
              </p>
            </div>
          ) : (
            <div className="p-2">
              {inProgressTasks.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1 flex items-center gap-1.5">
                    <span>RUNNING</span>
                    <span className="tabular-nums text-muted-foreground/70">
                      {inProgressTasks.length}
                    </span>
                  </h3>
                  <div className="space-y-1">
                    {inProgressTasks.map((task) => (
                      <TaskListItem
                        key={task.id}
                        task={task}
                        isSelected={selectedTaskId === task.id}
                        onSelect={() => selectTask(task.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {queuedTasks.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1 flex items-center gap-1.5">
                    <span>QUEUED</span>
                    <span className="tabular-nums text-muted-foreground/70">
                      {queuedTasks.length}
                    </span>
                  </h3>
                  <div className="space-y-1">
                    {queuedTasks.map((task) => (
                      <TaskListItem
                        key={task.id}
                        task={task}
                        isSelected={selectedTaskId === task.id}
                        onSelect={() => selectTask(task.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {completedTasks.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1 flex items-center gap-1.5">
                    <span>COMPLETED</span>
                    <span className="tabular-nums text-muted-foreground/70">
                      {completedTasks.length}
                    </span>
                  </h3>
                  <div className="space-y-1">
                    {completedTasks.map((task) => (
                      <TaskListItem
                        key={task.id}
                        task={task}
                        isSelected={selectedTaskId === task.id}
                        onSelect={() => selectTask(task.id)}
                      />
                    ))}
                  </div>
                  {/* Infinite-scroll sentinel — mounted only while more history
                      remains; sliding it into view pulls the next page. */}
                  {(tasksHasMore || tasksLoadingMore) && (
                    <div
                      ref={sentinelRef}
                      className="flex items-center justify-center py-3 text-muted-foreground"
                    >
                      {tasksLoadingMore && <Loader2 className="w-4 h-4 animate-spin" />}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Task Detail */}
      <div className="flex-1 flex flex-col">
        {selectedTaskId ? (
          <TaskDetail taskId={selectedTaskId} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <ListTodo className="w-16 h-16 text-muted-foreground/30 mb-4" />
            <h3 className="font-medium mb-2">No task selected</h3>
            <p className="text-sm text-muted-foreground">
              Select a task to view its details. Start new tasks from a pull
              request in the GitHub panel.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Running tasks always render as a live cloud run — a spinning
// "Working" indicator (the cloud provider exposes no finer-grained
// agent status).
const runningStatus = {
  icon: Loader2,
  label: 'Working',
  color: 'text-blue-400',
} as const;

interface TaskListItemProps {
  task: Task;
  isSelected: boolean;
  onSelect: () => void;
}

function TaskListItem({ task, isSelected, onSelect }: TaskListItemProps) {
  const environments = useWorkspaceStore((s) => s.environments);
  const provider = taskCloudProvider(task, environments);
  const isRunning = task.status === 'in_progress';

  const StatusIcon = isRunning ? runningStatus.icon : statusConfig[task.status].icon;
  const statusColor = isRunning ? runningStatus.color : statusConfig[task.status].color;

  return (
    <Card
      className={cn(
        'p-3 cursor-pointer transition-colors border-transparent bg-transparent shadow-none border-l-4 border-l-transparent',
        isSelected ? 'bg-accent' : 'hover:bg-accent/50'
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 bg-secondary',
            statusColor
          )}
        >
          <StatusIcon className={cn('w-4 h-4', isRunning && 'animate-spin')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{task.title}</span>
            <ProviderIcon provider={provider} className="h-3 w-3" />
          </div>
          <div className="flex items-center gap-2 mt-1">
            {task.status === 'completed' && task.completedAt ? (
              <span
                className="text-xs text-muted-foreground tabular-nums"
                title={new Date(task.completedAt).toLocaleString()}
              >
                {formatRelativeTime(task.completedAt)}
              </span>
            ) : (
              <span
                className="text-xs text-muted-foreground tabular-nums"
                title={new Date(task.createdAt).toLocaleString()}
              >
                {formatRelativeTime(task.createdAt)}
              </span>
            )}
            {isRunning && (
              <Badge variant="secondary" className="text-xs">
                {runningStatus.label}
              </Badge>
            )}
            {!isRunning && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                {(() => {
                  const TypeIcon = taskTypeConfig[task.type]?.icon ?? Hand;
                  return <TypeIcon className="w-3 h-3" />;
                })()}
                {taskTypeConfig[task.type]?.label ?? task.type}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

interface TaskDetailProps {
  taskId: string;
}

function TaskDetail({ taskId }: TaskDetailProps) {
  const { tasks, environments, repositories } = useWorkspaceStore();
  const {
    cancelTask,
    retryTask,
    startTask,
    deleteTask,
  } = useTaskActions();
  // Track which specific action is in flight, not a shared boolean —
  // otherwise clicking Retry puts the Delete button into a spinner too
  // (and vice versa). We still disable every action while ANY one is in
  // flight so the user can't double-click around a slow request.
  const [activeAction, setActiveAction] = useState<
    'start' | 'cancel' | 'retry' | 'delete' | null
  >(null);
  const actionInFlight = activeAction !== null;
  const isLoadingFor = (action: typeof activeAction): boolean => activeAction === action;
  const [actionError, setActionError] = useState<string | null>(null);
  const task = tasks.find((t) => t.id === taskId);
  const repo = task?.repositoryId ? repositories.find(r => r.id === task.repositoryId) : null;
  const cloudMeta = task ? readCloudTaskMeta(task) : null;
  const provider = task ? taskCloudProvider(task, environments) : null;

  // PR detail side-sheet — opened by clicking the PR status pill on
  // the task header. Stays mounted at the TaskDetail root so it
  // survives task switches.
  const [prSheetId, setPRSheetId] = useState<string | null>(null);

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground">Task not found</p>
      </div>
    );
  }

  const isRunning = task.status === 'in_progress';
  const isAgent = isAgentTask(task.type);
  const canStart = isAgent && ['pending', 'queued'].includes(task.status);

  const handleStartTask = async () => {
    setActiveAction('start');
    try {
      await startTask(taskId);
    } finally {
      setActiveAction(null);
    }
  };

  const handleCancelTask = async () => {
    setActiveAction('cancel');
    try {
      await cancelTask(taskId);
    } finally {
      setActiveAction(null);
    }
  };

  const handleRetryTask = async () => {
    setActiveAction('retry');
    try {
      await retryTask(taskId);
    } finally {
      setActiveAction(null);
    }
  };

  const handleDeleteTask = async () => {
    if (!window.confirm('Delete this failed task? This cannot be undone.')) return;
    setActiveAction('delete');
    setActionError(null);
    try {
      await deleteTask(taskId);
    } catch (err) {
      // Surface the backend error inline — "delete does nothing" was
      // the previous UX because the finally block hid rejections.
      setActionError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setActiveAction(null);
    }
  };

  const StatusIcon = isRunning ? runningStatus.icon : statusConfig[task.status].icon;

  // The cloud-run banner — provider, remote status, deep link to the run.
  const cloudBanner = cloudMeta && (
    <div className="px-4 py-2 border-b bg-muted/40 flex items-center gap-2 text-xs">
      <ProviderIcon provider={provider ?? cloudMeta.provider} className="h-3.5 w-3.5" />
      <span className="text-muted-foreground">
        Cloud run on {providerLabel(provider ?? cloudMeta.provider) ?? cloudMeta.provider}
      </span>
      {cloudMeta.status && (
        <Badge variant="secondary" className="text-[10px]">
          {cloudMeta.status}
        </Badge>
      )}
      {cloudMeta.logUrl && (
        <button
          type="button"
          onClick={() => window.open(cloudMeta.logUrl!, '_blank')}
          className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="w-3 h-3" />
          View run
        </button>
      )}
    </div>
  );

  // If task is running, show terminal
  if (isRunning) {
    const env = environments.find((e) => e.id === task.assignedEnvironmentId);

    return (
      <>
        {/* Header */}
        <div className="app-region-drag p-4 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'w-10 h-10 rounded-lg flex items-center justify-center bg-secondary',
                  runningStatus.color
                )}
              >
                <StatusIcon className="w-5 h-5 animate-spin" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">{task.title}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="secondary">{runningStatus.label}</Badge>
                  {provider && (
                    <Badge variant="outline" className="text-xs gap-1">
                      <ProviderIcon provider={provider} className="h-3 w-3" />
                      {providerLabel(provider)}
                    </Badge>
                  )}
                  {env && (
                    <Badge variant="outline" className="text-xs">
                      {env.name}
                    </Badge>
                  )}
                  {repo && (
                    <Badge variant="outline" className="text-xs">
                      <GitBranch className="w-3 h-3 mr-1" />
                      {repo.fullName}
                    </Badge>
                  )}
                  {task.branch && (
                    <Badge variant="secondary" className="text-xs font-mono">
                      {task.branch}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            {/*
              No task-control buttons here — TaskTerminal's header renders
              the per-task Abort contextually beside the terminal it manages.
              We do surface the linked-PR status pill so a PR-fix run shows
              the PR's CI/merge state while it works.
            */}
            <div className="app-region-no-drag flex items-center gap-2 shrink-0">
              <TaskPRControls task={task} onOpen={setPRSheetId} />
            </div>
          </div>
        </div>

        {cloudBanner}

        {/* Cloud tasks have no local Files/Git data — the agent log is the
            whole story. */}
        <div className="flex-1 overflow-hidden p-4">
          <div className="h-full">
            <TaskTerminal task={task} />
          </div>
        </div>
        <Suspense fallback={null}><PRDetailSheet pullRequestId={prSheetId} onClose={() => setPRSheetId(null)} /></Suspense>
      </>
    );
  }

  // Non-running task view
  return (
    <>
      {/* Header */}
      <div className="app-region-drag p-4 border-b">
        <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div
              className={cn(
                'w-10 h-10 rounded-lg flex items-center justify-center bg-secondary shrink-0',
                statusConfig[task.status].color
              )}
            >
              <StatusIcon className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold break-words">{task.title}</h2>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <Badge variant="outline">{statusConfig[task.status].label}</Badge>
                {provider && (
                  <Badge variant="outline" className="gap-1">
                    <ProviderIcon provider={provider} className="h-3 w-3" />
                    {providerLabel(provider)}
                  </Badge>
                )}
                {(() => {
                  // Set when the task ran an agent skill (metadata.skill).
                  const skill = task.metadata?.skill as { name?: string } | undefined;
                  return skill?.name ? (
                    <Badge variant="outline" className="gap-1">
                      <Wand2 className="h-3 w-3" />
                      {skill.name}
                    </Badge>
                  ) : null;
                })()}
                <Badge
                  variant={
                    task.priority === 'urgent'
                      ? 'destructive'
                      : task.priority === 'high'
                      ? 'warning'
                      : 'secondary'
                  }
                >
                  {priorityConfig[task.priority].label} Priority
                </Badge>
              </div>
            </div>
          </div>
          <div className="app-region-no-drag flex items-center gap-2 flex-wrap shrink-0">
            {canStart && (
              <Button size="sm" data-attr="task-start-now" onClick={handleStartTask} disabled={actionInFlight}>
                {isLoadingFor('start') ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 mr-1" />
                )}
                Start Now
              </Button>
            )}
            {/* PR pill + open-on-GitHub link on any task with a PR linked
                (started-from-a-PR, or linked once the cloud run opened one). */}
            <TaskPRControls task={task} onOpen={setPRSheetId} />
            {task.status === 'failed' && (
              <>
                <Button size="sm" data-attr="task-retry" onClick={handleRetryTask} disabled={actionInFlight}>
                  {isLoadingFor('retry') ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RotateCw className="w-4 h-4 mr-1" />}
                  Retry
                </Button>
                <Button size="sm" variant="destructive" data-attr="task-delete" onClick={handleDeleteTask} disabled={actionInFlight}>
                  {isLoadingFor('delete') ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4 mr-1" />
                  )}
                  Delete
                </Button>
                {actionError && (
                  <span className="text-xs text-destructive self-center ml-2">
                    {actionError}
                  </span>
                )}
              </>
            )}
            {['pending', 'queued'].includes(task.status) && (
              <Button size="sm" variant="destructive" data-attr="task-cancel" onClick={handleCancelTask} disabled={actionInFlight}>
                {isLoadingFor('cancel') && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Compact info strip — replaces the bulky Details card so the
          log below can own the vertical space. */}
      <div className="px-4 py-2 border-b text-xs text-muted-foreground flex items-center gap-4 flex-wrap">
        {repo && (
          <span className="flex items-center gap-1 min-w-0">
            <GitBranch className="w-3 h-3 shrink-0" />
            <span className="truncate" title={repo.fullName}>{repo.fullName}</span>
          </span>
        )}
        {task.branch && (
          <span
            className="font-mono bg-secondary px-1.5 py-0.5 rounded truncate max-w-[220px]"
            title={task.branch}
          >
            {task.branch}
          </span>
        )}
        <span title={new Date(task.createdAt).toLocaleString()}>
          Created {formatRelativeTime(task.createdAt)}
        </span>
        {task.completedAt && (
          <span title={new Date(task.completedAt).toLocaleString()}>
            Completed {formatRelativeTime(task.completedAt)}
          </span>
        )}
        {(() => {
          const pr = (task.metadata as { pullRequest?: { number: number; url: string } } | undefined)
            ?.pullRequest;
          if (pr) {
            return (
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="w-3 h-3" />
                PR #{pr.number}
              </a>
            );
          }
          const prErr = (task.metadata as { pullRequestError?: string } | undefined)
            ?.pullRequestError;
          if (prErr) {
            return (
              <span
                className="text-amber-600 dark:text-amber-500"
                title={prErr}
              >
                No PR linked
              </span>
            );
          }
          return null;
        })()}
      </div>

      {/* Prompt — always shown when present, above the log. Description
          dropped when it just duplicates the prompt (common case). */}
      {(task.prompt ||
        (task.description && task.description.trim() !== (task.prompt ?? '').trim())) && (
        <div className="px-4 pt-3 pb-2 border-b">
          {task.prompt ? (
            <pre className="text-sm bg-secondary p-3 rounded-lg whitespace-pre-wrap break-words max-h-32 overflow-auto">
              {task.prompt}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground break-words">{task.description}</p>
          )}
        </div>
      )}

      {/* Failed/cancelled result banner — loud, above the log, with the
          full reason + a Retry action. */}
      {task.result && !task.result.success && (
        <div className="px-4 py-3 border-b bg-red-500/10 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-medium text-red-700 dark:text-red-400">
                  {task.status === 'cancelled' ? 'Task cancelled' : 'Task failed'}
                </p>
                <p className="text-xs text-red-700/80 dark:text-red-300/80 mt-1 break-words whitespace-pre-wrap">
                  {task.result.summary || task.result.error || 'Unknown error.'}
                </p>
              </div>
            </div>
            {task.status === 'failed' && (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={handleRetryTask}
                disabled={actionInFlight}
              >
                {isLoadingFor('retry') ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <RotateCw className="w-3 h-3 mr-1" />
                )}
                Retry
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Scheduler-rollback banner: task is still in queued but the
          last attempt to dispatch it failed (provider error, missing
          credentials, etc). Gives the user a clue why they keep
          seeing the spinner without progress. */}
      {task.status === 'queued' &&
        (() => {
          const meta = task.metadata as
            | { lastScheduleError?: { at: string; reason: string } }
            | undefined;
          const err = meta?.lastScheduleError;
          if (!err) return null;
          return (
            <div className="px-4 py-2 border-b bg-amber-500/10 text-xs">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
                <p className="text-amber-700 dark:text-amber-300 break-words">
                  Last attempt to start this task failed at{' '}
                  {new Date(err.at).toLocaleTimeString()}: {err.reason}
                </p>
              </div>
            </div>
          );
        })()}

      {cloudBanner}

      {/* The run transcript — read-only, hydrated on demand from the
          provider's durable logs even for finished tasks. */}
      <div className="flex-1 overflow-hidden">
        <TaskTerminal task={task} />
      </div>
      <Suspense fallback={null}><PRDetailSheet pullRequestId={prSheetId} onClose={() => setPRSheetId(null)} /></Suspense>
    </>
  );
}

/**
 * The linked-PR controls for a task header: the live status pill plus a
 * "View PR" deep link. Renders off `metadata.pullRequest`, which is set
 * both when a task opens a PR (poller) and when a task is started FROM a
 * PR (creation time) — so the pill shows while the task is still running.
 */
function TaskPRControls({
  task,
  onOpen,
}: {
  task: Task;
  onOpen: (prId: string) => void;
}) {
  const pr = (
    task.metadata as
      | { pullRequest?: { number: number; url: string; id?: string } }
      | undefined
  )?.pullRequest;
  if (!pr) return null;
  return (
    <>
      {pr.id && (
        // key on the PR id so switching tasks remounts the pill, letting it
        // re-seed synchronously from the PR status cache instead of carrying
        // the prior task's state.
        <PRStatusPillForTask key={pr.id} pullRequestId={pr.id} onOpen={() => onOpen(pr.id!)} />
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => window.open(pr.url, '_blank', 'noopener,noreferrer')}
        title={pr.url}
      >
        <GitPullRequest className="w-4 h-4 mr-1" />
        View PR #{pr.number}
      </Button>
    </>
  );
}

/**
 * Wraps PRStatusPill so the task header always shows the linked PR's
 * status. Seeds synchronously from the shared {@link prSummaryCache} so a
 * previously-seen PR paints instantly on task switch, then revalidates with
 * a background fetch. WS updates flow through the cache too. Renders nothing
 * only the first time a PR is ever seen (until its first fetch resolves).
 */
function PRStatusPillForTask({
  pullRequestId,
  onOpen,
}: {
  pullRequestId: string;
  onOpen: () => void;
}) {
  // Initialise from cache so there's no blank-then-pop on switch.
  const cached = getCachedPRStatus(pullRequestId);
  const [summary, setSummary] = useState<PRSummaryShape | null>(cached?.summary ?? null);
  const [state, setState] = useState<PRState>(cached?.state ?? 'open');

  // Subscribe to cache updates (own fetch + the global WS handler both
  // write through prime()), and revalidate in the background on mount.
  useEffect(() => {
    const unsubscribe = subscribePRStatus(pullRequestId, (status) => {
      setSummary(status.summary);
      setState(status.state);
    });
    let cancelled = false;
    api.pullRequests
      .get(pullRequestId)
      .then((res) => {
        if (cancelled) return;
        prime(pullRequestId, { summary: res.row.summary, state: res.row.state });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [pullRequestId]);

  // Mark this PR focused while the task is on screen — backend
  // tightens TTL to 30 s so the pill reflects upstream changes
  // quickly. Cleared on unmount (task switch / panel close).
  useEffect(() => {
    api.pullRequests.focus(pullRequestId, true).catch(() => {});
    return () => {
      api.pullRequests.focus(pullRequestId, false).catch(() => {});
    };
  }, [pullRequestId]);

  if (!summary) return null;
  return (
    <PRStatusPill
      blockingReason={summary.blockingReason}
      checks={summary.checks}
      state={state}
      onClick={onOpen}
      // All-in-one pill (no separate review column): the decision keeps an
      // approved-but-protection-held PR from reading as "Review".
      reviewDecision={summary.effectiveReviewDecision ?? summary.reviewDecision}
      labels={summary.labels}
    />
  );
}
