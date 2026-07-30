import { create } from 'zustand';
import type { MergeQueuePublic, PRRow, PRSummaryShape, PRState } from '../lib/api';

/**
 * Shared open-PR state, lifted out of the old single GitHub panel so the
 * Sidebar (live count badges) and the three pages — My PRs, Reviews, Merge
 * Queue — all read one set of rows kept current by a single
 * `pull_request:updated` subscription. `usePullRequestSync` owns the fetch +
 * WS wiring and writes here; components read + derive their filtered views.
 *
 * The list holds OPEN PRs only — merged/closed rows are dropped on the WS
 * echo, matching the old panel's open-only browse model.
 */

/** Payload shape of a `pull_request:updated` WS event. Relationship/watcher/
 *  queue fields only ride along when they changed, so they're optional. */
export interface PullRequestUpdatePayload {
  id: string;
  taskId: string | null;
  state: PRState;
  /** May be a *partial* summary (e.g. the incremental check-count path sends only
   *  `{ checks }`); it's merged into the held summary, not replaced. */
  lastSummary: Partial<PRSummaryShape>;
  reviewRequested?: boolean;
  authored?: boolean;
  autoKeepMergeable?: boolean;
  autoMergeState?: { attempts: number; paused: boolean } | null;
  mergeQueued?: boolean;
  mergeQueueState?: {
    status: 'waiting' | 'fixing' | 'merging' | 'blocked';
    attempts: number;
    position: number;
    reason?: string;
  } | null;
  /** v2 payload — rides along with mergeQueueState on v2-era echoes. */
  mergeQueue?: MergeQueuePublic | null;
}

interface PullRequestState {
  rows: PRRow[];
  loading: boolean;
  error: string | null;
  // null = connection not yet checked. Distinguishes "GitHub disconnected"
  // from "connected but no PRs" so the empty state isn't misleading.
  connected: boolean | null;
  // The viewer's GitHub login — labels "requested directly" rows on Reviews.
  viewerLogin: string | null;
  // Whether PostHog Code (cloud tasks) is configured — gates follow-up runs.
  posthogConnected: boolean;

  setRows: (rows: PRRow[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setConnected: (connected: boolean | null) => void;
  setViewerLogin: (login: string | null) => void;
  setPosthogConnected: (connected: boolean) => void;

  /**
   * Merge a `pull_request:updated` echo into `rows` in place. Returns true
   * when the payload is for an OPEN PR we don't yet hold, so the caller can
   * refetch the open list (we lack workspaceId/repositoryId to insert it,
   * and the backend orders by lastPolledAt).
   */
  applyPullRequestUpdate: (p: PullRequestUpdatePayload) => boolean;

  /** Optimistic single-row patch (merge-queue toggle, task linking). */
  patchRow: (id: string, updates: Partial<PRRow>) => void;
  /** Drop a row (optimistic merge, or it left the open set). */
  removeRow: (id: string) => void;
}

export const usePullRequestStore = create<PullRequestState>((set, get) => ({
  rows: [],
  // Starts true so the pages show their loading state on first paint, before
  // usePullRequestSync's initial-fetch effect has even run (effects fire after
  // render — starting false would flash the empty state for a frame).
  loading: true,
  error: null,
  connected: null,
  viewerLogin: null,
  posthogConnected: false,

  setRows: (rows) => set({ rows }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setConnected: (connected) => set({ connected }),
  setViewerLogin: (viewerLogin) => set({ viewerLogin }),
  setPosthogConnected: (posthogConnected) => set({ posthogConnected }),

  applyPullRequestUpdate: (p) => {
    const prev = get().rows;
    const idx = prev.findIndex((r) => r.id === p.id);
    if (idx === -1) {
      // The list only holds open PRs, so a non-open echo for a row we don't
      // have is a no-op. A new *open* PR needs a refetch (we can't hand-insert
      // without workspaceId/repositoryId) — signal that to the caller.
      return p.state === 'open';
    }
    // A row that left "open" (merged/closed upstream, incl. auto-merge) no
    // longer belongs in this open-only list — drop it.
    if (p.state !== 'open') {
      set({ rows: prev.filter((r) => r.id !== p.id) });
      return false;
    }
    const next = prev.slice();
    next[idx] = {
      ...next[idx],
      state: p.state,
      // Merge, don't replace: an incremental echo carries only the changed slice
      // (e.g. `{ checks }`), and full echoes carry every field so merging is a
      // no-op for them. Keeps title/mergeable/etc. when only counts changed.
      summary: { ...next[idx].summary, ...p.lastSummary },
      // Preserve a known link if the echo omits it; adopt a new one when the
      // backend reports it (e.g. just-started fix task).
      taskId: p.taskId ?? next[idx].taskId,
      // Relationship flags are only on the payload when the monitor re-bucketed
      // the row (e.g. it left Review after being reviewed); else keep ours.
      reviewRequested: p.reviewRequested ?? next[idx].reviewRequested,
      authored: p.authored ?? next[idx].authored,
      // Watcher state only rides along when it changed; otherwise keep ours.
      autoKeepMergeable: p.autoKeepMergeable ?? next[idx].autoKeepMergeable,
      autoMergeState:
        p.autoMergeState !== undefined ? p.autoMergeState : next[idx].autoMergeState,
      // Merge-queue state only rides along when it changed; otherwise keep ours.
      mergeQueued: p.mergeQueued ?? next[idx].mergeQueued,
      mergeQueueState:
        p.mergeQueueState !== undefined ? p.mergeQueueState : next[idx].mergeQueueState,
      mergeQueue: p.mergeQueue !== undefined ? p.mergeQueue : next[idx].mergeQueue,
    };
    set({ rows: next });
    return false;
  },

  patchRow: (id, updates) =>
    set((state) => ({
      rows: state.rows.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    })),

  removeRow: (id) =>
    set((state) => ({ rows: state.rows.filter((r) => r.id !== id) })),
}));
