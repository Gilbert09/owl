import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Settings,
  FolderKanban,
  Github,
  BarChart3,
  Plus,
  Trash2,
  Shuffle,
  Upload,
  Check,
  AlertCircle,
  ChevronDown,
  Loader2,
  Unlink,
  RefreshCw,
  Palette,
  Sun,
  Moon,
  Monitor,
  User,
  LogOut,
  Pencil,
  Bug,
  Info,
  Download,
  Bot,
  Plug,
  Copy,
  KeyRound,
  Wand2,
  CreditCard,
  Zap,
  Server,
} from 'lucide-react';
import { SkillsSettings } from './SkillsSettings';
import { api, GitHubRepo, getMcpEndpoint } from '../../lib/api';
import { toast } from '../../stores/toast';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { setLogoutReason } from '../../lib/logoutReason';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { WorkspaceLogo } from '../widgets/WorkspaceLogo';
import {
  GetKeyLink,
  POSTHOG_API_KEYS_URL,
  ANTHROPIC_API_KEYS_URL,
  CLAUDE_SETUP_TOKEN_URL,
  POSTHOG_KEY_SCOPE_NOTE,
} from '../widgets/GetKeyLink';
import { GithubInstallStatus } from '../widgets/GithubInstallStatus';
import { useGithubInstallations } from '../../hooks/useGithubInstallations';
import { useIsDevBuild } from '../../hooks/useIsDevBuild';
import { isOwnerCovered } from '../../lib/githubInstall';
import { openExternal } from '../../lib/openExternal';
import { openGithubAppFlow } from '../../lib/githubInstall';
import { APP_VERSION } from '../../lib/env';
import type {
  WorkspaceLogo as WorkspaceLogoData,
  Workspace,
  McpToken,
  BillingOrder,
} from '@talyn/shared';
import { DEFAULT_FLEET_MODEL_ID, FLEET_MODELS, CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL_ID, POSTHOG_CODE_MODELS, DEFAULT_POSTHOG_CODE_MODEL_ID, parseAutoKeepMergeableLabels } from '@talyn/shared';
import { useWorkspaceStore, type Theme } from '../../stores/workspace';
import { useBillingStore } from '../../stores/billing';
import {
  useWorkspaceActions,
  getMergeBlockedNotifyEnabled,
  setMergeBlockedNotifyEnabled,
} from '../../hooks/useApi';
import { useAuth } from '../auth/AuthProvider';
import {
  trackEvent,
  isAnalyticsConfigured,
  getAnalyticsOptOut,
  setAnalyticsOptOut,
} from '../../lib/analytics';
import {
  REPO_CACHE_TTL_MS,
  readRepoCache,
  writeRepoCache,
  formatAge,
} from '../../lib/repoCache';

export function SettingsPanel() {
  // Section lives in the store so other surfaces (e.g. the sidebar cloud-provider
  // status, the per-task "Set default" action) can deep-link to a section.
  const activeSection = useWorkspaceStore((s) => s.settingsSection);
  const setActiveSection = useWorkspaceStore((s) => s.setSettingsSection);

  const sections = [
    { id: 'workspace' as const, icon: FolderKanban, label: 'Workspace' },
    { id: 'integrations' as const, icon: Settings, label: 'Integrations' },
    { id: 'skills' as const, icon: Wand2, label: 'Skills' },
    { id: 'account' as const, icon: User, label: 'Account' },
    { id: 'billing' as const, icon: CreditCard, label: 'Billing' },
    { id: 'appearance' as const, icon: Palette, label: 'Appearance' },
    { id: 'developer' as const, icon: Bug, label: 'Developer' },
    { id: 'mcp' as const, icon: Plug, label: 'MCP server' },
    { id: 'about' as const, icon: Info, label: 'About' },
  ];

  return (
    <div className="flex h-full">
      {/* Settings Navigation */}
      <div className="w-56 border-r flex flex-col">
        <div className="app-region-drag p-4 border-b">
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
            {activeSection === 'skills' && <SkillsSettings />}
            {activeSection === 'account' && <AccountSettings />}
            {activeSection === 'billing' && <BillingSettings />}
            {activeSection === 'appearance' && <AppearanceSettings />}
            {activeSection === 'developer' && <DeveloperSettings />}
            {activeSection === 'mcp' && <MCPServerSettings />}
            {activeSection === 'about' && <AboutSettings />}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

/**
 * Load an image file, downscale it to fit within `maxDim` px (preserving
 * aspect ratio), and return a PNG data URL. Keeps inline-stored logos small.
 */
function downscaleImage(file: File, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      URL.revokeObjectURL(url);
      if (!ctx) return reject(new Error('no canvas context'));
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('could not load image'));
    };
    img.src = url;
  });
}

function WorkspaceSettings() {
  const {
    workspaces,
    currentWorkspaceId,
    setCreateWorkspaceOpen,
    setCurrentWorkspace,
    repositories: watchedRepos,
    setRepositories,
  } = useWorkspaceStore();
  const { refreshWorkspaces } = useWorkspaceActions();
  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId);

  // Editable name, re-seeded whenever the active workspace changes.
  const [name, setName] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setName(currentWorkspace?.name ?? '');
    setConfirmDelete(false);
  }, [currentWorkspaceId, currentWorkspace?.name]);

  const metaDirty = !!currentWorkspace && name.trim() !== currentWorkspace.name;
  const isOnlyWorkspace = workspaces.length <= 1;

  async function handleSaveMeta() {
    if (!currentWorkspaceId || !name.trim() || !metaDirty) return;
    setSavingMeta(true);
    try {
      await api.workspaces.update(currentWorkspaceId, {
        name: name.trim(),
      });
      await refreshWorkspaces();
    } finally {
      setSavingMeta(false);
    }
  }

  async function handleDelete() {
    if (!currentWorkspaceId || isOnlyWorkspace) return;
    setDeleting(true);
    try {
      await api.workspaces.delete(currentWorkspaceId);
      // Switch to another workspace before the list refreshes so the UI never
      // sits on a deleted id.
      const next = workspaces.find((w) => w.id !== currentWorkspaceId);
      setCurrentWorkspace(next?.id ?? null);
      await refreshWorkspaces();
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // ---------- Logo ----------
  const fileRef = useRef<HTMLInputElement>(null);
  const [savingLogo, setSavingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  async function saveLogo(logo: WorkspaceLogoData) {
    if (!currentWorkspaceId) return;
    setSavingLogo(true);
    setLogoError(null);
    try {
      await api.workspaces.update(currentWorkspaceId, { logo });
      await refreshWorkspaces();
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Could not update logo');
    } finally {
      setSavingLogo(false);
    }
  }

  async function handleUploadLogo(file: File) {
    setLogoError(null);
    try {
      const dataUrl = await downscaleImage(file, 256);
      if (dataUrl.length > 512 * 1024) {
        setLogoError('That image is too detailed — try a smaller or simpler one.');
        return;
      }
      await saveLogo({ kind: 'image', dataUrl });
    } catch {
      setLogoError('Could not read that image.');
    }
  }

  // Repository state. The watched-repo list lives in the shared workspace
  // store (not local state) so adds/removes here propagate immediately to
  // every other repo dropdown in the app — GitHub panel, task composer —
  // instead of going stale until the next app refresh.
  // The full set of repos the user can watch (own + every org's),
  // hydrated from a localStorage cache and refreshed on demand.
  const [availableRepos, setAvailableRepos] = useState<GitHubRepo[]>([]);
  const [reposFetchedAt, setReposFetchedAt] = useState<number | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [showRepoSelector, setShowRepoSelector] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');
  // App-installation coverage for the watched repos' orgs.
  const {
    installations,
    checked: installsChecked,
    loading: installsLoading,
    refresh: refreshInstalls,
  } = useGithubInstallations(currentWorkspaceId, githubConnected);

  // Fetch the full repo set from GitHub (user + all orgs) and cache it.
  // This is the expensive call, so it only runs on a cache miss/stale or
  // an explicit refresh — never on every picker open.
  const refreshRepos = useCallback(async () => {
    if (!currentWorkspaceId) return;
    setReposLoading(true);
    try {
      const repos = await api.github.listAllRepos(currentWorkspaceId);
      const now = Date.now();
      setAvailableRepos(repos);
      setReposFetchedAt(now);
      writeRepoCache(currentWorkspaceId, repos, now);
    } catch (_e) {
      // Keep whatever the cache gave us.
    } finally {
      setReposLoading(false);
    }
  }, [currentWorkspaceId]);

  // Load watched repos + GitHub status. Repos hydrate from the
  // localStorage cache for instant render; a stale/empty cache triggers
  // a background refresh.
  const loadRepos = useCallback(async () => {
    if (!currentWorkspaceId) return;

    try {
      const watched = await api.repositories.list(currentWorkspaceId);
      setRepositories(watched);
    } catch (_e) {
      // Ignore errors
    }

    try {
      const status = await api.github.getStatus(currentWorkspaceId);
      setGithubConnected(status.connected);
      if (!status.connected) return;

      const cached = readRepoCache(currentWorkspaceId);
      if (cached) {
        setAvailableRepos(cached.repos);
        setReposFetchedAt(cached.fetchedAt);
      }
      if (!cached || Date.now() - cached.fetchedAt > REPO_CACHE_TTL_MS) {
        void refreshRepos();
      }
    } catch (_e) {
      setGithubConnected(false);
    }
  }, [currentWorkspaceId, refreshRepos, setRepositories]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  const handleAddRepo = async (repo: GitHubRepo) => {
    if (!currentWorkspaceId) return;
    setLoadingRepos(true);
    try {
      const watched = await api.repositories.add(
        currentWorkspaceId,
        repo.owner.login,
        repo.name
      );
      setRepositories([...watchedRepos, watched]);
      void refreshWorkspaces();
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
      setRepositories(watchedRepos.filter((r) => r.id !== repoId));
      void refreshWorkspaces();
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

  // Candidate repos (all accessible), minus already-watched, sorted
  // alphabetically so owners cluster and the list is browsable without
  // searching. Capped only to keep the DOM bounded on huge accounts.
  const matchedRepos = availableRepos
    .filter((repo) => !watchedRepos.some((w) => w.fullName === repo.full_name))
    .filter((repo) =>
      repoSearch
        ? repo.full_name.toLowerCase().includes(repoSearch.toLowerCase())
        : true
    )
    .sort((a, b) =>
      a.full_name.toLowerCase().localeCompare(b.full_name.toLowerCase())
    );
  const REPO_LIST_CAP = 500;
  const filteredRepos = matchedRepos.slice(0, REPO_LIST_CAP);
  const reposTruncated = matchedRepos.length > REPO_LIST_CAP;

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
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1"
                disabled={savingMeta}
              />
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleSaveMeta}
                disabled={!metaDirty || !name.trim() || savingMeta}
              >
                {savingMeta ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save changes'}
              </Button>
            </div>
          </Card>

          <Card className="p-4">
            <h4 className="font-medium mb-3">Logo</h4>
            <div className="flex items-center gap-4">
              <WorkspaceLogo
                logo={currentWorkspace.logo}
                fallbackSeed={currentWorkspace.id}
                size={64}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void saveLogo({ kind: 'identicon', seed: crypto.randomUUID() })}
                  disabled={savingLogo}
                  title="Generate a new identicon"
                >
                  <Shuffle className="w-4 h-4 mr-1" />
                  Shuffle
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={savingLogo}
                >
                  <Upload className="w-4 h-4 mr-1" />
                  Upload image
                </Button>
                {savingLogo && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleUploadLogo(file);
                    e.target.value = ''; // allow re-picking the same file
                  }}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Uploads are downscaled to 256px. Shuffle to go back to a generated logo.
            </p>
            {logoError && <p className="text-xs text-destructive mt-1">{logoError}</p>}
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
                  <div key={repo.id} className="p-2 rounded bg-secondary">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <Github className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">{repo.fullName}</span>
                        {installsChecked && !isOwnerCovered(repo.owner, installations) && (
                          <Badge variant="warning" className="shrink-0 text-xs">
                            App not installed
                          </Badge>
                        )}
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
                  </div>
                ))}
              </div>
            )}

            {githubConnected && (
              <div className="mb-3">
                <GithubInstallStatus
                  workspaceId={currentWorkspaceId ?? ''}
                  installations={installations}
                  checked={installsChecked}
                  loading={installsLoading}
                  watchedOwners={watchedRepos.map((r) => r.owner)}
                  onRefresh={refreshInstalls}
                />
              </div>
            )}

            {showRepoSelector ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Search all your repositories…"
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    autoFocus
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={refreshRepos}
                    disabled={reposLoading}
                    title="Re-fetch your repos + all your orgs' repos from GitHub"
                  >
                    <RefreshCw className={cn('w-4 h-4', reposLoading && 'animate-spin')} />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Your repos + every org you belong to.{' '}
                  {reposLoading
                    ? 'Refreshing…'
                    : reposFetchedAt
                      ? `Updated ${formatAge(reposFetchedAt)}.`
                      : ''}
                </p>

                {reposLoading && availableRepos.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-2 flex items-center gap-2">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Loading repositories…
                  </p>
                ) : filteredRepos.length > 0 ? (
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
                        <span className="ml-auto flex items-center gap-1">
                          {installsChecked && !isOwnerCovered(repo.owner.login, installations) && (
                            <Badge variant="warning" className="text-xs">App not installed</Badge>
                          )}
                          {repo.private && (
                            <Badge variant="outline" className="text-xs">Private</Badge>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground p-2">
                    {repoSearch
                      ? 'No matching repositories. Try Refresh if a repo is missing.'
                      : 'No repositories found. Try Refresh.'}
                  </p>
                )}
                {reposTruncated && (
                  <p className="text-xs text-muted-foreground">
                    Showing first {REPO_LIST_CAP} of {matchedRepos.length}. Type to narrow.
                  </p>
                )}
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

          <AutoKeepMergeableDefaultToggle />

          <Card className="p-4 border-destructive/30">
            <h4 className="font-medium mb-1">Delete workspace</h4>
            <p className="text-sm text-muted-foreground mb-3">
              Permanently removes this workspace and its watched repos, tasks, and
              integration credentials. This cannot be undone.
            </p>
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    `Delete "${currentWorkspace.name}"`
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={isOnlyWorkspace}
                title={
                  isOnlyWorkspace
                    ? 'You need at least one workspace'
                    : 'Delete this workspace'
                }
              >
                <Trash2 className="w-4 h-4 mr-1" />
                Delete workspace
              </Button>
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
          <Button onClick={() => setCreateWorkspaceOpen(true)}>
            <Plus className="w-4 h-4 mr-1" />
            Create Workspace
          </Button>
        </Card>
      )}
    </div>
  );
}

function IntegrationsSettings() {
  // GitHub status + user are preloaded into the store at startup
  // (useSystemStatus) and kept fresh there on window focus, so this panel
  // renders the connection state instantly instead of fetching on open. We
  // still kick a non-blocking refresh on mount to catch anything that changed
  // since the last focus; render never waits on it.
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const githubStatus = useWorkspaceStore((s) => s.githubStatus);
  const githubUser = useWorkspaceStore((s) => s.githubUser);
  const setGitHubStatus = useWorkspaceStore((s) => s.setGitHubStatus);
  const setGitHubUser = useWorkspaceStore((s) => s.setGitHubUser);
  const {
    installations,
    checked: installsChecked,
    loading: installsLoading,
    refresh: refreshInstalls,
  } = useGithubInstallations(currentWorkspaceId, Boolean(githubStatus?.connected));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshGitHubStatus = useCallback(async () => {
    if (!currentWorkspaceId) return;
    try {
      const status = await api.github.getStatus(currentWorkspaceId);
      setGitHubStatus(status);
      if (status.connected) {
        try {
          setGitHubUser(await api.github.getUser(currentWorkspaceId));
        } catch (_e) {
          // User fetch failed, but the connection might still be valid.
        }
      } else {
        setGitHubUser(null);
      }
    } catch (_e) {
      // Fetch failure ≠ "OAuth unconfigured" — claiming configured:false here
      // painted a misleading global banner whenever the request failed for
      // unrelated reasons (e.g. a stale workspace id 404ing). Status unknown.
      setGitHubStatus(null);
    }
  }, [currentWorkspaceId, setGitHubStatus, setGitHubUser]);

  useEffect(() => {
    void refreshGitHubStatus();
  }, [refreshGitHubStatus]);

  // Start the GitHub App install flow. The stateful install URL must be opened
  // in the real browser (it's a multi-step GitHub install + authorize page);
  // GitHub redirects back through /github/app/callback, which records the
  // installation + user token. Connection status refreshes on window focus.
  const handleGitHubAppConnect = async () => {
    if (!currentWorkspaceId) return;

    setIsLoading(true);
    setError(null);

    try {
      // Shared helper — separate tab, so this panel stays mounted and its
      // focus-based status re-check still fires. See lib/githubInstall.
      await openGithubAppFlow(currentWorkspaceId, 'connect');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to start GitHub App install');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGitHubDisconnect = async () => {
    if (!currentWorkspaceId) return;

    setIsLoading(true);
    try {
      await api.github.disconnect(currentWorkspaceId);
      // Surface the change immediately across the banner + this panel.
      setGitHubStatus({ configured: true, connected: false });
      setGitHubUser(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    } finally {
      setIsLoading(false);
    }
  };

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
                {githubStatus?.configured === false && (
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
                  githubStatus?.message || 'Set up the GitHub App (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)'
                )}
              </p>
            </div>
            {githubStatus?.connected ? (
              // Connecting GitHub installs the App, so a connected workspace
              // always has webhooks — no separate "enable" step.
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
              // The GitHub App (webhooks + realtime) is the only connect path —
              // a "connected" workspace always has webhooks.
              <Button
                onClick={handleGitHubAppConnect}
                disabled={isLoading || !githubStatus?.configured || !currentWorkspaceId}
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Connect GitHub'}
              </Button>
            )}
          </div>

          {githubStatus?.connected && currentWorkspaceId && (
            <div className="mt-4 border-t pt-4">
              <GithubInstallStatus
                workspaceId={currentWorkspaceId}
                installations={installations}
                checked={installsChecked}
                loading={installsLoading}
                onRefresh={refreshInstalls}
                showAddAccount
              />
            </div>
          )}
        </Card>

      </div>

      {/* Cloud providers — the vendors that run the agent loop and open PRs. */}
      <div className="space-y-3">
        <div>
          <h4 className="text-sm font-semibold">Cloud providers</h4>
          <p className="text-sm text-muted-foreground">
            Vendors that run your tasks and open PRs. Connect one or more, then choose which
            provider new tasks use by default.
          </p>
        </div>

        <ProviderConnectCards />

        <CloudProviderDefaultSelector />
      </div>
    </div>
  );
}

/**
 * Native <select> with room to breathe: the global appearance reset strips
 * the platform chevron, which left option text jammed against (and clipping
 * under) the border. Explicit right padding + our own chevron instead.
 */
function SettingsSelect({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative shrink-0', className)}>
      <select
        {...props}
        className="w-full appearance-none rounded-md border bg-background py-1.5 pl-3 pr-8 text-sm disabled:opacity-60"
      />
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

/**
 * Which model a cloud provider's tasks run on. Shown only while that provider
 * is connected. Persists to the given `workspace.settings` key; editable
 * without re-entering credentials — switching just makes the next run use the
 * new model.
 */
function WorkspaceModelSelector({
  providerType,
  title,
  description,
  models,
  defaultId,
  settingKey,
}: {
  providerType: 'claude_code' | 'posthog_code' | 'selfhosted';
  title: string;
  description: string;
  models: ReadonlyArray<{ id: string; label: string }>;
  defaultId: string;
  settingKey: 'claudeModel' | 'posthogCodeModel' | 'fleetModel';
}) {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const [saving, setSaving] = useState(false);

  const connected = (cloudProviders ?? []).some(
    (p) => p.type === providerType && p.connected,
  );
  if (!connected) return null;

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const current = workspace?.settings?.[settingKey] ?? defaultId;

  const onChange = async (value: string) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      const settings = { [settingKey]: value } as Workspace['settings'];
      await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, ...settings } as Workspace['settings'] }
            : w,
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-medium">{title}</h4>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
      </div>
      <SettingsSelect
        value={current}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </SettingsSelect>
    </div>
  );
}

/**
 * The two provider connect cards (PostHog Code + Claude Code), shared by the
 * Settings → Integrations section and the "connect an agent" modal so both
 * render the identical connect/verify flow from a single definition.
 */
export function ProviderConnectCards() {
  return (
    <>
      {/* PostHog Code (cloud tasks) */}
      <PostHogCodeCard />

      {/* Claude Code (Managed Agents). Generic card driven by the
          /cloud-providers routes — the template additional providers reuse. */}
      <CloudProviderCard
        type="claude_code"
        displayName="Claude Code"
        icon={Bot}
        blurb="Add an Anthropic API key to run tasks on Claude’s cloud sandbox (Managed Agents). GitHub access reuses this workspace’s GitHub connection."
        connectedBlurb="Cloud tasks run on Claude Managed Agents and open PRs via your GitHub connection."
        fields={[
          { key: 'anthropicApiKey', label: 'Anthropic API key', type: 'password', placeholder: 'sk-ant-...' },
        ]}
        keyHelp={{ url: ANTHROPIC_API_KEYS_URL }}
        connectedExtras={
          <WorkspaceModelSelector
            providerType="claude_code"
            title="Model"
            description="Which model Claude Code tasks run on. Sonnet handles PR fixes well; Opus is more capable but costs more."
            models={CLAUDE_MODELS}
            defaultId={DEFAULT_CLAUDE_MODEL_ID}
            settingKey="claudeModel"
          />
        }
      />

      {/* Talyn Fleet (Firecracker). Rendered ONLY when the backend
          listed it for this workspace: /cloud-providers filters it out for
          anyone not on FLEET_ALLOWED_EMAILS, so showing the card
          unconditionally would offer every user a form whose save 403s. */}
      <SelfHostedFleetCard />
    </>
  );
}

/**
 * What a workspace has to supply to use Talyn Fleet: its Claude credential, and
 * literally nothing else.
 *
 * Two fields used to sit here and neither was the workspace's to give. The
 * fleet API bearer authenticates the BACKEND to a host — one service to
 * another, identical for every workspace — so asking a user for it made them
 * custodian of a secret they neither own nor can rotate. The endpoint answered
 * WHICH host, which nobody using the product is in a position to answer: they
 * cannot see which box is least loaded, which is draining, or which stopped
 * reporting four minutes ago. The registry can, from reports seconds old, and a
 * stale pinned endpoint silently routed every task to a dead machine.
 *
 * Both are deployment config now — `FLEET_API_TOKEN` and, for the debugging
 * case, `FLEET_PINNED_ENDPOINT`.
 *
 * Exported for the card tests, whose entire point is that this list has exactly
 * one entry and does not re-grow the other two.
 */
export const SELFHOSTED_FIELDS: CloudProviderField[] = [
  {
    key: 'claudeToken',
    label: 'Claude OAuth token',
    type: 'password',
    placeholder: 'sk-ant-oat…',
  },
];

/**
 * The Talyn Fleet card.
 *
 * Gated on the provider appearing in the workspace's provider list rather than
 * rendered unconditionally like the other two. The fleet runs on hardware we
 * own and the backend only offers it to allow-listed workspaces; a card that
 * appeared for everyone would be a form that always 403s on save, which reads
 * as a broken integration rather than one you do not have.
 *
 * Absence is not "still loading" — `cloudProviders === null` is. Both mean
 * "render nothing", but conflating them is how a card flashes in and out on
 * every settings visit.
 */
function SelfHostedFleetCard() {
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  if (!cloudProviderOffered(cloudProviders, 'selfhosted')) return null;

  return (
    <CloudProviderCard
      type="selfhosted"
      displayName="Talyn Fleet"
      icon={Server}
      blurb="Run tasks on Talyn's own Firecracker fleet. Each task gets its own microVM; the GitHub token is injected host-side and never enters the VM."
      connectedBlurb="Cloud tasks run in microVMs on Talyn's hardware and open PRs via this workspace's GitHub connection."
      fields={SELFHOSTED_FIELDS}
      keyHelp={{
        url: CLAUDE_SETUP_TOKEN_URL,
        label: 'How to get a token',
        note: 'run `claude setup-token` for an OAuth token off your Claude subscription, or paste a Console API key (sk-ant-api\u2026) to be billed per token.',
      }}
      connectedExtras={
        <WorkspaceModelSelector
          providerType="selfhosted"
          title="Model"
          description="Which model fleet runs use. Sonnet 5 handles the mechanical work — rebases, conflicts, re-running CI — at a fraction of Opus's cost; switch to Opus 5 for harder investigative runs."
          models={FLEET_MODELS}
          defaultId={DEFAULT_FLEET_MODEL_ID}
          settingKey="fleetModel"
        />
      }
    />
  );
}


/**
 * Lets the workspace pick which cloud provider new tasks dispatch to — Auto
 * (prefer PostHog Code, else Claude), a specific connected provider, or "Ask
 * every time" (the desktop shows a per-task picker; backend auto-fixes fall
 * back to Auto). Always shown so the default is discoverable even with one (or
 * zero) providers connected. Persists to `workspace.settings.defaultCloudProvider`.
 */
/**
 * Workspace default: auto-arm "auto-keep mergeable" on every new PR the viewer
 * authored. Persists to `workspace.settings.defaultAutoKeepMergeable`; the
 * backend applies it only to authored PRs on first sighting (never a PR you're
 * only reviewing). Individual PRs stay hand-toggleable in the PR detail sheet.
 */
function AutoKeepMergeableDefaultToggle() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const [saving, setSaving] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const enabled = workspace?.settings?.defaultAutoKeepMergeable === true;

  const onToggle = async (next: boolean) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      const settings = { defaultAutoKeepMergeable: next } as Workspace['settings'];
      await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, ...settings } as Workspace['settings'] }
            : w,
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4 space-y-4">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving || !currentWorkspaceId}
          onChange={(e) => void onToggle(e.target.checked)}
          className="mt-1"
        />
        <div className="flex-1">
          <div className="font-medium text-sm">Auto-keep new PRs mergeable</div>
          <p className="text-xs text-muted-foreground mt-1">
            When a PR you authored first shows up in this workspace, automatically turn on
            “Auto-keep mergeable” — a cloud agent fixes conflicts, CI, and review comments to keep
            it mergeable until it merges. Applies only to PRs you opened, never ones you’re just
            reviewing. You can still toggle any individual PR from its detail panel.
          </p>
        </div>
      </label>
      <AutoKeepMergeableLabelsField />
    </Card>
  );
}

/** Persists to `workspace.settings.autoKeepMergeableLabels`; the watcher tick applies them and never removes them. */
export function AutoKeepMergeableLabelsField() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const [saving, setSaving] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const saved = (workspace?.settings?.autoKeepMergeableLabels ?? []).join(', ');
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved, currentWorkspaceId]);

  const commit = async () => {
    const labels = parseAutoKeepMergeableLabels(draft);
    if (!currentWorkspaceId || labels.join(', ') === saved) {
      setDraft(saved);
      return;
    }
    setSaving(true);
    try {
      const settings = { autoKeepMergeableLabels: labels } as Workspace['settings'];
      await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, ...settings } as Workspace['settings'] }
            : w,
        ),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save labels');
      setDraft(saved);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-border pt-4">
      <div className="font-medium text-sm">Label watched PRs</div>
      <p className="text-xs text-muted-foreground mt-1 mb-2">
        Add these GitHub labels to every PR that “Auto-keep mergeable” is watching, so a bot in
        your org that keys off a label (auto-review, stamping) picks them up. Comma-separated.
        Applied within a minute, including to PRs already being watched, and never removed. Leave
        blank to turn off. Needs the GitHub App’s “Issues: Read &amp; write” permission.
      </p>
      <Input
        placeholder="e.g. auto-review, needs-stamp"
        value={draft}
        disabled={saving || !currentWorkspaceId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="max-w-sm"
      />
    </div>
  );
}

function CloudProviderDefaultSelector() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  // One source of truth — preloaded + kept fresh by useSystemStatus.
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const connected = (cloudProviders ?? []).filter((p) => p.connected);
  const [saving, setSaving] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const current = (workspace?.settings?.defaultCloudProvider as string | undefined) ?? '';

  const onChange = async (value: string) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      const defaultCloudProvider = value === '' ? undefined : value;
      await api.workspaces.update(currentWorkspaceId, {
        settings: { defaultCloudProvider } as Workspace['settings'],
      });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, defaultCloudProvider } as Workspace['settings'] }
            : w
        )
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-secondary shrink-0">
          <Shuffle className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-medium">Default for new tasks</h4>
          <p className="text-sm text-muted-foreground mt-1">
            Which cloud provider new tasks use. “Ask every time” shows a picker on the Task button
            when more than one is connected.
          </p>
        </div>
        <SettingsSelect
          value={current}
          disabled={saving}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Auto (prefer PostHog Code)</option>
          {connected.map((p) => (
            <option key={p.type} value={p.type}>
              {p.displayName}
            </option>
          ))}
          <option value="ask">Ask every time</option>
        </SettingsSelect>
      </div>
    </Card>
  );
}

interface CloudProviderField {
  key: string;
  label: string;
  type?: 'text' | 'password';
  placeholder?: string;
  /**
   * A field the provider will accept without. Without it the form refuses to
   * submit a configuration the backend would have accepted.
   *
   * No descriptor currently sets it: Talyn Fleet was the only user and its
   * optional field turned out not to belong in the UI at all. Kept because the
   * rule it encodes is generic and `cloudProviderFormComplete` implements it —
   * a provider with a genuinely optional credential should set this rather than
   * rediscover why every field being required is wrong.
   */
  optional?: boolean;
}


/**
 * The fields a provider's config request must carry, from what the user typed.
 *
 * Blank OPTIONAL fields are omitted rather than sent as "": a provider that
 * stores what it is given would persist an empty credential and then fail
 * authenticating with it, which reads as a bad key rather than no key. Exported
 * so the rule is testable without rendering the card.
 */
export function cloudProviderConfigFromValues(
  fields: CloudProviderField[],
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    fields
      .map((f) => [f.key, (values[f.key] ?? '').trim()] as const)
      .filter(([, v]) => v !== ''),
  );
}

/** Whether every REQUIRED field has a value. Optional ones may stay blank. */
export function cloudProviderFormComplete(
  fields: CloudProviderField[],
  values: Record<string, string>,
): boolean {
  return fields.every((f) => f.optional || Boolean(values[f.key]?.trim()));
}

/**
 * Whether the backend offered this provider to the current workspace.
 *
 * `null` means the list has not loaded, which is NOT the same as "absent" even
 * though both render nothing — conflating them is how a card flashes in and out
 * on every settings visit.
 */
export function cloudProviderOffered(
  cloudProviders: { type: string }[] | null,
  type: string,
): boolean {
  return Boolean(cloudProviders?.some((p) => p.type === type));
}

/**
 * Generic Settings card for a cloud task provider, driven entirely by the
 * provider-agnostic `/cloud-providers` routes (list / config / disconnect).
 * A new provider needs only a descriptor here — no bespoke API client or
 * store wiring. (PostHogCodeCard predates this and keeps its richer
 * project/host display; it can migrate to this card later.)
 */
function CloudProviderCard({
  type,
  displayName,
  icon: Icon,
  blurb,
  connectedBlurb,
  fields,
  keyHelp,
  connectedExtras,
}: {
  type: string;
  displayName: string;
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
  connectedBlurb: string;
  fields: CloudProviderField[];
  /** Optional "Get a key ↗" link (+ scope note) shown under the form. */
  keyHelp?: { url: string; label?: string; note?: string };
  /** Extra per-provider settings (e.g. the model row) rendered inside the
   *  card, under a divider, only while connected. */
  connectedExtras?: React.ReactNode;
}) {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  // Connection status comes from the shared store (preloaded + kept fresh by
  // useSystemStatus on focus / WS / reconnect), so leaving and returning to this
  // tab can't show a stale "Not Connected", and there's no flash on restart.
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const setCloudProviders = useWorkspaceStore((s) => s.setCloudProviders);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loaded = cloudProviders !== null;
  const connected = Boolean(cloudProviders?.find((p) => p.type === type)?.connected);

  // Reflect a connect/disconnect into the shared list so this badge, the sidebar
  // status row, and the default selector all update together (and persist across
  // tab switches) without waiting for the next focus refetch.
  const setConnectedInStore = useCallback(
    (isConnected: boolean) => {
      const list = useWorkspaceStore.getState().cloudProviders ?? [];
      const existing = list.find((p) => p.type === type);
      const next = existing
        ? list.map((p) => (p.type === type ? { ...p, connected: isConnected } : p))
        : [...list, { type, displayName, connected: isConnected }];
      setCloudProviders(next);
    },
    [type, displayName, setCloudProviders]
  );

  const handleSave = async () => {
    if (!currentWorkspaceId) return;
    if (!cloudProviderFormComplete(fields, values)) return;
    setIsSaving(true);
    setError(null);
    try {
      const config = cloudProviderConfigFromValues(fields, values);
      await api.cloudProviders.saveConfig(type, currentWorkspaceId, config);
      trackEvent('cloud_provider_connected', { provider: type });
      setConnectedInStore(true);
      setValues({});
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!currentWorkspaceId) return;
    setIsSaving(true);
    try {
      await api.cloudProviders.disconnect(type, currentWorkspaceId);
      setConnectedInStore(false);
      setValues({});
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    } finally {
      setIsSaving(false);
    }
  };

  // Don't offer the form until we actually know the state — avoids flashing the
  // connect form (then the connected card) on first load / tab return.
  const showForm = editing || (loaded && !connected);
  const canSave = cloudProviderFormComplete(fields, values);

  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <div
          className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0',
            connected ? 'bg-green-500/10' : 'bg-secondary'
          )}
        >
          <Icon className={cn('w-5 h-5', connected && 'text-green-500')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium">{displayName}</h4>
            {!loaded ? (
              <Badge variant="secondary">Checking…</Badge>
            ) : connected ? (
              <Badge variant="default" className="bg-green-600">
                <Check className="w-3 h-3 mr-1" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary">Not Connected</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {connected ? connectedBlurb : blurb}
          </p>

          {showForm && (
            <div className="mt-3 space-y-3">
              {fields.map((f) => (
                <Input
                  key={f.key}
                  label={f.label}
                  type={f.type ?? 'text'}
                  placeholder={f.placeholder}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  disabled={isSaving}
                />
              ))}
              {keyHelp && <GetKeyLink url={keyHelp.url} label={keyHelp.label} note={keyHelp.note} />}
              {error && (
                <div className="text-sm text-destructive flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving || !canSave || !currentWorkspaceId}
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save & verify'}
                </Button>
                {connected && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(false);
                      setValues({});
                      setError(null);
                    }}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {connected && !showForm && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={isSaving}>
              <Pencil className="w-4 h-4 mr-1" />
              Edit
            </Button>
            <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={isSaving}>
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />}
            </Button>
          </div>
        )}
      </div>

      {connected && connectedExtras && (
        <div className="mt-4 border-t pt-4">{connectedExtras}</div>
      )}
    </Card>
  );
}

/**
 * PostHog Code (cloud tasks) credentials, per workspace.
 *
 * Two ways to connect, both first-class:
 *
 * - **OAuth** — offered when the backend has `POSTHOG_OAUTH_*` configured. The
 *   user authorizes Talyn on PostHog and picks the project on PostHog's own
 *   consent screen, so no credential ever passes through this window and the
 *   grant is narrowed to one project + `task:read`/`task:write`. It's revocable
 *   from PostHog's Connected Apps screen.
 * - **Personal API key** — the original path, still fully supported, and the only
 *   one on a deployment without OAuth configured (self-hosted, local dev). An
 *   existing key install is never migrated or nagged: it keeps this card and its
 *   Edit button exactly as before, with OAuth offered as a quiet alternative
 *   rather than a prompt.
 *
 * Either way the credential is write-only — the backend returns neither the key
 * nor a token, so this renders connection state and the project id, nothing more.
 */
function PostHogCodeCard() {
  // Status is preloaded into the store at startup (useSystemStatus), so the
  // card shows the connection state instantly. Mutations below write the fresh
  // status straight back to the store; the OAuth flow finishes in the system
  // browser instead, which useSystemStatus picks up on window focus.
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const status = useWorkspaceStore((s) => s.posthogStatus);
  const setStatus = useWorkspaceStore((s) => s.setPostHogStatus);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [host, setHost] = useState('https://us.posthog.com');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the edit-form fields from the preloaded status. Deps are the scalar
  // values, so this won't clobber in-progress edits (status is stable while
  // editing) — it only fires when the preload lands or after a save.
  useEffect(() => {
    if (status?.projectId) setProjectId(status.projectId);
    if (status?.host) setHost(status.host);
  }, [status?.projectId, status?.host]);

  // The backend 302s browser clients back to /settings?posthog=connected|error at
  // the end of the OAuth flow. Success needs nothing (the status re-check on
  // mount/focus renders it), but a FAILURE would otherwise be invisible here —
  // the desktop gets the reason rendered as a page in its browser tab, and this
  // is the only place the web app can show it. Consumed once, then stripped from
  // the URL so a refresh doesn't resurrect a stale failure.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('posthog') !== 'error') return;
    setError(params.get('message') || 'PostHog could not be connected.');
    params.delete('posthog');
    params.delete('message');
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, []);

  const connected = Boolean(status?.connected);
  const usingOAuth = status?.authMethod === 'oauth';
  const needsReauth = status?.needsReauth === true;
  // Strict `=== true`: a desktop build newer than its backend sees `undefined`
  // here, and offering a flow the backend can't start is worse than not offering
  // it at all.
  const oauthAvailable = status?.oauthAvailable === true;
  // The key form is the default landing state only where OAuth isn't an option.
  const keyFormOpen = editing || (!connected && !oauthAvailable);

  const handleConnectOAuth = async () => {
    if (!currentWorkspaceId) return;
    setIsSaving(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.posthog.startOAuth(currentWorkspaceId, {
        host: host.trim() || undefined,
        // Only a pre-selection on PostHog's consent screen, and only honoured
        // there if the user actually has access to it — useful on a reconnect.
        projectId: status?.projectId,
      });
      trackEvent('cloud_provider_oauth_started', { provider: 'posthog_code' });
      // Navigate THIS tab rather than opening one. `window.open` is only granted
      // while user activation is live and the await above spends it (see
      // lib/openExternal), so a popup here would be blocked. The backend sends
      // browser clients back to /settings?posthog=… at the end of the flow, so
      // the user lands exactly where they started.
      window.location.assign(authorizeUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start the PostHog connection');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    if (!currentWorkspaceId || !apiKey.trim() || !projectId.trim()) return;
    setIsSaving(true);
    setError(null);
    try {
      const s = await api.posthog.saveConfig(currentWorkspaceId, {
        apiKey: apiKey.trim(),
        projectId: projectId.trim(),
        host: host.trim() || undefined,
      });
      trackEvent('cloud_provider_connected', { provider: 'posthog_code' });
      setStatus(s);
      setApiKey('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!currentWorkspaceId) return;
    setIsSaving(true);
    try {
      await api.posthog.disconnect(currentWorkspaceId);
      setStatus({ connected: false, oauthAvailable });
      setProjectId('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    } finally {
      setIsSaving(false);
    }
  };

  const description = () => {
    if (needsReauth) {
      return 'PostHog rejected the stored authorization — reconnect to keep cloud tasks running.';
    }
    if (connected) {
      return `Cloud tasks run under project ${status?.projectId} on ${status?.host}${
        usingOAuth ? ', authorized with your PostHog account.' : '.'
      }`;
    }
    return oauthAvailable
      ? 'Connect your PostHog account to run tasks on PostHog Code’s cloud sandbox. Talyn asks only for task access to the one project you pick.'
      : 'Add a personal API key + project id to run tasks on PostHog Code’s cloud sandbox.';
  };

  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <div
          className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0',
            connected && !needsReauth ? 'bg-green-500/10' : 'bg-secondary'
          )}
        >
          <BarChart3 className={cn('w-5 h-5', connected && !needsReauth && 'text-green-500')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium">PostHog Code</h4>
            {needsReauth ? (
              <Badge variant="destructive">Reconnect needed</Badge>
            ) : connected ? (
              <Badge variant="default" className="bg-green-600">
                <Check className="w-3 h-3 mr-1" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary">Not Connected</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{description()}</p>

          {/* Not connected, OAuth on the table: lead with it, and keep the key
              path one click away rather than hidden. */}
          {!connected && oauthAvailable && !keyFormOpen && (
            <div className="mt-3 space-y-3">
              <Input
                label="PostHog host"
                placeholder="https://us.posthog.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                disabled={isSaving}
              />
              {error && (
                <div className="text-sm text-destructive flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleConnectOAuth} disabled={isSaving || !currentWorkspaceId}>
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Connect with PostHog'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(true)}
                  disabled={isSaving}
                >
                  <KeyRound className="w-4 h-4 mr-1" />
                  Use a personal API key
                </Button>
              </div>
            </div>
          )}

          {keyFormOpen && (
            <div className="mt-3 space-y-3">
              <Input
                label="Personal API key"
                type="password"
                placeholder="phx_..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={isSaving}
              />
              <GetKeyLink url={POSTHOG_API_KEYS_URL} note={POSTHOG_KEY_SCOPE_NOTE} />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Project (team) id"
                  placeholder="e.g. 2"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={isSaving}
                />
                <Input
                  label="Host"
                  placeholder="https://us.posthog.com"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  disabled={isSaving}
                />
              </div>
              {error && (
                <div className="text-sm text-destructive flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving || !apiKey.trim() || !projectId.trim() || !currentWorkspaceId}
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save & verify'}
                </Button>
                {/* Offered, never pushed: an existing key install works fine and
                    nothing here suggests it's deprecated. */}
                {oauthAvailable && (
                  <Button size="sm" variant="ghost" onClick={handleConnectOAuth} disabled={isSaving}>
                    Connect with PostHog instead
                  </Button>
                )}
                {(connected || oauthAvailable) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(false);
                      setApiKey('');
                      setError(null);
                    }}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {connected && !keyFormOpen && (
          <div className="flex gap-2">
            {usingOAuth ? (
              // No key to rotate on an OAuth connection — re-consenting is the
              // equivalent, and it's also how you move the workspace to a
              // different PostHog project.
              <Button
                variant={needsReauth ? 'default' : 'outline'}
                size="sm"
                onClick={handleConnectOAuth}
                disabled={isSaving}
              >
                <RefreshCw className="w-4 h-4 mr-1" />
                Reconnect
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={isSaving}>
                <Pencil className="w-4 h-4 mr-1" />
                Edit
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={isSaving}>
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />}
            </Button>
          </div>
        )}
      </div>

      {/* Per-provider model choice lives with its provider, mirroring the
          generic CloudProviderCard's connectedExtras slot. */}
      {connected && (
        <div className="mt-4 border-t pt-4">
          <WorkspaceModelSelector
            providerType="posthog_code"
            title="Model"
            description="Which model PostHog Code runs use. Opus 4.8 is the most capable of the Claude 4 line; Fable 5 is the newest."
            models={POSTHOG_CODE_MODELS}
            defaultId={DEFAULT_POSTHOG_CODE_MODEL_ID}
            settingKey="posthogCodeModel"
          />
        </div>
      )}
    </Card>
  );
}

function AppearanceSettings() {
  const { theme, setTheme } = useWorkspaceStore();
  const [notifyBlocked, setNotifyBlocked] = useState(getMergeBlockedNotifyEnabled());
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );

  const toggleNotifyBlocked = async (next: boolean) => {
    setMergeBlockedNotifyEnabled(next);
    setNotifyBlocked(next);
    // Request OS permission eagerly on enable so the first real block doesn't
    // race the browser permission prompt.
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        setNotifyPermission(await Notification.requestPermission());
      } catch {
        // ignore
      }
    }
  };

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
          Customize the look and feel of Talyn
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

      <Card className="p-4">
        <h4 className="font-medium mb-3">Notifications</h4>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={notifyBlocked}
            onChange={(e) => void toggleNotifyBlocked(e.target.checked)}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="font-medium text-sm">
              Notify me when a merge-queue PR is blocked
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Shows a desktop notification and an in-app alert when a PR in the merge
              queue gives up after its retry budget and needs manual intervention.
              Click the notification to jump to it.
            </p>
            {notifyPermission === 'denied' && (
              <p className="text-xs text-yellow-500 mt-1">
                Desktop notifications are blocked at the OS level — grant Talyn
                permission in your system settings to receive them. (The in-app alert
                still shows.)
              </p>
            )}
          </div>
        </label>
      </Card>
    </div>
  );
}

function DeveloperSettings() {
  // The account wipe is a dev-workflow tool (reset to a first-run state);
  // production users should never see a one-click "delete everything".
  const isDevBuild = useIsDevBuild();
  const [wipeArmed, setWipeArmed] = useState(false);
  const [wiping, setWiping] = useState(false);

  async function handleWipe() {
    setWiping(true);
    try {
      await api.users.wipeMe();
    } catch {
      // The wipe severs our own auth mid-flight, so a late failure here is
      // expected — proceed with the local reset regardless.
    }
    try {
      localStorage.clear();
    } catch {
      // Privacy mode — nothing persisted to clear anyway.
    }
    if (isSupabaseConfigured()) {
      setLogoutReason('account_wiped');
      await getSupabase().auth.signOut({ scope: 'local' });
    }
    window.location.reload();
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">Developer</h3>
        <p className="text-sm text-muted-foreground">
          Tools for looking under the hood of Talyn
        </p>
      </div>

      <Card className="p-4">
        <h4 className="font-medium flex items-center gap-2">
          <Bug className="w-4 h-4" />
          Operator tooling
        </h4>
        <p className="text-sm text-muted-foreground mt-1">
          The Debug panel moved to{' '}
          <strong>admin.talyn.dev</strong>, along with fleet and account
          tooling. It surfaced internals across every account, so it belongs on
          the operator console rather than in the product.
        </p>
      </Card>

      {isDevBuild && (
      <Card className="p-4 border-destructive/50">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="font-medium flex items-center gap-2 text-destructive">
              <Trash2 className="w-4 h-4" />
              Wipe account &amp; start fresh
            </h4>
            <p className="text-sm text-muted-foreground mt-1">
              Deletes your user profile, every workspace it owns (integrations,
              watched repos, PRs, tasks), and this app's local storage, then
              signs you out. The next sign-in runs onboarding from scratch.
            </p>
          </div>
          {wipeArmed ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWipeArmed(false)}
                disabled={wiping}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleWipe}
                disabled={wiping}
              >
                {wiping ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Yes, wipe everything'
                )}
              </Button>
            </div>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0"
              onClick={() => setWipeArmed(true)}
            >
              Wipe…
            </Button>
          )}
        </div>
      </Card>
      )}
    </div>
  );
}

/**
 * MCP server settings — mint a long-lived personal token and copy the one-line
 * `claude mcp add` command that points a Claude client at the hosted endpoint.
 * The token authenticates the backend's `/api/v1/mcp` endpoint; it's shown in
 * full exactly once at creation, then only its prefix is ever displayed.
 */
function MCPServerSettings() {
  const endpoint = getMcpEndpoint();
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The full plaintext token + command, held only until the user dismisses it
  // (we can never retrieve the secret again).
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setTokens(await api.mcpTokens.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tokens');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const installCommand = (token: string) =>
    `claude mcp add --transport http talyn ${endpoint} --header "Authorization: Bearer ${token}"`;

  // The secret never renders in full — head + tail is enough to recognise it;
  // the Copy buttons carry the real value.
  const maskToken = (token: string) =>
    `${token.slice(0, 14)}${'•'.repeat(12)}${token.slice(-4)}`;

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await api.mcpTokens.create(name.trim() ? { name: name.trim() } : {});
      setFreshToken(res.token);
      setName('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create token');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await api.mcpTokens.revoke(id);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke token');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">MCP server</h3>
        <p className="text-sm text-muted-foreground">
          Drive Talyn from a Claude client (Claude Code or Claude Desktop). Generate a
          personal token, then run the command below to connect.
        </p>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Plug className="w-4 h-4" />
          <span className="font-medium">Endpoint</span>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 truncate">{endpoint}</code>
          <Button size="sm" variant="outline" onClick={() => void copy(endpoint, 'Endpoint')}>
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </div>
      </Card>

      {/* Generate */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4" />
          <span className="font-medium">Generate a token</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Tokens are long-lived (90 days) and tied to your account. The full token is shown
          once — copy it now. You can revoke it any time below.
        </p>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Optional label (e.g. Laptop)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1"
          />
          <Button size="sm" onClick={() => void handleCreate()} disabled={creating}>
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
            Generate
          </Button>
        </div>
        {error && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </p>
        )}

        {freshToken && (
          <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
            <p className="text-xs font-medium flex items-center gap-1">
              <Check className="w-3.5 h-3.5 text-green-600" /> Token created — copy it now, it
              won&apos;t be shown again.
            </p>
            <div>
              <label className="text-xs text-muted-foreground">Token</label>
              <div className="flex items-center gap-2 mt-1">
                {/* Displayed masked (head + tail only) so the secret never sits
                    readable on screen; the Copy button carries the real value. */}
                <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 truncate">
                  {maskToken(freshToken)}
                </code>
                <Button size="sm" variant="outline" onClick={() => void copy(freshToken, 'Token')}>
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  Copy token
                </Button>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                Install command (includes the token)
              </label>
              <div className="flex items-start gap-2 mt-1">
                <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 break-all whitespace-pre-wrap">
                  {installCommand(maskToken(freshToken))}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copy(installCommand(freshToken), 'Command')}
                >
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  Copy command
                </Button>
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setFreshToken(null)}>
              Done
            </Button>
          </div>
        )}
      </Card>

      {/* Existing tokens */}
      <Card className="p-4 space-y-3">
        <span className="font-medium">Your tokens</span>
        {tokens === null ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
          </p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tokens yet.</p>
        ) : (
          <div className="divide-y">
            {tokens.map((t) => {
              const fmt = (iso: string) =>
                new Date(iso).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                });
              const expiringSoon =
                t.expiresAt &&
                new Date(t.expiresAt).getTime() - Date.now() < 14 * 86_400_000;
              return (
                <div key={t.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-sm truncate">{t.name}</span>
                      <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t.tokenPrefix}…
                      </code>
                    </div>
                    <div className="grid grid-cols-3 gap-x-6 text-xs">
                      <div>
                        <div className="text-muted-foreground/70">Created</div>
                        <div className="text-muted-foreground">{fmt(t.createdAt)}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground/70">Last used</div>
                        <div className="text-muted-foreground">
                          {t.lastUsedAt ? fmt(t.lastUsedAt) : 'Never'}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground/70">Expires</div>
                        <div
                          className={cn(
                            'text-muted-foreground',
                            expiringSoon && 'text-amber-600 dark:text-amber-400'
                          )}
                        >
                          {t.expiresAt ? fmt(t.expiresAt) : 'Never'}
                        </div>
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    title="Revoke this token"
                    onClick={() => void handleRevoke(t.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

const REPO_URL = 'https://github.com/Gilbert09/talyn';
const SITE_URL = 'https://talyn.dev';

function openRepo() {
  // Direct from a click, so user activation is intact and this isn't blocked.
  void openExternal(REPO_URL);
}

function AboutSettings() {
  // The desktop's About section drives electron-updater: current version over
  // IPC, a stable/nightly channel picker, "check for updates", and a
  // restart-to-install button. None of it has a web analogue — the browser app
  // is continuously deployed and a reload IS the update — so it is dropped
  // rather than stubbed, and replaced with the build identifier plus a pointer
  // to the desktop app for the things only it can do.
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">About</h3>
        <p className="text-sm text-muted-foreground">Version information</p>
      </div>

      <Card className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="font-medium">Talyn</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Build {APP_VERSION}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              This is the web app — it updates automatically on every deploy.
              Reload the page to pick up the latest build.
            </p>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <p className="text-sm font-medium">Desktop app</p>
          <p className="text-sm text-muted-foreground mt-1">
            The desktop app additionally reads skills from{' '}
            <code className="text-xs">~/.claude/skills</code> on your machine
            and keeps your session in the OS keychain.
          </p>
          <button
            type="button"
            onClick={() => openExternal(SITE_URL)}
            className="mt-2 text-sm underline underline-offset-2 hover:no-underline"
          >
            Download for macOS, Windows or Linux
          </button>
        </div>

        <div className="border-t border-border pt-4 flex gap-4">
          <button
            type="button"
            onClick={openRepo}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            Report an issue
          </button>
          <button
            type="button"
            onClick={() => openExternal(SITE_URL)}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            talyn.dev
          </button>
        </div>
      </Card>
    </div>
  );
}

function AccountSettings() {
  const { user, signOut } = useAuth();
  const analyticsConfigured = isAnalyticsConfigured();
  // Toggle semantics: checked = sharing enabled = NOT opted out.
  const [shareAnalytics, setShareAnalytics] = useState(!getAnalyticsOptOut());

  const toggleShareAnalytics = (next: boolean) => {
    setAnalyticsOptOut(!next);
    setShareAnalytics(next);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Account</h3>
        <Card className="p-4 space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Signed in as</p>
            <p className="font-medium">{user?.email ?? '—'}</p>
          </div>
          <Button variant="outline" onClick={signOut} className="gap-2">
            <LogOut className="w-4 h-4" /> Sign out
          </Button>
        </Card>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Privacy</h3>
        <Card className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h4 className="font-medium">Share usage data &amp; session replays</h4>
              <p className="text-sm text-muted-foreground mt-1">
                Helps us improve Talyn by collecting usage events, errors, and
                session replays of the app UI.
              </p>
              {!analyticsConfigured && (
                <p className="text-xs text-muted-foreground mt-1">
                  Analytics isn&apos;t enabled in this build — nothing is
                  collected either way.
                </p>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={shareAnalytics}
              disabled={!analyticsConfigured}
              onClick={() => toggleShareAnalytics(!shareAnalytics)}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                shareAnalytics && analyticsConfigured ? 'bg-primary' : 'bg-muted',
                !analyticsConfigured && 'opacity-50 cursor-not-allowed'
              )}
            >
              <span
                className={cn(
                  'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
                  shareAnalytics && analyticsConfigured
                    ? 'translate-x-5'
                    : 'translate-x-0.5'
                )}
              />
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function formatRenewalDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/** One free-plan usage row: label, n/limit count, and a fill bar that goes
 *  destructive at the cap. Used for active tasks and the merge queue. */
function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const atLimit = used >= limit;
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-medium', atLimit && 'text-destructive')}>
          {used}/{limit}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', atLimit ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${Math.min(100, (used / Math.max(1, limit)) * 100)}%` }}
        />
      </div>
    </div>
  );
}

function BillingSettings() {
  const status = useBillingStore((s) => s.status);
  const refresh = useBillingStore((s) => s.refresh);
  const startCheckoutPollBurst = useBillingStore((s) => s.startCheckoutPollBurst);
  const [portalBusy, setPortalBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<null | 'monthly' | 'annual'>(null);
  const [awaitingCheckout, setAwaitingCheckout] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<BillingOrder[] | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState<string | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);

  const billingOn = status?.billingEnabled === true;

  // Live usage on entry — the snapshot's activeTasks goes stale as tasks
  // finish in the background.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Order history — also refetched when the plan changes (a fresh checkout
  // lands its first order moments after the WS push flips the plan).
  useEffect(() => {
    if (!billingOn) return;
    let cancelled = false;
    api.billing
      .orders()
      .then((rows) => {
        if (!cancelled) setOrders(rows);
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [billingOn, status?.plan]);

  const openInvoice = async (orderId: string) => {
    setInvoiceBusy(orderId);
    setInvoiceError(null);
    try {
      const { url } = await api.billing.invoice(orderId);
      await openExternal(url);
    } catch (err) {
      setInvoiceError(err instanceof Error ? err.message : 'Could not fetch the invoice');
    } finally {
      setInvoiceBusy(null);
    }
  };

  // Checkout directly from the plan cards — the settings page IS the pitch,
  // so no modal detour here (the UpgradeModal stays for the at-limit flow).
  const startCheckout = async (period: 'monthly' | 'annual') => {
    setCheckoutBusy(period);
    setError(null);
    try {
      const { url } = await api.billing.checkout({ period });
      await openExternal(url);
      startCheckoutPollBurst();
      setAwaitingCheckout(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout');
    } finally {
      setCheckoutBusy(null);
    }
  };

  const openPortal = async () => {
    setPortalBusy(true);
    setError(null);
    try {
      const { url } = await api.billing.portal();
      await openExternal(url);
      // Portal changes (cancel/resume/payment method) also land via webhook.
      startCheckoutPollBurst();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the billing portal');
    } finally {
      setPortalBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="space-y-6">
        <h3 className="text-lg font-semibold mb-4">Billing</h3>
        <Card className="p-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </Card>
      </div>
    );
  }

  if (!status.billingEnabled) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold mb-4">Billing</h3>
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">
              Billing is not configured on this backend — all plans run without limits.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  const comped = status.planSource === 'override';
  const free = status.plan === 'free';
  const pastDue = status.subscriptionStatus === 'past_due';
  const limit = status.activeTaskLimit ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Billing</h3>
        <Card className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Current plan</p>
              <p className="font-medium flex items-center gap-2">
                {free ? 'Free' : 'Unlimited'}
                {!free && <Zap className="w-4 h-4 text-primary" />}
              </p>
              {comped && (
                <p className="text-sm text-muted-foreground mt-1">
                  Complimentary plan — unlimited tasks, nothing to pay.
                </p>
              )}
              {free && (
                <p className="text-sm text-muted-foreground mt-1">
                  Up to {limit} tasks running and {status.mergeQueueLimit ?? limit} PRs in the
                  merge queue at once, across all your workspaces.
                </p>
              )}
              {!free && !comped && status.currentPeriodEnd && (
                <p className="text-sm text-muted-foreground mt-1">
                  {status.cancelAtPeriodEnd
                    ? `Unlimited until ${formatRenewalDate(status.currentPeriodEnd)}, then Free.`
                    : `Renews ${formatRenewalDate(status.currentPeriodEnd)}.`}
                </p>
              )}
            </div>
          </div>

          {free && (
            <>
              <UsageMeter label="Active tasks" used={status.activeTasks} limit={limit} />
              <UsageMeter
                label="Merge queue"
                used={status.queuedPrs}
                limit={status.mergeQueueLimit ?? limit}
              />
            </>
          )}

          {pastDue && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
              <p className="text-sm">
                Your last payment failed. Update your payment method to keep unlimited tasks —
                the plan drops to Free if the retries run out.
              </p>
            </div>
          )}

          {!comped && !free && (
            <Button
              variant="outline"
              onClick={openPortal}
              disabled={portalBusy}
              className="gap-2"
            >
              {portalBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CreditCard className="w-4 h-4" />
              )}
              {status.cancelAtPeriodEnd ? 'Resume or manage subscription' : 'Manage subscription'}
            </Button>
          )}

          {/* Checkout errors render under the plan cards below; this slot is
              for the portal path only. */}
          {!free && error && <p className="text-sm text-destructive">{error}</p>}
        </Card>
      </div>

      {free && (
        <div>
          <h3 className="text-lg font-semibold mb-4">Upgrade to Unlimited</h3>
          <div className="grid grid-cols-2 gap-3">
            <Card className="p-4 flex flex-col gap-3 relative border-primary/40">
              <span className="absolute right-3 top-3 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                2 months free
              </span>
              <div>
                <p className="font-medium">Annual</p>
                <p className="text-2xl font-semibold">
                  $150
                  <span className="text-sm font-normal text-muted-foreground"> /year</span>
                </p>
              </div>
              <Button
                onClick={() => startCheckout('annual')}
                disabled={checkoutBusy !== null || awaitingCheckout}
                className="gap-2 mt-auto"
              >
                {checkoutBusy === 'annual' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Zap className="w-4 h-4" />
                )}
                Upgrade annual
              </Button>
            </Card>
            <Card className="p-4 flex flex-col gap-3">
              <div>
                <p className="font-medium">Monthly</p>
                <p className="text-2xl font-semibold">
                  $15
                  <span className="text-sm font-normal text-muted-foreground"> /month</span>
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => startCheckout('monthly')}
                disabled={checkoutBusy !== null || awaitingCheckout}
                className="gap-2 mt-auto"
              >
                {checkoutBusy === 'monthly' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Zap className="w-4 h-4" />
                )}
                Upgrade monthly
              </Button>
            </Card>
          </div>

          {awaitingCheckout && (
            <p className="text-sm text-muted-foreground mt-3">
              <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
              Finish checkout in your browser — this page updates by itself once payment
              completes.
            </p>
          )}
          {error && <p className="text-sm text-destructive mt-3">{error}</p>}

          <ul className="space-y-1.5 text-sm text-muted-foreground mt-4">
            <li className="flex items-center gap-2">
              <Check className="w-4 h-4" /> Unlimited concurrent tasks
            </li>
            <li className="flex items-center gap-2">
              <Check className="w-4 h-4" /> Merge queue &amp; auto-keep-mergeable never wait for a
              free slot
            </li>
            <li className="flex items-center gap-2">
              <Check className="w-4 h-4" /> Cancel anytime
            </li>
          </ul>
        </div>
      )}

      {/* Order history — shown for anyone with past orders (a now-free user
          can still grab an old invoice). */}
      {orders != null && orders.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-4">Order history</h3>
          <Card className="divide-y p-0">
            {orders.map((order) => (
              <div key={order.id} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {order.productName ?? 'Talyn Unlimited'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatRenewalDate(order.createdAt)}
                    {order.invoiceNumber ? ` · ${order.invoiceNumber}` : ''}
                  </p>
                </div>
                <div className="text-sm font-medium tabular-nums">
                  {formatOrderAmount(order.amount, order.currency)}
                </div>
                {order.status !== 'paid' && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground capitalize">
                    {order.status.replace('_', ' ')}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openInvoice(order.id)}
                  disabled={invoiceBusy !== null}
                  className="gap-1.5 shrink-0"
                  title="Open the invoice in your browser"
                >
                  {invoiceBusy === order.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  Invoice
                </Button>
              </div>
            ))}
          </Card>
          {invoiceError && <p className="text-sm text-destructive mt-2">{invoiceError}</p>}
        </div>
      )}
    </div>
  );
}

function formatOrderAmount(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
