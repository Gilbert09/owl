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
 * Used by both `TaskFilesPanel` (renders the list + diffs) and the
 * Files tab button (renders the count badge), so the subscription is
 * shared rather than duplicated.
 */
export function useTaskFiles(taskId: string): {
  files: ChangedFile[];
  loading: boolean;
  error: string | null;
} {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [taskId]);

  useEffect(() => {
    const unsub = wsClient.on<{
      taskId: string;
      files: ChangedFile[];
    }>('task:files_changed', (payload) => {
      if (payload.taskId !== taskId) return;
      setFiles(payload.files);
    });
    return () => unsub();
  }, [taskId]);

  return { files, loading, error };
}
