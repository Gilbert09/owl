import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Terminal as TerminalIcon } from 'lucide-react';
import { Button } from '../ui/button';
import { XTerm } from '../terminal/XTerm';
import { api } from '../../lib/api';

interface TerminalHistoryProps {
  taskId: string;
}

export function TerminalHistory({ taskId }: TerminalHistoryProps) {
  const [output, setOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setOutput(null);

    api.tasks
      .getTerminal(taskId)
      .then((data) => {
        if (!cancelled) setOutput(data.terminalOutput || '');
      })
      .catch((err) => {
        console.error('Failed to load terminal history:', err);
        if (!cancelled) setOutput('');
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

  if (!output) {
    return null;
  }

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
        <span className="ml-2 text-xs text-muted-foreground font-normal">
          ({output.length.toLocaleString()} chars)
        </span>
      </Button>
      {expanded && (
        <div className="h-96 bg-[#1e1e1e] rounded-lg overflow-hidden border">
          <XTerm output={output} inputEnabled={false} />
        </div>
      )}
    </div>
  );
}
