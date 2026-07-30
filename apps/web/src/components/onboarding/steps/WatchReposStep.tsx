import React, { useCallback, useEffect, useState } from 'react';
import { Github, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Badge } from '../../ui/badge';
import { api, type GitHubRepo } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useWorkspaceActions } from '../../../hooks/useApi';
import { useGithubInstallations } from '../../../hooks/useGithubInstallations';
import { GithubInstallStatus } from '../../widgets/GithubInstallStatus';
import { isOwnerCovered } from '../../../lib/githubInstall';
import {
  REPO_CACHE_TTL_MS,
  readRepoCache,
  writeRepoCache,
  formatAge,
} from '../../../lib/repoCache';

const REPO_LIST_CAP = 500;

interface WatchReposStepProps {
  workspaceId: string;
}

/**
 * Step 3 — pick repositories to watch. Reuses the same localStorage repo
 * cache as the Settings card (one shared key per workspace) so the expensive
 * "all repos" fetch isn't repeated. Skippable: repos can be added later in
 * Settings → Workspace.
 */
export function WatchReposStep({ workspaceId }: WatchReposStepProps) {
  const { repositories, setRepositories } = useWorkspaceStore();
  const { refreshWorkspaces } = useWorkspaceActions();
  // Reaching this step means GitHub is connected (the wizard gates Next on it).
  const { installations, checked, loading, refresh } = useGithubInstallations(workspaceId, true);
  const [availableRepos, setAvailableRepos] = useState<GitHubRepo[]>([]);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [search, setSearch] = useState('');

  const refreshRepos = useCallback(async () => {
    setReposLoading(true);
    try {
      const repos = await api.github.listAllRepos(workspaceId);
      const now = Date.now();
      setAvailableRepos(repos);
      setFetchedAt(now);
      writeRepoCache(workspaceId, repos, now);
    } catch {
      // Keep whatever the cache gave us.
    } finally {
      setReposLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    const cached = readRepoCache(workspaceId);
    if (cached) {
      setAvailableRepos(cached.repos);
      setFetchedAt(cached.fetchedAt);
    }
    if (!cached || Date.now() - cached.fetchedAt > REPO_CACHE_TTL_MS) {
      void refreshRepos();
    }
  }, [workspaceId, refreshRepos]);

  async function handleAddRepo(repo: GitHubRepo) {
    setMutating(true);
    try {
      const watched = await api.repositories.add(workspaceId, repo.owner.login, repo.name);
      setRepositories([...repositories, watched]);
      // Keep the workspace's embedded repo list (the sidebar's "N repos"
      // count reads it) in sync — otherwise it stays at its pre-onboarding 0.
      void refreshWorkspaces();
    } finally {
      setMutating(false);
    }
  }

  async function handleRemoveRepo(id: string) {
    setMutating(true);
    try {
      await api.repositories.remove(id);
      setRepositories(repositories.filter((r) => r.id !== id));
      void refreshWorkspaces();
    } finally {
      setMutating(false);
    }
  }

  const matched = availableRepos
    .filter((repo) => !repositories.some((w) => w.fullName === repo.full_name))
    .filter((repo) =>
      search ? repo.full_name.toLowerCase().includes(search.toLowerCase()) : true
    )
    .sort((a, b) => a.full_name.toLowerCase().localeCompare(b.full_name.toLowerCase()));
  const filtered = matched.slice(0, REPO_LIST_CAP);
  const truncated = matched.length > REPO_LIST_CAP;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Pick the repositories you want Talyn to track. Their PRs, reviews, and CI status
        show up in the GitHub panel.
      </p>

      {repositories.length > 0 && (
        <div className="space-y-2">
          {repositories.map((repo) => (
            <div
              key={repo.id}
              className="flex items-center justify-between rounded bg-secondary p-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Github className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">{repo.fullName}</span>
                {checked && !isOwnerCovered(repo.owner, installations) && (
                  <Badge variant="warning" className="shrink-0 text-xs">
                    App not installed
                  </Badge>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-red-500 hover:bg-red-500/10 hover:text-red-600"
                onClick={() => handleRemoveRepo(repo.id)}
                disabled={mutating}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <GithubInstallStatus
        workspaceId={workspaceId}
        installations={installations}
        checked={checked}
        loading={loading}
        watchedOwners={repositories.map((r) => r.owner)}
        onRefresh={refresh}
      />

      <div className="flex items-center gap-2">
        <Input
          placeholder="Search all your repositories…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={refreshRepos}
          disabled={reposLoading}
          title="Re-fetch your repos + all your orgs' repos from GitHub"
        >
          <RefreshCw className={reposLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Your repos + every org you belong to.{' '}
        {reposLoading ? 'Refreshing…' : fetchedAt ? `Updated ${formatAge(fetchedAt)}.` : ''}
      </p>

      {reposLoading && availableRepos.length === 0 ? (
        <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Loading repositories…
        </p>
      ) : filtered.length > 0 ? (
        <div className="max-h-56 overflow-y-auto rounded-md border">
          {filtered.map((repo) => (
            <button
              key={repo.id}
              className="flex w-full items-center gap-2 p-2 text-left text-sm hover:bg-secondary"
              onClick={() => handleAddRepo(repo)}
              disabled={mutating}
            >
              <Github className="h-4 w-4 text-muted-foreground" />
              <span>{repo.full_name}</span>
              <span className="ml-auto flex items-center gap-1">
                {checked && !isOwnerCovered(repo.owner.login, installations) && (
                  <Badge variant="warning" className="text-xs">
                    App not installed
                  </Badge>
                )}
                {repo.private && (
                  <Badge variant="outline" className="text-xs">
                    Private
                  </Badge>
                )}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="p-2 text-sm text-muted-foreground">
          {search
            ? 'No matching repositories. Try Refresh if a repo is missing.'
            : 'No repositories found. Try Refresh.'}
        </p>
      )}
      {truncated && (
        <p className="text-xs text-muted-foreground">
          Showing first {REPO_LIST_CAP} of {matched.length}. Type to narrow.
        </p>
      )}

      {repositories.length === 0 && (
        <p className="text-xs text-muted-foreground">
          You can skip this and add repositories later in Settings.
        </p>
      )}
    </div>
  );
}
