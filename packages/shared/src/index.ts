// Core types for FastOwl

// ============================================================================
// Workspace
// ============================================================================

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  repos: Repository[];
  integrations: WorkspaceIntegrations;
  settings: WorkspaceSettings;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: string;
  name: string; // e.g., "posthog/posthog"
  url: string;
  localPath?: string; // Path on environments
  defaultBranch: string;
}

export interface WorkspaceIntegrations {
  github?: GitHubIntegration;
  slack?: SlackIntegration;
  posthog?: PostHogIntegration;
}

export interface GitHubIntegration {
  enabled: boolean;
  accessToken?: string;
  org?: string;
  watchedRepos: string[];
}

export interface SlackIntegration {
  enabled: boolean;
  accessToken?: string;
  workspaceId?: string;
  watchedChannels: string[];
}

export interface PostHogIntegration {
  enabled: boolean;
  apiKey?: string;
  projectId?: string;
  host?: string;
}

export interface WorkspaceSettings {
  autoAssignTasks: boolean;
  maxConcurrentAgents: number;
  continuousBuild?: ContinuousBuildSettings;
}

export interface ContinuousBuildSettings {
  enabled: boolean;
  /** How many code_writing tasks can be in-flight at once. */
  maxConcurrent: number;
  /** If true, wait for user to approve a task before spawning the next. */
  requireApproval: boolean;
}

// ============================================================================
// Environment
// ============================================================================

export type EnvironmentType = 'local' | 'ssh' | 'coder';

export type EnvironmentStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'error';

export interface Environment {
  id: string;
  name: string;
  type: EnvironmentType;
  status: EnvironmentStatus;
  config: EnvironmentConfig;
  lastConnected?: string;
  error?: string;
}

export type EnvironmentConfig =
  | LocalEnvironmentConfig
  | SSHEnvironmentConfig
  | CoderEnvironmentConfig;

export interface LocalEnvironmentConfig {
  type: 'local';
  workingDirectory?: string;
}

export interface SSHEnvironmentConfig {
  type: 'ssh';
  host: string;
  port: number;
  username: string;
  authMethod: 'key' | 'password' | 'agent';
  privateKeyPath?: string;
  workingDirectory?: string;
}

export interface CoderEnvironmentConfig {
  type: 'coder';
  workspaceName: string;
  coderUrl: string;
}

// ============================================================================
// Agent
// ============================================================================

export type AgentStatus =
  | 'idle'
  | 'working'
  | 'awaiting_input'
  | 'tool_use'
  | 'completed'
  | 'error';

export type AgentAttention = 'none' | 'low' | 'medium' | 'high';

export interface Agent {
  id: string;
  environmentId: string;
  workspaceId: string;
  status: AgentStatus;
  attention: AgentAttention;
  currentTaskId?: string;
  terminalOutput: string;
  lastActivity: string;
  createdAt: string;
}

// ============================================================================
// Task
// ============================================================================

export type TaskType =
  | 'code_writing'
  | 'pr_response'
  | 'pr_review'
  | 'manual';

/** Types for which FastOwl spawns a Claude agent. */
export const AGENT_TASK_TYPES: readonly TaskType[] = [
  'code_writing',
  'pr_response',
  'pr_review',
];

/** True if FastOwl should spawn/drive a Claude agent for this task. */
export function isAgentTask(type: TaskType): boolean {
  return type !== 'manual';
}

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'in_progress'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  workspaceId: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  title: string;
  description: string;
  prompt?: string; // Prompt for Claude agent
  repositoryId?: string; // Repository to run the task in
  branch?: string; // Git branch for this task (auto-created for code tasks)
  assignedAgentId?: string;
  assignedEnvironmentId?: string;
  result?: TaskResult;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  // Agent-related fields (when task is running)
  agentStatus?: AgentStatus;
  agentAttention?: AgentAttention;
  terminalOutput?: string;
}

export interface TaskResult {
  success: boolean;
  summary?: string;
  output?: string;
  error?: string;
}

// ============================================================================
// Backlog (Continuous Build)
// ============================================================================

/** Where backlog items are sourced from. Start with markdown; others later. */
export type BacklogSourceType = 'markdown_file';

export interface BacklogSource {
  id: string;
  workspaceId: string;
  type: BacklogSourceType;
  enabled: boolean;
  /** Environment to read the source from. Defaults to the first local env. */
  environmentId?: string;
  config: BacklogSourceConfig;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type BacklogSourceConfig = MarkdownFileBacklogConfig;

export interface MarkdownFileBacklogConfig {
  type: 'markdown_file';
  /** Absolute path on the environment. */
  path: string;
  /** Optional heading title; only items under this section are parsed. */
  section?: string;
}

export type BacklogItemState =
  | 'pending'
  | 'in_progress'
  | 'awaiting_review'
  | 'completed'
  | 'blocked';

export interface BacklogItem {
  id: string;
  sourceId: string;
  workspaceId: string;
  /** Stable ID within the source — hash of text + parent. Survives reorderings. */
  externalId: string;
  text: string;
  parentExternalId?: string;
  completed: boolean;
  blocked: boolean;
  /** Task currently working on this item, if any. */
  claimedTaskId?: string;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

/** Request: create a new backlog source on a workspace. */
export interface CreateBacklogSourceRequest {
  workspaceId: string;
  type: BacklogSourceType;
  config: BacklogSourceConfig;
  environmentId?: string;
  enabled?: boolean;
}

export interface UpdateBacklogSourceRequest {
  enabled?: boolean;
  environmentId?: string;
  config?: BacklogSourceConfig;
}

// ============================================================================
// Inbox
// ============================================================================

export type InboxItemType =
  | 'agent_question'
  | 'agent_completed'
  | 'agent_error'
  | 'pr_review'
  | 'pr_ci_failure'
  | 'pr_ready_to_merge'
  | 'slack_mention'
  | 'posthog_alert'
  | 'custom';

export type InboxItemStatus = 'unread' | 'read' | 'actioned' | 'snoozed';

export interface InboxItem {
  id: string;
  workspaceId: string;
  type: InboxItemType;
  status: InboxItemStatus;
  priority: TaskPriority;
  title: string;
  summary: string;
  source: InboxItemSource;
  actions: InboxAction[];
  data?: Record<string, unknown>;
  snoozedUntil?: string;
  createdAt: string;
  readAt?: string;
  actionedAt?: string;
}

export interface InboxItemSource {
  type: 'agent' | 'github' | 'slack' | 'posthog' | 'system';
  id?: string;
  name?: string;
  url?: string;
}

export interface InboxAction {
  id: string;
  label: string;
  type: 'primary' | 'secondary' | 'danger';
  action: string; // Action identifier
}

// ============================================================================
// WebSocket Events
// ============================================================================

export type WSEventType =
  | 'agent:status'
  | 'agent:output'
  | 'agent:attention'
  | 'task:status'
  | 'task:output'
  | 'task:agent_status'
  | 'inbox:new'
  | 'inbox:update'
  | 'environment:status'
  | 'connection:status';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  payload: T;
  timestamp: string;
}

export interface AgentStatusEvent {
  agentId: string;
  status: AgentStatus;
  attention: AgentAttention;
}

export interface AgentOutputEvent {
  agentId: string;
  output: string;
  append: boolean;
}

export interface TaskStatusEvent {
  taskId: string;
  status: TaskStatus;
  result?: TaskResult;
}

export interface TaskOutputEvent {
  taskId: string;
  output: string;
  append: boolean;
}

export interface TaskAgentStatusEvent {
  taskId: string;
  status: AgentStatus;
  attention: AgentAttention;
}

export interface InboxNewEvent {
  item: InboxItem;
}

export interface EnvironmentStatusEvent {
  environmentId: string;
  status: EnvironmentStatus;
  error?: string;
}

// ============================================================================
// API Types
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Workspace API
export interface CreateWorkspaceRequest {
  name: string;
  description?: string;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  description?: string;
  settings?: Partial<WorkspaceSettings>;
}

// Environment API
export interface CreateEnvironmentRequest {
  name: string;
  type: EnvironmentType;
  config: Omit<EnvironmentConfig, 'type'> & { type: EnvironmentType };
}

export interface TestEnvironmentRequest {
  config: EnvironmentConfig;
}

// Task API
export interface CreateTaskRequest {
  workspaceId: string;
  type: TaskType;
  title: string;
  description: string;
  prompt?: string;
  priority?: TaskPriority;
  repositoryId?: string;
  assignedEnvironmentId?: string;
}

export interface GenerateTaskMetadataRequest {
  prompt: string;
}

export interface GenerateTaskMetadataResponse {
  title: string;
  description: string;
  suggestedPriority: TaskPriority;
}

// Agent API
export interface StartAgentRequest {
  environmentId: string;
  workspaceId: string;
  taskId?: string;
  prompt?: string;
  workingDirectory?: string; // Directory to run Claude in (e.g., repository path)
}

export interface SendAgentInputRequest {
  input: string;
}
