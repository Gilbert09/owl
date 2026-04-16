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
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { useTaskActions } from '../../hooks/useApi';
import { CreateTaskModal } from '../modals/CreateTaskModal';
import type { Task, TaskStatus, TaskPriority } from '@fastowl/shared';

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

interface TaskListItemProps {
  task: Task;
  isSelected: boolean;
  onSelect: () => void;
}

function TaskListItem({ task, isSelected, onSelect }: TaskListItemProps) {
  const StatusIcon = statusConfig[task.status].icon;

  return (
    <Card
      className={cn(
        'p-3 cursor-pointer transition-colors',
        isSelected ? 'bg-accent' : 'hover:bg-accent/50'
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 bg-secondary',
            statusConfig[task.status].color
          )}
        >
          <StatusIcon
            className={cn(
              'w-4 h-4',
              task.status === 'in_progress' && 'animate-spin'
            )}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{task.title}</span>
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
            <span className="text-xs text-muted-foreground">
              {task.type === 'automated' ? 'Auto' : 'Manual'}
            </span>
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
  const { tasks } = useWorkspaceStore();
  const { updateTaskStatus, cancelTask } = useTaskActions();
  const [isLoading, setIsLoading] = useState(false);
  const task = tasks.find((t) => t.id === taskId);

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground">Task not found</p>
      </div>
    );
  }

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

  const StatusIcon = statusConfig[task.status].icon;

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
              <StatusIcon
                className={cn(
                  'w-5 h-5',
                  task.status === 'in_progress' && 'animate-spin'
                )}
              />
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
            {task.status === 'pending' && (
              <Button size="sm" onClick={handleQueueTask} disabled={isLoading}>
                {isLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />}
                Queue
              </Button>
            )}
            {task.status === 'queued' && (
              <Button size="sm" variant="outline" onClick={handlePauseTask} disabled={isLoading}>
                {isLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Pause className="w-4 h-4 mr-1" />}
                Unqueue
              </Button>
            )}
            {task.status === 'in_progress' && (
              <Button size="sm" variant="outline" disabled>
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                Running
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
              </Card>
            </div>
          )}

          <div>
            <h3 className="text-sm font-medium mb-2">Metadata</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Type:</span>
                <span className="ml-2 capitalize">{task.type}</span>
              </div>
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
        </div>
      </ScrollArea>
    </>
  );
}
