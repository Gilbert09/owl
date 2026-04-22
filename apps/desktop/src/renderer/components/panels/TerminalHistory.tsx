import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
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
 * Renders a completed task's terminal/transcript inline inside the
 * Terminal tab. Structured tasks (everything since Slice 4) render via
 * `AgentConversation` in read-only mode; pre-structured tasks fall
 * back to a plain `<pre>` dump of the old `terminal_output` column so
 * historical work stays inspectable.
 *
 * There's no collapse toggle — the whole component is the tab body,
 * so hiding its own content would leave an empty panel.
 */
export function TerminalHistory({ taskId }: TerminalHistoryProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);

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
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading terminal…
      </div>
    );
  }

  if (!snapshot) return null;

  const hasTranscript = (snapshot.transcript?.length ?? 0) > 0;
  const hasLegacy = snapshot.legacyOutput.length > 0;
  if (!hasTranscript && !hasLegacy) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        No terminal output recorded for this task.
      </p>
    );
  }

  return (
    <div className="h-full bg-[#1e1e1e] rounded-lg overflow-hidden border">
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
  );
}
