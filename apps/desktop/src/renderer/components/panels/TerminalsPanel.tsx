import React, { useState, useCallback } from 'react';
import {
  Terminal,
  Plus,
  Maximize2,
  Play,
  Square,
  RotateCcw,
  AlertCircle,
  CheckCircle,
  Loader2,
  MessageSquare,
  Send,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { useAgentActions } from '../../hooks/useApi';
import { XTerm } from '../terminal/XTerm';
import { StartAgentModal } from '../modals/StartAgentModal';
import type { Agent, AgentStatus, AgentAttention } from '@fastowl/shared';

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

export function TerminalsPanel() {
  const { agents, environments, selectedAgentId, selectAgent } =
    useWorkspaceStore();
  const { sendInput, stopAgent } = useAgentActions();
  const [inputValue, setInputValue] = useState('');
  const [showStartModal, setShowStartModal] = useState(false);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  const handleSendInput = useCallback(async () => {
    if (!selectedAgent || !inputValue.trim()) return;
    try {
      await sendInput(selectedAgent.id, inputValue);
      setInputValue('');
    } catch (err) {
      console.error('Failed to send input:', err);
    }
  }, [selectedAgent, inputValue, sendInput]);

  const handleStopAgent = useCallback(async () => {
    if (!selectedAgent) return;
    try {
      await stopAgent(selectedAgent.id);
    } catch (err) {
      console.error('Failed to stop agent:', err);
    }
  }, [selectedAgent, stopAgent]);

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
    <>
      <StartAgentModal open={showStartModal} onOpenChange={setShowStartModal} />

      <div className="flex h-full">
        {/* Agent List */}
        <div className="w-72 border-r flex flex-col">
          <div className="flex items-center justify-between p-4 border-b">
            <div>
              <h2 className="text-lg font-semibold">Agents</h2>
              <p className="text-sm text-muted-foreground">
                {agents.filter((a) => a.status === 'working').length} active
              </p>
            </div>
            <Button size="sm" onClick={() => setShowStartModal(true)}>
              <Plus className="w-4 h-4 mr-1" />
              New
            </Button>
          </div>

        <ScrollArea className="flex-1">
          {agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center p-4">
              <Terminal className="w-10 h-10 text-muted-foreground/50 mb-3" />
              <h3 className="font-medium mb-1 text-sm">No agents running</h3>
              <p className="text-xs text-muted-foreground">
                Start an agent to begin working
              </p>
              <Button size="sm" className="mt-3" onClick={() => setShowStartModal(true)}>
                <Plus className="w-4 h-4 mr-1" />
                Start Agent
              </Button>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {agents.map((agent) => {
                const env = environments.find(
                  (e) => e.id === agent.environmentId
                );
                return (
                  <AgentListItem
                    key={agent.id}
                    agent={agent}
                    environmentName={env?.name || 'Unknown'}
                    isSelected={selectedAgentId === agent.id}
                    onSelect={() => selectAgent(agent.id)}
                  />
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Terminal View */}
      <div className="flex-1 flex flex-col">
        {selectedAgent ? (
          <>
            {/* Terminal Header */}
            <div className="flex items-center justify-between p-3 border-b bg-card">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    'w-3 h-3 rounded-full',
                    selectedAgent.status === 'working' && 'bg-blue-400 animate-pulse',
                    selectedAgent.status === 'idle' && 'bg-slate-400',
                    selectedAgent.status === 'awaiting_input' && 'bg-yellow-400',
                    selectedAgent.status === 'error' && 'bg-red-400',
                    selectedAgent.status === 'completed' && 'bg-green-400'
                  )}
                />
                <span className="font-medium text-sm">
                  Agent on{' '}
                  {environments.find((e) => e.id === selectedAgent.environmentId)
                    ?.name || 'Unknown'}
                </span>
                <Badge variant="outline" className="text-xs">
                  {statusConfig[selectedAgent.status].label}
                </Badge>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8" title="Restart">
                  <RotateCcw className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title="Stop Agent"
                  onClick={handleStopAgent}
                  disabled={selectedAgent.status === 'idle' || selectedAgent.status === 'completed'}
                >
                  <Square className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" title="Maximize">
                  <Maximize2 className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Terminal Content */}
            <div className="flex-1 bg-[#1e1e1e] overflow-hidden">
              <XTerm
                output={selectedAgent.terminalOutput || '$ Waiting for output...'}
                inputEnabled={selectedAgent.status === 'awaiting_input'}
              />
            </div>

            {/* Input Area (when awaiting input) */}
            {selectedAgent.status === 'awaiting_input' && (
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
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <Terminal className="w-16 h-16 text-muted-foreground/30 mb-4" />
            <h3 className="font-medium mb-2">No agent selected</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Select an agent from the list or start a new one
            </p>
            <Button onClick={() => setShowStartModal(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Start New Agent
            </Button>
          </div>
        )}
      </div>
      </div>
    </>
  );
}

interface AgentListItemProps {
  agent: Agent;
  environmentName: string;
  isSelected: boolean;
  onSelect: () => void;
}

function AgentListItem({
  agent,
  environmentName,
  isSelected,
  onSelect,
}: AgentListItemProps) {
  const StatusIcon = statusConfig[agent.status].icon;

  return (
    <Card
      className={cn(
        'p-3 cursor-pointer transition-colors border-l-4',
        attentionColors[agent.attention],
        isSelected ? 'bg-accent' : 'hover:bg-accent/50'
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 bg-secondary',
            statusConfig[agent.status].color
          )}
        >
          <StatusIcon
            className={cn(
              'w-4 h-4',
              agent.status === 'working' && 'animate-spin'
            )}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">
              {environmentName}
            </span>
            {agent.attention !== 'none' && (
              <div
                className={cn(
                  'w-2 h-2 rounded-full flex-shrink-0',
                  agent.attention === 'high' && 'bg-red-400',
                  agent.attention === 'medium' && 'bg-orange-400',
                  agent.attention === 'low' && 'bg-yellow-400'
                )}
              />
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {statusConfig[agent.status].label}
          </p>
        </div>
      </div>
    </Card>
  );
}
