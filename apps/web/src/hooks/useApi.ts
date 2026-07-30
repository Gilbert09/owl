import { useEffect, useCallback, useState, useRef } from 'react';
import { api, wsClient } from '../lib/api';
import { prefetchSkills } from '../lib/skillsData';
import { useOnReconnect } from './useOnReconnect';
import {
  useWorkspaceStore,
  ACTIVE_STATUS_PARAM,
  HISTORY_STATUS_PARAM,
  HISTORY_TASK_STATUSES,
} from '../stores/workspace';
import type { BillingStatus, Task } from '@talyn/shared';
import { maybeHandleBillingLimit, useBillingStore } from '../stores/billing';
import type {
  AgentEvent,
  TaskStatusEvent,
  TaskUpdateEvent,
  TaskEventBroadcast,
  TaskCreatedEvent,
  MergeQueueBlockedEvent,
  EnvironmentStatusEvent,
  EnvironmentCreatedEvent,
  WorkspaceSettings,
} from '@talyn/shared';
import { toast } from '../stores/toast';
import { trackEvent } from '../lib/analytics';

// ---------------------------------------------------------------------------
// task:event coalescing
//
// A running agent emits a `task:event` per stream-json event — during a
// turn that's dozens per second. The naive handler did an O(n) dedup +
// O(n log n) re-sort of the whole transcript AND triggered a full React
// re-render *per event*. On a long transcript that's O(n²) work plus a
// re-render storm, which is the single biggest source of the "task screen
// feels sluggish" complaint.
//
// Instead we buffer incoming events per task and flush once per frame:
// one merge, one store write, one re-render — no matter how many events
// arrived in that window. Append is the hot path (events almost always
// arrive in order), so we only re-sort when we actually detect an
// out-of-order seq.
// ---------------------------------------------------------------------------

let pendingTaskEvents = new Map<string, AgentEvent[]>();
let taskEventFlushTimer: number | null = null;

/**
 * Merge new events into a task's transcript in the store, deduping on `seq`
 * (reconnects/backfills can replay) and re-sorting only when seqs actually
 * arrive out of order. Shared by the live `task:event` flush and the
 * on-open transcript hydration (TaskTerminal). No-op if nothing changed.
 */
export function mergeTaskTranscript(taskId: string, incoming: AgentEvent[]): void {
  if (incoming.length === 0) return;
  const store = useWorkspaceStore.getState();
  const task = store.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const existing = task.transcript ?? [];
  const seen = new Set(existing.map((e) => e.seq));
  const merged = existing.slice();
  let changed = false;
  for (const ev of incoming) {
    if (seen.has(ev.seq)) continue; // reconnects can replay events
    seen.add(ev.seq);
    merged.push(ev);
    changed = true;
  }
  if (!changed) return;
  // Cheap ordered-check; only pay for a sort when seqs actually arrived
  // out of order (rare — happens across WS reconnects).
  let ordered = true;
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].seq < merged[i - 1].seq) {
      ordered = false;
      break;
    }
  }
  if (!ordered) merged.sort((a, b) => a.seq - b.seq);
  store.updateTask(taskId, { transcript: merged });
}

function flushTaskEvents() {
  taskEventFlushTimer = null;
  if (pendingTaskEvents.size === 0) return;
  // Swap the buffer for a fresh Map up front so events arriving mid-flush
  // queue cleanly for the next frame rather than being dropped. NOTE: this
  // must reassign, not `.clear()` — clearing the same Map `batch` points at
  // would empty it before we iterate and silently drop every event.
  const batch = pendingTaskEvents;
  pendingTaskEvents = new Map();

  for (const [taskId, incoming] of batch) {
    mergeTaskTranscript(taskId, incoming);
  }
}

function scheduleTaskEventFlush() {
  if (taskEventFlushTimer !== null) return;
  // ~1 frame. setTimeout (not rAF) so it still flushes when the window is
  // backgrounded — a continuous-build run shouldn't silently stall its
  // transcript just because the user tabbed away.
  taskEventFlushTimer = window.setTimeout(flushTaskEvents, 40);
}

// How many finished-history tasks to fetch per page (initial load + each
// infinite-scroll "load more"). Active tasks are always fetched in full.
export const TASK_HISTORY_PAGE_SIZE = 30;

const HISTORY_STATUS_SET = new Set<string>(HISTORY_TASK_STATUSES);

/**
 * Load a workspace's task working set: EVERY active task (pending/queued/
 * in_progress — few and always relevant) plus the first page of finished
 * history (completed/failed/cancelled, newest first). Returns the combined
 * list and whether more history exists beyond this page. The two fetches are
 * independent, so they run in parallel.
 */
async function fetchInitialTasks(
  workspaceId: string,
): Promise<{ tasks: Task[]; hasMore: boolean }> {
  const [active, history] = await Promise.all([
    api.tasks.list({ workspaceId, status: ACTIVE_STATUS_PARAM }),
    api.tasks.list({
      workspaceId,
      status: HISTORY_STATUS_PARAM,
      limit: TASK_HISTORY_PAGE_SIZE,
    }),
  ]);
  return { tasks: [...active, ...history], hasMore: history.length === TASK_HISTORY_PAGE_SIZE };
}

/**
 * Refetch the active workspace's task list and reconcile it into the store.
 * WS broadcasts are fire-and-forget to currently-open sockets only, so any
 * status change (e.g. a cloud run auto-finalising) that lands while the app is
 * asleep / disconnected is lost. Run this on reconnect to catch those up.
 *
 * Only fetches active tasks + the first history page (not the whole table) —
 * reconcileTasks keeps already-loaded older history, so pagination survives a
 * reconnect.
 */
async function reconcileTasksFromServer(): Promise<void> {
  const store = useWorkspaceStore.getState();
  const workspaceId = store.currentWorkspaceId;
  if (!workspaceId) return;
  try {
    const { tasks, hasMore } = await fetchInitialTasks(workspaceId);
    store.reconcileTasks(tasks, workspaceId);
    // Only relax hasMore→false; if the user had already paged past the first
    // page, keep their "more available" state rather than resetting it.
    if (!hasMore) store.setTasksHasMore(false);
  } catch (err) {
    console.error('Failed to reconcile tasks after reconnect:', err);
  }
}

/**
 * Infinite-scroll "load more": fetch the next page of finished history older
 * than the oldest history task currently loaded, and append it. Guards against
 * concurrent calls (scroll fires repeatedly) and stops once exhausted.
 */
export async function loadMoreTasks(): Promise<void> {
  const store = useWorkspaceStore.getState();
  const workspaceId = store.currentWorkspaceId;
  if (!workspaceId || store.tasksLoadingMore || !store.tasksHasMore) return;

  // Cursor = the oldest loaded history task's createdAt for this workspace.
  let before: string | undefined;
  for (const t of store.tasks) {
    if (t.workspaceId !== workspaceId || !HISTORY_STATUS_SET.has(t.status)) continue;
    if (before === undefined || t.createdAt < before) before = t.createdAt;
  }

  store.setTasksLoadingMore(true);
  try {
    const older = await api.tasks.list({
      workspaceId,
      status: HISTORY_STATUS_PARAM,
      limit: TASK_HISTORY_PAGE_SIZE,
      before,
    });
    useWorkspaceStore.getState().appendOlderTasks(older);
    useWorkspaceStore.getState().setTasksHasMore(older.length === TASK_HISTORY_PAGE_SIZE);
  } catch (err) {
    console.error('Failed to load more tasks:', err);
  } finally {
    useWorkspaceStore.getState().setTasksLoadingMore(false);
  }
}

/**
 * Refetch the environment list on reconnect. Environments only change via
 * `environment:created` / `environment:status` events (e.g. a provider env
 * auto-provisioned while we were offline), so missed broadcasts otherwise
 * leave the list stale until a full reload.
 */
async function reconcileEnvironmentsFromServer(): Promise<void> {
  try {
    const environments = await api.environments.list();
    useWorkspaceStore.getState().setEnvironments(environments);
  } catch (err) {
    console.error('Failed to reconcile environments after reconnect:', err);
  }
}

/**
 * Hook to initialize API connection and real-time updates
 */
export function useApiConnection() {
  const {
    currentWorkspaceId,
    updateTask,
    updateEnvironment,
    addEnvironment,
  } = useWorkspaceStore();

  // Connect to WebSocket on mount. `connect()` is async because it needs
  // to fetch the auth token before opening the socket.
  useEffect(() => {
    void wsClient.connect();
    return () => {
      wsClient.disconnect();
    };
  }, []);

  // Subscribe to current workspace
  useEffect(() => {
    if (currentWorkspaceId) {
      wsClient.subscribe(currentWorkspaceId);
      return () => {
        wsClient.unsubscribe(currentWorkspaceId);
      };
    }
  }, [currentWorkspaceId]);

  // Reconnect catch-up: WS broadcasts that fired while we were offline are
  // gone (fire-and-forget to open sockets only). On reconnect, refetch the
  // task + environment lists to reconcile any changes we missed. The first
  // connect is covered by useInitialDataLoad.
  useOnReconnect(() => {
    void reconcileTasksFromServer();
    void reconcileEnvironmentsFromServer();
    void useBillingStore.getState().refresh();
  });

  // Billing snapshot: fetch once on mount, and re-fetch on window focus —
  // the backstop for plan changes made in the browser (checkout / portal)
  // while the WS was down.
  useEffect(() => {
    const refresh = () => void useBillingStore.getState().refresh();
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      useBillingStore.getState().stopCheckoutPollBurst();
    };
  }, []);

  // Handle WebSocket events
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Task deletions — single source of truth for dropping a task
    // from the local store. `useTaskActions.deleteTask` also calls
    // the store directly as an optimistic step, but this is the
    // authoritative signal (handles multi-client + scheduler-side
    // cleanups consistently).
    unsubscribers.push(
      wsClient.on<{ taskId: string }>('task:deleted', (payload) => {
        useWorkspaceStore.getState().removeTask(payload.taskId);
      })
    );

    // Newly-created tasks — the authoritative signal for tasks created on the
    // backend (merge-queue / auto-keep fix runs) that the desktop never created
    // itself. Deduped by id so the optimistic add from useTaskActions.createTask
    // doesn't double it.
    unsubscribers.push(
      wsClient.on<TaskCreatedEvent>('task:created', (payload) => {
        const store = useWorkspaceStore.getState();
        if (!store.tasks.some((t) => t.id === payload.task.id)) {
          store.addTask(payload.task);
        }
      })
    );

    // Task status updates
    unsubscribers.push(
      wsClient.on<TaskStatusEvent>('task:status', (payload) => {
        updateTask(payload.taskId, {
          status: payload.status,
          result: payload.result,
        });
      })
    );

    // Arbitrary task field updates — currently fires when the async
    // title refiner completes, but the shape is general.
    unsubscribers.push(
      wsClient.on<TaskUpdateEvent>('task:update', (payload) => {
        updateTask(payload.taskId, payload.updates);
      })
    );

    // Structured-renderer events (stream-json). Buffered per task and
    // flushed once per frame (see scheduleTaskEventFlush) — dedup on
    // `seq` and out-of-order resolution happen in the flush.
    unsubscribers.push(
      wsClient.on<TaskEventBroadcast>('task:event', (payload) => {
        const buf = pendingTaskEvents.get(payload.taskId);
        if (buf) buf.push(payload.event);
        else pendingTaskEvents.set(payload.taskId, [payload.event]);
        scheduleTaskEventFlush();
      })
    );

    // Environment status updates
    unsubscribers.push(
      wsClient.on<EnvironmentStatusEvent>('environment:status', (payload) => {
        updateEnvironment(payload.environmentId, {
          status: payload.status,
          error: payload.error,
        });
      })
    );

    // New environments (e.g. PostHog Code auto-provisioned on integration
    // connect) — add to the store live so they appear without a restart.
    unsubscribers.push(
      wsClient.on<EnvironmentCreatedEvent>('environment:created', (payload) => {
        addEnvironment(payload.environment);
      })
    );

    // A merge-queue PR exhausted its auto-fix retries and now needs a human.
    // This is a top-level (not panel-scoped) listener so the notification
    // fires regardless of which panel is open. Fire-once on the backend's
    // transition signal — see notifyMergeQueueBlocked.
    unsubscribers.push(
      wsClient.on<MergeQueueBlockedEvent>('merge_queue:blocked', (payload) => {
        notifyMergeQueueBlocked(payload);
      })
    );

    // Plan changes (Polar webhook applied server-side). Per-user event; also
    // ends the post-checkout poll burst early via setStatus.
    unsubscribers.push(
      wsClient.on<BillingStatus>('subscription:updated', (payload) => {
        useBillingStore.getState().setStatus(payload);
      })
    );

    return () => {
      unsubscribers.forEach((unsub) => unsub());
      // Drain any buffered transcript events before tearing down so a
      // teardown mid-burst doesn't drop the tail of a turn.
      if (taskEventFlushTimer !== null) {
        window.clearTimeout(taskEventFlushTimer);
        flushTaskEvents();
      }
    };
  }, [updateTask, updateEnvironment, addEnvironment]);
}

/**
 * Hook to load initial data
 */
export function useInitialDataLoad() {
  const {
    currentWorkspaceId,
    setCurrentWorkspace,
    setWorkspaces,
    setEnvironments,
    setTasks,
    setTasksHasMore,
    setRepositories,
    setOnboardingComplete,
  } = useWorkspaceStore();
  const [loaded, setLoaded] = useState(false);
  // The onboarding migration must reflect whether the user already had
  // workspaces when this session started — not whether the wizard's step 1
  // just created one. So we only evaluate it on the very first load
  // (loadData re-runs when the active workspace changes).
  const migrationCheckedRef = useRef(false);

  const loadData = useCallback(async () => {
    try {
      // Load workspaces and environments (global)
      const [workspaces, environments] = await Promise.all([
        api.workspaces.list(),
        api.environments.list(),
      ]);

      // No silent default-workspace creation: a true first run lands on the
      // onboarding wizard (step 1 creates the first workspace). But a
      // returning user who already has workspaces must never see the wizard —
      // this is the only place with the fetched server-side list, so mark
      // them onboarded here if the persisted flag isn't set yet. Only on the
      // first load, so the workspace the wizard creates doesn't trip it.
      if (!migrationCheckedRef.current) {
        migrationCheckedRef.current = true;
        const onboarded = useWorkspaceStore.getState().onboardingComplete;
        if (workspaces.length > 0 && !onboarded) {
          setOnboardingComplete(true);
        } else if (workspaces.length === 0 && onboarded) {
          // The inverse migration: the server has no workspaces (fresh DB or
          // a backend switch) but a previous session's persisted flag says
          // "onboarded" — without this the user lands in an empty MainLayout
          // with no way to create a workspace. Re-run the wizard.
          setOnboardingComplete(false);
        }
      }

      // Cloud-provider env markers are auto-provisioned by the backend
      // when a provider is connected (Settings → Integrations) — the
      // desktop never creates one.

      setWorkspaces(workspaces);
      setEnvironments(environments);

      // Honor the persisted selection if it still exists; otherwise fall
      // back to the first workspace (e.g. the stored one was deleted).
      let activeWorkspaceId = currentWorkspaceId;
      const stillExists =
        !!activeWorkspaceId && workspaces.some((w) => w.id === activeWorkspaceId);
      if (!stillExists && workspaces.length > 0) {
        activeWorkspaceId = workspaces[0].id;
        setCurrentWorkspace(activeWorkspaceId);
        console.log('Selected workspace:', workspaces[0].name);
      } else if (!stillExists && activeWorkspaceId) {
        // The persisted workspace is gone and there's no fallback — clear it,
        // or every per-workspace fetch 404s against the stale id ("workspace
        // not found" everywhere).
        activeWorkspaceId = null;
        setCurrentWorkspace(null);
      }

      // Load workspace-specific data. Tasks come as active (all) + the first
      // page of finished history; the queue panel lazy-loads older history.
      if (activeWorkspaceId) {
        const [taskPage, repositories] = await Promise.all([
          fetchInitialTasks(activeWorkspaceId),
          api.repositories.list(activeWorkspaceId).catch(() => []), // May not exist
        ]);

        setTasks(taskPage.tasks);
        setTasksHasMore(taskPage.hasMore);
        setRepositories(repositories);

        // Warm the skills cache (local + per-repo discovery) so the per-PR
        // skill picker opens instantly populated. Fire-and-forget.
        void prefetchSkills(
          activeWorkspaceId,
          repositories.map((r) => r.id)
        ).catch(() => {});
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    } finally {
      setLoaded(true);
    }
  }, [
    currentWorkspaceId,
    setCurrentWorkspace,
    setWorkspaces,
    setEnvironments,
    setTasks,
    setTasksHasMore,
    setRepositories,
    setOnboardingComplete,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return { reload: loadData, loaded };
}

/**
 * Hook for task actions
 */
export function useTaskActions() {
  const { addTask, updateTask, removeTask } = useWorkspaceStore();

  const createTask = useCallback(
    async (data: Parameters<typeof api.tasks.create>[0]) => {
      let task;
      try {
        task = await api.tasks.create(data);
      } catch (err) {
        // Free-plan limit → upgrade modal; still rethrow so the calling
        // surface shows its inline error too.
        maybeHandleBillingLimit(err, 'task_create');
        throw err;
      }
      trackEvent('task_created', {
        task_type: data.type,
        model: data.model,
        runtime_adapter: data.runtimeAdapter,
        from_pr: Boolean(data.pullRequestId),
      });
      addTask(task);
      return task;
    },
    [addTask]
  );

  const updateTaskStatus = useCallback(
    async (taskId: string, status: string) => {
      try {
        const task = await api.tasks.update(taskId, { status: status as any });
        updateTask(taskId, task);
        return task;
      } catch (err) {
        maybeHandleBillingLimit(err, 'task_requeue'); // re-queueing via PATCH is gated too
        throw err;
      }
    },
    [updateTask]
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.update(taskId, { status: 'cancelled' as any });
      trackEvent('task_cancelled', { task_type: task.type });
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const retryTask = useCallback(
    async (taskId: string) => {
      let task;
      try {
        task = await api.tasks.retry(taskId);
      } catch (err) {
        maybeHandleBillingLimit(err, 'task_retry');
        throw err;
      }
      trackEvent('task_retried', { task_type: task.type });
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  // Task execution control
  const startTask = useCallback(
    async (taskId: string) => {
      let task;
      try {
        task = await api.tasks.start(taskId);
      } catch (err) {
        maybeHandleBillingLimit(err, 'task_start');
        throw err;
      }
      trackEvent('task_started_manually', { task_type: task.type });
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const stopTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.stop(taskId);
      trackEvent('task_aborted', { task_type: task.type });
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      await api.tasks.delete(taskId);
      trackEvent('task_deleted');
      removeTask(taskId);
    },
    [removeTask]
  );

  return {
    createTask,
    updateTaskStatus,
    cancelTask,
    retryTask,
    startTask,
    stopTask,
    deleteTask,
  };
}

/**
 * Hook for workspace actions
 */
export function useWorkspaceActions() {
  const { setWorkspaces, currentWorkspaceId } = useWorkspaceStore();

  const createWorkspace = useCallback(
    async (data: Parameters<typeof api.workspaces.create>[0]) => {
      const workspace = await api.workspaces.create(data);
      const workspaces = await api.workspaces.list();
      setWorkspaces(workspaces);
      return workspace;
    },
    [setWorkspaces]
  );

  const updateWorkspace = useCallback(
    async (id: string, data: Parameters<typeof api.workspaces.update>[1]) => {
      const workspace = await api.workspaces.update(id, data);
      const workspaces = await api.workspaces.list();
      setWorkspaces(workspaces);
      return workspace;
    },
    [setWorkspaces]
  );

  const deleteWorkspace = useCallback(
    async (id: string) => {
      await api.workspaces.delete(id);
      const workspaces = await api.workspaces.list();
      setWorkspaces(workspaces);
    },
    [setWorkspaces]
  );

  const updateCurrentWorkspaceSettings = useCallback(
    async (settings: Partial<WorkspaceSettings>) => {
      if (!currentWorkspaceId) return null;
      // Cast is safe because backend merges partial settings with existing values
      const workspace = await api.workspaces.update(currentWorkspaceId, {
        settings: settings as WorkspaceSettings,
      });
      const workspaces = await api.workspaces.list();
      setWorkspaces(workspaces);
      return workspace;
    },
    [currentWorkspaceId, setWorkspaces]
  );

  /**
   * Re-fetch the workspace list. Callers trigger this after mutations
   * that change workspace *relations* (e.g., adding/removing a repo)
   * so derived UI like the sidebar's repo count stays in sync.
   */
  const refreshWorkspaces = useCallback(async () => {
    const workspaces = await api.workspaces.list();
    setWorkspaces(workspaces);
  }, [setWorkspaces]);

  return {
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    updateCurrentWorkspaceSettings,
    refreshWorkspaces,
  };
}

// ============================================================================
// Notifications
// ============================================================================

const NOTIFY_BLOCKED_KEY = 'fastowl:notify:mergeBlocked';

/** Whether merge-queue-blocked notifications are enabled. Default on. */
export function getMergeBlockedNotifyEnabled(): boolean {
  try {
    const raw = localStorage.getItem(NOTIFY_BLOCKED_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

/** Persist the merge-queue-blocked notification preference. */
export function setMergeBlockedNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFY_BLOCKED_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore quota / privacy-mode issues
  }
}

/**
 * A merge-queue PR gave up after its retry budget. Surface it both as an
 * in-app toast (seen while the app is open) and an OS notification (seen when
 * it's backgrounded). Both honour the Settings toggle; the OS path also needs
 * the user to have granted notification permission, requested lazily on first
 * fire. Electron bridges the renderer `Notification` API to the native center.
 */
function notifyMergeQueueBlocked(p: MergeQueueBlockedEvent): void {
  if (!getMergeBlockedNotifyEnabled()) return;

  const ref = `${p.owner}/${p.repo}#${p.number}`;
  const body = `${ref} can't merge — ${p.reason}. Needs manual intervention.`;

  // In-app toast (error variant lingers longer so there's time to read it).
  toast.error('Merge queue blocked', body);

  // OS notification.
  if (typeof Notification === 'undefined') return;
  const fire = () => {
    try {
      const n = new Notification('Talyn — merge queue blocked', { body, silent: false });
      n.onclick = () => {
        try {
          window.focus();
          // Jump to the Merge Queue page, where the blocked PR's amber badge lives.
          useWorkspaceStore.getState().setActivePanel('merge_queue');
        } catch {
          // ignore
        }
      };
    } catch {
      // Permission denied / renderer weirdness — the toast already covered it.
    }
  };
  if (Notification.permission === 'granted') {
    fire();
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission()
      .then((perm) => {
        if (perm === 'granted') fire();
      })
      .catch(() => {
        // ignore
      });
  }
}
