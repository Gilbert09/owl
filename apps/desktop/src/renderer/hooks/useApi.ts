import { useEffect, useCallback } from 'react';
import { api, wsClient } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import type {
  AgentStatusEvent,
  AgentOutputEvent,
  TaskStatusEvent,
  InboxNewEvent,
  EnvironmentStatusEvent,
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

  // Connect to WebSocket on mount
  useEffect(() => {
    wsClient.connect();
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
        updateTask(payload.taskId, {
          status: payload.status,
          result: payload.result,
        });
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
        const [agents, tasks, inboxItems] = await Promise.all([
          api.agents.list({ workspaceId: activeWorkspaceId }),
          api.tasks.list({ workspaceId: activeWorkspaceId }),
          api.inbox.list({ workspaceId: activeWorkspaceId }),
        ]);

        setAgents(agents);
        setTasks(tasks);
        setInboxItems(inboxItems);
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

  return { createTask, updateTaskStatus, cancelTask };
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
    async (settings: { autoAssignTasks?: boolean; maxConcurrentAgents?: number }) => {
      if (!currentWorkspaceId) return null;
      // Cast is safe because backend merges partial settings with existing values
      const workspace = await api.workspaces.update(currentWorkspaceId, {
        settings: settings as { autoAssignTasks: boolean; maxConcurrentAgents: number }
      });
      const workspaces = await api.workspaces.list();
      setWorkspaces(workspaces);
      return workspace;
    },
    [currentWorkspaceId, setWorkspaces]
  );

  return { createWorkspace, updateWorkspace, deleteWorkspace, updateCurrentWorkspaceSettings };
}
