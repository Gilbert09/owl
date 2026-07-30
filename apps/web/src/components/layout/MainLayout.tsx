import React from 'react';
import { Sidebar } from './Sidebar';
import { SystemStatusBanner } from './SystemStatusBanner';
import { QueuePanel } from '../panels/QueuePanel';
import { MyPRsPanel } from '../panels/github/MyPRsPanel';
import { ReviewsPanel } from '../panels/github/ReviewsPanel';
import { MergeQueuePanel } from '../panels/github/MergeQueuePanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { DebugPanel } from '../panels/DebugPanel';
import { CreateWorkspaceModal } from '../modals/CreateWorkspaceModal';
import { UpgradeModal } from '../modals/UpgradeModal';
import { ConnectAgentModal } from '../modals/ConnectAgentModal';
import { useWorkspaceStore } from '../../stores/workspace';
import { useBillingStore } from '../../stores/billing';
import { usePanelUrlSync } from '../../hooks/usePanelUrlSync';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { usePullRequestSync } from '../../hooks/usePullRequestSync';

export function MainLayout() {
  const { activePanel, createWorkspaceOpen, setCreateWorkspaceOpen } = useWorkspaceStore();
  const upgradeModalOpen = useBillingStore((s) => s.upgradeModalOpen);
  const setUpgradeModalOpen = useBillingStore((s) => s.setUpgradeModalOpen);
  useSystemStatus();
  // Mirrors activePanel into the address bar (and back) — see the hook.
  usePanelUrlSync();
  // Owns the shared open-PR fetch + WS subscription for the Sidebar badges and
  // all three GitHub pages. Mounted once here.
  usePullRequestSync();

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        {/* Banner lives inside the main column (not above the sidebar) so the
            sidebar reaches the window top, where the macOS traffic lights sit. */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <SystemStatusBanner />
          <div className="flex-1 overflow-hidden">
            {activePanel === 'queue' && <QueuePanel />}
            {activePanel === 'my_prs' && <MyPRsPanel />}
            {activePanel === 'reviews' && <ReviewsPanel />}
            {activePanel === 'merge_queue' && <MergeQueuePanel />}
            {activePanel === 'settings' && <SettingsPanel />}
            {activePanel === 'debug' && <DebugPanel />}
          </div>
        </main>
      </div>
      <CreateWorkspaceModal
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
      />
      <UpgradeModal open={upgradeModalOpen} onOpenChange={setUpgradeModalOpen} />
      <ConnectAgentModal />
    </div>
  );
}
