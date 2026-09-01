import React from 'react';
import { Sidebar } from './Sidebar';
import { SystemStatusBanner } from './SystemStatusBanner';
import { QueuePanel } from '../panels/QueuePanel';
import { MyPRsPanel } from '../panels/github/MyPRsPanel';
import { ReviewsPanel } from '../panels/github/ReviewsPanel';
import { MergeQueuePanel } from '../panels/github/MergeQueuePanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { CreateWorkspaceModal } from '../modals/CreateWorkspaceModal';
import { UpgradeModal } from '../modals/UpgradeModal';
import { ConnectAgentModal } from '../modals/ConnectAgentModal';
import { WhatsNewModal } from '../modals/WhatsNewModal';
import { useWorkspaceStore } from '../../stores/workspace';
import { useBillingStore } from '../../stores/billing';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { usePullRequestSync } from '../../hooks/usePullRequestSync';
import { useWhatsNew } from '../../hooks/useWhatsNew';

export function MainLayout() {
  const { activePanel, createWorkspaceOpen, setCreateWorkspaceOpen } = useWorkspaceStore();
  const upgradeModalOpen = useBillingStore((s) => s.upgradeModalOpen);
  const setUpgradeModalOpen = useBillingStore((s) => s.setUpgradeModalOpen);
  useSystemStatus();
  // Owns the shared open-PR fetch + WS subscription for the Sidebar badges and
  // all three GitHub pages. Mounted once here.
  usePullRequestSync();
  // Decides whether the release highlights since the user's last-seen version
  // are worth a modal. Mounted here so it can only run once onboarding is done.
  useWhatsNew();

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
          </div>
        </main>
      </div>
      <CreateWorkspaceModal
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
      />
      <UpgradeModal open={upgradeModalOpen} onOpenChange={setUpgradeModalOpen} />
      <ConnectAgentModal />
      <WhatsNewModal />
    </div>
  );
}
