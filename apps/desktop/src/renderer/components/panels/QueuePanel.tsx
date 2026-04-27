import React, { useEffect, useState } from 'react';
import {
  ListTodo,
  Plus,
  Play,
  Pause,
  Clock,
  CheckCircle,
  AlertCircle,
  Loader2,
  RotateCw,
  MessageSquare,
  Terminal,
  GitBranch,
  Sparkles,
  Eye,
  Hand,
  Trash2,
  GitCommit,
  ExternalLink,
  GitPullRequest,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { useTaskActions } from '../../hooks/useApi';
import { useTaskFiles } from '../../hooks/useTaskFiles';
import { api } from '../../lib/api';
import { CreateTaskModal } from '../modals/CreateTaskModal';
import { TaskTerminal } from './TaskTerminal';
import { TerminalHistory } from './TerminalHistory';
import { TaskFilesPanel } from './TaskFilesPanel';
import { TaskGitPanel } from './TaskGitPanel';
import { useTaskGitLog } from '../../hooks/useTaskGitLog';
import { PRStatusPill } from '../widgets/PRStatusPill';
import { PRDetailSheet } from '../widgets/PRDetailSheet';
import type { PRSummaryShape } from '../../lib/api';
import { isAgentTask } from '@fastowl/shared';
import type { Task, TaskStatus, TaskType, TaskPriority, AgentStatus, AgentAttention } from '@fastowl/shared';

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
  awaiting_review: {
    icon: Clock,
    label: 'Awaiting Review',
    color: 'text-yellow-400',
  },
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
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  const queuedTasks = tasks.filter((t) =>
    ['pending', 'queued'].includes(t.status)
  );
  // In-flight: child process actually running.
  const inProgressTasks = tasks.filter((t) => t.status === 'in_progress');
  // Exited cleanly; waiting on a human decision (approve / reject).
  const reviewTasks = tasks.filter((t) => t.status === 'awaiting_review');
  const completedTasks = tasks.filter((t) =>
    ['completed', 'failed', 'cancelled'].includes(t.status)
  );

  return (
    <>
    <CreateTaskModal open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen} />
    <div className="flex h-full">
      {/* Task List */}
      <div className="w-80 border-r flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Task Queue</h2>
          <Button size="sm" onClick={() => setIsCreateModalOpen(true)}>
            <Plus className="w-4 h-4 mr-1" />
            Add
          </Button>
        </div>

        <ScrollArea className="flex-1">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center p-4">
              <ListTodo className="w-10 h-10 text-muted-foreground/50 mb-3" />
              <h3 className="font-medium mb-1 text-sm">No tasks</h3>
              <p className="text-xs text-muted-foreground">
                Add tasks to automate your workflow
              </p>
              <Button size="sm" className="mt-3" onClick={() => setIsCreateModalOpen(true)}>
                <Plus className="w-4 h-4 mr-1" />
                Add Task
              </Button>
            </div>
          ) : (
            <div className="p-2">
              {reviewTasks.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1 flex items-center gap-1.5">
                    <span>AWAITING REVIEW</span>
                    <span className="tabular-nums text-muted-foreground/70">
                      {reviewTasks.length}
                    </span>
                  </h3>
                  <div className="space-y-1">
                    {reviewTasks.map((task) => (
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
            <p className="text-sm text-muted-foreground mb-4">
              Select a task to view details or create a new one
            </p>
            <Button onClick={() => setIsCreateModalOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Create Task
            </Button>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

// Agent status config for running tasks
const agentStatusConfig: Record<
  AgentStatus,
  { icon: React.ElementType; label: string; color: string }
> = {
  idle: { icon: Terminal, label: 'Idle', color: 'text-slate-400' },
  working: { icon: Loader2, label: 'Working', color: 'text-blue-400' },
  awaiting_input: {
    icon: MessageSquare,
    label: 'Input Needed',
    color: 'text-yellow-400',
  },
  tool_use: { icon: Play, label: 'Tool', color: 'text-purple-400' },
  completed: { icon: CheckCircle, label: 'Done', color: 'text-green-400' },
  error: { icon: AlertCircle, label: 'Error', color: 'text-red-400' },
};

const attentionColors: Record<AgentAttention, string> = {
  none: 'border-transparent',
  low: 'border-l-yellow-400/50',
  medium: 'border-l-orange-400',
  high: 'border-l-red-400',
};

interface TaskListItemProps {
  task: Task;
  isSelected: boolean;
  onSelect: () => void;
}

function TaskListItem({ task, isSelected, onSelect }: TaskListItemProps) {
  // Show agent status indicator for running tasks
  const isRunning = task.status === 'in_progress';
  const agentStatus = task.agentStatus || 'working';
  const agentAttention = task.agentAttention || 'none';

  // Diff stats (+NN -MM) only make sense once the task has a branch to
  // diff against. Gate the fetch so branch-less tasks (pending / queued
  // pre-scheduler) don't hit the backend for an empty list.
  const { files: changedFiles } = useTaskFiles(task.id, {
    enabled: !!task.branch,
  });
  const diffStats = changedFiles.reduce(
    (acc, f) => ({
      added: acc.added + (f.binary ? 0 : f.added),
      removed: acc.removed + (f.binary ? 0 : f.removed),
    }),
    { added: 0, removed: 0 },
  );
  const hasDiff = changedFiles.length > 0;

  // Determine which icon to show
  const StatusIcon = isRunning
    ? agentStatusConfig[agentStatus].icon
    : statusConfig[task.status].icon;
  const statusColor = isRunning
    ? agentStatusConfig[agentStatus].color
    : statusConfig[task.status].color;

  return (
    <Card
      className={cn(
        'p-3 cursor-pointer transition-colors border-l-4',
        isSelected ? 'bg-accent' : 'hover:bg-accent/50',
        isRunning ? attentionColors[agentAttention] : 'border-l-transparent'
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
          <StatusIcon
            className={cn(
              'w-4 h-4',
              isRunning && agentStatus === 'working' && 'animate-spin'
            )}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{task.title}</span>
            {isRunning && agentAttention !== 'none' && (
              <div
                className={cn(
                  'w-2 h-2 rounded-full flex-shrink-0',
                  agentAttention === 'high' && 'bg-red-400',
                  agentAttention === 'medium' && 'bg-orange-400',
                  agentAttention === 'low' && 'bg-yellow-400'
                )}
              />
            )}
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
                {agentStatusConfig[agentStatus].label}
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
            {hasDiff && (
              <span
                className="text-xs tabular-nums flex items-center gap-1"
                title={`${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed`}
              >
                <span className="text-green-500">+{diffStats.added}</span>
                <span className="text-red-500">-{diffStats.removed}</span>
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
    updateTaskStatus,
    cancelTask,
    retryTask,
    startTask,
    approveTask,
    rejectTask,
    deleteTask,
    readyForReview,
  } = useTaskActions();
  // Track which specific action is in flight, not a shared boolean —
  // otherwise clicking Create PR puts the Reject button into a
  // spinner too (and vice versa). We still disable every action
  // while ANY one is in flight so the user can't double-click around
  // a slow request.
  const [activeAction, setActiveAction] = useState<
    | 'start'
    | 'queue'
    | 'pause'
    | 'cancel'
    | 'retry'
    | 'createPr'
    | 'reject'
    | 'delete'
    | 'readyForReview'
    | null
  >(null);
  const actionInFlight = activeAction !== null;
  const isLoadingFor = (action: typeof activeAction): boolean => activeAction === action;
  const [actionError, setActionError] = useState<string | null>(null);
  const task = tasks.find((t) => t.id === taskId);
  const repo = task?.repositoryId ? repositories.find(r => r.id === task.repositoryId) : null;

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
  const agentStatus = task.agentStatus || 'working';

  // Live file count for the Files tab badge — subscribed at the
  // detail-view level so the count is visible even on the Terminal
  // tab. We pass the result down into TaskFilesPanel instead of
  // having the panel call the hook itself, so the badge and the
  // list body never show different counts.
  const {
    files: changedFiles,
    loading: changedFilesLoading,
    error: changedFilesError,
  } = useTaskFiles(taskId);
  // Same pattern for the Git tab badge — count of recorded commands.
  // Lifted here (instead of the panel owning it) so the badge number
  // never drifts from the list the user sees after clicking the tab.
  const {
    entries: gitLogEntries,
    loading: gitLogLoading,
    error: gitLogError,
  } = useTaskGitLog(taskId);

  const handleStartTask = async () => {
    setActiveAction('start');
    try {
      await startTask(taskId);
    } finally {
      setActiveAction(null);
    }
  };

  const handleQueueTask = async () => {
    setActiveAction('queue');
    try {
      await updateTaskStatus(taskId, 'queued');
    } finally {
      setActiveAction(null);
    }
  };

  const handlePauseTask = async () => {
    setActiveAction('pause');
    try {
      await updateTaskStatus(taskId, 'pending');
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

  // Re-runs autoCommit + advances the task. Wired to the
  // "Retry auto-commit" button in the failure banner — the same
  // /ready-for-review endpoint the in-progress UI uses to finish a
  // task early. If the underlying problem (dirty after commit, no
  // commits) is fixed, this is what unsticks the task.
  const handleReadyForReview = async () => {
    setActiveAction('readyForReview');
    setActionError(null);
    try {
      await readyForReview(taskId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to retry auto-commit');
    } finally {
      setActiveAction(null);
    }
  };

  const [activeTab, setActiveTab] = useState<'terminal' | 'files' | 'git'>('terminal');
  // PR detail side-sheet — opened by clicking the PR status pill on
  // the task header. Phase 4 ships the skeleton; Phase 5 fleshes the
  // tabs out. Stays mounted at the TaskDetail root so it survives
  // tab switches.
  const [prSheetId, setPRSheetId] = useState<string | null>(null);
  const [retryingPr, setRetryingPr] = useState(false);

  const handleRetryPr = async () => {
    setRetryingPr(true);
    try {
      await api.tasks.retryPullRequest(taskId);
      // Result flows in via task:update WS — no need to update local
      // state explicitly; the metadata.pullRequest change will trigger
      // a re-render.
    } catch {
      // Error is now on task.metadata.pullRequestError and will show
      // in the info strip via the existing WS update.
    } finally {
      setRetryingPr(false);
    }
  };

  const handleCreatePr = async () => {
    setActiveAction('createPr');
    setActionError(null);
    try {
      await approveTask(taskId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Create PR failed');
    } finally {
      setActiveAction(null);
    }
  };

  const handleRejectTask = async () => {
    setActiveAction('reject');
    try {
      await rejectTask(taskId);
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

  const StatusIcon = isRunning
    ? agentStatusConfig[agentStatus].icon
    : statusConfig[task.status].icon;

  // If task is running, show terminal
  if (isRunning) {
    const env = environments.find((e) => e.id === task.assignedEnvironmentId);

    return (
      <>
        {/* Header */}
        <div className="p-4 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'w-10 h-10 rounded-lg flex items-center justify-center bg-secondary',
                  agentStatusConfig[agentStatus].color
                )}
              >
                <StatusIcon
                  className={cn(
                    'w-5 h-5',
                    agentStatus === 'working' && 'animate-spin'
                  )}
                />
              </div>
              <div>
                <h2 className="text-lg font-semibold">{task.title}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="secondary">
                    {agentStatusConfig[agentStatus].label}
                  </Badge>
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
              Intentionally no action buttons here — TaskTerminal's
              header renders the per-task controls (Finish / Stop)
              contextually beside the terminal it manages.
            */}
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b px-4 flex items-center gap-1">
          <TabButton
            active={activeTab === 'terminal'}
            onClick={() => setActiveTab('terminal')}
          >
            <Terminal className="w-3.5 h-3.5 mr-1.5" />
            Terminal
          </TabButton>
          <TabButton
            active={activeTab === 'files'}
            onClick={() => setActiveTab('files')}
          >
            <GitBranch className="w-3.5 h-3.5 mr-1.5" />
            Files
            {changedFiles.length > 0 && (
              <Badge
                variant="secondary"
                className={cn(
                  'ml-1.5 h-5 px-1.5 text-[10px] tabular-nums',
                  activeTab !== 'files' && 'bg-primary/15 text-primary'
                )}
              >
                {changedFiles.length}
              </Badge>
            )}
          </TabButton>
          <TabButton
            active={activeTab === 'git'}
            onClick={() => setActiveTab('git')}
          >
            <GitCommit className="w-3.5 h-3.5 mr-1.5" />
            Git
            {gitLogEntries.length > 0 && (
              <Badge
                variant="secondary"
                className={cn(
                  'ml-1.5 h-5 px-1.5 text-[10px] tabular-nums',
                  activeTab !== 'git' && 'bg-primary/15 text-primary'
                )}
              >
                {gitLogEntries.length}
              </Badge>
            )}
          </TabButton>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden p-4">
          {activeTab === 'terminal' && (
            <div className="h-full">
              <TaskTerminal task={task} />
            </div>
          )}
          {activeTab === 'files' && (
            <div className="h-full">
              <TaskFilesPanel
              taskId={task.id}
              files={changedFiles}
              loading={changedFilesLoading}
              error={changedFilesError}
            />
            </div>
          )}
          {activeTab === 'git' && (
            <div className="h-full">
              <TaskGitPanel
              taskId={task.id}
              entries={gitLogEntries}
              loading={gitLogLoading}
              error={gitLogError}
            />
            </div>
          )}
        </div>
      </>
    );
  }

  // Non-running task view
  return (
    <>
      {/* Header */}
      <div className="p-4 border-b">
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
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            {task.status === 'awaiting_review' && (
              <>
                <Button
                  size="sm"
                  onClick={handleCreatePr}
                  disabled={actionInFlight}
                  title="Push the task branch to origin and open a pull request."
                >
                  {isLoadingFor('createPr') ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <GitPullRequest className="w-4 h-4 mr-1" />
                  )}
                  Create PR
                </Button>
                <Button size="sm" variant="outline" onClick={handleRejectTask} disabled={actionInFlight}>
                  {isLoadingFor('reject') ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <RotateCw className="w-4 h-4 mr-1" />
                  )}
                  Reject & Requeue
                </Button>
              </>
            )}
            {canStart && (
              <Button size="sm" onClick={handleStartTask} disabled={actionInFlight}>
                {isLoadingFor('start') ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 mr-1" />
                )}
                Start Now
              </Button>
            )}
            {task.status === 'pending' && (
              <Button size="sm" variant="outline" onClick={handleQueueTask} disabled={actionInFlight}>
                {isLoadingFor('queue') ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ListTodo className="w-4 h-4 mr-1" />}
                Queue
              </Button>
            )}
            {task.status === 'queued' && (
              <Button size="sm" variant="outline" onClick={handlePauseTask} disabled={actionInFlight}>
                {isLoadingFor('pause') ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Pause className="w-4 h-4 mr-1" />}
                Unqueue
              </Button>
            )}
            {(() => {
              // Show the PR pill + open-on-GitHub button on any task
              // that has a PR linked (typically `completed` or
              // `awaiting_review` after the approve flow opened one).
              const pr = (task.metadata as
                | { pullRequest?: { number: number; url: string; id?: string } }
                | undefined)?.pullRequest;
              if (!pr) return null;
              return (
                <>
                  {pr.id && (
                    <PRStatusPillForTask
                      pullRequestId={pr.id}
                      onOpen={() => setPRSheetId(pr.id ?? null)}
                    />
                  )}
                  <Button
                    size="sm"
                    onClick={() => window.open(pr.url, '_blank', 'noopener,noreferrer')}
                    title={pr.url}
                  >
                    <GitPullRequest className="w-4 h-4 mr-1" />
                    View PR #{pr.number}
                  </Button>
                </>
              );
            })()}
            {task.status === 'failed' && (
              <>
                <Button size="sm" onClick={handleRetryTask} disabled={actionInFlight}>
                  {isLoadingFor('retry') ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RotateCw className="w-4 h-4 mr-1" />}
                  Retry
                </Button>
                <Button size="sm" variant="destructive" onClick={handleDeleteTask} disabled={actionInFlight}>
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
              <Button size="sm" variant="destructive" onClick={handleCancelTask} disabled={actionInFlight}>
                {isLoadingFor('cancel') && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Compact info strip — replaces the bulky Details card so the
          tabs below can own the vertical space. */}
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
              <span className="flex items-center gap-1.5">
                <span
                  className="text-amber-600 dark:text-amber-500"
                  title={prErr}
                >
                  PR failed
                </span>
                <button
                  type="button"
                  onClick={handleRetryPr}
                  disabled={retryingPr}
                  className="text-primary hover:underline disabled:opacity-60"
                >
                  {retryingPr ? 'Retrying…' : 'Retry'}
                </button>
              </span>
            );
          }
          return null;
        })()}
      </div>

      {/* Prompt — always shown when present, above tabs. Description
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

      {/* Auto-commit status banner. Three shapes:
          - Hard fail (in_progress + advanceOk=false): loud red, with a
            Retry button that re-runs autoCommit via /ready-for-review.
            This is the surface the user kept missing — without it,
            "task transitioned to awaiting_review with uncommitted
            files" was indistinguishable from "everything worked".
          - Awaiting_review + committed: subtle green confirmation.
          - Awaiting_review + not committed but advanced (Claude already
            committed): subtle amber "branch had prior commits". */}
      {(() => {
        const meta = task.metadata as
          | {
              autoCommit?: {
                committed: boolean;
                advanceOk?: boolean;
                at: string;
                sha?: string;
                message?: string;
                reason?: string;
                error?: string;
                porcelain?: string;
              };
            }
          | undefined;
        const ac = meta?.autoCommit;
        if (!ac) return null;

        if (task.status === 'in_progress' && ac.advanceOk === false) {
          const dirtyCount = ac.porcelain
            ? ac.porcelain.split('\n').filter(Boolean).length
            : 0;
          return (
            <div className="px-4 py-3 border-b bg-red-500/10 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="font-medium text-red-700 dark:text-red-400">
                      Auto-commit refused to advance: {ac.reason}
                    </p>
                    {ac.error && (
                      <p className="text-xs text-red-700/80 dark:text-red-300/80 mt-1 break-words whitespace-pre-wrap">
                        {ac.error}
                      </p>
                    )}
                    {dirtyCount > 0 && (
                      <p className="text-xs text-red-700/80 dark:text-red-300/80 mt-1">
                        {dirtyCount} file{dirtyCount === 1 ? '' : 's'} still uncommitted
                        in the working tree.
                      </p>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={handleReadyForReview}
                  disabled={actionInFlight}
                  title="Re-run auto-commit and try to advance to awaiting review."
                >
                  {isLoadingFor('readyForReview') ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <RotateCw className="w-3 h-3 mr-1" />
                  )}
                  Retry auto-commit
                </Button>
              </div>
            </div>
          );
        }

        if (task.status === 'awaiting_review' && ac.committed && ac.sha) {
          return (
            <div className="px-4 py-2 border-b bg-emerald-500/10 text-xs">
              <div className="flex items-start gap-2">
                <GitCommit className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-500 shrink-0 mt-0.5" />
                <p className="text-emerald-700 dark:text-emerald-300 break-words font-mono">
                  Auto-committed {ac.sha.slice(0, 10)}
                  {ac.message && (
                    <span className="font-sans"> · {ac.message.split('\n')[0]}</span>
                  )}
                </p>
              </div>
            </div>
          );
        }

        if (
          task.status === 'awaiting_review' &&
          !ac.committed &&
          ac.reason === 'no-changes-prior-commits'
        ) {
          return (
            <div className="px-4 py-2 border-b bg-amber-500/10 text-xs">
              <div className="flex items-start gap-2">
                <GitCommit className="w-3.5 h-3.5 text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
                <p className="text-amber-700 dark:text-amber-300 break-words">
                  Branch already had commits — nothing new to add. Auto-commit
                  skipped.
                </p>
              </div>
            </div>
          );
        }

        return null;
      })()}

      {/* Failed/cancelled result banner — loud, above tabs, with the
          full reason + a Retry action. */}
      {task.result && !task.result.success && (
        <div className="px-4 py-3 border-b bg-red-500/10 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-medium text-red-700 dark:text-red-400">
                  Task failed
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
          last attempt to pick it up failed (git prep error, agent
          start threw, etc). Gives the user a clue why they keep
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

      {/* Tabs — same shape as the in_progress view. */}
      <div className="border-b px-4 flex items-center gap-1 shrink-0">
        <TabButton
          active={activeTab === 'terminal'}
          onClick={() => setActiveTab('terminal')}
        >
          <Terminal className="w-3.5 h-3.5 mr-1.5" />
          Terminal
        </TabButton>
        <TabButton
          active={activeTab === 'files'}
          onClick={() => setActiveTab('files')}
        >
          <GitBranch className="w-3.5 h-3.5 mr-1.5" />
          Files
          {changedFiles.length > 0 && (
            <Badge
              variant="secondary"
              className={cn(
                'ml-1.5 h-5 px-1.5 text-[10px] tabular-nums',
                activeTab !== 'files' && 'bg-primary/15 text-primary'
              )}
            >
              {changedFiles.length}
            </Badge>
          )}
        </TabButton>
        <TabButton
          active={activeTab === 'git'}
          onClick={() => setActiveTab('git')}
        >
          <GitCommit className="w-3.5 h-3.5 mr-1.5" />
          Git
          {gitLogEntries.length > 0 && (
            <Badge
              variant="secondary"
              className={cn(
                'ml-1.5 h-5 px-1.5 text-[10px] tabular-nums',
                activeTab !== 'git' && 'bg-primary/15 text-primary'
              )}
            >
              {gitLogEntries.length}
            </Badge>
          )}
        </TabButton>
      </div>

      <div className="flex-1 overflow-hidden p-4">
        {activeTab === 'terminal' && (
          <div className="h-full overflow-auto">
            <TerminalHistory taskId={task.id} />
          </div>
        )}
        {activeTab === 'files' && (
          <div className="h-full">
            <TaskFilesPanel
              taskId={task.id}
              files={changedFiles}
              loading={changedFilesLoading}
              error={changedFilesError}
            />
          </div>
        )}
        {activeTab === 'git' && (
          <div className="h-full">
            <TaskGitPanel
              taskId={task.id}
              entries={gitLogEntries}
              loading={gitLogLoading}
              error={gitLogError}
            />
          </div>
        )}
      </div>
      <PRDetailSheet pullRequestId={prSheetId} onClose={() => setPRSheetId(null)} />
    </>
  );
}

/**
 * Wraps PRStatusPill with a fetch + WS subscription so the task header
 * always shows the current state of the linked PR. Renders nothing
 * (silently) until the first fetch resolves — pre-render placeholder
 * would jitter the header layout for a fraction of a second.
 */
function PRStatusPillForTask({
  pullRequestId,
  onOpen,
}: {
  pullRequestId: string;
  onOpen: () => void;
}) {
  const [summary, setSummary] = useState<PRSummaryShape | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.pullRequests
      .get(pullRequestId)
      .then((res) => {
        if (cancelled) return;
        setSummary(res.row.summary);
      })
      .catch(() => {
        if (cancelled) return;
        setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pullRequestId]);

  useEffect(() => {
    const unsubscribe = api.ws.on('pull_request:updated', (payload) => {
      const p = payload as { id: string; lastSummary: unknown };
      if (p.id !== pullRequestId) return;
      setSummary(p.lastSummary as PRSummaryShape);
    });
    return unsubscribe;
  }, [pullRequestId]);

  if (!summary) return null;
  return (
    <PRStatusPill
      blockingReason={summary.blockingReason}
      checks={summary.checks}
      onClick={onOpen}
    />
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center text-xs px-3 py-2 border-b-2 -mb-[1px] transition-colors',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
