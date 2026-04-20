import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Terminal as TerminalIcon } from 'lucide-react';
import { Button } from '../ui/button';
import { AgentConversation } from '../terminal/AgentConversation';
import { api } from '../../lib/api';
import type { AgentEvent } from '@fastowl/shared';

interface TerminalHistoryProps {
  taskId: string;
}

interface Snapshot {
  /** Legacy PTY byte dump for tasks that pre-date the structured renderer. */
  legacyOutput: string;
  transcript?: AgentEvent[];
}

/**
 * Shows a completed task's transcript below the task detail view.
 * Structured tasks (everything since Slice 4) render via
 * `AgentConversation` in read-only mode; pre-structured tasks fall
 * back to a plain `<pre>` dump of the old `terminal_output` column
 * so historical work stays inspectable.
 */
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
          legacyOutput: data.terminalOutput || '',
          transcript: data.transcript,
        });
      })
      .catch((err) => {
        console.error('Failed to load terminal history:', err);
        if (!cancelled) setSnapshot({ legacyOutput: '' });
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

  const hasTranscript = (snapshot.transcript?.length ?? 0) > 0;
  const hasLegacy = snapshot.legacyOutput.length > 0;
  if (!hasTranscript && !hasLegacy) return null;

  const summary = hasTranscript
    ? `${snapshot.transcript?.length ?? 0} events`
    : `${snapshot.legacyOutput.length.toLocaleString()} chars`;

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
          {hasTranscript ? (
            <AgentConversation
              taskId={taskId}
              transcript={snapshot.transcript}
              interactive={false}
            />
          ) : (
            <pre className="h-full overflow-auto p-3 text-xs font-mono text-foreground/80 whitespace-pre-wrap">
              {snapshot.legacyOutput}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
