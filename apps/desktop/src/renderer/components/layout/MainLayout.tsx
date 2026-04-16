import React from 'react';
import { Sidebar } from './Sidebar';
import { InboxPanel } from '../panels/InboxPanel';
import { TerminalsPanel } from '../panels/TerminalsPanel';
import { QueuePanel } from '../panels/QueuePanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { useWorkspaceStore } from '../../stores/workspace';

export function MainLayout() {
  const { activePanel } = useWorkspaceStore();

  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Title bar area for window controls */}
        <div className="h-8 bg-card border-b titlebar-drag-region flex items-center px-4">
          <span className="text-xs font-medium text-muted-foreground titlebar-no-drag">
            FastOwl
          </span>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-hidden">
          {activePanel === 'inbox' && <InboxPanel />}
          {activePanel === 'terminals' && <TerminalsPanel />}
          {activePanel === 'queue' && <QueuePanel />}
          {activePanel === 'settings' && <SettingsPanel />}
        </div>
      </main>
    </div>
  );
}
