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

export type EnvironmentType = 'local' | 'ssh' | 'coder' | 'daemon';

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
  /**
   * When true, autonomous Claude tasks on this env bypass every
   * permission prompt (bash / edits / MCP trust). Appropriate for
   * throwaway daemon VMs; dangerous for `local`. Defaults to false;
   * toggle from Settings → Environments. See
   * `services/agent.ts` for how this gates the --permission-mode flag.
   */
  autonomousBypassPermissions: boolean;
  /**
   * How tasks on this env are driven + rendered:
   *  - `pty`         (default) spawns the `claude` CLI in an interactive
   *                  PTY. Raw bytes flow through XTerm. Works for every
   *                  env type.
   *  - `structured`  spawns `claude -p --output-format stream-json` and
   *                  consumes JSONL events. Desktop renders a structured
   *                  conversation (markdown text, collapsible tool calls,
   *                  per-tool permission prompts). Slice 1 supports
   *                  `local` envs only.
   */
  renderer: EnvironmentRenderer;
  /**
   * Tool names pre-approved on this env — the structured renderer's
   * PreToolUse hook skips the permission prompt when the requested
   * tool is in this list. Populated by the "Allow always" button in
   * the Approve/Deny UI. Scoped per-env (not per-task) so approvals
   * stick across every task on that machine.
   */
  toolAllowlist: string[];
}

export type EnvironmentRenderer = 'pty' | 'structured';

export type EnvironmentConfig =
  | LocalEnvironmentConfig
  | SSHEnvironmentConfig
  | CoderEnvironmentConfig
  | DaemonEnvironmentConfig;

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

export interface DaemonEnvironmentConfig {
  type: 'daemon';
  /** Where the daemon was provisioned, for UI display. */
  hostname?: string;
  /** Working directory override for tasks running on this daemon. */
  workingDirectory?: string;
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
  /**
   * Structured JSONL event log for tasks driven by the `structured`
   * renderer. One entry per event emitted by the CLI's stream-json
   * output (assistant/tool_use/tool_result/result/etc). Null for
   * PTY-rendered tasks.
   */
  transcript?: AgentEvent[];
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
  /** Repository that generated tasks should target (branch + cwd). */
  repositoryId?: string;
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
  /** How many times in a row a task on this item has failed. Drives scheduler backoff. */
  consecutiveFailures: number;
  /** Timestamp of the most recent failed task on this item, if any. */
  lastFailureAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Request: create a new backlog source on a workspace. */
export interface CreateBacklogSourceRequest {
  workspaceId: string;
  type: BacklogSourceType;
  config: BacklogSourceConfig;
  environmentId?: string;
  repositoryId?: string;
  enabled?: boolean;
}

export interface UpdateBacklogSourceRequest {
  enabled?: boolean;
  environmentId?: string;
  repositoryId?: string;
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
// Structured agent events (stream-json renderer)
// ============================================================================

/**
 * A single event from the `claude -p --output-format stream-json --verbose`
 * pipeline. We store these verbatim — shape matches the CLI's output —
 * plus a monotonically-increasing `seq` so reconnecting clients can ask
 * for "everything after N".
 *
 * Deliberately permissive typing: the CLI's stream is still evolving, and
 * we don't want a schema mismatch to drop events we could otherwise
 * render. Renderer should switch on `type` + `subtype` and ignore things
 * it doesn't recognize.
 */
export interface AgentEvent {
  /** Monotonic per-task sequence number, assigned backend-side. */
  seq: number;
  /** The CLI event type: `system` | `assistant` | `user` | `stream_event` | `result` | `rate_limit_event` | ... */
  type: string;
  /** The CLI event subtype (e.g. `init`, `status`, `success`). Not all events have one. */
  subtype?: string;
  /** Session id the CLI assigned to this run. Lets us `--resume` later. */
  session_id?: string;
  /** For assistant/user events — the message content blocks. */
  message?: {
    role?: string;
    content?: unknown;
    [k: string]: unknown;
  };
  /** For `stream_event` — the partial API delta. */
  event?: unknown;
  /** For `result` — final summary. */
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  permission_denials?: Array<{ tool_name: string; tool_use_id?: string; tool_input?: unknown }>;
  usage?: unknown;
  /** Anything else the CLI emits. */
  [k: string]: unknown;
}

// ============================================================================
// WebSocket Events
// ============================================================================

export type WSEventType =
  | 'agent:status'
  | 'agent:output'
  | 'agent:event'
  | 'agent:permission_request'
  | 'agent:permission_response'
  | 'agent:attention'
  | 'task:status'
  | 'task:output'
  | 'task:event'
  | 'task:agent_status'
  | 'inbox:new'
  | 'inbox:update'
  | 'inbox:remove'
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

export interface InboxUpdateEvent {
  itemId: string;
  updates: Partial<InboxItem>;
}

export interface InboxRemoveEvent {
  itemId: string;
}

export interface EnvironmentStatusEvent {
  environmentId: string;
  status: EnvironmentStatus;
  error?: string;
}

export interface AgentEventBroadcast {
  agentId: string;
  taskId?: string;
  event: AgentEvent;
}

export interface TaskEventBroadcast {
  taskId: string;
  event: AgentEvent;
}

// ============================================================================
// Permission prompts (structured renderer Slice 2)
// ============================================================================

/**
 * A pending permission request. The child CLI's PreToolUse hook has
 * asked the backend if it can run `toolName` with `toolInput`; the
 * backend surfaces this request to the desktop until the user clicks
 * Approve / Deny.
 *
 * Synthetic events of `type: 'fastowl_permission_request'` and
 * `type: 'fastowl_permission_response'` are inserted into the task
 * transcript so the renderer has a single ordered event stream. The
 * `requestId` lets the response event close out the request block.
 */
export interface PermissionRequest {
  requestId: string;
  agentId: string;
  taskId?: string;
  toolName: string;
  toolInput: unknown;
  /** The CLI's session id for this run — lets us correlate with the tool_use event. */
  sessionId?: string;
  /** CLI-assigned tool_use id so the renderer can co-locate the request with the tool_use block. */
  toolUseId?: string;
  /** When the hook call was received. ISO timestamp. */
  requestedAt: string;
}

export type PermissionDecision = 'allow' | 'deny';

export interface PermissionResponse {
  requestId: string;
  decision: PermissionDecision;
  /** "Allow always for this tool on this env" when `decision === 'allow'`. */
  persist?: boolean;
  reason?: string;
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
  renderer?: EnvironmentRenderer;
}

export interface TestEnvironmentRequest {
  config: EnvironmentConfig;
}

/** Provision the FastOwl daemon on a remote VM over SSH. */
export interface InstallDaemonOverSshRequest {
  host: string;
  port?: number;
  username: string;
  authMethod: 'key' | 'password' | 'agent';
  /** Path to a private key on the *server* side (or `~/.ssh/id_rsa`). */
  privateKeyPath?: string;
  /** Raw password, if `authMethod === 'password'`. */
  password?: string;
  /** Optional base URL override — defaults to the current backend's public URL. */
  backendUrl?: string;
}

export interface InstallDaemonOverSshResponse {
  success: boolean;
  /** Transcript of the install script stdout+stderr. */
  log: string;
  error?: string;
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

// ============================================================================
// Daemon wire protocol
// ============================================================================

export * from './daemonProtocol.js';
