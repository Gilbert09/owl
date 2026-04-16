import React, { useState, useEffect, useCallback } from 'react';
import {
  GitPullRequest,
  GitMerge,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  RefreshCw,
  Clock,
} from 'lucide-react';
import { api, type GitHubPullRequest, type WatchedRepo } from '../../lib/api';
import { useWorkspaceStore } from '../../stores/workspace';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { PRDetailModal } from '../modals/PRDetailModal';

interface PRWithRepo extends GitHubPullRequest {
  repo: WatchedRepo;
  checksStatus?: 'success' | 'failure' | 'pending' | 'unknown';
}

export function PRListWidget() {
  const { currentWorkspaceId } = useWorkspaceStore();
  const [prs, setPrs] = useState<PRWithRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPR, setSelectedPR] = useState<PRWithRepo | null>(null);

  const loadPRs = useCallback(async () => {
    if (!currentWorkspaceId) {
      setPrs([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // First check if GitHub is connected
      const status = await api.github.getStatus(currentWorkspaceId);
      if (!status.connected) {
        setPrs([]);
        setLoading(false);
        return;
      }

      // Get watched repos
      const repos = await api.repositories.list(currentWorkspaceId);
      if (repos.length === 0) {
        setPrs([]);
        setLoading(false);
        return;
      }

      // Fetch PRs for each watched repo
      const allPRs: PRWithRepo[] = [];
      for (const repo of repos) {
        try {
          const repoPRs = await api.github.listPullRequests(
            currentWorkspaceId,
            repo.owner,
            repo.repo
          );

          // Get checks status for each PR
          for (const pr of repoPRs) {
            let checksStatus: 'success' | 'failure' | 'pending' | 'unknown' = 'unknown';
            try {
              const checks = await api.github.getPRChecks(
                currentWorkspaceId,
                repo.owner,
                repo.repo,
                pr.number
              );
              if (checks.check_runs.length > 0) {
                const allCompleted = checks.check_runs.every(c => c.status === 'completed');
                if (!allCompleted) {
                  checksStatus = 'pending';
                } else {
                  const allSuccess = checks.check_runs.every(c => c.conclusion === 'success');
                  checksStatus = allSuccess ? 'success' : 'failure';
                }
              }
            } catch {
              // Ignore check fetch errors
            }

            allPRs.push({
              ...pr,
              repo,
              checksStatus,
            });
          }
        } catch {
          // Skip repos that fail to load
        }
      }

      // Sort by updated_at (most recent first)
      allPRs.sort((a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );

      setPrs(allPRs);
    } catch (err: any) {
      setError(err.message || 'Failed to load pull requests');
    } finally {
      setLoading(false);
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    loadPRs();
  }, [loadPRs]);

  const getCheckStatusIcon = (status: PRWithRepo['checksStatus']) => {
    switch (status) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-green-400" />;
      case 'failure':
        return <XCircle className="w-4 h-4 text-red-400" />;
      case 'pending':
        return <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />;
      default:
        return <AlertCircle className="w-4 h-4 text-zinc-500" />;
    }
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  if (!currentWorkspaceId) {
    return null;
  }

  return (
    <Card className="flex flex-col h-full">
      <div className="p-3 border-b flex items-center justify-between">
        <h3 className="font-medium flex items-center gap-2">
          <GitPullRequest className="w-4 h-4" />
          Pull Requests
        </h3>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={loadPRs}
          disabled={loading}
        >
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {loading && prs.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
          </div>
        ) : error ? (
          <div className="p-4 text-sm text-red-400">{error}</div>
        ) : prs.length === 0 ? (
          <div className="p-4 text-sm text-zinc-500 text-center">
            No open pull requests
          </div>
        ) : (
          <div className="divide-y divide-zinc-800">
            {prs.map((pr) => (
              <button
                key={`${pr.repo.id}-${pr.id}`}
                className="w-full p-3 hover:bg-zinc-800/50 text-left transition-colors"
                onClick={() => setSelectedPR(pr)}
              >
                <div className="flex items-start gap-2">
                  <GitPullRequest className="w-4 h-4 mt-0.5 text-green-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {pr.title}
                      </span>
                      {pr.draft && (
                        <Badge variant="outline" className="text-xs">Draft</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                      <span>{pr.repo.fullName}#{pr.number}</span>
                      <span className="text-zinc-600">|</span>
                      <span>{pr.user.login}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1.5">
                      {getCheckStatusIcon(pr.checksStatus)}
                      {pr.mergeable === true && (
                        <span className="flex items-center gap-1 text-xs text-green-400">
                          <GitMerge className="w-3 h-3" />
                          Ready
                        </span>
                      )}
                      {pr.mergeable === false && (
                        <span className="flex items-center gap-1 text-xs text-red-400">
                          <AlertCircle className="w-3 h-3" />
                          Conflicts
                        </span>
                      )}
                      <span className="flex items-center gap-1 text-xs text-zinc-500 ml-auto">
                        <Clock className="w-3 h-3" />
                        {formatTimeAgo(pr.updated_at)}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>

      {selectedPR && (
        <PRDetailModal
          open={!!selectedPR}
          onOpenChange={(open) => !open && setSelectedPR(null)}
          workspaceId={currentWorkspaceId}
          owner={selectedPR.repo.owner}
          repo={selectedPR.repo.repo}
          prNumber={selectedPR.number}
        />
      )}
    </Card>
  );
}
