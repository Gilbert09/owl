import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleDot,
  FileDiff,
  FileMinus,
  FilePlus,
  FileText,
  Loader2,
} from 'lucide-react';
import * as Diff2Html from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib/types';
import 'diff2html/bundles/css/diff2html.min.css';
import DOMPurify from 'dompurify';
import { cn } from '../../lib/utils';
import { api, wsClient } from '../../lib/api';
import { useTaskFiles, type ChangedFile } from '../../hooks/useTaskFiles';

interface TaskFilesPanelProps {
  taskId: string;
}

export function TaskFilesPanel({ taskId }: TaskFilesPanelProps) {
  const { files, loading, error } = useTaskFiles(taskId);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [writingPaths, setWritingPaths] = useState<Set<string>>(new Set());
  const [pulseKey, setPulseKey] = useState(0);

  // Ref so the WS handler can see the freshest selection without
  // re-subscribing on every click.
  const userTouchedSelectionRef = useRef(false);

  // Bump pulseKey whenever the live file list changes so the diff
  // viewer re-fetches the currently selected file.
  useEffect(() => {
    setPulseKey((k) => k + 1);
  }, [files]);

  useEffect(() => {
    // Track in-flight writes from tool_use events so we can render a
    // pulse next to the path Claude is currently editing.
    const unsubEvents = wsClient.on<{
      taskId: string;
      event: {
        type?: string;
        message?: { content?: unknown };
      };
    }>('task:event', (payload) => {
      if (payload.taskId !== taskId) return;
      const content = payload.event?.message?.content;
      if (!Array.isArray(content)) return;

      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue;
        const b = raw as {
          type?: string;
          name?: string;
          id?: string;
          input?: { file_path?: string; path?: string };
          tool_use_id?: string;
        };
        if (b.type === 'tool_use') {
          const path = b.input?.file_path || b.input?.path;
          if (!path) continue;
          if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name ?? '')) continue;
          setWritingPaths((prev) => {
            const next = new Set(prev);
            next.add(toRepoRelative(path));
            return next;
          });
          // Clear after 2s — matching tool_result clears sooner (below)
          // but this is a safety net in case we miss it.
          window.setTimeout(() => {
            setWritingPaths((prev) => {
              const next = new Set(prev);
              next.delete(toRepoRelative(path));
              return next;
            });
          }, 2000);
        } else if (b.type === 'tool_result') {
          // We don't know the path directly from the result; the 2s
          // timeout handles clearing. No-op for now.
        }
      }
    });

    return () => {
      unsubEvents();
    };
  }, [taskId]);

  // Auto-select the first file if the user hasn't picked one yet.
  useEffect(() => {
    if (userTouchedSelectionRef.current) return;
    if (!selectedPath && files.length > 0) {
      setSelectedPath(files[0].path);
    }
  }, [files, selectedPath]);

  const handleSelect = (path: string) => {
    userTouchedSelectionRef.current = true;
    setSelectedPath(path);
  };

  if (loading && files.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading files…
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-muted-foreground p-6">
        Couldn't load files: {error}
      </p>
    );
  }

  if (files.length === 0) {
    return (
      <p className="text-sm text-muted-foreground p-6">
        No changes detected against the base branch yet.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-[300px] min-w-0 border rounded-lg overflow-hidden bg-card">
      <div className="w-56 min-w-[160px] max-w-[40%] shrink-0 border-r bg-muted/30 overflow-auto">
        <ul className="text-sm">
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              selected={selectedPath === f.path}
              writing={writingPaths.has(f.path)}
              pulseKey={pulseKey}
              onClick={() => handleSelect(f.path)}
            />
          ))}
        </ul>
      </div>
      <div className="flex-1 min-w-0 bg-card overflow-auto">
        {selectedPath ? (
          <FileDiffView taskId={taskId} path={selectedPath} refreshKey={pulseKey} />
        ) : (
          <div className="p-6 text-sm text-muted-foreground">
            Select a file to view its diff.
          </div>
        )}
      </div>
    </div>
  );
}

interface FileRowProps {
  file: ChangedFile;
  selected: boolean;
  writing: boolean;
  pulseKey: number;
  onClick: () => void;
}

function FileRow({ file, selected, writing, onClick }: FileRowProps) {
  const StatusIcon =
    file.status === 'added' || file.status === 'untracked'
      ? FilePlus
      : file.status === 'deleted'
        ? FileMinus
        : file.status === 'renamed'
          ? FileDiff
          : FileText;
  const statusColor =
    file.status === 'added' || file.status === 'untracked'
      ? 'text-green-600 dark:text-green-500'
      : file.status === 'deleted'
        ? 'text-red-600 dark:text-red-500'
        : 'text-muted-foreground';

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent font-mono text-xs',
          selected && 'bg-accent'
        )}
      >
        <StatusIcon className={cn('w-3.5 h-3.5 shrink-0', statusColor)} />
        <span className="flex-1 min-w-0 truncate" title={file.path}>
          {file.path}
        </span>
        {writing && (
          <CircleDot
            className="w-3 h-3 text-amber-500 animate-pulse"
            aria-label="Being edited"
          />
        )}
        {!file.binary && (file.added > 0 || file.removed > 0) && (
          <span className="ml-2 text-[11px] tabular-nums">
            {file.added > 0 && <span className="text-green-600 dark:text-green-500">+{file.added}</span>}
            {file.added > 0 && file.removed > 0 && ' '}
            {file.removed > 0 && <span className="text-red-600 dark:text-red-500">-{file.removed}</span>}
          </span>
        )}
        {file.binary && <span className="text-[11px] text-muted-foreground">bin</span>}
      </button>
    </li>
  );
}

interface FileDiffViewProps {
  taskId: string;
  path: string;
  refreshKey: number;
}

function FileDiffView({ taskId, path, refreshKey }: FileDiffViewProps) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.tasks
      .getFileDiff(taskId, path)
      .then((data) => {
        if (cancelled) return;
        setDiff(data.diff);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load file diff');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, path, refreshKey]);

  const html = useMemo(() => {
    if (!diff || diff.trim().length === 0) return '';
    // diff2html parses unified-diff text and renders a GitHub-style
    // side-by-side or line-by-line HTML view. We render line-by-line
    // inline so it flows with the panel; the "github" colorScheme
    // follows the app theme via CSS variables we override below.
    const raw = Diff2Html.html(diff, {
      outputFormat: 'line-by-line',
      drawFileList: false,
      matching: 'lines',
      colorScheme: ColorSchemeType.AUTO,
      renderNothingWhenEmpty: true,
    });
    // Diff bodies come from the user's own repos, but a malicious
    // upstream could smuggle HTML that diff2html's escape misses.
    // Sanitize before dangerouslySetInnerHTML — belt-and-braces.
    return DOMPurify.sanitize(raw);
  }, [diff]);

  if (loading && !diff) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading diff…
      </div>
    );
  }

  if (error) {
    return <p className="p-6 text-sm text-muted-foreground">Error: {error}</p>;
  }

  if (!diff || diff.trim().length === 0 || !html) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        No diff available for this file.
      </p>
    );
  }

  // HTML is DOMPurify-sanitized diff2html output.
  return <div className="diff2html-wrapper" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * tool_use inputs carry absolute paths (`/Users/.../repo/src/foo.ts`);
 * our file list uses repo-relative paths. Strip any leading prefix up
 * to the first match of a known repo directory marker. This is a
 * heuristic — good enough to align pulse dots with the file list in
 * the common case, and a silent no-op when the path is already short.
 */
function toRepoRelative(path: string): string {
  // Any absolute path segment like "/Users/x/dev/owner/repo/src/foo.ts"
  // likely contains the repo name twice. We just take the part after
  // the last known directory indicator. Best-effort only.
  const idx = path.lastIndexOf('/');
  if (idx === -1) return path;
  // Heuristic: strip everything up to a src/, app/, packages/, apps/
  // prefix if present.
  const markers = ['/src/', '/app/', '/packages/', '/apps/', '/lib/', '/test/', '/tests/'];
  for (const m of markers) {
    const i = path.indexOf(m);
    if (i !== -1) return path.slice(i + 1);
  }
  return path;
}
