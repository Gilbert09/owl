import React, { useState, useCallback } from 'react';
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
import { XTerm } from '../terminal/XTerm';
import { useTaskActions } from '../../hooks/useApi';
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
  const { sendTaskInput, stopTask, readyForReview } = useTaskActions();
  const [inputValue, setInputValue] = useState('');
  const [isStopping, setIsStopping] = useState(false);
  const [isMarkingReady, setIsMarkingReady] = useState(false);

  const agentStatus = task.agentStatus || 'working';
  const agentAttention = task.agentAttention || 'none';
  const terminalOutput = task.terminalOutput || '$ Waiting for output...';

  const StatusIcon = statusConfig[agentStatus].icon;

  const handleSendInput = useCallback(async () => {
    if (!inputValue.trim()) return;
    try {
      await sendTaskInput(task.id, inputValue);
      setInputValue('');
    } catch (err) {
      console.error('Failed to send input:', err);
    }
  }, [task.id, inputValue, sendTaskInput]);

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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendInput();
      }
    },
    [handleSendInput]
  );

  return (
    <div
      className={cn(
        'flex flex-col h-full border-l-4',
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
        <XTerm
          output={terminalOutput}
          inputEnabled={agentStatus === 'awaiting_input'}
        />
      </div>

      {/* Input Area - always visible for interactive terminal */}
      <div
        className={cn(
          'p-3 border-t',
          agentStatus === 'awaiting_input' ? 'bg-yellow-500/10 border-yellow-500/20' : 'bg-card'
        )}
      >
        <div className="flex gap-2">
          <input
            type="text"
            placeholder={
              agentStatus === 'awaiting_input'
                ? 'Type your response...'
                : 'Send a message to Claude...'
            }
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            autoFocus={agentStatus === 'awaiting_input'}
          />
          <Button size="sm" onClick={handleSendInput} disabled={!inputValue.trim()}>
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
    </div>
  );
}
