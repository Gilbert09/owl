import { useEffect, useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { api } from '../../lib/api';

interface ApproveTaskModalProps {
  taskId: string;
  taskTitle: string;
  open: boolean;
  onClose: () => void;
  onApproved: () => void;
  onApprove: (commitMessage: string) => Promise<void>;
}

export function ApproveTaskModal({
  taskId,
  taskTitle,
  open,
  onClose,
  onApproved,
  onApprove,
}: ApproveTaskModalProps) {
  const [message, setMessage] = useState('');
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingMessage(true);
    setError(null);
    api.tasks
      .proposeCommitMessage(taskId)
      .then((data) => {
        if (!cancelled) setMessage(data.message);
      })
      .catch((err) => {
        if (!cancelled) {
          setMessage(taskTitle);
          setError(err?.message || 'Failed to generate commit message');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingMessage(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, taskId, taskTitle]);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onApprove(message.trim());
      onApproved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="max-w-xl" onClose={onClose}>
        <DialogHeader>
          <DialogTitle>Commit &amp; push</DialogTitle>
          <DialogDescription>
            FastOwl will stage the working tree, commit on the task branch, and push it to origin.
            Edit the commit message below before continuing.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {loadingMessage ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              Generating commit message…
            </div>
          ) : (
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={10}
              className="font-mono text-sm"
              placeholder="Commit message"
              autoFocus
            />
          )}
          {error && (
            <p className="mt-2 text-sm text-red-500">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || loadingMessage || message.trim().length === 0}
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <CheckCircle className="w-4 h-4 mr-1" />
            )}
            Commit &amp; push
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
