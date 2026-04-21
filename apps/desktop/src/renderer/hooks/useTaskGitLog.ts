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
    api.tasks
      .getGitLog(taskId)
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries);
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
      setEntries((prev) => [...prev, payload.entry].slice(-200));
    });
    return () => unsub();
  }, [taskId]);

  return { entries, loading, error };
}
