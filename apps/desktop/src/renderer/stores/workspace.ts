import { create } from 'zustand';
import type { Workspace, Environment, Agent, Task, InboxItem } from '@fastowl/shared';

interface WorkspaceState {
  // Current workspace
  currentWorkspaceId: string | null;
  workspaces: Workspace[];

  // Environments
  environments: Environment[];

  // Agents
  agents: Agent[];

  // Tasks
  tasks: Task[];

  // Inbox
  inboxItems: InboxItem[];
  unreadCount: number;

  // UI State
  sidebarCollapsed: boolean;
  activePanel: 'inbox' | 'terminals' | 'queue' | 'settings';
  selectedAgentId: string | null;
  selectedTaskId: string | null;

  // Actions
  setCurrentWorkspace: (id: string | null) => void;
  setWorkspaces: (workspaces: Workspace[]) => void;
  addWorkspace: (workspace: Workspace) => void;

  setEnvironments: (environments: Environment[]) => void;
  updateEnvironment: (id: string, updates: Partial<Environment>) => void;

  setAgents: (agents: Agent[]) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  addAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;

  setTasks: (tasks: Task[]) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  addTask: (task: Task) => void;

  setInboxItems: (items: InboxItem[]) => void;
  addInboxItem: (item: InboxItem) => void;
  markInboxRead: (id: string) => void;
  markInboxActioned: (id: string) => void;

  toggleSidebar: () => void;
  setActivePanel: (panel: 'inbox' | 'terminals' | 'queue' | 'settings') => void;
  selectAgent: (id: string | null) => void;
  selectTask: (id: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  // Initial state
  currentWorkspaceId: null,
  workspaces: [],
  environments: [],
  agents: [],
  tasks: [],
  inboxItems: [],
  unreadCount: 0,
  sidebarCollapsed: false,
  activePanel: 'terminals',
  selectedAgentId: null,
  selectedTaskId: null,

  // Actions
  setCurrentWorkspace: (id) => set({ currentWorkspaceId: id }),

  setWorkspaces: (workspaces) => set({ workspaces }),

  addWorkspace: (workspace) =>
    set((state) => ({ workspaces: [...state.workspaces, workspace] })),

  setEnvironments: (environments) => set({ environments }),

  updateEnvironment: (id, updates) =>
    set((state) => ({
      environments: state.environments.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      ),
    })),

  setAgents: (agents) => set({ agents }),

  updateAgent: (id, updates) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === id ? { ...a, ...updates } : a
      ),
    })),

  addAgent: (agent) =>
    set((state) => ({ agents: [...state.agents, agent] })),

  removeAgent: (id) =>
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== id),
      selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
    })),

  setTasks: (tasks) => set({ tasks }),

  updateTask: (id, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),

  addTask: (task) =>
    set((state) => ({ tasks: [...state.tasks, task] })),

  setInboxItems: (items) =>
    set({
      inboxItems: items,
      unreadCount: items.filter((i) => i.status === 'unread').length,
    }),

  addInboxItem: (item) =>
    set((state) => ({
      inboxItems: [item, ...state.inboxItems],
      unreadCount: state.unreadCount + (item.status === 'unread' ? 1 : 0),
    })),

  markInboxRead: (id) =>
    set((state) => ({
      inboxItems: state.inboxItems.map((i) =>
        i.id === id ? { ...i, status: 'read' as const } : i
      ),
      unreadCount: Math.max(0, state.unreadCount - 1),
    })),

  markInboxActioned: (id) =>
    set((state) => ({
      inboxItems: state.inboxItems.map((i) =>
        i.id === id ? { ...i, status: 'actioned' as const } : i
      ),
    })),

  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setActivePanel: (panel) => set({ activePanel: panel }),

  selectAgent: (id) => set({ selectedAgentId: id }),

  selectTask: (id) => set({ selectedTaskId: id }),
}));
