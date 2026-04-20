import { useEffect, useCallback } from 'react';
import { api, wsClient } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import type {
  AgentStatusEvent,
  AgentOutputEvent,
  TaskStatusEvent,
  TaskOutputEvent,
  TaskAgentStatusEvent,
  TaskEventBroadcast,
  InboxNewEvent,
  EnvironmentStatusEvent,
  WorkspaceSettings,
} from '@fastowl/shared';

/**
 * Hook to initialize API connection and real-time updates
 */
export function useApiConnection() {
  const {
    currentWorkspaceId,
    updateAgent,
    updateTask,
    addInboxItem,
    updateEnvironment,
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

  // Handle WebSocket events
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Agent status updates
    unsubscribers.push(
      wsClient.on<AgentStatusEvent>('agent:status', (payload) => {
        updateAgent(payload.agentId, {
          status: payload.status,
          attention: payload.attention,
        });
      })
    );

    // Agent output updates
    unsubscribers.push(
      wsClient.on<AgentOutputEvent>('agent:output', (payload) => {
        // Get current output and append
        const store = useWorkspaceStore.getState();
        const agent = store.agents.find((a) => a.id === payload.agentId);
        if (agent) {
          const newOutput = payload.append
            ? agent.terminalOutput + payload.output
            : payload.output;
          updateAgent(payload.agentId, { terminalOutput: newOutput });
        }
      })
    );

    // Task status updates
    unsubscribers.push(
      wsClient.on<TaskStatusEvent>('task:status', (payload) => {
        const store = useWorkspaceStore.getState();
        const existing = store.tasks.find((t) => t.id === payload.taskId);
        const wasAwaitingReview = existing?.status === 'awaiting_review';

        updateTask(payload.taskId, {
          status: payload.status,
          result: payload.result,
        });

        // Desktop OS notification on transition into awaiting_review.
        // Only fires when it's a real transition (not an idempotent
        // restate), and only when the user has granted permission.
        if (payload.status === 'awaiting_review' && !wasAwaitingReview) {
          maybeNotifyAwaitingReview(existing?.title ?? 'Task', existing?.workspaceId);
        }
      })
    );

    // Task output updates
    unsubscribers.push(
      wsClient.on<TaskOutputEvent>('task:output', (payload) => {
        const store = useWorkspaceStore.getState();
        const task = store.tasks.find((t) => t.id === payload.taskId);
        if (task) {
          const newOutput = payload.append
            ? (task.terminalOutput || '') + payload.output
            : payload.output;
          updateTask(payload.taskId, { terminalOutput: newOutput });
        }
      })
    );

    // Task agent status updates
    unsubscribers.push(
      wsClient.on<TaskAgentStatusEvent>('task:agent_status', (payload) => {
        updateTask(payload.taskId, {
          agentStatus: payload.status,
          agentAttention: payload.attention,
        });
      })
    );

    // Structured-renderer events (stream-json). Each event is appended
    // to the task's in-memory transcript. Out-of-order events (rare but
    // possible across WS reconnects) are resolved by the event's `seq`.
    unsubscribers.push(
      wsClient.on<TaskEventBroadcast>('task:event', (payload) => {
        const store = useWorkspaceStore.getState();
        const task = store.tasks.find((t) => t.id === payload.taskId);
        if (!task) return;
        const existing = task.transcript ?? [];
        // Dedup on `seq`: reconnects can replay events the client
        // already has.
        if (existing.some((e) => e.seq === payload.event.seq)) return;
        const next = [...existing, payload.event].sort((a, b) => a.seq - b.seq);
        updateTask(payload.taskId, { transcript: next });
      })
    );

    // New inbox items
    unsubscribers.push(
      wsClient.on<InboxNewEvent>('inbox:new', (payload) => {
        addInboxItem(payload.item);
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

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [updateAgent, updateTask, addInboxItem, updateEnvironment]);
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
    setAgents,
    setTasks,
    setRepositories,
    setInboxItems,
  } = useWorkspaceStore();

  const loadData = useCallback(async () => {
    try {
      // Load workspaces and environments (global)
      let [workspaces, environments] = await Promise.all([
        api.workspaces.list(),
        api.environments.list(),
      ]);

      // If no workspaces exist, create a default one
      if (workspaces.length === 0) {
        console.log('No workspaces found, creating default workspace...');
        const defaultWorkspace = await api.workspaces.create({
          name: 'Default Workspace',
          description: 'Your first FastOwl workspace',
        });
        workspaces = [defaultWorkspace];
      }

      // If no environments exist, create a local environment
      if (environments.length === 0) {
        console.log('No environments found, creating local environment...');
        const localEnv = await api.environments.create({
          name: 'Local Machine',
          type: 'local',
          config: { type: 'local' },
        });
        environments = [localEnv];
      }

      setWorkspaces(workspaces);
      setEnvironments(environments);

      // Auto-select first workspace if none selected
      let activeWorkspaceId = currentWorkspaceId;
      if (!activeWorkspaceId && workspaces.length > 0) {
        activeWorkspaceId = workspaces[0].id;
        setCurrentWorkspace(activeWorkspaceId);
        console.log('Auto-selected workspace:', workspaces[0].name);
      }

      // Load workspace-specific data
      if (activeWorkspaceId) {
        const [agents, tasks, inboxItems, repositories] = await Promise.all([
          api.agents.list({ workspaceId: activeWorkspaceId }),
          api.tasks.list({ workspaceId: activeWorkspaceId }),
          api.inbox.list({ workspaceId: activeWorkspaceId }),
          api.repositories.list(activeWorkspaceId).catch(() => []), // May not exist
        ]);

        setAgents(agents);
        setTasks(tasks);
        setInboxItems(inboxItems);
        setRepositories(repositories);
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  }, [
    currentWorkspaceId,
    setCurrentWorkspace,
    setWorkspaces,
    setEnvironments,
    setAgents,
    setTasks,
    setRepositories,
    setInboxItems,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return { reload: loadData };
}

/**
 * Hook for agent actions
 */
export function useAgentActions() {
  const { addAgent, updateAgent, removeAgent } = useWorkspaceStore();

  const startAgent = useCallback(
    async (environmentId: string, workspaceId: string, prompt?: string) => {
      const agent = await api.agents.start({
        environmentId,
        workspaceId,
        prompt,
      });
      addAgent(agent);
      return agent;
    },
    [addAgent]
  );

  const sendInput = useCallback(async (agentId: string, input: string) => {
    await api.agents.sendInput(agentId, input);
  }, []);

  const stopAgent = useCallback(
    async (agentId: string) => {
      await api.agents.stop(agentId);
      updateAgent(agentId, { status: 'idle', attention: 'none' });
    },
    [updateAgent]
  );

  const deleteAgent = useCallback(
    async (agentId: string) => {
      await api.agents.delete(agentId);
      removeAgent(agentId);
    },
    [removeAgent]
  );

  return { startAgent, sendInput, stopAgent, deleteAgent };
}

/**
 * Hook for task actions
 */
export function useTaskActions() {
  const { addTask, updateTask } = useWorkspaceStore();

  const createTask = useCallback(
    async (data: Parameters<typeof api.tasks.create>[0]) => {
      const task = await api.tasks.create(data);
      addTask(task);
      return task;
    },
    [addTask]
  );

  const updateTaskStatus = useCallback(
    async (taskId: string, status: string) => {
      const task = await api.tasks.update(taskId, { status: status as any });
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.update(taskId, { status: 'cancelled' as any });
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const retryTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.retry(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  // Task execution control
  const startTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.start(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const sendTaskInput = useCallback(async (taskId: string, input: string) => {
    await api.tasks.sendInput(taskId, input);
  }, []);

  const stopTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.stop(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const readyForReview = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.readyForReview(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const approveTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.approve(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const rejectTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.reject(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  return {
    createTask,
    updateTaskStatus,
    cancelTask,
    retryTask,
    startTask,
    sendTaskInput,
    stopTask,
    readyForReview,
    approveTask,
    rejectTask,
  };
}

/**
 * Hook for inbox actions
 */
export function useInboxActions() {
  const { markInboxRead, markInboxActioned } = useWorkspaceStore();

  const markRead = useCallback(
    async (itemId: string) => {
      await api.inbox.markRead(itemId);
      markInboxRead(itemId);
    },
    [markInboxRead]
  );

  const markActioned = useCallback(
    async (itemId: string) => {
      await api.inbox.markActioned(itemId);
      markInboxActioned(itemId);
    },
    [markInboxActioned]
  );

  const snooze = useCallback(async (itemId: string, until: Date) => {
    await api.inbox.snooze(itemId, until.toISOString());
  }, []);

  return { markRead, markActioned, snooze };
}

/**
 * Hook for environment actions
 */
export function useEnvironmentActions() {
  const { setEnvironments } = useWorkspaceStore();

  const createEnvironment = useCallback(
    async (data: Parameters<typeof api.environments.create>[0]) => {
      const env = await api.environments.create(data);
      const envs = await api.environments.list();
      setEnvironments(envs);
      return env;
    },
    [setEnvironments]
  );

  const testConnection = useCallback(async (envId: string) => {
    return api.environments.test(envId);
  }, []);

  const deleteEnvironment = useCallback(
    async (envId: string) => {
      await api.environments.delete(envId);
      const envs = await api.environments.list();
      setEnvironments(envs);
    },
    [setEnvironments]
  );

  return { createEnvironment, testConnection, deleteEnvironment };
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

const NOTIFY_PREF_KEY = 'fastowl:notify:awaitingReview';

/** Read the user's preference for awaiting_review notifications. Default on. */
function isAwaitingReviewNotifyEnabled(): boolean {
  try {
    const raw = localStorage.getItem(NOTIFY_PREF_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

/** Write the user's preference. */
export function setAwaitingReviewNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFY_PREF_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore quota / privacy-mode issues
  }
}

export function getAwaitingReviewNotifyEnabled(): boolean {
  return isAwaitingReviewNotifyEnabled();
}

/**
 * Fire a desktop notification when a task lands in awaiting_review.
 * Electron bridges `new Notification(...)` to the native OS notification
 * center — no preload plumbing needed.
 *
 * Permission is requested lazily: if it's `default`, we ask on first
 * eligible event. Users can disable via the Settings toggle.
 */
function maybeNotifyAwaitingReview(title: string, _workspaceId?: string): void {
  if (!isAwaitingReviewNotifyEnabled()) return;
  if (typeof Notification === 'undefined') return;

  const fire = () => {
    try {
      const n = new Notification('FastOwl — task awaiting review', {
        body: title,
        silent: false,
      });
      n.onclick = () => {
        // Focus the desktop window. In Electron, window.focus() + a
        // message to the main process would be cleaner, but the default
        // behaviour already brings the window to front on most OSes.
        try { window.focus(); } catch { /* ignore */ }
      };
    } catch {
      // Permission denied or renderer in a weird state — drop silently.
    }
  };

  if (Notification.permission === 'granted') {
    fire();
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission()
      .then((perm) => {
        if (perm === 'granted') fire();
      })
      .catch(() => { /* ignore */ });
  }
}
