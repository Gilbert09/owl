import React, { useState } from 'react';
import { Loader2, Zap, Check } from 'lucide-react';
import { FREE_PLAN_ACTIVE_TASK_LIMIT } from '@talyn/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { api } from '../../lib/api';
import { openExternal } from '../../lib/openExternal';
import { trackEvent } from '../../lib/analytics';
import { useBillingStore } from '../../stores/billing';

type Period = 'monthly' | 'annual';

/**
 * The upgrade pitch. Opens when a free user hits the active-task limit (see
 * maybeHandleTaskLimit) or from Settings → Billing. Checkout happens in the
 * system browser; completion arrives via the subscription:updated WS push
 * backed by the store's poll burst — the modal flips to a success state on
 * its own when the plan changes.
 */
export function UpgradeModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const status = useBillingStore((s) => s.status);
  const startCheckoutPollBurst = useBillingStore((s) => s.startCheckoutPollBurst);
  const [period, setPeriod] = useState<Period>('annual');
  const [opening, setOpening] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const limit = status?.activeTaskLimit ?? FREE_PLAN_ACTIVE_TASK_LIMIT;
  const atTaskLimit =
    status?.plan === 'free' && status.activeTasks >= (status.activeTaskLimit ?? Infinity);
  const atQueueLimit =
    status?.plan === 'free' && status.queuedPrs >= (status.mergeQueueLimit ?? Infinity);
  const upgraded = status != null && status.plan !== 'free';

  const pitch = () => {
    if (upgraded) return 'Your plan is active — run as many tasks as you like.';
    if (atQueueLimit && !atTaskLimit) {
      const qLimit = status?.mergeQueueLimit ?? limit;
      return (
        `The free plan holds up to ${qLimit} PRs in the merge queue — you're using all ${qLimit}. ` +
        'Upgrade for an unlimited queue, or wait for a queued PR to land.'
      );
    }
    if (atTaskLimit) {
      return (
        `The free plan runs up to ${limit} tasks at once — you're using all ${limit}. ` +
        'Upgrade for unlimited concurrent tasks, or wait for a task to finish.'
      );
    }
    return `The free plan runs up to ${limit} tasks at once and queues up to ${
      status?.mergeQueueLimit ?? limit
    } PRs. Unlimited removes both caps.`;
  };

  function handleClose(next: boolean) {
    if (!next) {
      setWaiting(false);
      setError(null);
    }
    onOpenChange(next);
  }

  async function handleUpgrade() {
    setOpening(true);
    setError(null);
    trackEvent('checkout_started', { period });
    try {
      const { url } = await api.billing.checkout({ period });
      await openExternal(url);
      startCheckoutPollBurst();
      setWaiting(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout');
    } finally {
      setOpening(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={() => handleClose(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            {upgraded ? 'You’re on Unlimited' : 'Upgrade to Unlimited'}
          </DialogTitle>
          <DialogDescription>{pitch()}</DialogDescription>
        </DialogHeader>

        {!upgraded && (
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-2">
              <PlanOption
                label="Annual"
                price="$150/yr"
                hint="2 months free"
                selected={period === 'annual'}
                onSelect={() => setPeriod('annual')}
                disabled={opening || waiting}
              />
              <PlanOption
                label="Monthly"
                price="$15/mo"
                selected={period === 'monthly'}
                onSelect={() => setPeriod('monthly')}
                disabled={opening || waiting}
              />
            </div>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4" /> Unlimited concurrent tasks
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4" /> Unlimited PRs in the merge queue
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4" /> Merge queue & auto-keep-mergeable never wait for a
                slot
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4" /> Cancel anytime from Settings
              </li>
            </ul>
            {waiting && (
              <p className="text-sm text-muted-foreground">
                <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
                Finish checkout in your browser — this updates by itself once payment completes.
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {upgraded ? (
            <Button onClick={() => handleClose(false)}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => handleClose(false)} disabled={opening}>
                Not now
              </Button>
              <Button onClick={handleUpgrade} disabled={opening || waiting}>
                {opening ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : waiting ? (
                  'Waiting for checkout…'
                ) : (
                  `Upgrade — ${period === 'annual' ? '$150/yr' : '$15/mo'}`
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanOption({
  label,
  price,
  hint,
  selected,
  onSelect,
  disabled,
}: {
  label: string;
  price: string;
  hint?: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`rounded-md border p-3 text-left transition-colors ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="text-lg font-semibold">{price}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </button>
  );
}
