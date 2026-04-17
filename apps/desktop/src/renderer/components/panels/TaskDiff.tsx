import React, { useEffect, useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, GitBranch, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { api } from '../../lib/api';

interface TaskDiffProps {
  taskId: string;
}

export function TaskDiff({ taskId }: TaskDiffProps) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiff(null);

    api.tasks
      .getDiff(taskId)
      .then((data) => {
        if (!cancelled) setDiff(data.diff || '');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load diff');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const lines = useMemo(() => (diff ?? '').split('\n'), [diff]);
  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
  }, [lines]);

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-2 text-sm font-medium mb-2">
          <GitBranch className="w-4 h-4" />
          Diff
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading diff...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <div className="flex items-center gap-2 text-sm font-medium mb-2">
          <GitBranch className="w-4 h-4" />
          Diff
        </div>
        <p className="text-sm text-muted-foreground">
          Couldn't load diff: {error}
        </p>
      </div>
    );
  }

  if (!diff || diff.trim().length === 0) {
    return (
      <div>
        <div className="flex items-center gap-2 text-sm font-medium mb-2">
          <GitBranch className="w-4 h-4" />
          Diff
        </div>
        <p className="text-sm text-muted-foreground">
          No changes detected against the base branch.
        </p>
      </div>
    );
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
        <GitBranch className="w-4 h-4 mr-1" />
        Diff
        <span className="ml-2 text-xs font-normal">
          <span className="text-green-500">+{stats.added}</span>{' '}
          <span className="text-red-500">-{stats.removed}</span>
        </span>
      </Button>
      {expanded && (
        <div className="rounded-lg border bg-[#0b0b0b] overflow-auto max-h-96">
          <pre className="text-xs font-mono leading-5 p-3">
            {lines.map((line, idx) => {
              let color = 'text-slate-300';
              if (line.startsWith('+++') || line.startsWith('---')) color = 'text-slate-500';
              else if (line.startsWith('+')) color = 'text-green-400';
              else if (line.startsWith('-')) color = 'text-red-400';
              else if (line.startsWith('@@')) color = 'text-cyan-400';
              else if (line.startsWith('diff ') || line.startsWith('index ')) color = 'text-slate-500';
              return (
                <div key={idx} className={color}>
                  {line || ' '}
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
}
