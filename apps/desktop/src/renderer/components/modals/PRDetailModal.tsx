import React, { useState, useEffect, useCallback } from 'react';
import {
  GitPullRequest,
  GitMerge,
  MessageSquare,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
  FileCode,
  Clock,
  User,
  GitBranch,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Select } from '../ui/select';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { api, type GitHubPullRequest, type GitHubPRFile, type GitHubCheckRun } from '../../lib/api';

interface PRDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  owner: string;
  repo: string;
  prNumber: number;
}

type ActionType = 'merge' | 'comment' | 'approve' | 'request_changes' | null;

export function PRDetailModal({
  open,
  onOpenChange,
  workspaceId,
  owner,
  repo,
  prNumber,
}: PRDetailModalProps) {
  const [pr, setPr] = useState<GitHubPullRequest | null>(null);
  const [files, setFiles] = useState<GitHubPRFile[]>([]);
  const [checks, setChecks] = useState<GitHubCheckRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [actionType, setActionType] = useState<ActionType>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [mergeMethod, setMergeMethod] = useState<'merge' | 'squash' | 'rebase'>('squash');

  // Fetch PR data
  useEffect(() => {
    if (!open) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        const [prData, filesData, checksData] = await Promise.all([
          api.github.getPullRequest(workspaceId, owner, repo, prNumber),
          api.github.getPRFiles(workspaceId, owner, repo, prNumber),
          api.github.getPRChecks(workspaceId, owner, repo, prNumber),
        ]);

        setPr(prData);
        setFiles(filesData);
        setChecks(checksData.check_runs);
      } catch (err: any) {
        setError(err.message || 'Failed to load PR details');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [open, workspaceId, owner, repo, prNumber]);

  const handleMerge = useCallback(async () => {
    setActionLoading(true);
    setActionError(null);

    try {
      await api.github.mergePullRequest(workspaceId, owner, repo, prNumber, {
        merge_method: mergeMethod,
      });
      onOpenChange(false);
    } catch (err: any) {
      setActionError(err.message || 'Failed to merge PR');
    } finally {
      setActionLoading(false);
    }
  }, [workspaceId, owner, repo, prNumber, mergeMethod, onOpenChange]);

  const handleComment = useCallback(async () => {
    if (!commentBody.trim()) return;

    setActionLoading(true);
    setActionError(null);

    try {
      await api.github.createPRComment(workspaceId, owner, repo, prNumber, commentBody);
      setCommentBody('');
      setActionType(null);
    } catch (err: any) {
      setActionError(err.message || 'Failed to add comment');
    } finally {
      setActionLoading(false);
    }
  }, [workspaceId, owner, repo, prNumber, commentBody]);

  const handleReview = useCallback(async (event: 'APPROVE' | 'REQUEST_CHANGES') => {
    setActionLoading(true);
    setActionError(null);

    try {
      await api.github.createPRReview(workspaceId, owner, repo, prNumber, {
        body: commentBody || undefined,
        event,
      });
      setCommentBody('');
      setActionType(null);
      onOpenChange(false);
    } catch (err: any) {
      setActionError(err.message || 'Failed to submit review');
    } finally {
      setActionLoading(false);
    }
  }, [workspaceId, owner, repo, prNumber, commentBody, onOpenChange]);

  const handleClose = useCallback(() => {
    if (!actionLoading) {
      onOpenChange(false);
      setActionType(null);
      setCommentBody('');
      setActionError(null);
    }
  }, [actionLoading, onOpenChange]);

  const getCheckStatusIcon = (check: GitHubCheckRun) => {
    if (check.status !== 'completed') {
      return <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />;
    }
    switch (check.conclusion) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-green-400" />;
      case 'failure':
        return <XCircle className="w-4 h-4 text-red-400" />;
      default:
        return <AlertCircle className="w-4 h-4 text-yellow-400" />;
    }
  };

  const getFileStatusColor = (status: string) => {
    switch (status) {
      case 'added':
        return 'text-green-400';
      case 'removed':
        return 'text-red-400';
      case 'modified':
        return 'text-yellow-400';
      default:
        return 'text-zinc-400';
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl" onClose={handleClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequest className="w-5 h-5" />
            Pull Request #{prNumber}
          </DialogTitle>
          <DialogDescription>
            {owner}/{repo}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
          </div>
        ) : error ? (
          <div className="p-4 rounded-md bg-red-500/10 border border-red-500/20 text-red-400">
            {error}
          </div>
        ) : pr ? (
          <div className="space-y-4 py-4">
            {/* PR Title and Status */}
            <div>
              <h3 className="text-lg font-semibold text-zinc-100">{pr.title}</h3>
              <div className="flex items-center gap-2 mt-2 text-sm text-zinc-400">
                <User className="w-4 h-4" />
                <span>{pr.user.login}</span>
                <span className="text-zinc-600">|</span>
                <Clock className="w-4 h-4" />
                <span>{new Date(pr.created_at).toLocaleDateString()}</span>
                <span className="text-zinc-600">|</span>
                <Badge variant={pr.state === 'open' ? 'default' : 'secondary'}>
                  {pr.state}
                </Badge>
                {pr.draft && <Badge variant="outline">Draft</Badge>}
              </div>
            </div>

            {/* Branch Info */}
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <GitBranch className="w-4 h-4" />
              <code className="px-1 bg-zinc-800 rounded">{pr.head.ref}</code>
              <span>into</span>
              <code className="px-1 bg-zinc-800 rounded">{pr.base.ref}</code>
            </div>

            {/* Mergeable Status */}
            {pr.state === 'open' && (
              <div className="flex items-center gap-2 text-sm">
                {pr.mergeable === true ? (
                  <>
                    <CheckCircle className="w-4 h-4 text-green-400" />
                    <span className="text-green-400">Ready to merge</span>
                  </>
                ) : pr.mergeable === false ? (
                  <>
                    <XCircle className="w-4 h-4 text-red-400" />
                    <span className="text-red-400">Has merge conflicts</span>
                  </>
                ) : (
                  <>
                    <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />
                    <span className="text-yellow-400">Checking mergeability...</span>
                  </>
                )}
              </div>
            )}

            {/* CI Checks */}
            {checks.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-zinc-300">CI Checks</h4>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {checks.map((check) => (
                    <div
                      key={check.id}
                      className="flex items-center gap-2 text-sm text-zinc-400"
                    >
                      {getCheckStatusIcon(check)}
                      <span>{check.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Files Changed */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-zinc-300">
                Files Changed ({files.length})
              </h4>
              <ScrollArea className="h-32 border border-zinc-800 rounded-md p-2">
                <div className="space-y-1">
                  {files.map((file) => (
                    <div
                      key={file.filename}
                      className="flex items-center gap-2 text-sm"
                    >
                      <FileCode className={`w-4 h-4 ${getFileStatusColor(file.status)}`} />
                      <span className="text-zinc-400 truncate">{file.filename}</span>
                      <span className="text-green-400 text-xs">+{file.additions}</span>
                      <span className="text-red-400 text-xs">-{file.deletions}</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>

            {/* Action Panel */}
            {actionType === null && pr.state === 'open' && (
              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  size="sm"
                  onClick={() => setActionType('merge')}
                  disabled={!pr.mergeable}
                >
                  <GitMerge className="w-4 h-4 mr-1" />
                  Merge
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setActionType('approve')}
                >
                  <CheckCircle className="w-4 h-4 mr-1" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setActionType('request_changes')}
                >
                  <AlertCircle className="w-4 h-4 mr-1" />
                  Request Changes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setActionType('comment')}
                >
                  <MessageSquare className="w-4 h-4 mr-1" />
                  Comment
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => window.open(pr.html_url, '_blank')}
                >
                  <ExternalLink className="w-4 h-4 mr-1" />
                  Open in GitHub
                </Button>
              </div>
            )}

            {/* Merge Action */}
            {actionType === 'merge' && (
              <div className="space-y-3 p-3 bg-zinc-900 rounded-md border border-zinc-800">
                <h4 className="text-sm font-medium text-zinc-300">Merge Pull Request</h4>
                <Select
                  label="Merge Method"
                  value={mergeMethod}
                  onChange={(e) => setMergeMethod(e.target.value as any)}
                  disabled={actionLoading}
                >
                  <option value="squash">Squash and merge</option>
                  <option value="merge">Create merge commit</option>
                  <option value="rebase">Rebase and merge</option>
                </Select>
                <div className="flex gap-2">
                  <Button onClick={handleMerge} disabled={actionLoading}>
                    {actionLoading ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <GitMerge className="w-4 h-4 mr-2" />
                    )}
                    Confirm Merge
                  </Button>
                  <Button variant="outline" onClick={() => setActionType(null)} disabled={actionLoading}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Comment/Review Action */}
            {(actionType === 'comment' || actionType === 'approve' || actionType === 'request_changes') && (
              <div className="space-y-3 p-3 bg-zinc-900 rounded-md border border-zinc-800">
                <h4 className="text-sm font-medium text-zinc-300">
                  {actionType === 'comment' ? 'Add Comment' :
                   actionType === 'approve' ? 'Approve PR' : 'Request Changes'}
                </h4>
                <Textarea
                  placeholder={actionType === 'comment'
                    ? 'Write a comment...'
                    : 'Leave a review comment (optional)...'}
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  disabled={actionLoading}
                  rows={3}
                />
                <div className="flex gap-2">
                  {actionType === 'comment' ? (
                    <Button onClick={handleComment} disabled={actionLoading || !commentBody.trim()}>
                      {actionLoading ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <MessageSquare className="w-4 h-4 mr-2" />
                      )}
                      Add Comment
                    </Button>
                  ) : (
                    <Button
                      onClick={() => handleReview(actionType === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES')}
                      disabled={actionLoading}
                      variant={actionType === 'approve' ? 'default' : 'destructive'}
                    >
                      {actionLoading ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : actionType === 'approve' ? (
                        <CheckCircle className="w-4 h-4 mr-2" />
                      ) : (
                        <AlertCircle className="w-4 h-4 mr-2" />
                      )}
                      {actionType === 'approve' ? 'Approve' : 'Request Changes'}
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setActionType(null)} disabled={actionLoading}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Action Error */}
            {actionError && (
              <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                {actionError}
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={actionLoading}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
