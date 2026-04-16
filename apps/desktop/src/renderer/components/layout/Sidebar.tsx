import React, { useState } from 'react';
import {
  Inbox,
  Terminal,
  ListTodo,
  Settings,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  Plus,
  Server,
  WifiOff,
  Github,
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
    workspaces,
    currentWorkspaceId,
    agents,
    environments,
  } = useWorkspaceStore();

  const [showAddEnvModal, setShowAddEnvModal] = useState(false);

  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId);

  const navItems = [
    {
      id: 'inbox' as const,
      icon: Inbox,
      label: 'Inbox',
      badge: unreadCount > 0 ? unreadCount : undefined,
    },
    {
      id: 'terminals' as const,
      icon: Terminal,
      label: 'Agents',
      badge: agents.filter((a) => a.attention !== 'none').length || undefined,
    },
    {
      id: 'queue' as const,
      icon: ListTodo,
      label: 'Queue',
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
        {navItems.map((item) => (
          <Button
            key={item.id}
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
                    variant={item.id === 'inbox' ? 'default' : 'warning'}
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
