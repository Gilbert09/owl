import React, { useState } from 'react';
import {
  Inbox,
  ListTodo,
  Settings,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  Plus,
  Server,
  WifiOff,
  Github,
  Archive,
  CircleDot,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { useWorkspaceStore } from '../../stores/workspace';
import { useAuth } from '../auth/AuthProvider';
import { AddEnvironmentModal } from '../modals/AddEnvironmentModal';

interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: SidebarProps) {
  const {
    sidebarCollapsed,
    toggleSidebar,
    activePanel,
    setActivePanel,
    unreadCount,
    inboxView,
    setInboxView,
    workspaces,
    currentWorkspaceId,
    tasks,
    environments,
  } = useWorkspaceStore();

  const [showAddEnvModal, setShowAddEnvModal] = useState(false);
  const { user } = useAuth();

  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId);

  // Count tasks that need attention (running with high/medium attention)
  const tasksNeedingAttention = tasks.filter(
    (t) => t.status === 'in_progress' && t.agentAttention && t.agentAttention !== 'none'
  ).length;

  // Count running tasks
  const runningTasksCount = tasks.filter((t) => t.status === 'in_progress').length;

  // Both badges (parent 'Inbox' + 'Active' sub-item) count unread items
  // so the numbers match. Read-but-not-actioned items remain visible in
  // the Active pane but don't inflate the attention-count.

  const navItems = [
    {
      id: 'inbox' as const,
      icon: Inbox,
      label: 'Inbox',
      badge: unreadCount > 0 ? unreadCount : undefined,
    },
    {
      id: 'queue' as const,
      icon: ListTodo,
      label: 'Tasks',
      badge: tasksNeedingAttention > 0 ? tasksNeedingAttention : runningTasksCount > 0 ? runningTasksCount : undefined,
      badgeVariant: tasksNeedingAttention > 0 ? 'warning' : 'secondary',
    },
    {
      id: 'github' as const,
      icon: Github,
      label: 'GitHub',
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
      {/* Header / Workspace Selector */}
      <div className="p-3 border-b">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <FolderKanban className="w-4 h-4 text-primary" />
          </div>
          {!sidebarCollapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {currentWorkspace?.name || 'No Workspace'}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {currentWorkspace
                  ? `${currentWorkspace.repos.length} repos`
                  : 'Select a workspace'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 space-y-1">
        {navItems.map((item) => {
          const isInbox = item.id === 'inbox';
          const showInboxChildren = isInbox && activePanel === 'inbox' && !sidebarCollapsed;
          return (
            <React.Fragment key={item.id}>
              <Button
                variant={activePanel === item.id ? 'secondary' : 'ghost'}
                className={cn(
                  'w-full justify-start gap-3',
                  sidebarCollapsed && 'justify-center px-2'
                )}
                onClick={() => {
                  setActivePanel(item.id);
                  // Default sub-view: clicking Inbox always lands on
                  // "Active" so the user sees what needs attention.
                  if (isInbox) setInboxView('active');
                }}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                {!sidebarCollapsed && (
                  <>
                    <span className="flex-1 text-left">{item.label}</span>
                    {item.badge && (
                      <Badge
                        variant={isInbox ? 'default' : (item.badgeVariant as 'warning' | 'secondary') || 'warning'}
                        className="ml-auto"
                      >
                        {item.badge}
                      </Badge>
                    )}
                  </>
                )}
              </Button>
              {showInboxChildren && (
                <div className="ml-3 border-l pl-2 space-y-1">
                  <Button
                    variant={inboxView === 'active' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="w-full justify-start gap-2 h-8 text-xs"
                    onClick={() => setInboxView('active')}
                  >
                    <CircleDot className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1 text-left">Active</span>
                    {unreadCount > 0 && (
                      <Badge variant="default" className="ml-auto h-5">
                        {unreadCount}
                      </Badge>
                    )}
                  </Button>
                  <Button
                    variant={inboxView === 'archive' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="w-full justify-start gap-2 h-8 text-xs"
                    onClick={() => setInboxView('archive')}
                  >
                    <Archive className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1 text-left">Archive</span>
                  </Button>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </nav>

      {/* Environments Status */}
      {!sidebarCollapsed && (
        <div className="p-3 border-t">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">
              Environments
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setShowAddEnvModal(true)}
              title="Add Environment"
            >
              <Plus className="w-3 h-3" />
            </Button>
          </div>
          <div className="space-y-1">
            {environments.length === 0 ? (
              <button
                onClick={() => setShowAddEnvModal(true)}
                className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
              >
                <Server className="w-3 h-3" />
                <span>Add environment...</span>
              </button>
            ) : (
              environments.map((env) => (
                <div key={env.id} className="flex items-center gap-2 text-xs">
                  <div
                    className={cn(
                      'w-2 h-2 rounded-full',
                      env.status === 'connected' && 'bg-green-500',
                      env.status === 'connecting' && 'bg-yellow-500 animate-pulse',
                      env.status === 'disconnected' && 'bg-slate-500',
                      env.status === 'error' && 'bg-red-500'
                    )}
                  />
                  <span className="truncate flex-1">{env.name}</span>
                  {env.status === 'error' && (
                    <WifiOff className="w-3 h-3 text-red-500" />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <AddEnvironmentModal open={showAddEnvModal} onOpenChange={setShowAddEnvModal} />

      {/* Footer */}
      <div className="border-t p-2">
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
      title={`Signed in as @${username} — click for account settings`}
      className={cn(
        'flex items-center gap-2 text-sm rounded-md hover:bg-accent transition-colors',
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
    </button>
  );
}
