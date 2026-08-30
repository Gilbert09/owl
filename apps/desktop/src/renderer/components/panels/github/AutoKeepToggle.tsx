import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { Workspace } from '@talyn/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../ui/dialog';
import { Button } from '../../ui/button';
import { api } from '../../../lib/api';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useBillingStore, maybeHandleBillingLimit } from '../../../stores/billing';
import { toast } from '../../../stores/toast';

/**
 * Workspace toggle for "keep new PRs green" — every PR you open gets the
 * auto-keep-mergeable watcher armed, so a cloud agent clears conflicts and red
 * CI on its own.
 *
 * It lives in the My PRs header rather than only in Settings because that is
 * where you feel the absence of it: you are looking at the list of your own red
 * PRs. Same setting either place (`workspace.settings.defaultAutoKeepMergeable`),
 * so flipping it here shows up there.
 *
 * **Turning it ON is an Unlimited feature, and the gate is on the transition.**
 * The backend refuses an OFF→ON change for a free plan with a 402
 * (`auto_keep_default_requires_unlimited`), which `maybeHandleBillingLimit`
 * turns into the upgrade modal. A free workspace that ALREADY has it on
 * predates the gate and keeps it — so this renders as on, works, and can be
 * turned off; asking for it back is what costs. That asymmetry is deliberate:
 * nobody loses a feature they were already using.
 *
 * The server is the authority on all of it. The `free && !enabled` check below
 * only saves a round-trip and lets the button say what it will do before you
 * press it — a stale plan snapshot just means the 402 arrives instead.
 */

/**
 * Marks that the user has been shown what this does and knowingly turned it on
 * once. Per device, like the theme — it gates an explainer, not an entitlement,
 * so there is nothing worth a server round-trip or a schema column.
 *
 * Set on CONFIRM only. Cancelling leaves the safety net in place: the flag
 * means "you have switched this on deliberately before", and someone who backed
 * out has not.
 */
const EXPLAINED_KEY = 'fastowl-auto-keep-explained';

function hasBeenExplained(): boolean {
  try {
    return localStorage.getItem(EXPLAINED_KEY) === '1';
  } catch {
    // Private mode / storage disabled — show the explainer every time rather
    // than silently arming an open-ended stream of cloud runs.
    return false;
  }
}

function markExplained(): void {
  try {
    localStorage.setItem(EXPLAINED_KEY, '1');
  } catch {
    /* best-effort */
  }
}

export function AutoKeepToggle() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const plan = useBillingStore((s) => s.status?.plan);
  const [saving, setSaving] = useState(false);
  const [explaining, setExplaining] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const enabled = workspace?.settings?.defaultAutoKeepMergeable === true;
  // `plan` is undefined until the first billing fetch lands. Treat unknown as
  // paid: the worst case is one refused round-trip, whereas guessing "free"
  // would flash the upgrade modal at an Unlimited user on a cold start.
  const locked = plan === 'free' && !enabled;

  function pitchUpgrade() {
    useBillingStore.getState().setUpgradeModalOpen(true, 'auto_keep_default');
  }

  async function apply(next: boolean) {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      const settings = { defaultAutoKeepMergeable: next } as Workspace['settings'];
      await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, ...settings } as Workspace['settings'] }
            : w
        )
      );
      toast.success(
        next
          ? 'New PRs you open will be kept green'
          : 'New PRs will no longer be kept green automatically'
      );
    } catch (err) {
      // A racing plan change (or a stale snapshot) lands here instead.
      if (!maybeHandleBillingLimit(err, 'auto_keep_default')) {
        toast.error(
          'Could not change the setting',
          err instanceof Error ? err.message : undefined
        );
      }
    } finally {
      setSaving(false);
    }
  }

  function onClick() {
    if (!currentWorkspaceId || saving) return;
    // Turning it OFF never needs explaining, and never needs a plan.
    if (enabled) {
      void apply(false);
      return;
    }
    // First time through, say what it will do before it does it — this commits
    // the account to a cloud run per PR opened, indefinitely.
    if (!hasBeenExplained()) {
      setExplaining(true);
      return;
    }
    if (locked) {
      pitchUpgrade();
      return;
    }
    void apply(true);
  }

  function confirmFromExplainer() {
    markExplained();
    setExplaining(false);
    if (locked) pitchUpgrade();
    else void apply(true);
  }

  if (!currentWorkspaceId) return null;

  return (
    <>
      <button
        type="button"
        data-attr="my-prs-auto-keep-toggle"
        onClick={onClick}
        disabled={saving}
        aria-pressed={enabled}
        title={
          enabled
            ? 'Every PR you open is kept green automatically — click to turn off'
            : 'Let a cloud agent clear conflicts and red CI on every PR you open'
        }
        className={cn(
          'group/ak relative inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
          'text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-60',
          enabled
            ? // ON — lit up. The glow is a coloured ring plus a soft outer shadow;
              // both are toned down in dark mode, where a bright halo blooms.
              'border-violet-400/50 bg-gradient-to-r from-violet-500/15 via-fuchsia-500/10 to-sky-500/15 ' +
                'text-violet-700 shadow-[0_0_14px_-3px_rgba(139,92,246,0.55)] ' +
                'hover:shadow-[0_0_18px_-3px_rgba(139,92,246,0.7)] ' +
                'dark:border-violet-400/40 dark:text-violet-200 ' +
                'dark:shadow-[0_0_14px_-4px_rgba(167,139,250,0.5)]'
            : // OFF — dashed, quiet, but still tinted so it reads as the premium
              // thing rather than another grey filter chip.
              'border-dashed border-violet-400/40 bg-violet-500/[0.04] text-muted-foreground ' +
                'hover:border-violet-400/70 hover:bg-violet-500/10 hover:text-violet-700 ' +
                'dark:hover:text-violet-200'
        )}
      >
        {saving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles
            className={cn(
              'h-3.5 w-3.5 transition-colors',
              enabled
                ? 'text-violet-500 dark:text-violet-300'
                : 'text-violet-400/70 group-hover/ak:text-violet-500'
            )}
          />
        )}
        <span
          className={cn(
            enabled &&
              'bg-gradient-to-r from-violet-600 via-fuchsia-600 to-sky-600 bg-clip-text text-transparent ' +
                'dark:from-violet-300 dark:via-fuchsia-300 dark:to-sky-300'
          )}
        >
          Keep new PRs green
        </span>
        {locked && (
          <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
            Unlimited
          </span>
        )}
      </button>

      <Dialog open={explaining} onOpenChange={(o) => !o && setExplaining(false)}>
        <DialogContent onClose={() => setExplaining(false)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-500" />
              Keep new PRs green
            </DialogTitle>
            <DialogDescription>
              Every PR you open in this workspace gets watched from the moment Talyn sees
              it — no flagging them one at a time.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 text-sm">
            <p className="text-muted-foreground">
              When a watched PR falls behind its base, hits a conflict, or goes red, Talyn
              sends a cloud agent to fix it and push the fix to your branch. It keeps doing
              that until the PR merges.
            </p>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">Only PRs you author.</span>{' '}
                Never one you are just reviewing — fixing pushes commits, and someone
                else&apos;s branch is not yours to push to.
              </li>
              <li>
                <span className="font-medium text-foreground">It spends agent credits.</span>{' '}
                Runs execute on the cloud provider you connected, under your account, one
                per PR that needs fixing.
              </li>
              <li>
                <span className="font-medium text-foreground">Per PR still works.</span> You
                can arm or disarm any individual PR from its detail panel, whatever this is
                set to.
              </li>
            </ul>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setExplaining(false)}>
              Cancel
            </Button>
            <Button data-attr="auto-keep-explainer-confirm" onClick={confirmFromExplainer}>
              {locked ? 'See Unlimited' : 'Turn it on'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
