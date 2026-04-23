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
  /**
   * 'live' = served from a live git query against the env,
   * 'cache' = served from the `metadata.finalFiles` snapshot.
   * The UI can use this to surface an "env offline — showing
   * cached diffs" hint when the branch isn't reachable.
   */
  source: 'live' | 'cache' | null;
} {
  const { enabled = true } = options;
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'live' | 'cache' | null>(null);

  useEffect(() => {
    if (!enabled) {
      setFiles([]);
      setLoading(false);
      setError(null);
      setSource(null);
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
        setSource(data.source);
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
      // Live WS updates only fire on in_progress tasks via
      // TaskFileWatcher, so we're always 'live' when one lands.
      setSource('live');
    });
    return () => unsub();
  }, [taskId, enabled]);

  return { files, loading, error, source };
}
