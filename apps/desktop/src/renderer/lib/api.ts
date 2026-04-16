import type {
  Workspace,
  Environment,
  Agent,
  Task,
  InboxItem,
  CreateWorkspaceRequest,
  CreateEnvironmentRequest,
  CreateTaskRequest,
  StartAgentRequest,
  ApiResponse,
  WSEvent,
} from '@fastowl/shared';

// In Electron renderer, use hardcoded defaults for development
// In production, these could be configured via electron-store or IPC
const API_BASE = 'http://localhost:4747/api/v1';
const WS_URL = 'ws://localhost:4747/ws';

// ============================================================================
// HTTP Client
// ============================================================================

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await response.json()) as ApiResponse<T>;

  if (!data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data.data as T;
}

// Workspaces
export const workspaces = {
  list: () => request<Workspace[]>('GET', '/workspaces'),
  get: (id: string) => request<Workspace>('GET', `/workspaces/${id}`),
  create: (data: CreateWorkspaceRequest) =>
    request<Workspace>('POST', '/workspaces', data),
  update: (id: string, data: Partial<Workspace>) =>
    request<Workspace>('PATCH', `/workspaces/${id}`, data),
  delete: (id: string) => request<void>('DELETE', `/workspaces/${id}`),
};

// Environments
export const environments = {
  list: () => request<Environment[]>('GET', '/environments'),
  get: (id: string) => request<Environment>('GET', `/environments/${id}`),
  create: (data: CreateEnvironmentRequest) =>
    request<Environment>('POST', '/environments', data),
  update: (id: string, data: Partial<Environment>) =>
    request<Environment>('PATCH', `/environments/${id}`, data),
  delete: (id: string) => request<void>('DELETE', `/environments/${id}`),
  test: (id: string) =>
    request<{ connected: boolean }>('POST', `/environments/${id}/test`),
};

// Agents
export const agents = {
  list: (params?: { workspaceId?: string; environmentId?: string }) => {
    const query = new URLSearchParams();
    if (params?.workspaceId) query.set('workspaceId', params.workspaceId);
    if (params?.environmentId) query.set('environmentId', params.environmentId);
    const queryStr = query.toString();
    return request<Agent[]>('GET', `/agents${queryStr ? `?${queryStr}` : ''}`);
  },
  get: (id: string) => request<Agent>('GET', `/agents/${id}`),
  start: (data: StartAgentRequest) => request<Agent>('POST', '/agents/start', data),
  sendInput: (id: string, input: string) =>
    request<void>('POST', `/agents/${id}/input`, { input }),
  stop: (id: string) => request<Agent>('POST', `/agents/${id}/stop`),
  delete: (id: string) => request<void>('DELETE', `/agents/${id}`),
};

// Task metadata generation response
export interface TaskMetadata {
  title: string;
  description: string;
  suggestedPriority: 'low' | 'medium' | 'high' | 'urgent';
}

// Tasks
export const tasks = {
  list: (params?: { workspaceId?: string; status?: string; type?: string }) => {
    const query = new URLSearchParams();
    if (params?.workspaceId) query.set('workspaceId', params.workspaceId);
    if (params?.status) query.set('status', params.status);
    if (params?.type) query.set('type', params.type);
    const queryStr = query.toString();
    return request<Task[]>('GET', `/tasks${queryStr ? `?${queryStr}` : ''}`);
  },
  get: (id: string) => request<Task>('GET', `/tasks/${id}`),
  create: (data: CreateTaskRequest) => request<Task>('POST', '/tasks', data),
  update: (id: string, data: Partial<Task>) =>
    request<Task>('PATCH', `/tasks/${id}`, data),
  retry: (id: string) => request<Task>('POST', `/tasks/${id}/retry`),
  delete: (id: string) => request<void>('DELETE', `/tasks/${id}`),
  // Task execution control
  start: (id: string) => request<Task>('POST', `/tasks/${id}/start`),
  sendInput: (id: string, input: string) =>
    request<void>('POST', `/tasks/${id}/input`, { input }),
  stop: (id: string) => request<Task>('POST', `/tasks/${id}/stop`),
  getTerminal: (id: string) =>
    request<{ terminalOutput: string }>('GET', `/tasks/${id}/terminal`),
  // Generate task metadata from prompt using AI
  generateMetadata: (prompt: string) =>
    request<TaskMetadata>('POST', '/tasks/generate-metadata', { prompt }),
};

// Inbox
export const inbox = {
  list: (params?: { workspaceId?: string; status?: string; type?: string }) => {
    const query = new URLSearchParams();
    if (params?.workspaceId) query.set('workspaceId', params.workspaceId);
    if (params?.status) query.set('status', params.status);
    if (params?.type) query.set('type', params.type);
    const queryStr = query.toString();
    return request<InboxItem[]>('GET', `/inbox${queryStr ? `?${queryStr}` : ''}`);
  },
  get: (id: string) => request<InboxItem>('GET', `/inbox/${id}`),
  markRead: (id: string) => request<InboxItem>('POST', `/inbox/${id}/read`),
  markActioned: (id: string) => request<InboxItem>('POST', `/inbox/${id}/action`),
  snooze: (id: string, until: string) =>
    request<InboxItem>('POST', `/inbox/${id}/snooze`, { until }),
  delete: (id: string) => request<void>('DELETE', `/inbox/${id}`),
  bulkRead: (ids: string[]) =>
    request<{ updated: number }>('POST', '/inbox/bulk/read', { ids }),
  bulkAction: (ids: string[]) =>
    request<{ updated: number }>('POST', '/inbox/bulk/action', { ids }),
};

// GitHub Integration
export interface GitHubStatus {
  configured: boolean;
  connected: boolean;
  message?: string;
  scopes?: string[];
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
  };
}

export interface GitHubPRFile {
  sha: string;
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GitHubReview {
  id: number;
  user: { login: string; avatar_url: string };
  body: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at: string;
  html_url: string;
}

export interface GitHubBranch {
  name: string;
  protected: boolean;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  html_url: string;
}

export const github = {
  getStatus: (workspaceId?: string) => {
    const query = workspaceId ? `?workspaceId=${workspaceId}` : '';
    return request<GitHubStatus>('GET', `/github/status${query}`);
  },
  connect: (workspaceId: string) =>
    request<{ authUrl: string; state: string }>('POST', '/github/connect', { workspaceId }),
  disconnect: (workspaceId: string) =>
    request<void>('POST', '/github/disconnect', { workspaceId }),
  getUser: (workspaceId: string) =>
    request<GitHubUser>('GET', `/github/user?workspaceId=${workspaceId}`),
  listRepos: (workspaceId: string) =>
    request<GitHubRepo[]>('GET', `/github/repos?workspaceId=${workspaceId}`),
  listBranches: (workspaceId: string, owner: string, repo: string) =>
    request<GitHubBranch[]>('GET', `/github/repos/${owner}/${repo}/branches?workspaceId=${workspaceId}`),
  listPullRequests: (workspaceId: string, owner: string, repo: string) =>
    request<GitHubPullRequest[]>('GET', `/github/repos/${owner}/${repo}/pulls?workspaceId=${workspaceId}`),
  getPullRequest: (workspaceId: string, owner: string, repo: string, number: number) =>
    request<GitHubPullRequest>('GET', `/github/repos/${owner}/${repo}/pulls/${number}?workspaceId=${workspaceId}`),
  getPRFiles: (workspaceId: string, owner: string, repo: string, number: number) =>
    request<GitHubPRFile[]>('GET', `/github/repos/${owner}/${repo}/pulls/${number}/files?workspaceId=${workspaceId}`),
  getPRChecks: (workspaceId: string, owner: string, repo: string, number: number) =>
    request<{ total_count: number; check_runs: GitHubCheckRun[] }>('GET', `/github/repos/${owner}/${repo}/pulls/${number}/checks?workspaceId=${workspaceId}`),
  createPullRequest: (workspaceId: string, owner: string, repo: string, data: {
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
  }) =>
    request<GitHubPullRequest>('POST', `/github/repos/${owner}/${repo}/pulls`, { workspaceId, ...data }),
  updatePullRequest: (workspaceId: string, owner: string, repo: string, number: number, data: {
    title?: string;
    body?: string;
    state?: 'open' | 'closed';
  }) =>
    request<GitHubPullRequest>('PATCH', `/github/repos/${owner}/${repo}/pulls/${number}`, { workspaceId, ...data }),
  mergePullRequest: (workspaceId: string, owner: string, repo: string, number: number, data?: {
    commit_title?: string;
    commit_message?: string;
    merge_method?: 'merge' | 'squash' | 'rebase';
  }) =>
    request<{ sha: string; merged: boolean; message: string }>('PUT', `/github/repos/${owner}/${repo}/pulls/${number}/merge`, { workspaceId, ...data }),
  createPRReview: (workspaceId: string, owner: string, repo: string, number: number, data: {
    body?: string;
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  }) =>
    request<GitHubReview>('POST', `/github/repos/${owner}/${repo}/pulls/${number}/reviews`, { workspaceId, ...data }),
  createPRComment: (workspaceId: string, owner: string, repo: string, number: number, body: string) =>
    request<{ id: number; html_url: string }>('POST', `/github/repos/${owner}/${repo}/pulls/${number}/comments`, { workspaceId, body }),
};

// Watched Repositories
export interface WatchedRepo {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  fullName: string;
}

export const repositories = {
  list: (workspaceId: string) =>
    request<WatchedRepo[]>('GET', `/repositories?workspaceId=${workspaceId}`),
  add: (workspaceId: string, owner: string, repo: string) =>
    request<WatchedRepo>('POST', '/repositories', { workspaceId, owner, repo }),
  remove: (id: string) =>
    request<void>('DELETE', `/repositories/${id}`),
  forcePoll: () =>
    request<{ message: string }>('POST', '/repositories/poll'),
};

// ============================================================================
// WebSocket Client
// ============================================================================

type EventHandler<T = unknown> = (payload: T) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private subscribedWorkspaces: Set<string> = new Set();

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    console.log('Connecting to WebSocket...');
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;

      // Resubscribe to workspaces
      for (const workspaceId of this.subscribedWorkspaces) {
        this.send({ type: 'subscribe', workspaceId });
      }

      this.emit('connection:status', { connected: true });
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WSEvent;
        this.emit(data.type, data.payload);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.emit('connection:status', { connected: false });
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  subscribe(workspaceId: string): void {
    this.subscribedWorkspaces.add(workspaceId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'subscribe', workspaceId });
    }
  }

  unsubscribe(workspaceId: string): void {
    this.subscribedWorkspaces.delete(workspaceId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'unsubscribe', workspaceId });
    }
  }

  on<T>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler as EventHandler);
    };
  }

  private emit(event: string, payload: unknown): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`Handler error for ${event}:`, err);
        }
      }
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
    }, delay);
  }
}

// Singleton instance
export const wsClient = new WebSocketClient();

// ============================================================================
// Combined API export
// ============================================================================

export const api = {
  workspaces,
  environments,
  agents,
  tasks,
  inbox,
  github,
  repositories,
  ws: wsClient,
};
