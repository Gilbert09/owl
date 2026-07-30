import { create } from 'zustand';
import type { Workspace, Environment, Task, TaskStatus, SkillSummary } from '@talyn/shared';
import type {
  GitHubStatus,
  GitHubUser,
  GitHubInstallation,
  PostHogCodeStatus,
  CloudProviderInfo,
  PRRow,
} from '../lib/api';

/**
 * A task the user tried to start with no cloud provider connected. Stashed when
 * the "connect an agent" modal opens so it can auto-run the instant a provider
 * connects. `providerType` preserves an explicit picker choice, if any.
 */
export type PendingCloudTask =
  | { kind: 'fix'; row: PRRow; providerType?: string }
  | {
      kind: 'skill';
      row: PRRow;
      skill: SkillSummary;
      localContent?: string;
      providerType?: string;
    };

/**
 * Task status groups. Active tasks are few and always fully loaded; the finished
 * history is unbounded and paginated. Kept here as the single source of truth so
 * the store, the initial load, and the queue panel agree on the split. Both are
 * exported as comma-joined strings for the `?status=` list the API accepts.
 */
export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'pending',
  'queued',
  'in_progress',
]);
export const HISTORY_TASK_STATUSES: readonly TaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
];
export const ACTIVE_STATUS_PARAM = [...ACTIVE_TASK_STATUSES].join(',');
export const HISTORY_STATUS_PARAM = HISTORY_TASK_STATUSES.join(',');

/** Settings sub-sections — kept in the store so other surfaces (the sidebar
 *  provider status, the per-task "Set default" action) can deep-link into a
 *  specific section. */
export type SettingsSection =
  | 'workspace'
  | 'integrations'
  | 'skills'
  | 'account'
  | 'billing'
  | 'appearance'
  | 'developer'
  | 'mcp'
  | 'about';

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

const DEBUG_MODE_KEY = 'fastowl-debug-mode';

// Developer-only Debug panel toggle. Persisted like the theme so it survives
// restarts. Off by default — it surfaces app internals (requests, polling,
// WebSocket) and is meant to be opt-in.
function getInitialDebugMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(DEBUG_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

const ONBOARDING_KEY = 'fastowl-onboarding-complete';

// First-run onboarding gate. Persisted like the theme/debug flags so it
// survives restarts. Defaults to false → the wizard shows on a true first
// run; `useInitialDataLoad` flips it to true for returning users who already
// have at least one workspace, so they never see the wizard.
function getInitialOnboardingComplete(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(ONBOARDING_KEY) === 'true';
  } catch {
    return false;
  }
}

const WORKSPACE_PREF_KEY = 'fastowl-current-workspace';

// Last-selected workspace id, so a switch survives an app restart instead of
// snapping back to the first workspace. Validated against the fetched list on
// load (the id may have been deleted elsewhere).
function getInitialWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(WORKSPACE_PREF_KEY);
  } catch {
    return null;
  }
}

function persistWorkspaceId(id: string | null) {
  try {
    if (id) localStorage.setItem(WORKSPACE_PREF_KEY, id);
    else localStorage.removeItem(WORKSPACE_PREF_KEY);
  } catch {
    // ignore quota / privacy-mode issues
  }
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

  // Tasks. Active tasks (pending/queued/in_progress) are always fully loaded;
  // the finished history (completed/failed/cancelled) is paginated — the first
  // page loads with the workspace and `appendOlderTasks` walks further back.
  tasks: Task[];
  // Whether more finished-history tasks exist server-side beyond what's loaded.
  tasksHasMore: boolean;
  // A "load older history" page fetch is in flight (guards the infinite scroll).
  tasksLoadingMore: boolean;

  // Repositories (watched repos)
  repositories: WatchedRepo[];

  // UI State
  sidebarCollapsed: boolean;
  activePanel: 'queue' | 'my_prs' | 'reviews' | 'merge_queue' | 'settings' | 'debug';
  // Developer-only Debug panel visibility (sidebar entry + reachable view).
  debugMode: boolean;
  selectedTaskId: string | null;
  theme: Theme;
  // Whether the create-workspace modal is open (triggered from the sidebar
  // switcher and the Settings empty state).
  createWorkspaceOpen: boolean;
  // First-run onboarding gate. When false, App renders the OnboardingWizard
  // instead of MainLayout.
  onboardingComplete: boolean;
  // One-shot flag set when the user finishes the wizard (not on the returning-
  // user migration path). The freshly-watched repos haven't been polled yet, so
  // usePullRequestSync consumes this to force a real GitHub poll on first entry
  // instead of a cached list that would land them on an empty state. Transient
  // (never persisted) — cleared immediately after it's consumed.
  justOnboarded: boolean;
  // Integration connection state for the current workspace, preloaded at
  // startup (useSystemStatus) so Settings → Integrations renders instantly
  // instead of fetching on open. null = not yet checked.
  githubStatus: GitHubStatus | null;
  githubUser: GitHubUser | null;
  // GitHub App installations the connected user can access (one per account/org).
  // Preloaded by useSystemStatus and kept fresh on focus, so the global banner +
  // Settings can tell which watched repos lack an active App install. null = not
  // yet checked (don't flash a "not installed" warning before the first load).
  githubInstallations: GitHubInstallation[] | null;
  posthogStatus: PostHogCodeStatus | null;
  // Connected cloud providers for the current workspace, preloaded + kept fresh
  // by useSystemStatus (one source of truth, so the Settings cards, the default
  // selector, the sidebar status row, and the per-task picker never disagree or
  // flash a stale "disconnected" on remount). null = not yet checked.
  cloudProviders: CloudProviderInfo[] | null;
  // "Connect an agent" modal. Task buttons render even with no provider
  // connected (so first-run users can reach them); clicking one with nothing
  // connected opens this instead of silently no-oping. `pendingCloudTask` is
  // the intent to auto-run the moment a provider connects.
  connectAgentOpen: boolean;
  pendingCloudTask: PendingCloudTask | null;
  // Which Settings sub-section is active. Lifted out of SettingsPanel so other
  // surfaces can deep-link (e.g. clicking the sidebar provider status).
  settingsSection: SettingsSection;

  // Actions
  setCurrentWorkspace: (id: string | null) => void;
  setWorkspaces: (workspaces: Workspace[]) => void;
  addWorkspace: (workspace: Workspace) => void;
  setCreateWorkspaceOpen: (open: boolean) => void;
  setOnboardingComplete: (done: boolean) => void;
  setJustOnboarded: (value: boolean) => void;
  setGitHubStatus: (status: GitHubStatus | null) => void;
  setGitHubUser: (user: GitHubUser | null) => void;
  setGitHubInstallations: (installations: GitHubInstallation[] | null) => void;
  setPostHogStatus: (status: PostHogCodeStatus | null) => void;
  setCloudProviders: (providers: CloudProviderInfo[] | null) => void;
  /** Open the "connect an agent" modal, optionally stashing a task to auto-run
   *  the instant a provider connects. */
  openConnectAgent: (pending?: PendingCloudTask | null) => void;
  /** Close the modal and drop any stashed task. */
  closeConnectAgent: () => void;
  /** Drop just the stashed task (after it has fired). */
  clearPendingCloudTask: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  /** Jump to Settings, optionally pre-selecting a sub-section. */
  openSettings: (section?: SettingsSection) => void;

  setEnvironments: (environments: Environment[]) => void;
  updateEnvironment: (id: string, updates: Partial<Environment>) => void;
  addEnvironment: (environment: Environment) => void;

  setTasks: (tasks: Task[]) => void;
  // Reconcile the task list for one workspace against a fresh server fetch,
  // used after a WebSocket reconnect to replay status changes whose broadcasts
  // we missed while offline. Unlike setTasks it preserves locally-loaded rich
  // fields (transcript) the list endpoint omits for egress.
  reconcileTasks: (tasks: Task[], workspaceId: string) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  addTask: (task: Task) => void;
  removeTask: (id: string) => void;
  // Append an older page of finished-history tasks (deduped by id) fetched by
  // the infinite-scroll "load more".
  appendOlderTasks: (tasks: Task[]) => void;
  setTasksHasMore: (hasMore: boolean) => void;
  setTasksLoadingMore: (loading: boolean) => void;

  setRepositories: (repos: WatchedRepo[]) => void;

  toggleSidebar: () => void;
  setActivePanel: (
    panel: 'queue' | 'my_prs' | 'reviews' | 'merge_queue' | 'settings' | 'debug'
  ) => void;
  setDebugMode: (on: boolean) => void;
  selectTask: (id: string | null) => void;
  setTheme: (theme: Theme) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  // Initial state
  currentWorkspaceId: getInitialWorkspaceId(),
  workspaces: [],
  environments: [],
  tasks: [],
  tasksHasMore: false,
  tasksLoadingMore: false,
  repositories: [],
  sidebarCollapsed: false,
  activePanel: 'my_prs',
  debugMode: getInitialDebugMode(),
  selectedTaskId: null,
  theme: getInitialTheme(),
  createWorkspaceOpen: false,
  onboardingComplete: getInitialOnboardingComplete(),
  justOnboarded: false,
  githubStatus: null,
  githubUser: null,
  githubInstallations: null,
  posthogStatus: null,
  cloudProviders: null,
  connectAgentOpen: false,
  pendingCloudTask: null,
  settingsSection: 'workspace',

  // Actions
  setCurrentWorkspace: (id) => {
    persistWorkspaceId(id);
    set({ currentWorkspaceId: id });
  },

  setWorkspaces: (workspaces) => set({ workspaces }),

  addWorkspace: (workspace) =>
    set((state) => ({ workspaces: [...state.workspaces, workspace] })),

  setCreateWorkspaceOpen: (createWorkspaceOpen) => set({ createWorkspaceOpen }),

  setOnboardingComplete: (done) => {
    try {
      localStorage.setItem(ONBOARDING_KEY, done ? 'true' : 'false');
    } catch {
      // ignore quota / privacy-mode issues
    }
    set({ onboardingComplete: done });
  },

  setJustOnboarded: (justOnboarded) => set({ justOnboarded }),

  setGitHubStatus: (githubStatus) => set({ githubStatus }),

  setGitHubUser: (githubUser) => set({ githubUser }),

  setGitHubInstallations: (githubInstallations) => set({ githubInstallations }),

  setPostHogStatus: (posthogStatus) => set({ posthogStatus }),

  setCloudProviders: (cloudProviders) => set({ cloudProviders }),

  openConnectAgent: (pending = null) =>
    set({ connectAgentOpen: true, pendingCloudTask: pending }),
  closeConnectAgent: () => set({ connectAgentOpen: false, pendingCloudTask: null }),
  clearPendingCloudTask: () => set({ pendingCloudTask: null }),

  setSettingsSection: (settingsSection) => set({ settingsSection }),

  openSettings: (section) =>
    set((state) => ({
      activePanel: 'settings',
      settingsSection: section ?? state.settingsSection,
    })),

  setEnvironments: (environments) => set({ environments }),

  updateEnvironment: (id, updates) =>
    set((state) => ({
      environments: state.environments.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      ),
    })),

  addEnvironment: (environment) =>
    set((state) =>
      state.environments.some((e) => e.id === environment.id)
        ? { environments: state.environments.map((e) => (e.id === environment.id ? environment : e)) }
        : { environments: [...state.environments, environment] }
    ),

  setTasks: (tasks) => set({ tasks }),

  reconcileTasks: (incoming, workspaceId) =>
    set((state) => {
      const localById = new Map(state.tasks.map((t) => [t.id, t]));
      const incomingIds = new Set(incoming.map((t) => t.id));
      // Rebuild in the server's order, re-attaching any rich local-only fields
      // (transcript) the list endpoint drops for egress reasons.
      const next: Task[] = incoming.map((fresh) => {
        const local = localById.get(fresh.id);
        if (!local) return fresh;
        return {
          ...fresh,
          transcript: local.transcript ?? fresh.transcript,
        };
      });
      // Decide what to keep among local tasks the fetch didn't return. The
      // reconnect fetch only covers all ACTIVE tasks + the first page of
      // finished history, so "missing" is ambiguous:
      //   - a different workspace's task → keep (not in scope);
      //   - a this-workspace ACTIVE task absent from the fetch → it changed
      //     server-side (finished/deleted) → drop;
      //   - a this-workspace FINISHED task absent → it's just older history
      //     paginated out of the first page, NOT deleted → keep.
      for (const local of state.tasks) {
        if (incomingIds.has(local.id)) continue;
        const otherWorkspace = local.workspaceId !== workspaceId;
        const active = ACTIVE_TASK_STATUSES.has(local.status);
        if (otherWorkspace || !active) next.push(local);
      }
      return {
        tasks: next,
        // Drop the selection if the selected task vanished server-side.
        selectedTaskId:
          state.selectedTaskId && !next.some((t) => t.id === state.selectedTaskId)
            ? null
            : state.selectedTaskId,
      };
    }),

  updateTask: (id, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) => {
        if (t.id !== id) return t;
        const merged = { ...t, ...updates };
        // Partial WS updates (the cloud pollers) send only the metadata keys
        // that changed — a shallow replace would drop the rest (the provider
        // marker, the PR pointer), which made the cloud banner vanish and
        // mis-attributed the provider. Deep-merge metadata + its cloudTask.
        if (updates.metadata) {
          const prev = (t.metadata ?? {}) as Record<string, unknown>;
          const next = updates.metadata as Record<string, unknown>;
          merged.metadata = { ...prev, ...next };
          const prevCloud = prev.cloudTask as Record<string, unknown> | undefined;
          const nextCloud = next.cloudTask as Record<string, unknown> | undefined;
          if (prevCloud || nextCloud) {
            (merged.metadata as Record<string, unknown>).cloudTask = {
              ...prevCloud,
              ...nextCloud,
            };
          }
        }
        return merged;
      }),
    })),

  addTask: (task) =>
    set((state) =>
      // Idempotent: a task can arrive from several sources (optimistic create,
      // the task:created broadcast, an on-demand fetch). Skip if we already
      // have it rather than appending a duplicate or clobbering richer local
      // state (e.g. a loaded transcript) the incoming copy lacks.
      state.tasks.some((t) => t.id === task.id)
        ? state
        : { tasks: [...state.tasks, task] }
    ),

  removeTask: (id) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
      selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId,
    })),

  appendOlderTasks: (older) =>
    set((state) => {
      const have = new Set(state.tasks.map((t) => t.id));
      const add = older.filter((t) => !have.has(t.id));
      return add.length ? { tasks: [...state.tasks, ...add] } : {};
    }),

  setTasksHasMore: (hasMore) => set({ tasksHasMore: hasMore }),
  setTasksLoadingMore: (loading) => set({ tasksLoadingMore: loading }),

  setRepositories: (repos) => set({ repositories: repos }),

  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setActivePanel: (panel) => set({ activePanel: panel }),

  setDebugMode: (on) => {
    try {
      localStorage.setItem(DEBUG_MODE_KEY, on ? 'true' : 'false');
    } catch {
      // ignore quota / privacy-mode issues
    }
    // Leaving debug mode while sitting on the Debug panel would strand the
    // user on a now-hidden view — bounce them back to the GitHub panel.
    set((state) => ({
      debugMode: on,
      activePanel: !on && state.activePanel === 'debug' ? 'my_prs' : state.activePanel,
    }));
  },

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
