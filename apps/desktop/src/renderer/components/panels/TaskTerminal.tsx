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
  const { sendTaskInput, stopTask } = useTaskActions();
  const [inputValue, setInputValue] = useState('');
  const [isStopping, setIsStopping] = useState(false);

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
            variant="ghost"
            size="sm"
            className="h-8"
            title="Stop Task"
            onClick={handleStopTask}
            disabled={isStopping}
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

      {/* Input Area (when awaiting input) */}
      {agentStatus === 'awaiting_input' && (
        <div className="p-3 border-t bg-yellow-500/10 border-yellow-500/20">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Type your response..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            <Button size="sm" onClick={handleSendInput} disabled={!inputValue.trim()}>
              <Send className="w-4 h-4 mr-1" />
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
