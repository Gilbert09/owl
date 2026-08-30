import { create } from 'zustand';
import {
  AUTO_KEEP_DEFAULT_ERROR_CODE,
  MERGE_QUEUE_LIMIT_ERROR_CODE,
  TASK_LIMIT_ERROR_CODE,
  type BillingStatus,
} from '@talyn/shared';
import { api, ApiError } from '../lib/api';
import { trackEvent } from '../lib/analytics';

/**
 * Billing state: the user's plan/usage snapshot plus the upgrade-modal flag.
 *
 * The snapshot is server-authoritative (`GET /billing/status`) — never
 * derived from the local task list, which doesn't span every workspace the
 * user owns. It refreshes on app start, on window focus, on the
 * `subscription:updated` WS push, and in a short poll burst right after a
 * checkout/portal page is opened in the browser (webhooks can lag the
 * checkout by a few seconds, and the WS may be reconnecting at that moment).
 */

const POLL_BURST_INTERVAL_MS = 3_000;
const POLL_BURST_MAX_MS = 2 * 60_000;

interface BillingState {
  status: BillingStatus | null;
  upgradeModalOpen: boolean;
  /** What the user was refused, so the modal can pitch that thing. */
  upgradeReason: UpgradeReason | null;
  setStatus: (status: BillingStatus) => void;
  setUpgradeModalOpen: (open: boolean, reason?: UpgradeReason | null) => void;
  /** Re-fetch the snapshot from the backend. Safe to call repeatedly. */
  refresh: () => Promise<void>;
  /** Start (or restart) the post-checkout poll burst. */
  startCheckoutPollBurst: () => void;
  stopCheckoutPollBurst: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollDeadline = 0;

export const useBillingStore = create<BillingState>((set, get) => ({
  status: null,
  upgradeModalOpen: false,
  upgradeReason: null,

  setStatus: (status) => {
    const prev = get().status;
    set({ status });
    // Conversion signal: fire once when a free plan flips to paid *within the
    // session* (checkout completing via the WS push / poll burst, or a comp).
    // Guarding on prev existing + being free means loading an already-upgraded
    // account on startup doesn't count as an upgrade.
    if (prev?.plan === 'free' && status.plan !== 'free') {
      trackEvent('upgrade_completed', { plan_source: status.planSource });
    }
    // The burst exists to catch the plan flip; once we're not free (or
    // billing turns out to be off) there's nothing left to poll for.
    if (status.plan !== 'free' || !status.billingEnabled) {
      get().stopCheckoutPollBurst();
    }
  },

  setUpgradeModalOpen: (upgradeModalOpen, reason) =>
    // Clear the reason on close so the next open can't inherit stale copy.
    set({ upgradeModalOpen, upgradeReason: upgradeModalOpen ? (reason ?? null) : null }),

  refresh: async () => {
    try {
      get().setStatus(await api.billing.status());
    } catch {
      // Transient (offline / backend restart) — keep the last snapshot; the
      // next focus/WS/poll tick retries. Enforcement is server-side anyway.
    }
  },

  startCheckoutPollBurst: () => {
    pollDeadline = Date.now() + POLL_BURST_MAX_MS;
    if (pollTimer) return; // already running — just extended the deadline
    pollTimer = setInterval(() => {
      if (Date.now() > pollDeadline) {
        get().stopCheckoutPollBurst();
        return;
      }
      void get().refresh();
    }, POLL_BURST_INTERVAL_MS);
  },

  stopCheckoutPollBurst: () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
}));

/** The 402 codes the free plan can reject with. */
const BILLING_LIMIT_CODES: ReadonlySet<string> = new Set([
  TASK_LIMIT_ERROR_CODE,
  MERGE_QUEUE_LIMIT_ERROR_CODE,
  AUTO_KEEP_DEFAULT_ERROR_CODE,
]);

/**
 * Why the modal opened. The two limit codes are usage caps the modal can
 * describe from the live snapshot ("you're using all 3"); a FEATURE code has no
 * count behind it, so the modal has to be told which feature was asked for or
 * it pitches a limit the user is nowhere near.
 */
export type UpgradeReason = 'task_limit' | 'merge_queue_limit' | 'auto_keep_default';

function reasonFor(code: string): UpgradeReason {
  if (code === MERGE_QUEUE_LIMIT_ERROR_CODE) return 'merge_queue_limit';
  if (code === AUTO_KEEP_DEFAULT_ERROR_CODE) return 'auto_keep_default';
  return 'task_limit';
}

/**
 * Shared 402 interception: when `err` is a free-plan limit rejection (task
 * concurrency or merge-queue cap), record the paywall impression, open the
 * upgrade modal (and refresh the snapshot so it shows live usage), and return
 * true. Callers keep their generic error handling for everything else.
 *
 * `trigger` is the action the user was taking when they hit the wall
 * (e.g. 'task_create', 'task_retry', 'merge_queue') — the entry point of the
 * monetization funnel, broken out so we can see which surface drives upgrades.
 */
export function maybeHandleBillingLimit(err: unknown, trigger?: string): boolean {
  if (!(err instanceof ApiError) || !err.code || !BILLING_LIMIT_CODES.has(err.code)) {
    return false;
  }
  const store = useBillingStore.getState();
  const status = store.status;
  const reason = reasonFor(err.code);
  trackEvent('paywall_shown', {
    // 'task_limit' | 'merge_queue_limit' | 'auto_keep_default' — what was refused.
    reason,
    trigger: trigger ?? 'unknown',
    // Live usage at the moment of the wall (the pre-refresh snapshot).
    active_tasks: status?.activeTasks,
    active_task_limit: status?.activeTaskLimit,
    queued_prs: status?.queuedPrs,
    merge_queue_limit: status?.mergeQueueLimit,
    plan: status?.plan,
  });
  void store.refresh();
  store.setUpgradeModalOpen(true, reason);
  return true;
}
