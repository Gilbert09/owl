import { useEffect, useState } from 'react';
import { Loader2, Eye, TriangleAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../ui/dialog';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { api, ApiError } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import { toast } from '../../../stores/toast';

/**
 * Track an arbitrary PR — normally one someone ELSE wrote — so its CI, checks
 * and mergeable state show up on My PRs.
 *
 * A PR can only be tracked inside a repo the workspace watches: the row's
 * repository FK is what the poller keys off and what makes GitHub webhooks
 * reach the PR at all. So when the pasted link names a repo we don't have, the
 * backend answers 409 `repo_not_watched` and this modal asks before re-sending
 * with `confirmAddRepo`. The local repo list renders that warning up front
 * where it can, but the server's 409 is the authority — the local list can be
 * stale, and only the server sees a concurrent repo removal.
 */

const PLACEHOLDER = 'https://github.com/owner/repo/pull/1234';

/**
 * Client-side twin of the backend's `parsePrRef`, used ONLY to preview the
 * repo warning while the user types. It is deliberately allowed to be more
 * permissive than the server: a false positive here shows a warning that the
 * submit then corrects, whereas a false negative would hide it.
 */
function previewRepo(input: string): { owner: string; repo: string } | null {
  const raw = input.trim();
  const m =
    raw.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+/) ??
    raw.match(/^([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)\d+$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

interface WatchPRModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WatchPRModal({ open, onOpenChange }: WatchPRModalProps) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const repositories = useWorkspaceStore((s) => s.repositories);
  const setRepositories = useWorkspaceStore((s) => s.setRepositories);
  const upsertRow = usePullRequestStore((s) => s.upsertRow);

  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the server (or the local list) says the repo needs adding. Holds
  // the coordinates so the copy can name the repo the user is agreeing to.
  const [needsRepo, setNeedsRepo] = useState<{ owner: string; repo: string } | null>(null);

  const preview = previewRepo(url);
  const previewUnwatched =
    preview !== null &&
    !repositories.some(
      (r) =>
        r.owner.toLowerCase() === preview.owner.toLowerCase() &&
        r.repo.toLowerCase() === preview.repo.toLowerCase()
    );
  // The pending repo the copy names: the server's answer if we have it, else
  // what the local list predicts.
  const pendingRepo = needsRepo ?? (previewUnwatched ? preview : null);

  // Editing the URL invalidates a confirmation given for a different repo.
  useEffect(() => {
    setNeedsRepo(null);
    setError(null);
  }, [url]);

  function reset() {
    setUrl('');
    setError(null);
    setNeedsRepo(null);
  }

  function handleClose(next: boolean) {
    if (submitting) return;
    if (!next) reset();
    onOpenChange(next);
  }

  async function submit(confirmAddRepo: boolean) {
    if (!workspaceId || !url.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await api.pullRequests.watch({
        workspaceId,
        url: url.trim(),
        confirmAddRepo: confirmAddRepo || undefined,
      });
      // The row arrives in full, so insert it rather than re-listing — a
      // re-list would force-poll GitHub for something we already have.
      upsertRow(row);
      const ref = `${row.owner}/${row.repo}#${row.number}`;
      if (row.repoAdded) {
        // Keep the Settings repo list honest without a refetch.
        setRepositories([
          ...repositories,
          {
            id: row.repositoryId,
            workspaceId: row.workspaceId,
            owner: row.owner,
            repo: row.repo,
            fullName: `${row.owner}/${row.repo}`,
          },
        ]);
      }
      if (row.alreadyTracked) {
        toast.info(`${ref} is already in your list`);
      } else {
        toast.success(
          `Now watching ${ref}`,
          row.repoAdded ? `Added ${row.owner}/${row.repo} to this workspace` : undefined
        );
      }
      reset();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'repo_not_watched') {
        // Not an error the user has to fix — a decision they have to make.
        setNeedsRepo(preview);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not watch this PR');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const confirming = needsRepo !== null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={() => handleClose(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5" />
            Watch a pull request
          </DialogTitle>
          <DialogDescription>
            Paste a GitHub PR link to track its checks and mergeable state on My PRs.
            It does not have to be your own PR.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-sm font-medium">Pull request</label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={PLACEHOLDER}
              autoFocus
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url.trim() && !submitting) void submit(confirming);
              }}
              className="mt-1"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Also accepts <code>owner/repo#1234</code>.
            </p>
          </div>

          {pendingRepo && (
            <div
              data-attr="watch-pr-repo-warning"
              className="flex gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1">
                <p>
                  Talyn isn&apos;t watching{' '}
                  <span className="font-medium">
                    {pendingRepo.owner}/{pendingRepo.repo}
                  </span>{' '}
                  yet.
                </p>
                <p className="text-muted-foreground">
                  Watching this PR adds the repo to this workspace, which also surfaces
                  your own PRs and review requests there.
                </p>
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit(confirming)} disabled={!url.trim() || submitting}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : pendingRepo ? (
              'Add repo & watch PR'
            ) : (
              'Watch PR'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
