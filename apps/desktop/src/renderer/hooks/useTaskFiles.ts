import { useEffect, useState } from 'react';
import { api, wsClient } from '../lib/api';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  status: FileStatus;
  added: number;
  removed: number;
  binary: boolean;
}

/**
 * Live list of files changed on a task's branch. Initial fetch from
 * `GET /tasks/:id/diff/files`, then subscribed to the `task:files_changed`
 * WS event for updates as the agent edits more files.
 *
 * Used by `TaskFilesPanel` (list + diffs), the Files tab badge, and
 * the per-row "+NN -MM" summary in the task list. The `enabled` flag
 * lets list-row callers skip the fetch for tasks that have no branch
 * yet (nothing to diff).
 */
export function useTaskFiles(
  taskId: string,
  options: { enabled?: boolean } = {},
): {
  files: ChangedFile[];
  loading: boolean;
  error: string | null;
} {
  const { enabled = true } = options;
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setFiles([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.tasks
      .getChangedFiles(taskId)
      .then((data) => {
        if (cancelled) return;
        setFiles(data.files);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to list changed files');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const unsub = wsClient.on<{
      taskId: string;
      files: ChangedFile[];
    }>('task:files_changed', (payload) => {
      if (payload.taskId !== taskId) return;
      setFiles(payload.files);
    });
    return () => unsub();
  }, [taskId, enabled]);

  return { files, loading, error };
}
