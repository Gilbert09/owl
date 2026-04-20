import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Terminal as TerminalIcon } from 'lucide-react';
import { Button } from '../ui/button';
import { XTerm } from '../terminal/XTerm';
import { AgentConversation } from '../terminal/AgentConversation';
import { api } from '../../lib/api';
import type { AgentEvent } from '@fastowl/shared';

interface TerminalHistoryProps {
  taskId: string;
}


interface Snapshot {
  terminalOutput: string;
  transcript?: AgentEvent[];
  runtime: 'pty' | 'structured';
}

export function TerminalHistory({ taskId }: TerminalHistoryProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSnapshot(null);

    api.tasks
      .getTerminal(taskId)
      .then((data) => {
        if (cancelled) return;
        setSnapshot({
          terminalOutput: data.terminalOutput || '',
          transcript: data.transcript,
          runtime: (data.runtime as 'pty' | 'structured') ?? 'pty',
        });
      })
      .catch((err) => {
        console.error('Failed to load terminal history:', err);
        if (!cancelled) setSnapshot({ terminalOutput: '', runtime: 'pty' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-2 text-sm font-medium mb-2">
          <TerminalIcon className="w-4 h-4" />
          Terminal History
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading...
        </div>
      </div>
    );
  }

  if (!snapshot) return null;

  const hasContent =
    snapshot.runtime === 'structured'
      ? (snapshot.transcript?.length ?? 0) > 0
      : snapshot.terminalOutput.length > 0;
  if (!hasContent) return null;

  const summary =
    snapshot.runtime === 'structured'
      ? `${snapshot.transcript?.length ?? 0} events`
      : `${snapshot.terminalOutput.length.toLocaleString()} chars`;

  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        className="h-auto p-0 mb-2 font-medium hover:bg-transparent"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 mr-1" />
        ) : (
          <ChevronRight className="w-4 h-4 mr-1" />
        )}
        <TerminalIcon className="w-4 h-4 mr-1" />
        Terminal History
        <span className="ml-2 text-xs text-muted-foreground font-normal">({summary})</span>
      </Button>
      {expanded && (
        <div className="h-96 bg-[#1e1e1e] rounded-lg overflow-hidden border">
          {snapshot.runtime === 'structured' ? (
            <AgentConversation
              taskId={taskId}
              transcript={snapshot.transcript}
              interactive={false}
            />
          ) : (
            <XTerm output={snapshot.terminalOutput} inputEnabled={false} />
          )}
        </div>
      )}
    </div>
  );
}
