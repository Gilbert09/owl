import React from 'react';
import { Github, Settings } from 'lucide-react';
import { PRListWidget } from '../widgets/PRListWidget';
import { Button } from '../ui/button';
import { useWorkspaceStore } from '../../stores/workspace';

export function GitHubPanel() {
  const { setActivePanel } = useWorkspaceStore();

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Github className="w-5 h-5" />
          GitHub
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setActivePanel('settings')}
          title="GitHub Settings"
        >
          <Settings className="w-4 h-4" />
        </Button>
      </div>
      <div className="flex-1 p-4 overflow-hidden">
        <PRListWidget />
      </div>
    </div>
  );
}
