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
  Square,
  MessageSquare,
  Terminal,
  GitBranch,
  Sparkles,
  Eye,
  Hand,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { useTaskActions } from '../../hooks/useApi';
import { CreateTaskModal } from '../modals/CreateTaskModal';
import { TaskTerminal } from './TaskTerminal';
import { TerminalHistory } from './TerminalHistory';
import { TaskDiff } from './TaskDiff';
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
  const inProgressTasks = tasks.filter((t) =>
    ['in_progress', 'awaiting_review'].includes(t.status)
  );
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
              {queuedTasks.length} queued, {inProgressTasks.length} in progress
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
              {inProgressTasks.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1">
                    IN PROGRESS
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
  const { updateTaskStatus, cancelTask, retryTask, startTask, stopTask, approveTask, rejectTask } = useTaskActions();
  const [isLoading, setIsLoading] = useState(false);
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

  const handleStopTask = async () => {
    setIsLoading(true);
    try {
      await stopTask(taskId);
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

  const handleApproveTask = async () => {
    setIsLoading(true);
    try {
      await approveTask(taskId);
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
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={handleStopTask}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Square className="w-4 h-4 mr-1" />
                )}
                Stop
              </Button>
            </div>
          </div>
        </div>

        {/* Terminal */}
        <div className="flex-1 overflow-hidden">
          <TaskTerminal task={task} />
        </div>
      </>
    );
  }

  // Non-running task view
  return (
    <>
      {/* Header */}
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'w-10 h-10 rounded-lg flex items-center justify-center bg-secondary',
                statusConfig[task.status].color
              )}
            >
              <StatusIcon className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{task.title}</h2>
              <div className="flex items-center gap-2 mt-1">
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
          <div className="flex items-center gap-2">
            {task.status === 'awaiting_review' && (
              <>
                <Button size="sm" onClick={handleApproveTask} disabled={isLoading}>
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle className="w-4 h-4 mr-1" />
                  )}
                  Approve
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
              <Button size="sm" onClick={handleRetryTask} disabled={isLoading}>
                {isLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RotateCw className="w-4 h-4 mr-1" />}
                Retry
              </Button>
            )}
            {['pending', 'queued'].includes(task.status) && (
              <Button size="sm" variant="destructive" onClick={handleCancelTask} disabled={isLoading}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-6">
          <div>
            <h3 className="text-sm font-medium mb-2">Description</h3>
            <p className="text-sm text-muted-foreground">{task.description}</p>
          </div>

          {task.prompt && (
            <div>
              <h3 className="text-sm font-medium mb-2">Prompt</h3>
              <pre className="text-sm bg-secondary p-3 rounded-lg whitespace-pre-wrap">
                {task.prompt}
              </pre>
            </div>
          )}

          {task.result && (
            <div>
              <h3 className="text-sm font-medium mb-2">Result</h3>
              <Card className="p-3">
                <div className="flex items-center gap-2 mb-2">
                  {task.result.success ? (
                    <CheckCircle className="w-4 h-4 text-green-400" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-400" />
                  )}
                  <span
                    className={cn(
                      'text-sm font-medium',
                      task.result.success ? 'text-green-400' : 'text-red-400'
                    )}
                  >
                    {task.result.success ? 'Success' : 'Failed'}
                  </span>
                </div>
                {task.result.summary && (
                  <p className="text-sm text-muted-foreground">
                    {task.result.summary}
                  </p>
                )}
                {task.result.error && (
                  <p className="text-sm text-red-400 mt-1">
                    {task.result.error}
                  </p>
                )}
              </Card>
            </div>
          )}

          <div>
            <h3 className="text-sm font-medium mb-2">Details</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Type:</span>
                <span className="ml-2">{taskTypeConfig[task.type]?.label ?? task.type}</span>
              </div>
              {repo && (
                <div>
                  <span className="text-muted-foreground">Repository:</span>
                  <span className="ml-2 flex items-center gap-1">
                    <GitBranch className="w-3 h-3" />
                    {repo.fullName}
                  </span>
                </div>
              )}
              {task.branch && (
                <div>
                  <span className="text-muted-foreground">Branch:</span>
                  <span className="ml-2 font-mono text-xs bg-secondary px-2 py-0.5 rounded">
                    {task.branch}
                  </span>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Created:</span>
                <span className="ml-2">
                  {new Date(task.createdAt).toLocaleString()}
                </span>
              </div>
              {task.completedAt && (
                <div>
                  <span className="text-muted-foreground">Completed:</span>
                  <span className="ml-2">
                    {new Date(task.completedAt).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          </div>

          {task.status === 'awaiting_review' && task.branch && task.repositoryId && (
            <TaskDiff taskId={task.id} />
          )}

          {['awaiting_review', 'completed', 'failed', 'cancelled'].includes(task.status) && (
            <TerminalHistory taskId={task.id} />
          )}
        </div>
      </ScrollArea>
    </>
  );
}
