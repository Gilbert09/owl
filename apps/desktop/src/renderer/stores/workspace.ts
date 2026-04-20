import { create } from 'zustand';
import type { Workspace, Environment, Agent, Task, InboxItem } from '@fastowl/shared';

// Simplified repository type for store (matches API response)
export interface WatchedRepo {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  fullName: string;
}

export type Theme = 'light' | 'dark' | 'system';

// Get initial theme from localStorage or default to 'light'
function getInitialTheme(): Theme {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('fastowl-theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  }
  return 'light';
}

// Apply theme to document
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  let effectiveTheme = theme;

  if (theme === 'system') {
    effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  if (effectiveTheme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

interface WorkspaceState {
  // Current workspace
  currentWorkspaceId: string | null;
  workspaces: Workspace[];

  // Environments
  environments: Environment[];

  // Agents (kept for internal use but not exposed in UI)
  agents: Agent[];

  // Tasks
  tasks: Task[];

  // Repositories (watched repos)
  repositories: WatchedRepo[];

  // Inbox
  inboxItems: InboxItem[];
  unreadCount: number;

  // UI State
  sidebarCollapsed: boolean;
  activePanel: 'inbox' | 'queue' | 'github' | 'settings';
  selectedTaskId: string | null;
  theme: Theme;

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

  setRepositories: (repos: WatchedRepo[]) => void;

  setInboxItems: (items: InboxItem[]) => void;
  addInboxItem: (item: InboxItem) => void;
  markInboxRead: (id: string) => void;
  markInboxActioned: (id: string) => void;

  toggleSidebar: () => void;
  setActivePanel: (panel: 'inbox' | 'queue' | 'github' | 'settings') => void;
  selectTask: (id: string | null) => void;
  setTheme: (theme: Theme) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  // Initial state
  currentWorkspaceId: null,
  workspaces: [],
  environments: [],
  agents: [],
  tasks: [],
  repositories: [],
  inboxItems: [],
  unreadCount: 0,
  sidebarCollapsed: false,
  activePanel: 'queue',
  selectedTaskId: null,
  theme: getInitialTheme(),

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

  setRepositories: (repos) => set({ repositories: repos }),

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
    set((state) => {
      const existing = state.inboxItems.find((i) => i.id === id);
      const wasUnread = existing?.status === 'unread';
      return {
        inboxItems: state.inboxItems.map((i) =>
          i.id === id ? { ...i, status: 'actioned' as const } : i
        ),
        unreadCount: wasUnread
          ? Math.max(0, state.unreadCount - 1)
          : state.unreadCount,
      };
    }),

  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setActivePanel: (panel) => set({ activePanel: panel }),

  selectTask: (id) => set({ selectedTaskId: id }),

  setTheme: (theme) => {
    localStorage.setItem('fastowl-theme', theme);
    applyTheme(theme);
    set({ theme });
  },
}));

// Apply initial theme on load
if (typeof window !== 'undefined') {
  const initialTheme = getInitialTheme();
  applyTheme(initialTheme);

  // Listen for system theme changes when in 'system' mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const state = useWorkspaceStore.getState();
    if (state.theme === 'system') {
      applyTheme('system');
    }
  });
}
