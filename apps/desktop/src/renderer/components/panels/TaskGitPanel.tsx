import { useEffect, useRef } from 'react';
import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTaskGitLog } from '../../hooks/useTaskGitLog';

interface TaskGitPanelProps {
  taskId: string;
}

/**
 * Audit view of every git command FastOwl ran on the task: prepare
 * branch, commit, push, stash, reset, etc. Each entry shows command,
 * exit code, duration, and a preview of stdout/stderr. Helps debug
 * "why didn't approve push anything?" without tail-ing backend logs.
 */
export function TaskGitPanel({ taskId }: TaskGitPanelProps) {
  const { entries, loading, error } = useTaskGitLog(taskId);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest entry on append.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length]);

  if (loading && entries.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading git log…
      </div>
    );
  }

  if (error) {
    return <p className="p-6 text-sm text-muted-foreground">Couldn't load git log: {error}</p>;
  }

  if (entries.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        No git activity recorded yet. Commands appear here as soon as the task starts, commits, or pushes.
      </p>
    );
  }

  return (
    <div className="border rounded-lg bg-card overflow-auto h-full min-h-[300px]">
      <ul className="divide-y">
        {entries.map((entry, idx) => {
          const ok = entry.exitCode === 0;
          return (
            <li key={`${entry.ts}-${idx}`} className="p-3 text-xs">
              <div className="flex items-start gap-2">
                {ok ? (
                  <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-green-600 dark:text-green-500" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-600 dark:text-red-500" />
                )}
                <div className="flex-1 min-w-0">
                  <pre className="font-mono whitespace-pre-wrap break-all">{entry.command}</pre>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>exit {entry.exitCode}</span>
                    <span>{entry.durationMs}ms</span>
                    {entry.cwd && (
                      <span className="font-mono truncate" title={entry.cwd}>
                        {entry.cwd}
                      </span>
                    )}
                    <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                  </div>
                  {entry.stderrPreview && (
                    <pre
                      className={cn(
                        'mt-2 font-mono text-[11px] whitespace-pre-wrap break-all rounded p-2',
                        ok ? 'bg-muted/50' : 'bg-red-500/10 text-red-700 dark:text-red-400'
                      )}
                    >
                      {entry.stderrPreview}
                    </pre>
                  )}
                  {entry.stdoutPreview && entry.stdoutPreview.trim() && (
                    <pre className="mt-2 font-mono text-[11px] whitespace-pre-wrap break-all rounded p-2 bg-muted/30">
                      {entry.stdoutPreview}
                    </pre>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div ref={bottomRef} />
    </div>
  );
}
