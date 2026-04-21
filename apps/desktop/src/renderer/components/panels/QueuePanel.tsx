import React, { useState } from 'react';
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
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { useTaskActions } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { CreateTaskModal } from '../modals/CreateTaskModal';
import { ApproveTaskModal } from '../modals/ApproveTaskModal';
import { TaskTerminal } from './TaskTerminal';
import { TerminalHistory } from './TerminalHistory';
import { TaskFilesPanel } from './TaskFilesPanel';
import { TaskGitPanel } from './TaskGitPanel';
import { useTaskFiles } from '../../hooks/useTaskFiles';
import { useTaskGitLog } from '../../hooks/useTaskGitLog';
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
          <div>
            <h2 className="text-lg font-semibold">Task Queue</h2>
            <p className="text-sm text-muted-foreground">
              {queuedTasks.length} queued · {inProgressTasks.length} running · {reviewTasks.length} awaiting review
            </p>
          </div>
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
                  <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1">
                    AWAITING REVIEW
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
                  <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1">
                    RUNNING
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
                  <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1">
                    QUEUED
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
                  <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1">
                    COMPLETED
                  </h3>
                  <div className="space-y-1">
                    {completedTasks.slice(0, 5).map((task) => (
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
            <Badge
              variant={
                task.priority === 'urgent'
                  ? 'destructive'
                  : task.priority === 'high'
                  ? 'warning'
                  : 'outline'
              }
              className="text-xs"
            >
              {priorityConfig[task.priority].label}
            </Badge>
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
  const { updateTaskStatus, cancelTask, retryTask, startTask, approveTask, rejectTask, deleteTask } = useTaskActions();
  const [isLoading, setIsLoading] = useState(false);
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
  // tab. Same hook drives TaskFilesPanel inside the tab.
  const { files: changedFiles } = useTaskFiles(taskId);
  // Same pattern for the Git tab badge — count of recorded commands.
  const { entries: gitLogEntries } = useTaskGitLog(taskId);

  const handleStartTask = async () => {
    setIsLoading(true);
    try {
      await startTask(taskId);
    } finally {
      setIsLoading(false);
    }
  };

  const handleQueueTask = async () => {
    setIsLoading(true);
    try {
      await updateTaskStatus(taskId, 'queued');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePauseTask = async () => {
    setIsLoading(true);
    try {
      await updateTaskStatus(taskId, 'pending');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelTask = async () => {
    setIsLoading(true);
    try {
      await cancelTask(taskId);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRetryTask = async () => {
    setIsLoading(true);
    try {
      await retryTask(taskId);
    } finally {
      setIsLoading(false);
    }
  };

  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'terminal' | 'files' | 'git'>('terminal');
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

  const handleApproveClick = (e: React.MouseEvent) => {
    // Shift-click bypasses the modal — commits with the auto-generated
    // message and pushes in one step. For users who trust the LLM.
    if (e.shiftKey) {
      void handleApproveTask();
      return;
    }
    setApproveModalOpen(true);
  };

  const handleApproveTask = async (commitMessage?: string) => {
    setIsLoading(true);
    setActionError(null);
    try {
      await approveTask(taskId, commitMessage);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Approve failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const handleRejectTask = async () => {
    setIsLoading(true);
    try {
      await rejectTask(taskId);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteTask = async () => {
    if (!window.confirm('Delete this failed task? This cannot be undone.')) return;
    setIsLoading(true);
    setActionError(null);
    try {
      await deleteTask(taskId);
    } catch (err) {
      // Surface the backend error inline — "delete does nothing" was
      // the previous UX because the finally block hid rejections.
      setActionError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setIsLoading(false);
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
              <TaskFilesPanel taskId={task.id} />
            </div>
          )}
          {activeTab === 'git' && (
            <div className="h-full">
              <TaskGitPanel taskId={task.id} />
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
                  onClick={handleApproveClick}
                  disabled={isLoading}
                  title="Review commit message, then commit + push to origin. Shift-click to skip the modal."
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle className="w-4 h-4 mr-1" />
                  )}
                  Commit &amp; push
                </Button>
                <Button size="sm" variant="outline" onClick={handleRejectTask} disabled={isLoading}>
                  <RotateCw className="w-4 h-4 mr-1" />
                  Reject & Requeue
                </Button>
              </>
            )}
            {canStart && (
              <Button size="sm" onClick={handleStartTask} disabled={isLoading}>
                {isLoading ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 mr-1" />
                )}
                Start Now
              </Button>
            )}
            {task.status === 'pending' && (
              <Button size="sm" variant="outline" onClick={handleQueueTask} disabled={isLoading}>
                {isLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ListTodo className="w-4 h-4 mr-1" />}
                Queue
              </Button>
            )}
            {task.status === 'queued' && (
              <Button size="sm" variant="outline" onClick={handlePauseTask} disabled={isLoading}>
                {isLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Pause className="w-4 h-4 mr-1" />}
                Unqueue
              </Button>
            )}
            {task.status === 'failed' && (
              <>
                <Button size="sm" onClick={handleRetryTask} disabled={isLoading}>
                  {isLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RotateCw className="w-4 h-4 mr-1" />}
                  Retry
                </Button>
                <Button size="sm" variant="destructive" onClick={handleDeleteTask} disabled={isLoading}>
                  <Trash2 className="w-4 h-4 mr-1" />
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
              <Button size="sm" variant="destructive" onClick={handleCancelTask} disabled={isLoading}>
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
          Created {new Date(task.createdAt).toLocaleDateString()}
        </span>
        {task.completedAt && (
          <span title={new Date(task.completedAt).toLocaleString()}>
            Completed {new Date(task.completedAt).toLocaleDateString()}
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
                disabled={isLoading}
              >
                <RotateCw className="w-3 h-3 mr-1" />
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
          Transcript
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
            <TaskFilesPanel taskId={task.id} />
          </div>
        )}
        {activeTab === 'git' && (
          <div className="h-full">
            <TaskGitPanel taskId={task.id} />
          </div>
        )}
      </div>
      <ApproveTaskModal
        taskId={taskId}
        taskTitle={task.title}
        open={approveModalOpen}
        onClose={() => setApproveModalOpen(false)}
        onApproved={() => setApproveModalOpen(false)}
        onApprove={(commitMessage) => handleApproveTask(commitMessage)}
      />
    </>
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
