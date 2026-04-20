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
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { useWorkspaceStore } from '../../stores/workspace';
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
      <div className="p-2 border-t flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <ChevronLeft className="w-4 h-4" />
          )}
        </Button>
        {!sidebarCollapsed && (
          <Button
            variant={activePanel === 'settings' ? 'secondary' : 'ghost'}
            size="icon"
            className="h-8 w-8"
            onClick={() => setActivePanel('settings')}
          >
            <Settings className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
