import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Square,
  Send,
  Loader2,
  MessageSquare,
  CheckCircle,
  AlertCircle,
  Play,
  Terminal,
  FileCheck,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { AgentConversation } from '../terminal/AgentConversation';
import { useTaskActions } from '../../hooks/useApi';
import { useWorkspaceStore } from '../../stores/workspace';
import type { Task, AgentStatus, AgentAttention } from '@fastowl/shared';

interface TaskTerminalProps {
  task: Task;
}

const statusConfig: Record<
  AgentStatus,
  { icon: React.ElementType; label: string; color: string }
> = {
  idle: { icon: Terminal, label: 'Idle', color: 'text-slate-400' },
  working: { icon: Loader2, label: 'Working', color: 'text-blue-400' },
  awaiting_input: {
    icon: MessageSquare,
    label: 'Awaiting Input',
    color: 'text-yellow-400',
  },
  tool_use: { icon: Play, label: 'Running Tool', color: 'text-purple-400' },
  completed: { icon: CheckCircle, label: 'Completed', color: 'text-green-400' },
  error: { icon: AlertCircle, label: 'Error', color: 'text-red-400' },
};

const attentionColors: Record<AgentAttention, string> = {
  none: 'border-transparent',
  low: 'border-yellow-400/50',
  medium: 'border-orange-400',
  high: 'border-red-400',
};

export function TaskTerminal({ task }: TaskTerminalProps) {
  const { sendTaskInput, continueTask, stopTask, readyForReview } = useTaskActions();
  const environments = useWorkspaceStore((s) => s.environments);
  const [inputValue, setInputValue] = useState('');
  const [isStopping, setIsStopping] = useState(false);
  const [isMarkingReady, setIsMarkingReady] = useState(false);

  const agentStatus = task.agentStatus || 'working';
  const agentAttention = task.agentAttention || 'none';
  const envName =
    environments.find((e) => e.id === task.assignedEnvironmentId)?.name;
  // Tasks whose child already exited (awaiting_review / completed /
  // failed) can still be resumed if we captured a `claudeSessionId`
  // on their metadata. The input bar routes Send to /continue in that
  // case, which spawns a fresh CLI child with `--resume <id>` + the
  // prompt.
  const claudeSessionId = (task.metadata as { claudeSessionId?: string } | undefined)
    ?.claudeSessionId;
  const isResumable =
    task.status !== 'in_progress' &&
    task.status !== 'cancelled' &&
    typeof claudeSessionId === 'string';

  const StatusIcon = statusConfig[agentStatus].icon;

  const handleSendInput = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    try {
      if (task.status === 'in_progress') {
        await sendTaskInput(task.id, inputValue);
      } else if (isResumable) {
        await continueTask(task.id, inputValue);
      } else {
        return;
      }
      setInputValue('');
    } catch (err) {
      console.error('Failed to send input:', err);
    }
  }, [task.id, task.status, inputValue, sendTaskInput, continueTask, isResumable]);

  const handleStopTask = useCallback(async () => {
    setIsStopping(true);
    try {
      await stopTask(task.id);
    } catch (err) {
      console.error('Failed to stop task:', err);
    } finally {
      setIsStopping(false);
    }
  }, [task.id, stopTask]);

  const handleReadyForReview = useCallback(async () => {
    setIsMarkingReady(true);
    try {
      await readyForReview(task.id);
    } catch (err) {
      console.error('Failed to mark ready for review:', err);
    } finally {
      setIsMarkingReady(false);
    }
  }, [task.id, readyForReview]);

  return (
    <div
      className={cn(
        'flex flex-col h-full min-w-0 border-l-4',
        attentionColors[agentAttention]
      )}
    >
      {/* Terminal Header */}
      <div className="flex items-center justify-between p-3 border-b bg-card">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'w-3 h-3 rounded-full',
              agentStatus === 'working' && 'bg-blue-400 animate-pulse',
              agentStatus === 'idle' && 'bg-slate-400',
              agentStatus === 'awaiting_input' && 'bg-yellow-400',
              agentStatus === 'error' && 'bg-red-400',
              agentStatus === 'completed' && 'bg-green-400',
              agentStatus === 'tool_use' && 'bg-purple-400'
            )}
          />
          <span className="font-medium text-sm">Task Terminal</span>
          <Badge variant="outline" className="text-xs">
            <StatusIcon
              className={cn(
                'w-3 h-3 mr-1',
                agentStatus === 'working' && 'animate-spin'
              )}
            />
            {statusConfig[agentStatus].label}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="default"
            size="sm"
            className="h-8"
            title="Mark work as ready for your review"
            onClick={handleReadyForReview}
            disabled={isMarkingReady || isStopping}
          >
            {isMarkingReady ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <FileCheck className="w-4 h-4 mr-1" />
            )}
            Ready for Review
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            title="Stop Task (discard work)"
            onClick={handleStopTask}
            disabled={isStopping || isMarkingReady}
          >
            {isStopping ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Square className="w-4 h-4 mr-1" />
            )}
            Stop
          </Button>
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 bg-[#1e1e1e] overflow-hidden">
        <AgentConversation
          taskId={task.id}
          transcript={task.transcript}
          envName={envName}
          interactive
        />
      </div>

      {/* Input Area — sends a message as the next stream-json turn. */}
      <TaskInputBar
        taskStatus={task.status}
        agentStatus={agentStatus}
        resumable={isResumable}
        inputValue={inputValue}
        onChange={setInputValue}
        onSend={handleSendInput}
      />
    </div>
  );
}

/**
 * Bottom-of-panel input. Auto-growing textarea; Enter sends,
 * Shift+Enter inserts a newline.
 *
 * Disabled states:
 *  - mid-turn (agent working / using a tool): user shouldn't queue
 *    a message thinking it interrupts.
 *  - task not in_progress (awaiting_review / completed / failed /
 *    cancelled): the child process has exited, there's nothing to
 *    send to. UI explains + suggests Retry.
 */
function TaskInputBar({
  taskStatus,
  agentStatus,
  resumable,
  inputValue,
  onChange,
  onSend,
}: {
  taskStatus: Task['status'];
  agentStatus: AgentStatus;
  /** True if an ended task can still accept input via `/continue`. */
  resumable: boolean;
  inputValue: string;
  onChange: (v: string) => void;
  onSend: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: scale with content, cap at ~8 lines so the input can't
  // eat the whole panel.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [inputValue]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend]
  );

  const ended = taskStatus !== 'in_progress';
  const busy = !ended && (agentStatus === 'working' || agentStatus === 'tool_use');
  // Input stays enabled for resumable ended tasks (we'll POST
  // /continue instead of /input). Only hard-disable for irretrievable
  // states (cancelled, or any ended state where we never captured a
  // claudeSessionId).
  const disabled = busy || (ended && !resumable);
  const placeholder = ended
    ? resumable
      ? 'Continue the conversation… (Shift+Enter for newline)'
      : `Task is ${taskStatus} — no active session.`
    : busy
      ? 'Claude is working…'
      : agentStatus === 'awaiting_input'
        ? 'Type your response…'
        : 'Send a message to Claude… (Shift+Enter for newline)';

  return (
    <div
      className={cn(
        'p-3 border-t',
        agentStatus === 'awaiting_input' ? 'bg-yellow-500/10 border-yellow-500/20' : 'bg-card'
      )}
    >
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          placeholder={placeholder}
          value={inputValue}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          className={cn(
            'flex-1 px-3 py-2 text-sm rounded-md border bg-background resize-none',
            'focus:outline-none focus:ring-2 focus:ring-ring',
            'min-h-[38px] max-h-[200px]'
          )}
          disabled={disabled}
          autoFocus={!ended && agentStatus === 'awaiting_input'}
        />
        <Button
          size="sm"
          onClick={onSend}
          disabled={!inputValue.trim() || disabled}
          className="h-[38px]"
        >
          <Send className="w-4 h-4 mr-1" />
          Send
        </Button>
      </div>
      {agentStatus === 'awaiting_input' && (
        <p className="text-xs text-yellow-500 mt-2">
          Claude is waiting for your input
        </p>
      )}
    </div>
  );
}
