import React, { Suspense, lazy } from 'react';
import { Sidebar } from './Sidebar';

/**
 * Code-split the panels that are not the landing screen. On the desktop the
 * whole bundle loads from local disk, so this bought nothing; on the web
 * every visitor downloads it, and Settings + Debug + Tasks are ~4k lines a
 * first-time visitor looking at their PRs never touches.
 *
 * The three GitHub panels stay eager: one of them IS the landing screen, and
 * they share prTableShared, so splitting them would mostly move the same
 * bytes into a chunk fetched immediately anyway.
 */
const QueuePanel = lazy(() =>
  import('../panels/QueuePanel').then((m) => ({ default: m.QueuePanel }))
);
const SettingsPanel = lazy(() =>
  import('../panels/SettingsPanel').then((m) => ({ default: m.SettingsPanel }))
);
import { SystemStatusBanner } from './SystemStatusBanner';
import { MyPRsPanel } from '../panels/github/MyPRsPanel';
import { ReviewsPanel } from '../panels/github/ReviewsPanel';
import { MergeQueuePanel } from '../panels/github/MergeQueuePanel';
import { CreateWorkspaceModal } from '../modals/CreateWorkspaceModal';
import { UpgradeModal } from '../modals/UpgradeModal';
import { ConnectAgentModal } from '../modals/ConnectAgentModal';
import { WhatsNewModal } from '../modals/WhatsNewModal';
import { useWorkspaceStore } from '../../stores/workspace';
import { useBillingStore } from '../../stores/billing';
import { usePanelUrlSync } from '../../hooks/usePanelUrlSync';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { usePullRequestSync } from '../../hooks/usePullRequestSync';
import { useWhatsNew } from '../../hooks/useWhatsNew';

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
            <Suspense fallback={<PanelLoading />}>
              {activePanel === 'queue' && <QueuePanel />}
              {activePanel === 'my_prs' && <MyPRsPanel />}
              {activePanel === 'reviews' && <ReviewsPanel />}
              {activePanel === 'merge_queue' && <MergeQueuePanel />}
              {activePanel === 'settings' && <SettingsPanel />}
            </Suspense>
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

/** Brief placeholder while a split panel chunk loads. */
function PanelLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-px w-44 overflow-hidden rounded-full bg-border/60">
        <div className="owl-scan-bar h-full w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent" />
      </div>
    </div>
  );
}
