import { useEffect, useRef, useState } from 'react';
import {
  ListTodo,
  Settings,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  GitPullRequest,
  GitMerge,
  Eye,
  Check,
  Plus,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { WorkspaceLogo } from '../widgets/WorkspaceLogo';
import { useWorkspaceStore } from '../../stores/workspace';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useIsDevBuild } from '../../hooks/useIsDevBuild';
import { useAuth } from '../auth/AuthProvider';

interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: SidebarProps) {
  const {
    sidebarCollapsed,
    toggleSidebar,
    activePanel,
    setActivePanel,
    tasks,
  } = useWorkspaceStore();

  const { user } = useAuth();

  // Count running tasks
  const runningTasksCount = tasks.filter((t) => t.status === 'in_progress').length;

  // Live PR counts for the three GitHub nav badges. The PR store is kept
  // current by usePullRequestSync, so these re-render on every WS update.
  const prRows = usePullRequestStore((s) => s.rows);
  // My PRs holds `authored || watching` — a manually tracked PR renders
  // there, so the badge must count it or it disagrees with the page.
  const myPrCount = prRows.filter((r) => r.authored || r.watching).length;
  const reviewCount = prRows.filter((r) => r.reviewRequested).length;
  const queueCount = prRows.filter((r) => r.mergeQueued).length;

  const navItems = [
    {
      id: 'my_prs' as const,
      icon: GitPullRequest,
      label: 'My PRs',
      badge: myPrCount > 0 ? myPrCount : undefined,
      badgeVariant: 'secondary',
    },
    {
      id: 'reviews' as const,
      icon: Eye,
      label: 'Reviews',
      badge: reviewCount > 0 ? reviewCount : undefined,
      badgeVariant: 'secondary',
    },
    {
      id: 'merge_queue' as const,
      icon: GitMerge,
      label: 'Merge Queue',
      badge: queueCount > 0 ? queueCount : undefined,
      badgeVariant: 'secondary',
    },
    {
      id: 'queue' as const,
      icon: ListTodo,
      label: 'Tasks',
      badge: runningTasksCount > 0 ? runningTasksCount : undefined,
      badgeVariant: 'secondary',
    },
  ];

  return (
    <div
      className={cn(
        'flex flex-col h-full bg-card border-r transition-all duration-200',
        sidebarCollapsed ? 'w-16' : 'w-56',
        className
      )}
    >
      {/* macOS frameless window: the inset traffic lights float over this
          strip, which doubles as the window's drag handle. Kept just tall
          enough to clear the lights so the workspace picker hugs them. */}
      {/* The desktop reserves a drag strip here for the macOS frameless
          title bar (-webkit-app-region). Inert in a browser, and it was
          in-flow, so it is dropped rather than left as dead space. */}

      {/* Header / Workspace Selector */}
      <div className="p-3 border-b">
        <WorkspaceSwitcher collapsed={sidebarCollapsed} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 space-y-1">
        {navItems.map((item) => (
          <Button
            key={item.id}
            data-attr={`nav-${item.id}`}
            variant={activePanel === item.id ? 'secondary' : 'ghost'}
            className={cn(
              'w-full justify-start gap-3',
              sidebarCollapsed && 'justify-center px-2'
            )}
            onClick={() => setActivePanel(item.id)}
          >
            <item.icon className="w-4 h-4 flex-shrink-0" />
            {!sidebarCollapsed && (
              <>
                <span className="flex-1 text-left">{item.label}</span>
                {item.badge && (
                  <Badge
                    variant={(item.badgeVariant as 'warning' | 'secondary') || 'warning'}
                    className="ml-auto"
                  >
                    {item.badge}
                  </Badge>
                )}
              </>
            )}
          </Button>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t p-2">
        <CloudProviderStatus collapsed={sidebarCollapsed} />
        <div
          className={cn(
            'flex items-center gap-1',
            sidebarCollapsed && 'flex-col',
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 flex-shrink-0"
            onClick={toggleSidebar}
          >
            {sidebarCollapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </Button>
          {user && (
            <UserChip
              user={user}
              collapsed={sidebarCollapsed}
              onClick={() => setActivePanel('settings')}
            />
          )}
          {!sidebarCollapsed && (
            <Button
              variant={activePanel === 'settings' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8 flex-shrink-0"
              onClick={() => setActivePanel('settings')}
            >
              <Settings className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Top-of-sidebar workspace switcher. Shows the active workspace and opens a
 * dropdown to switch between the user's workspaces, plus a shortcut into the
 * Workspace settings (where create / rename / delete live).
 */
function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const {
    workspaces,
    currentWorkspaceId,
    setCurrentWorkspace,
    setActivePanel,
    setCreateWorkspaceOpen,
  } = useWorkspaceStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = workspaces.find((w) => w.id === currentWorkspaceId);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const select = (id: string) => {
    if (id !== currentWorkspaceId) setCurrentWorkspace(id);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={collapsed ? current?.name ?? 'No workspace' : 'Switch workspace'}
        className={cn(
          'flex w-full items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-accent',
          collapsed && 'justify-center',
        )}
      >
        <WorkspaceLogo
          logo={current?.logo}
          fallbackSeed={current?.id ?? 'talyn'}
          size={32}
          className="flex-shrink-0"
        />
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{current?.name || 'No Workspace'}</p>
              <p className="truncate text-xs text-muted-foreground">
                {current ? `${current.repos.length} repos` : 'Select a workspace'}
              </p>
            </div>
            <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          </>
        )}
      </button>

      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 max-h-80 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
            collapsed ? 'left-0 w-56' : 'inset-x-0',
          )}
        >
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Workspaces</div>
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => select(w.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <Check
                className={cn(
                  'h-4 w-4 flex-shrink-0',
                  w.id === currentWorkspaceId ? 'opacity-100' : 'opacity-0',
                )}
              />
              <WorkspaceLogo logo={w.logo} fallbackSeed={w.id} size={20} className="flex-shrink-0" />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="text-xs text-muted-foreground">{w.repos.length}</span>
            </button>
          ))}
          <div className="my-1 border-t" />
          <button
            type="button"
            onClick={() => {
              setCreateWorkspaceOpen(true);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            <Plus className="h-4 w-4 flex-shrink-0" />
            New workspace…
          </button>
          <button
            type="button"
            onClick={() => {
              setActivePanel('settings');
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
          >
            <Settings className="h-4 w-4 flex-shrink-0" />
            Workspace settings
          </button>
        </div>
      )}
    </div>
  );
}

// NOTE: the desktop Sidebar renders an <UpdateNotice> here, driven by
// electron-updater events over IPC. There is no web analogue — the browser
// app is continuously deployed and a reload IS the update — so the
// component and its usage are dropped rather than stubbed.

/**
 * Cloud-provider connection status, shown just above the user chip. One row
 * per registered cloud provider with a dot: green = connected (credentials
 * configured for this workspace), grey = not connected.
 */
function CloudProviderStatus({ collapsed }: { collapsed: boolean }) {
  // Status comes from the store (preloaded + kept fresh by useSystemStatus on
  // focus / env WS events / reconnect), so this row never fetches on its own and
  // can't disagree with the Settings cards.
  const providers = useWorkspaceStore((s) => s.cloudProviders);
  const openSettings = useWorkspaceStore((s) => s.openSettings);

  if (!providers || providers.length === 0) return null;

  return (
    <button
      type="button"
      onClick={() => openSettings('integrations')}
      title="Manage cloud providers"
      className={cn(
        'mb-2 flex w-full flex-col gap-0.5 border-b pb-2 text-left transition-colors hover:bg-muted/50 rounded-md',
        collapsed && 'items-center',
      )}
    >
      {providers.map((p) => (
        <div
          key={p.type}
          title={`${p.displayName} — ${p.connected ? 'connected' : 'not connected'}`}
          className={cn(
            'flex items-center gap-2 rounded-md text-xs text-muted-foreground',
            collapsed ? 'h-6 w-6 justify-center' : 'px-2 py-1',
          )}
        >
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              p.connected ? 'bg-green-500' : 'bg-muted-foreground/40',
            )}
          />
          {!collapsed && <span className="min-w-0 flex-1 truncate">{p.displayName}</span>}
        </div>
      ))}
    </button>
  );
}

interface UserChipProps {
  user: User;
  collapsed: boolean;
  onClick: () => void;
}

/**
 * Bottom-of-sidebar identity chip. Shows the GitHub avatar + username
 * so users on machines with multiple GitHub accounts can see which
 * one is signed in at a glance. Clicking opens the Settings → Account
 * panel, which is where the Sign-out action lives.
 */
function UserChip({ user, collapsed, onClick }: UserChipProps) {
  const isDev = useIsDevBuild();
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  // GitHub's Supabase provider fills `user_name`; fall back to
  // `preferred_username` and finally the email local-part so something
  // meaningful always renders.
  const username =
    (typeof meta.user_name === 'string' && meta.user_name) ||
    (typeof meta.preferred_username === 'string' && meta.preferred_username) ||
    (user.email?.split('@')[0] ?? 'user');
  const avatarUrl =
    typeof meta.avatar_url === 'string' ? meta.avatar_url : undefined;
  const initials = username.slice(0, 1).toUpperCase();

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        isDev
          ? `DEV build — signed in as @${username}. Click for account settings`
          : `Signed in as @${username} — click for account settings`
      }
      className={cn(
        'flex items-center gap-2 text-sm rounded-md transition-colors',
        // Dev builds get an amber chip so it's obvious at a glance you're not
        // looking at production data.
        isDev
          ? 'bg-amber-400/25 ring-1 ring-inset ring-amber-500/40 hover:bg-amber-400/35'
          : 'hover:bg-accent',
        collapsed
          ? 'h-8 w-8 justify-center flex-shrink-0'
          : 'flex-1 min-w-0 px-2 py-1.5',
      )}
    >
      <span className="relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-full w-full object-cover"
            // GitHub avatar hosts can fail transiently; fall back to the
            // initials bubble rather than a broken-image icon.
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          initials
        )}
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1 truncate text-left">
          @{username}
        </span>
      )}
      {!collapsed && isDev && (
        <span className="shrink-0 rounded bg-amber-500 px-1 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-amber-950">
          Dev
        </span>
      )}
    </button>
  );
}
