import React, { useState, useEffect, useCallback } from 'react';
import {
  Settings,
  FolderKanban,
  Github,
  MessageSquare,
  BarChart3,
  Server,
  Plus,
  Trash2,
  ExternalLink,
  Check,
  AlertCircle,
  Loader2,
  Unlink,
  RefreshCw,
  Palette,
  Sun,
  Moon,
  Monitor,
} from 'lucide-react';
import { api, GitHubStatus, GitHubUser, GitHubRepo, WatchedRepo } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore, type Theme } from '../../stores/workspace';
import { useEnvironmentActions, useWorkspaceActions } from '../../hooks/useApi';
import { AddEnvironmentModal } from '../modals/AddEnvironmentModal';
import { Select } from '../ui/select';

type SettingsSection = 'workspace' | 'integrations' | 'environments' | 'appearance';

export function SettingsPanel() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('workspace');

  const sections = [
    { id: 'workspace' as const, icon: FolderKanban, label: 'Workspace' },
    { id: 'integrations' as const, icon: Settings, label: 'Integrations' },
    { id: 'environments' as const, icon: Server, label: 'Environments' },
    { id: 'appearance' as const, icon: Palette, label: 'Appearance' },
  ];

  return (
    <div className="flex h-full">
      {/* Settings Navigation */}
      <div className="w-56 border-r flex flex-col">
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Settings className="w-5 h-5" />
            Settings
          </h2>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {sections.map((section) => (
            <Button
              key={section.id}
              variant={activeSection === section.id ? 'secondary' : 'ghost'}
              className="w-full justify-start gap-2"
              onClick={() => setActiveSection(section.id)}
            >
              <section.icon className="w-4 h-4" />
              {section.label}
            </Button>
          ))}
        </nav>
      </div>

      {/* Settings Content */}
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-6 max-w-2xl">
            {activeSection === 'workspace' && <WorkspaceSettings />}
            {activeSection === 'integrations' && <IntegrationsSettings />}
            {activeSection === 'environments' && <EnvironmentsSettings />}
            {activeSection === 'appearance' && <AppearanceSettings />}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function WorkspaceSettings() {
  const { workspaces, currentWorkspaceId } = useWorkspaceStore();
  const { updateCurrentWorkspaceSettings } = useWorkspaceActions();
  const [isUpdating, setIsUpdating] = useState(false);
  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId);

  // Repository state
  const [watchedRepos, setWatchedRepos] = useState<WatchedRepo[]>([]);
  const [availableRepos, setAvailableRepos] = useState<GitHubRepo[]>([]);
  const [githubConnected, setGithubConnected] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [showRepoSelector, setShowRepoSelector] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');

  // Load watched repos and GitHub status
  const loadRepos = useCallback(async () => {
    if (!currentWorkspaceId) return;

    try {
      const watched = await api.repositories.list(currentWorkspaceId);
      setWatchedRepos(watched);
    } catch (_e) {
      // Ignore errors
    }

    try {
      const status = await api.github.getStatus(currentWorkspaceId);
      setGithubConnected(status.connected);

      if (status.connected) {
        const repos = await api.github.listRepos(currentWorkspaceId);
        setAvailableRepos(repos);
      }
    } catch (_e) {
      setGithubConnected(false);
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  const handleToggleAutoAssign = async () => {
    if (!currentWorkspace) return;
    setIsUpdating(true);
    try {
      await updateCurrentWorkspaceSettings({
        autoAssignTasks: !currentWorkspace.settings.autoAssignTasks,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleMaxAgentsChange = async (value: string) => {
    const maxAgents = parseInt(value, 10);
    if (isNaN(maxAgents) || maxAgents < 1) return;
    setIsUpdating(true);
    try {
      await updateCurrentWorkspaceSettings({
        maxConcurrentAgents: maxAgents,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleAddRepo = async (repo: GitHubRepo) => {
    if (!currentWorkspaceId) return;
    setLoadingRepos(true);
    try {
      const watched = await api.repositories.add(
        currentWorkspaceId,
        repo.owner.login,
        repo.name
      );
      setWatchedRepos((prev) => [...prev, watched]);
      setShowRepoSelector(false);
      setRepoSearch('');
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleRemoveRepo = async (repoId: string) => {
    setLoadingRepos(true);
    try {
      await api.repositories.remove(repoId);
      setWatchedRepos((prev) => prev.filter((r) => r.id !== repoId));
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleForcePoll = async () => {
    setLoadingRepos(true);
    try {
      await api.repositories.forcePoll();
    } finally {
      setLoadingRepos(false);
    }
  };

  // Filter available repos that aren't already watched
  const filteredRepos = availableRepos
    .filter((repo) => !watchedRepos.some((w) => w.fullName === repo.full_name))
    .filter((repo) =>
      repoSearch
        ? repo.full_name.toLowerCase().includes(repoSearch.toLowerCase())
        : true
    )
    .slice(0, 10);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">Workspace Settings</h3>
        <p className="text-sm text-muted-foreground">
          Configure your current workspace
        </p>
      </div>

      {currentWorkspace ? (
        <>
          <Card className="p-4 space-y-4">
            <div>
              <label className="text-sm font-medium">Workspace Name</label>
              <Input
                value={currentWorkspace.name}
                className="mt-1"
                disabled
              />
              <p className="text-xs text-muted-foreground mt-1">
                Workspace renaming coming soon
              </p>
            </div>

            <div>
              <label className="text-sm font-medium">Description</label>
              <Input
                value={currentWorkspace.description || ''}
                placeholder="Add a description..."
                className="mt-1"
                disabled
              />
            </div>
          </Card>

          <Card className="p-4">
            <h4 className="font-medium mb-3">Automation Settings</h4>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Auto-assign tasks</p>
                  <p className="text-xs text-muted-foreground">
                    Automatically assign queued tasks to idle agents
                  </p>
                </div>
                <Button
                  variant={currentWorkspace.settings.autoAssignTasks ? 'default' : 'outline'}
                  size="sm"
                  onClick={handleToggleAutoAssign}
                  disabled={isUpdating}
                >
                  {currentWorkspace.settings.autoAssignTasks ? 'Enabled' : 'Disabled'}
                </Button>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Max concurrent agents</p>
                  <p className="text-xs text-muted-foreground">
                    Maximum number of agents running simultaneously
                  </p>
                </div>
                <Select
                  value={String(currentWorkspace.settings.maxConcurrentAgents)}
                  onChange={(e) => handleMaxAgentsChange(e.target.value)}
                  disabled={isUpdating}
                  className="w-20"
                >
                  {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </Select>
              </div>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-medium">Watched Repositories</h4>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleForcePoll}
                disabled={loadingRepos || watchedRepos.length === 0}
                title="Check for updates now"
              >
                <RefreshCw className={cn('w-4 h-4', loadingRepos && 'animate-spin')} />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              Track PRs, reviews, and CI status for these repositories
            </p>

            {watchedRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No repositories being watched.
              </p>
            ) : (
              <div className="space-y-2 mb-3">
                {watchedRepos.map((repo) => (
                  <div
                    key={repo.id}
                    className="flex items-center justify-between p-2 rounded bg-secondary"
                  >
                    <div className="flex items-center gap-2">
                      <Github className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">{repo.fullName}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                      onClick={() => handleRemoveRepo(repo.id)}
                      disabled={loadingRepos}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {showRepoSelector ? (
              <div className="space-y-2">
                <Input
                  placeholder="Search repositories..."
                  value={repoSearch}
                  onChange={(e) => setRepoSearch(e.target.value)}
                  autoFocus
                />
                {filteredRepos.length > 0 ? (
                  <div className="border rounded-md max-h-48 overflow-y-auto">
                    {filteredRepos.map((repo) => (
                      <button
                        key={repo.id}
                        className="w-full flex items-center gap-2 p-2 hover:bg-secondary text-left text-sm"
                        onClick={() => handleAddRepo(repo)}
                        disabled={loadingRepos}
                      >
                        <Github className="w-4 h-4 text-muted-foreground" />
                        <span>{repo.full_name}</span>
                        {repo.private && (
                          <Badge variant="outline" className="ml-auto text-xs">Private</Badge>
                        )}
                      </button>
                    ))}
                  </div>
                ) : repoSearch ? (
                  <p className="text-sm text-muted-foreground p-2">No matching repositories</p>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowRepoSelector(false);
                    setRepoSearch('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRepoSelector(true)}
                disabled={!githubConnected}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add Repository
              </Button>
            )}

            {!githubConnected && (
              <p className="text-xs text-muted-foreground mt-2">
                Connect GitHub in Integrations to add repositories
              </p>
            )}
          </Card>
        </>
      ) : (
        <Card className="p-6 text-center">
          <FolderKanban className="w-10 h-10 mx-auto text-muted-foreground/50 mb-3" />
          <h4 className="font-medium mb-1">No Workspace Selected</h4>
          <p className="text-sm text-muted-foreground mb-4">
            Create or select a workspace to configure settings
          </p>
          <Button disabled>
            <Plus className="w-4 h-4 mr-1" />
            Create Workspace
          </Button>
        </Card>
      )}
    </div>
  );
}

function IntegrationsSettings() {
  const { currentWorkspaceId } = useWorkspaceStore();
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load GitHub status on mount and when workspace changes
  const loadGitHubStatus = useCallback(async () => {
    if (!currentWorkspaceId) return;

    try {
      const status = await api.github.getStatus(currentWorkspaceId);
      setGithubStatus(status);

      // If connected, load user info
      if (status.connected) {
        try {
          const user = await api.github.getUser(currentWorkspaceId);
          setGithubUser(user);
        } catch (_e) {
          // User fetch failed, but connection might still be valid
        }
      } else {
        setGithubUser(null);
      }
    } catch (_e) {
      setGithubStatus({ configured: false, connected: false });
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    loadGitHubStatus();
  }, [loadGitHubStatus]);

  // Check URL params for OAuth callback result
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('github_connected') === 'true') {
      // Clear the URL params
      window.history.replaceState({}, '', window.location.pathname);
      loadGitHubStatus();
    } else if (params.get('github_error')) {
      setError(params.get('github_error'));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [loadGitHubStatus]);

  const handleGitHubConnect = async () => {
    if (!currentWorkspaceId) return;

    setIsLoading(true);
    setError(null);

    try {
      const { authUrl } = await api.github.connect(currentWorkspaceId);
      // Open GitHub OAuth in a new window/tab
      window.open(authUrl, '_blank', 'width=600,height=700');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to start OAuth flow');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGitHubDisconnect = async () => {
    if (!currentWorkspaceId) return;

    setIsLoading(true);
    try {
      await api.github.disconnect(currentWorkspaceId);
      setGithubStatus({ configured: true, connected: false });
      setGithubUser(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    } finally {
      setIsLoading(false);
    }
  };

  const integrations = [
    {
      id: 'slack',
      name: 'Slack',
      icon: MessageSquare,
      description: 'Monitor Slack channels and respond to mentions',
      connected: false,
      comingSoon: true,
    },
    {
      id: 'posthog',
      name: 'PostHog',
      icon: BarChart3,
      description: 'View product analytics and receive alerts',
      connected: false,
      comingSoon: true,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">Integrations</h3>
        <p className="text-sm text-muted-foreground">
          Connect external services to enhance your workflow
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      <div className="space-y-4">
        {/* GitHub Integration */}
        <Card className="p-4">
          <div className="flex items-start gap-4">
            <div className={cn(
              'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0',
              githubStatus?.connected ? 'bg-green-500/10' : 'bg-secondary'
            )}>
              <Github className={cn('w-5 h-5', githubStatus?.connected && 'text-green-500')} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="font-medium">GitHub</h4>
                {!githubStatus?.configured && (
                  <Badge variant="secondary">Not Configured</Badge>
                )}
                {githubStatus?.connected && (
                  <Badge variant="default" className="bg-green-600">
                    <Check className="w-3 h-3 mr-1" />
                    Connected
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {githubStatus?.connected && githubUser ? (
                  <>Connected as <strong>@{githubUser.login}</strong></>
                ) : githubStatus?.configured ? (
                  'Connect to GitHub to track PRs, issues, and CI status'
                ) : (
                  githubStatus?.message || 'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables'
                )}
              </p>
            </div>
            {githubStatus?.connected ? (
              <Button
                variant="outline"
                onClick={handleGitHubDisconnect}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Unlink className="w-4 h-4 mr-1" />
                    Disconnect
                  </>
                )}
              </Button>
            ) : (
              <Button
                onClick={handleGitHubConnect}
                disabled={isLoading || !githubStatus?.configured || !currentWorkspaceId}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Connect'
                )}
              </Button>
            )}
          </div>
        </Card>

        {/* Other Integrations */}
        {integrations.map((integration) => (
          <Card key={integration.id} className="p-4">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0">
                <integration.icon className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="font-medium">{integration.name}</h4>
                  {integration.comingSoon && (
                    <Badge variant="secondary">Coming Soon</Badge>
                  )}
                  {integration.connected && (
                    <Badge variant="default" className="bg-green-600">
                      <Check className="w-3 h-3 mr-1" />
                      Connected
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {integration.description}
                </p>
              </div>
              <Button
                variant={integration.connected ? 'outline' : 'default'}
                disabled={integration.comingSoon}
              >
                {integration.connected ? (
                  <>
                    <ExternalLink className="w-4 h-4 mr-1" />
                    Configure
                  </>
                ) : (
                  'Connect'
                )}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function EnvironmentsSettings() {
  const { environments } = useWorkspaceStore();
  const { deleteEnvironment, testConnection } = useEnvironmentActions();
  const [showAddModal, setShowAddModal] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const handleTest = async (envId: string) => {
    setTesting(envId);
    try {
      await testConnection(envId);
    } finally {
      setTesting(null);
    }
  };

  const handleDelete = async (envId: string) => {
    if (confirm('Are you sure you want to remove this environment?')) {
      await deleteEnvironment(envId);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium mb-1">Environments</h3>
          <p className="text-sm text-muted-foreground">
            Manage machines where Claude agents can run
          </p>
        </div>
        <Button onClick={() => setShowAddModal(true)}>
          <Plus className="w-4 h-4 mr-1" />
          Add Environment
        </Button>
      </div>

      <AddEnvironmentModal open={showAddModal} onOpenChange={setShowAddModal} />

      {environments.length === 0 ? (
        <Card className="p-6 text-center">
          <Server className="w-10 h-10 mx-auto text-muted-foreground/50 mb-3" />
          <h4 className="font-medium mb-1">No Environments</h4>
          <p className="text-sm text-muted-foreground mb-4">
            Add an environment to start running Claude agents
          </p>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus className="w-4 h-4 mr-1" />
            Add Environment
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {environments.map((env) => (
            <Card key={env.id} className="p-4">
              <div className="flex items-start gap-4">
                <div
                  className={cn(
                    'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0',
                    env.status === 'connected' && 'bg-green-500/10',
                    env.status === 'connecting' && 'bg-yellow-500/10',
                    env.status === 'disconnected' && 'bg-slate-500/10',
                    env.status === 'error' && 'bg-red-500/10'
                  )}
                >
                  <Server
                    className={cn(
                      'w-5 h-5',
                      env.status === 'connected' && 'text-green-500',
                      env.status === 'connecting' && 'text-yellow-500',
                      env.status === 'disconnected' && 'text-slate-500',
                      env.status === 'error' && 'text-red-500'
                    )}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="font-medium">{env.name}</h4>
                    <Badge variant="outline">{env.type}</Badge>
                    <Badge
                      variant={
                        env.status === 'connected'
                          ? 'default'
                          : env.status === 'error'
                          ? 'destructive'
                          : 'secondary'
                      }
                      className={env.status === 'connected' ? 'bg-green-600' : undefined}
                    >
                      {env.status}
                    </Badge>
                  </div>
                  {env.type === 'ssh' && env.config.type === 'ssh' && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {env.config.username}@{env.config.host}:{env.config.port}
                    </p>
                  )}
                  {env.type === 'local' && (
                    <p className="text-sm text-muted-foreground mt-1">
                      Local machine
                    </p>
                  )}
                  {env.error && (
                    <div className="flex items-center gap-1 text-sm text-red-500 mt-1">
                      <AlertCircle className="w-3 h-3" />
                      {env.error}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(env.id)}
                    disabled={testing === env.id}
                  >
                    {testing === env.id ? 'Testing...' : 'Test'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                    onClick={() => handleDelete(env.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AppearanceSettings() {
  const { theme, setTheme } = useWorkspaceStore();

  const themeOptions: { value: Theme; label: string; icon: typeof Sun; description: string }[] = [
    {
      value: 'light',
      label: 'Light',
      icon: Sun,
      description: 'A clean, bright interface for well-lit environments',
    },
    {
      value: 'dark',
      label: 'Dark',
      icon: Moon,
      description: 'Easy on the eyes in low-light conditions',
    },
    {
      value: 'system',
      label: 'System',
      icon: Monitor,
      description: 'Automatically matches your operating system theme',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">Appearance</h3>
        <p className="text-sm text-muted-foreground">
          Customize the look and feel of FastOwl
        </p>
      </div>

      <Card className="p-4">
        <h4 className="font-medium mb-3">Theme</h4>
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setTheme(option.value)}
              className={cn(
                'flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-colors',
                theme === option.value
                  ? 'border-primary bg-primary/5'
                  : 'border-transparent bg-secondary hover:bg-secondary/80'
              )}
            >
              <div
                className={cn(
                  'w-10 h-10 rounded-lg flex items-center justify-center',
                  theme === option.value ? 'bg-primary text-primary-foreground' : 'bg-muted'
                )}
              >
                <option.icon className="w-5 h-5" />
              </div>
              <span className="font-medium text-sm">{option.label}</span>
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground mt-4">
          {themeOptions.find((o) => o.value === theme)?.description}
        </p>
      </Card>
    </div>
  );
}
