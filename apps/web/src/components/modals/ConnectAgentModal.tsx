import { useEffect, useRef } from 'react';
import { Bot } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { ProviderConnectCards } from '../panels/SettingsPanel';
import { useGitHubActions } from '../panels/github/useGitHubActions';
import { useWorkspaceStore } from '../../stores/workspace';

/**
 * "Connect an agent to run this." Task buttons render even with no cloud
 * provider connected (so a first-run user can reach them without an onboarding
 * detour); clicking one with nothing connected opens this modal and stashes the
 * task. The moment a provider connects — its env row lands via the
 * `environment:created` push — `providerReady` flips and the stashed task
 * auto-runs, so the user's click isn't wasted.
 *
 * Mounted once in MainLayout, driven by the workspace store.
 */
export function ConnectAgentModal() {
  const open = useWorkspaceStore((s) => s.connectAgentOpen);
  const pending = useWorkspaceStore((s) => s.pendingCloudTask);
  const closeConnectAgent = useWorkspaceStore((s) => s.closeConnectAgent);
  const { createPostHogTask, runSkillTask, providerReady } = useGitHubActions();
  // Guard against the async fire running twice while it's in flight.
  const firing = useRef(false);

  useEffect(() => {
    if (!open || !pending || !providerReady || firing.current) return;
    firing.current = true;
    void (async () => {
      try {
        if (pending.kind === 'fix') {
          await createPostHogTask(pending.row, pending.providerType);
        } else {
          await runSkillTask(pending.row, pending.skill, {
            providerType: pending.providerType,
            localContent: pending.localContent,
          });
        }
      } finally {
        firing.current = false;
        closeConnectAgent();
      }
    })();
  }, [open, pending, providerReady, createPostHogTask, runSkillTask, closeConnectAgent]);

  // Reset the fire guard on close so a later open can dispatch again.
  useEffect(() => {
    if (!open) firing.current = false;
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeConnectAgent();
      }}
    >
      <DialogContent onClose={closeConnectAgent}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            Connect an agent to run this
          </DialogTitle>
          <DialogDescription>
            Talyn hands the actual work to a cloud coding agent. Connect one below and your
            task starts the moment it&rsquo;s ready. You only do this once.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <ProviderConnectCards />
        </div>
      </DialogContent>
    </Dialog>
  );
}
