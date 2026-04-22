import { useEffect, useState } from 'react';
import { api, wsClient } from '../lib/api';

export interface GitLogEntry {
  ts: string;
  command: string;
  cwd?: string;
  exitCode: number;
  stdoutPreview: string;
  stderrPreview: string;
  durationMs: number;
}

function entryKey(e: GitLogEntry): string {
  return `${e.ts}|${e.command}|${e.durationMs}`;
}

/**
 * Live audit log of every git command FastOwl ran on this task's
 * behalf. Initial fetch from `GET /tasks/:id/git-log`, then subscribed
 * to `task:git_log` for new entries appended during /start, /approve,
 * /reject, or scheduler-driven branch prep.
 */
export function useTaskGitLog(taskId: string): {
  entries: GitLogEntry[];
  loading: boolean;
  error: string | null;
} {
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Reset state when switching tasks — otherwise the merge below
    // would stitch the previous task's WS events onto the new task's
    // REST result.
    setEntries([]);
    api.tasks
      .getGitLog(taskId)
      .then((data) => {
        if (cancelled) return;
        // Merge instead of replace: WS events that arrived while the
        // REST request was in flight (and which may not be in the DB
        // snapshot) get preserved. Otherwise we wipe entries that only
        // reached us live. Dedup by ts+command+durationMs — good
        // enough because no two git commands in one ms are identical.
        setEntries((prev) => {
          const restKeys = new Set(data.entries.map(entryKey));
          const extras = prev.filter((e) => !restKeys.has(entryKey(e)));
          return [...data.entries, ...extras].slice(-200);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load git log');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  useEffect(() => {
    const unsub = wsClient.on<{
      taskId: string;
      entry: GitLogEntry;
    }>('task:git_log', (payload) => {
      if (payload.taskId !== taskId) return;
      setEntries((prev) => {
        const key = entryKey(payload.entry);
        if (prev.some((e) => entryKey(e) === key)) return prev; // dedup
        return [...prev, payload.entry].slice(-200);
      });
    });
    return () => unsub();
  }, [taskId]);

  return { entries, loading, error };
}
