// Core types for FastOwl

// PR mergeable helpers (shared by the desktop button + backend watcher).
export * from './prMergeable.js';

// External merge queues (trunk.io / GitHub native) — label vocabulary shared by
// the backend pipeline and the desktop badges.
export * from './externalMergeQueue.js';

// Stacked-PR linking — the one definition of "B is stacked on A", shared by the
// merge queue's stack drain and both front ends' indented PR lists.
export * from './stacks.js';

// Agent skills (SKILL.md) + the run-skill-on-PR prompt builder.
export * from './skills.js';
export * from './skillPrompt.js';

// Editable prompt templates (Settings → Instructions) + the shipped defaults.
export * from './promptTemplates.js';

// The operator console's contract (admin.talyn.dev ⇄ /api/v1/admin).
export * from './admin.js';
export * from './transcript.js';

// SSE framing, shared by the fleet client, the admin SSE proxy, and the
// browser that reads the proxied stream.
export * from './sse.js';

import type { SkillKey, SkillSource, SkillSummary, SkillUsageEntry } from './skills.js';
import type { PromptTemplateSettings } from './promptTemplates.js';

// ============================================================================
// Workspace
// ============================================================================

/**
 * A workspace's logo. Either an auto-generated identicon (rendered
 * deterministically from `seed`) or a user-uploaded image (a downscaled
 * `data:image/...` URL).
 */
export type WorkspaceLogo =
  | { kind: 'identicon'; seed: string }
  | { kind: 'image'; dataUrl: string };

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  logo?: WorkspaceLogo;
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
  defaultBranch: string;
}

export interface WorkspaceIntegrations {
  github?: GitHubIntegration;
  posthog?: PostHogIntegration;
}

export interface GitHubIntegration {
  enabled: boolean;
  accessToken?: string;
  org?: string;
  watchedRepos: string[];
}

export interface PostHogIntegration {
  enabled: boolean;
  apiKey?: string;
  projectId?: string;
  host?: string;
}

/**
 * Claude models a workspace can run Claude Code tasks on, cheapest-capable
 * first in cost. Sonnet is the default — PR fix/respond/review work doesn't
 * warrant Opus pricing. Ids are the Anthropic model ids passed to the
 * Managed Agents API.
 */
export const CLAUDE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', blurb: 'Balanced capability and cost — the default.' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', blurb: 'Most capable, most expensive.' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', blurb: 'Fastest and cheapest.' },
] as const;

export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]['id'];

/** Default Claude model for Claude Code tasks when the workspace hasn't picked one. */
export const DEFAULT_CLAUDE_MODEL_ID: ClaudeModelId = 'claude-sonnet-4-6';

/** Type guard for a stored/incoming value being a known Claude model id. */
export function isClaudeModelId(value: unknown): value is ClaudeModelId {
  return typeof value === 'string' && CLAUDE_MODELS.some((m) => m.id === value);
}

/**
 * Models a workspace can run PostHog Code tasks on — the ONE list, imported by
 * the Settings picker, the per-task composer, and the backend's fallback. It
 * used to be three hand-maintained copies, which is exactly how the composer
 * ended up offering only Claude 4 models months after Claude 5 shipped.
 *
 * PostHog's run API takes `runtime_adapter` + `model` together and Talyn always
 * sends the `claude` adapter, so the ids here must be ones that adapter accepts:
 * the keys of `CLAUDE_REASONING_EFFORTS_BY_MODEL` in PostHog's
 * `products/tasks/backend/temporal/process_task/utils.py`. That is a narrower set
 * than the LLM gateway's catalog (`GET gateway.us.posthog.com/posthog_code/v1/models`,
 * which also serves `claude-haiku-4-5`, `claude-sonnet-4-5` and every `gpt-*`) —
 * offering a model from the gateway that the tasks runtime doesn't know earns a
 * 400 at dispatch, so don't populate this from there. `posthogCodeModels.test.ts`
 * pins the adapter's catalog so a bad id fails a test rather than a run.
 *
 * Current generation only, most capable first. Older Opus 4.x releases are still
 * ACCEPTED on a stored setting (see `LEGACY_POSTHOG_CODE_MODEL_IDS`) but no longer
 * offered.
 */
export const POSTHOG_CODE_MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5', blurb: 'Newest Opus, 1M context — the default.' },
  { id: 'claude-fable-5', label: 'Fable 5', blurb: 'Newest of the Claude 5 line.' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', blurb: 'Strong and fast.' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', blurb: 'The previous Opus flagship.' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', blurb: 'Cheapest of the supported set.' },
] as const;

export type PostHogCodeModelId = (typeof POSTHOG_CODE_MODELS)[number]['id'];

/**
 * Model ids the tasks runtime still accepts, and that a workspace may already
 * have pinned, but which the pickers no longer offer.
 *
 * The accepted set has to stay wider than the offered set. The composer used to
 * offer Opus 4.5/4.6/4.7, and a stored value that fails validation falls back to
 * the DEFAULT — so dropping them outright would silently move anyone who pinned
 * Opus 4.5 (deliberately, for cost) onto Opus 5, which is dearer. Their choice
 * keeps working; it just isn't on the menu any more.
 */
export const LEGACY_POSTHOG_CODE_MODEL_IDS = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
] as const;

export type LegacyPostHogCodeModelId = (typeof LEGACY_POSTHOG_CODE_MODEL_IDS)[number];

/** Anything valid to have stored on a workspace: offered or legacy. */
export type StoredPostHogCodeModelId = PostHogCodeModelId | LegacyPostHogCodeModelId;

/** Default model for PostHog Code runs when the workspace hasn't picked one. */
export const DEFAULT_POSTHOG_CODE_MODEL_ID: PostHogCodeModelId = 'claude-opus-5';

/**
 * Models a Talyn Fleet run may use.
 *
 * The same current-generation list as PostHog Code, because it is the same id
 * space: a fleet run is the Claude Agent SDK inside a microVM, so it takes the
 * Claude 5 ids rather than CLAUDE_MODELS' 4.x set.
 */
export const FLEET_MODELS = POSTHOG_CODE_MODELS;
export type FleetModelId = PostHogCodeModelId;

/**
 * Default model for a fleet run.
 *
 * SONNET, not Opus, and the difference is not small. Fleet runs were served by
 * Opus 5 on every turn and cost $348 in 18.5 hours — about $15.85 a run — on
 * work that is mostly mechanical: rebase, resolve conflicts, re-run CI, answer
 * review threads. Opus earns its price on the investigative runs (see the
 * merge-queue `queue_failure` kind), and a workspace that wants it back can
 * pick it in Settings → Talyn Fleet.
 */
export const DEFAULT_FLEET_MODEL_ID: FleetModelId = 'claude-sonnet-5';

/**
 * Which LLM API a fleet model belongs to.
 *
 * The fleet builds a run's egress route table from this, and a run reaches
 * exactly one provider — a run dispatched at an OpenAI model has no route to
 * api.anthropic.com at all. So this is not a label: it decides what the microVM
 * can talk to, and getting it wrong is a run that cannot make a single call.
 *
 * Every model in FLEET_MODELS is Anthropic's today, so this returns 'anthropic'
 * for all of them. It exists as the seam: adding a Codex model means adding it
 * to the catalogue and to the map below, not editing the dispatch path.
 */
export type FleetProvider = 'anthropic' | 'openai';

const FLEET_MODEL_PROVIDERS: Record<string, FleetProvider> = {};

export function fleetProviderForModel(modelId: string | undefined): FleetProvider {
  if (!modelId) return 'anthropic';
  return FLEET_MODEL_PROVIDERS[modelId] ?? 'anthropic';
}

/** Type guard for a value being a model the pickers currently OFFER. */
export function isPostHogCodeModelId(value: unknown): value is PostHogCodeModelId {
  return typeof value === 'string' && POSTHOG_CODE_MODELS.some((m) => m.id === value);
}

/**
 * Type guard for a value being one the runtime accepts — offered or legacy. Use
 * this when reading a STORED setting; use `isPostHogCodeModelId` when validating
 * something a picker should have produced.
 */
export function isStoredPostHogCodeModelId(
  value: unknown
): value is StoredPostHogCodeModelId {
  return (
    isPostHogCodeModelId(value) ||
    (typeof value === 'string' &&
      (LEGACY_POSTHOG_CODE_MODEL_IDS as readonly string[]).includes(value))
  );
}

/**
 * Type guard for a stored fleet model setting. Same id space as PostHog Code,
 * including the legacy ids, so a workspace that pinned an older model keeps it
 * rather than being silently moved to the default.
 */
export function isStoredFleetModelId(value: unknown): value is StoredPostHogCodeModelId {
  return isStoredPostHogCodeModelId(value);
}

export interface WorkspaceSettings {
  continuousBuild?: ContinuousBuildSettings;
  /**
   * Which model Talyn Fleet runs use. Unset means DEFAULT_FLEET_MODEL_ID
   * (Sonnet 5) — see the note there on why it is not Opus.
   */
  fleetModel?: StoredPostHogCodeModelId;
  /**
   * Which cloud provider new tasks dispatch to when more than one is connected.
   * A specific provider pins it; `'ask'` makes the desktop prompt per task (and
   * backend auto-fixes fall back to a deterministic order); unset = auto
   * (prefer PostHog Code, else Claude Code).
   */
  defaultCloudProvider?: CloudProviderType | 'ask';
  /** Which Claude model Claude Code tasks run on. Unset = {@link DEFAULT_CLAUDE_MODEL_ID}. */
  claudeModel?: ClaudeModelId;
  /** Which model PostHog Code runs use. Unset = {@link DEFAULT_POSTHOG_CODE_MODEL_ID}. */
  posthogCodeModel?: PostHogCodeModelId;
  /**
   * When on, a newly-tracked open PR the viewer AUTHORED gets "auto-keep
   * mergeable" armed automatically (the watcher fires cloud fix runs to keep it
   * mergeable until it merges). Scoped to authored PRs on purpose — arming it
   * pushes commits, so it must never auto-fire on someone else's
   * review-requested PR. Individual PRs can still be toggled by hand. Unset = off.
   */
  defaultAutoKeepMergeable?: boolean;
  /** GitHub labels the watcher adds (never removes) to every open PR it watches. Empty = off. */
  autoKeepMergeableLabels?: string[];
  /**
   * How the merge queue drains a (repo, base) group:
   * - `'ordered'` (default): FIFO — one merge in flight per group, each PR
   *   waits its turn. Conservative: same-base merges invalidate the CI of the
   *   PRs behind them, so serializing avoids wasted runs.
   * - `'eager'`: every queued PR is its own head — clean PRs merge (or arm
   *   auto-merge) the moment they're ready, blocked PRs get fix runs
   *   concurrently, nothing waits behind a sibling. Faster, at the cost of
   *   sibling CI churn after each merge.
   */
  mergeQueueMode?: MergeQueueMode;
  /**
   * Workspace overrides for the prompts Talyn hands to cloud agents, keyed by
   * prompt kind (Settings → Instructions). Absent kind = the shipped default.
   */
  prompts?: PromptTemplateSettings;
  /**
   * PostHog Visual Review — the screenshot-regression gate on posthog/posthog.
   * Absent = off, and off is the only safe default: finalizing REWRITES the
   * committed baseline and greens the gate, so turning it on delegates a
   * human review decision to the queue. See {@link VisualReviewSettings}.
   */
  visualReview?: VisualReviewSettings;
}

/**
 * Visual Review is a HUMAN-DECISION gate: CI diffs screenshots against
 * committed baselines and stays red until a person approves each change. No
 * code an agent can write will ever green it, which is why the queue used to
 * loop — 11 runs on PostHog/posthog#83850 over two days, every one carrying
 * the same 4 unapproved diffs, each fix run pushing a commit that triggered
 * the next run (2026-08-19).
 *
 * With `autoApprove` on, the queue finalizes the run itself (approve-all +
 * commit baseline) rather than dispatching a run that cannot help.
 *
 * Understand what that trades away. Approving is the review — an UNINTENDED
 * regression is baselined and shipped exactly as readily as an intended
 * change, because nothing here can tell them apart. Leave it off and the queue
 * still stops looping; it parks the PR and names the run for a human instead.
 */
export interface VisualReviewSettings {
  /**
   * Finalize the PR's visual review run instead of parking it for a human.
   * Absent/false = park and surface (the safe default).
   *
   * Note the object's PRESENCE is itself the switch for looking at all: with no
   * `visualReview` settings the queue never asks PostHog about a PR, so a
   * workspace whose repos have no visual review pays nothing. Set
   * `{ autoApprove: false }` to get the recognise-and-park behaviour without
   * the queue approving anything.
   */
  autoApprove?: boolean;
  /**
   * PostHog project id owning the visual reviews. Unset = the project on the
   * workspace's PostHog Code integration, which is the same project in every
   * setup seen so far.
   */
  projectId?: string;
}

export type MergeQueueMode = 'ordered' | 'eager';

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

/**
 * Environment type. Post cloud-only refactor an environment is a
 * secret-free delegation marker — a task assigned to it is handed to the
 * matching cloud provider, which runs the whole agent loop on its own
 * sandbox and opens a PR. Credentials live on the workspace's
 * `integrations` row, not on the env.
 *
 * STALE UNION: rows are actually created with `CloudProviderType` values
 * (see services/cloudProviders/environment.ts — `claude_code` exists in
 * the DB but not here), and `local`/`remote` are dead daemon-era members
 * nothing creates anymore. Cleanup candidate: collapse this onto
 * `CloudProviderType`.
 */
export type EnvironmentType = 'local' | 'remote' | 'posthog_code';

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
  /**
   * Version string reported by the daemon on its most recent hello,
   * shape `<pkgVersion>+<shortSha>` (e.g. `0.1.0+a1b2c3d`). Undefined
   * for envs that have never successfully paired. Compared against
   * the backend's own build SHA to surface "stale daemon" warnings.
   */
  daemonVersion?: string;
  /**
   * Opt-in auto-update: when true, the backend triggers this env's
   * daemon self-update on reconnect (and on a periodic scheduler
   * tick) whenever it sees a stale version. Off by default.
   */
  autoUpdateDaemon: boolean;
}

export type EnvironmentRenderer = 'pty' | 'structured';

export type EnvironmentConfig =
  | LocalEnvironmentConfig
  | RemoteEnvironmentConfig
  | PostHogCodeEnvironmentConfig;

export interface LocalEnvironmentConfig {
  type: 'local';
  /** Where the daemon runs — usually the user's hostname, for display. */
  hostname?: string;
  workingDirectory?: string;
}

export interface RemoteEnvironmentConfig {
  type: 'remote';
  /** Where the daemon runs, for UI display. */
  hostname?: string;
  workingDirectory?: string;
}

/**
 * PostHog Code (cloud) env config. Deliberately a marker with no
 * secrets — the personal API key + project id live on the task's
 * workspace `PostHogIntegration` so one set of credentials is shared
 * by every cloud task in the workspace. `projectId`/`host` here are
 * optional display hints only.
 */
export interface PostHogCodeEnvironmentConfig {
  type: 'posthog_code';
  /** Display-only, for parity with the other configs. Unused for cloud. */
  hostname?: string;
  workingDirectory?: string;
  /** Default agent runtime for tasks on this env. */
  runtimeAdapter?: PostHogCodeRuntimeAdapter;
  /** Default agent model for tasks on this env. */
  model?: string;
}

export type PostHogCodeRuntimeAdapter = 'claude' | 'codex';

// ============================================================================
// Task
// ============================================================================

export type TaskType =
  | 'code_writing'
  | 'pr_response'
  | 'pr_review'
  | 'manual';

/** Types FastOwl delegates to a cloud agent (everything except `manual`). */
export const AGENT_TASK_TYPES: readonly TaskType[] = [
  'code_writing',
  'pr_response',
  'pr_review',
];

/** True if FastOwl dispatches this task to a cloud agent. */
export function isAgentTask(type: TaskType): boolean {
  return type !== 'manual';
}

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'in_progress'
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
  assignedEnvironmentId?: string;
  result?: TaskResult;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
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
  | 'task:status'
  | 'task:event'
  | 'task:created'
  | 'task:update'
  | 'task:deleted'
  | 'task:files_changed'
  | 'pull_request:updated'
  | 'merge_queue:blocked'
  | 'environment:status'
  | 'environment:created'
  | 'connection:status'
  // Per-user billing fact (broadcastToUser) — fired by the Polar webhook
  // handler after a plan change; payload is the fresh BillingStatus.
  | 'subscription:updated'
  // Developer debug stream — one event per observed internal activity
  // (HTTP request, poll tick, WS broadcast, …). Broadcast to all clients;
  // the desktop Debug panel tails it. See DebugEvent below.
  | 'debug:event';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  payload: T;
  timestamp: string;
}

// ============================================================================
// Debug Tooling
// ============================================================================

/**
 * Buckets a {@link DebugEvent} into one of the app's internal activity
 * channels. Drives the filter chips in the desktop Debug panel.
 */
export type DebugCategory =
  | 'http' // outbound request to an external service (GitHub, PostHog Code)
  | 'db' // a Postgres query and the (estimated) bytes its result pulled back
  | 'polling' // a poll loop tick
  | 'websocket' // client connect/disconnect, inbound message, outbound broadcast
  | 'event' // in-process domain event (e.g. task:status)
  | 'webhook' // an inbound GitHub webhook delivery (receipt → enqueue → process)
  | 'error'; // an unexpected failure worth surfacing on its own

/**
 * A single observed internal activity. Metadata only — never request/response
 * bodies, auth headers, or tokens (URLs are stripped of their query string at
 * the recording site). Safe to surface in the UI and leave recording on.
 */
export interface DebugEvent {
  /** Monotonic per-process id; also used as a stable React key. */
  id: number;
  timestamp: string;
  category: DebugCategory;
  /** Originating subsystem, e.g. 'github', 'posthog_code', 'pr_monitor', 'ws'. */
  service: string;
  /** What happened, e.g. 'request', 'tick', 'connect', 'broadcast'. */
  action: string;
  /** Whether the activity succeeded (false for a failed request / errored tick). */
  ok: boolean;
  /** Human-readable one-liner for the stream row. */
  summary: string;
  durationMs?: number;
  /** Extra redacted context shown when a row is expanded. */
  meta?: Record<string, unknown>;
  /**
   * The FastOwl account this activity belongs to, when it can be attributed to
   * one (e.g. a GitHub call for a workspace that account owns). null for
   * backend-internal activity not tied to a single account. Used by the
   * admin-only Debug panel to filter by user.
   */
  ownerId?: string | null;
  /** Display label for {@link ownerId} (email or GitHub username). */
  ownerLabel?: string | null;
}

/** A FastOwl account that has debug activity attributed to it. */
export interface DebugOwner {
  ownerId: string;
  label: string;
}

/** Live state of one poll loop, surfaced in the Debug panel snapshot bar. */
export interface DebugPollerState {
  name: string;
  /** Human-readable explanation of what this loop does (shown as a tooltip). */
  description: string;
  /** Current cadence — the live interval, which may be stretched from the base. */
  intervalMs: number;
  /**
   * The un-throttled base cadence. Equals {@link intervalMs} unless the adaptive
   * rate-budget governor has slowed the loop to protect the GitHub budget — then
   * `intervalMs > baseIntervalMs` and the panel flags it as throttled.
   */
  baseIntervalMs: number;
  tickCount: number;
  lastTickAt: string | null;
  lastDurationMs: number | null;
  lastOk: boolean | null;
  lastError: string | null;
}

/**
 * GitHub GraphQL points budget for one rate-limit account, read off the free
 * `rateLimit { … }` field on our batched queries. GraphQL is a per-account
 * point bucket (≈5,000/hr, scaling to 12,500 / 15,000 on Enterprise Cloud);
 * this surfaces how close an account is to empty and whether non-urgent loops
 * are deferring to protect the reserve.
 */
export interface DebugGraphqlBudget {
  /** Rate-limit account key, e.g. `inst:140694558` (App installation) or a login. */
  accountKey: string;
  /** Max GraphQL points per hour for this account. */
  limit: number;
  /** Points remaining in the current window (optimistically `limit` once it resets). */
  remaining: number;
  /** ISO timestamp when the points window resets to `limit`. */
  resetAt: string;
  /** Point cost of the most recently observed query. */
  lastCost: number;
  /** When this budget was last observed (ISO). */
  observedAt: string;
  /** True while non-urgent loops are deferring work for this account (budget in reserve). */
  deferring: boolean;
}

/** Point-in-time view of the backend's internals for the Debug panel. */
export interface DebugSnapshot {
  pollers: DebugPollerState[];
  /** Lifetime event counts keyed by {@link DebugCategory}. */
  counters: Record<string, number>;
  /** Current number of buffered events. */
  bufferSize: number;
  /** Currently-connected WebSocket clients. */
  wsClients: number;
  /** GitHub GraphQL points budget per account, with deferral status. */
  graphqlBudgets: DebugGraphqlBudget[];
  /** Accounts with attributed debug activity, for the per-user filter. */
  owners: DebugOwner[];
  /** Cumulative Postgres query stats since the last clear. */
  dbStats: DebugDbStats;
  /**
   * Webhook consumer lag (enqueue→pickup) over recent processed deliveries —
   * dominated by the fast check_run/check_suite firehose.
   */
  webhookLag: DebugWebhookLag;
  /**
   * Lag of the SLOW lane only: pull_request/review/comment deliveries, which run
   * a bounded-concurrency `refreshPr`. Surfaces a backed-up refresh pool even
   * when the firehose (`webhookLag`) is at zero.
   */
  webhookLagSlow: DebugWebhookLag;
}

/**
 * How far behind real-time the webhook worker is: the enqueue→pickup latency of
 * recently processed deliveries. A healthy worker sits near zero; a rising
 * `maxMs` means the consumer can't keep up with the ingest stream.
 */
export interface DebugWebhookLag {
  /** Most recent processed delivery's enqueue→pickup lag, ms. */
  lastMs: number;
  /** Median lag across the recent sample window, ms. */
  medianMs: number;
  /** Worst lag in the recent sample window, ms. */
  maxMs: number;
  /** Number of samples behind the figures (0 = nothing processed yet). */
  samples: number;
  /** ISO time of the most recent processed delivery, or null if none yet. */
  observedAt: string | null;
}

/**
 * Running totals for Postgres traffic, surfaced as tiles on the Debug panel.
 * `egressBytes` is an estimate — the serialized size of each query's result
 * rows, not exact wire bytes — but directionally accurate for spotting which
 * queries dominate database egress.
 */
export interface DebugDbStats {
  /** Total queries issued since the last clear. */
  requests: number;
  /** Estimated total bytes returned by those queries since the last clear. */
  egressBytes: number;
}

export interface TaskStatusEvent {
  taskId: string;
  status: TaskStatus;
  result?: TaskResult;
}

export interface TaskUpdateEvent {
  taskId: string;
  updates: Partial<Task>;
}

export interface TaskDeletedEvent {
  taskId: string;
}

/**
 * Fired when a task is created on the BACKEND (merge-queue / auto-keep-mergeable
 * fix runs, or any non-desktop creator). Lets the desktop add it to the task
 * list live, so backend-created tasks show up in the Tasks screen and the PR's
 * task badge deep-links to a real, present task. The desktop dedupes by id, so
 * it's harmless when the creating client already added it optimistically.
 */
export interface TaskCreatedEvent {
  task: Task;
}

/**
 * Fired once when a PR in the FastOwl merge queue exhausts its auto-fix retry
 * budget and transitions into `blocked` — the queue has given up and the PR
 * now needs a human. The desktop turns this into an OS notification + in-app
 * toast. Distinct from the idempotent `pull_request:updated` (which is replayed
 * on reconnect/backfill) so the notification fires exactly once.
 */
export interface MergeQueueBlockedEvent {
  pullRequestId: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Short human reason, e.g. "merge conflicts with the base branch". */
  reason: string;
  /** How many fix runs were attempted before giving up. */
  attempts: number;
}

export interface EnvironmentStatusEvent {
  environmentId: string;
  status: EnvironmentStatus;
  error?: string;
}

export interface EnvironmentCreatedEvent {
  environment: Environment;
}

export interface TaskEventBroadcast {
  taskId: string;
  event: AgentEvent;
}

// ============================================================================
// API Types
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  /**
   * Machine-readable error discriminator for failures the client must branch
   * on (e.g. TASK_LIMIT_ERROR_CODE → upgrade modal). `error` stays the
   * human-readable message.
   */
  code?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ============================================================================
// Billing
// ============================================================================

export type Plan = 'free' | 'unlimited';

/** Max simultaneously-active tasks (pending/queued/in_progress) on the free plan. */
export const FREE_PLAN_ACTIVE_TASK_LIMIT = 3;

/** Max PRs sitting in the merge queue at once on the free plan. */
export const FREE_PLAN_MERGE_QUEUE_LIMIT = 3;

/** ApiResponse.code when task creation/activation is rejected by the free limit. */
/**
 * Why a queued task has not started yet.
 *
 * Written by the task queue onto `metadata.lastScheduleError`. `capacity` is
 * the field that matters to the UI: a provider being BUSY is not a failure —
 * the task is fine, still queued, and will be retried automatically — and
 * rendering it as one is why "waiting for a runner" looked like something had
 * gone wrong.
 */
export interface TaskScheduleError {
  at: string;
  /** User-facing. Must not carry internal endpoints or stack detail. */
  reason: string;
  attempts: number;
  /** True when the provider was busy or unreachable rather than refusing. */
  capacity?: boolean;
  /** When the queue will try again. Absent once the attempt budget is spent. */
  retryAt?: string;
  /** The attempt budget, so the UI can say "3 of 40" rather than just "3". */
  maxAttempts?: number;
}

export const TASK_LIMIT_ERROR_CODE = 'task_limit_reached';

/** ApiResponse.code when queueing a PR is rejected by the free merge-queue limit. */
export const MERGE_QUEUE_LIMIT_ERROR_CODE = 'merge_queue_limit_reached';

/**
 * The user's billing state as served by `GET /billing/status` and pushed on
 * the `subscription:updated` WS event.
 */
export interface BillingStatus {
  /** False when the backend has no Polar env configured — limits are off. */
  billingEnabled: boolean;
  plan: Plan;
  /** 'override' = manually comped (plan_override); 'billing_disabled' when unconfigured. */
  planSource: 'default' | 'subscription' | 'override' | 'billing_disabled';
  /** Raw provider subscription status, when a subscription exists. */
  subscriptionStatus?: 'active' | 'past_due' | 'canceled' | 'revoked' | string;
  cancelAtPeriodEnd: boolean;
  /** ISO date the current billing period ends (renewal or expiry). */
  currentPeriodEnd?: string;
  activeTasks: number;
  /** null = unlimited. */
  activeTaskLimit: number | null;
  /** PRs currently in the merge queue, across all the user's workspaces. */
  queuedPrs: number;
  /** null = unlimited. */
  mergeQueueLimit: number | null;
}

export interface CreateCheckoutRequest {
  period: 'monthly' | 'annual';
}

export interface CheckoutSessionResponse {
  url: string;
}

/** One past order, served by `GET /billing/orders` (newest first). */
export interface BillingOrder {
  id: string;
  createdAt: string; // ISO
  /** Total in the smallest currency unit (cents). */
  amount: number;
  currency: string;
  /** Provider order status: 'paid' | 'pending' | 'refunded' | 'partially_refunded' | … */
  status: string;
  paid: boolean;
  productName: string | null;
  /** Assigned once the order is finalized; shown as the invoice reference. */
  invoiceNumber: string | null;
}

// ============================================================================
// MCP tokens
// ============================================================================

/**
 * A long-lived personal access token for the hosted MCP endpoint, as shown
 * in the desktop "MCP server" settings list. Never carries the secret — only
 * the human-readable prefix. The plaintext token is returned exactly once at
 * creation (see {@link CreateMcpTokenResponse}).
 */
export interface McpToken {
  id: string;
  name: string;
  /** Human-readable head, e.g. `talyn_mcp_ab12cd` — for disambiguation only. */
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface CreateMcpTokenRequest {
  /** Optional label so the user can tell tokens apart. */
  name?: string;
  /** Days until expiry. Defaults to 90; null/0 means non-expiring. */
  expiresInDays?: number | null;
}

/** Returned once on creation — `token` is never retrievable again. */
export interface CreateMcpTokenResponse {
  /** The full plaintext token. Show once, then discard server-side. */
  token: string;
  token_meta: McpToken;
}

// Workspace API
export interface CreateWorkspaceRequest {
  name: string;
  description?: string;
  logo?: WorkspaceLogo;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  description?: string;
  logo?: WorkspaceLogo;
  settings?: Partial<WorkspaceSettings>;
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
  /**
   * Associate the new task with an existing pull_requests row (its `id`).
   * Set when the task is started from a PR row ("Get PR mergeable" /
   * "Address PR") so the GitHub screen can show a live in-progress
   * indicator on that row and deep-link back to the task. Best-effort:
   * an unknown / cross-workspace id is silently ignored.
   */
  pullRequestId?: string;
  /**
   * Cloud (PostHog Code) overrides. Only meaningful when the task is
   * assigned to a `posthog_code` env; ignored otherwise. `runtimeAdapter`
   * falls back to the env's default, then `claude`. `model` falls back to
   * the env's default, then the backend default — the PostHog Code API
   * requires a concrete model on every run, so it's always resolved server-side.
   */
  runtimeAdapter?: PostHogCodeRuntimeAdapter;
  model?: string;
  /**
   * Set when the task runs an agent skill. The skill's content is already
   * inlined into `prompt` by the caller (see buildSkillPrompt); this small
   * descriptor is persisted to `metadata.skill` for display and bumps the
   * workspace's skill-usage stats. Content is deliberately NOT stored here.
   */
  skill?: TaskSkillInfo;
}

/** Which skill a task ran — stored on `task.metadata.skill`. */
export interface TaskSkillInfo {
  key: SkillKey;
  name: string;
  source: SkillSource;
  /** repo skills — the repository the skill came from. */
  repositoryId?: string;
  /** platform skills — the `skills` row id. */
  platformSkillId?: string;
}

// Skills API
export interface ListSkillsResponse {
  /** Workspace (Talyn) skills — no content (fetch via GET /skills/:id). */
  platform: SkillSummary[];
  /** Skills discovered in the requested repo — empty when no repositoryId given. */
  repo: SkillSummary[];
  /** 'none' = repo has no .claude/skills dir; 'error' = GitHub fetch failed. */
  repoStatus: 'ok' | 'none' | 'error';
  /** Usage stats for every skill key the workspace has ever run. */
  usage: Record<SkillKey, SkillUsageEntry>;
}

export interface PlatformSkill extends SkillSummary {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlatformSkillRequest {
  workspaceId: string;
  name: string;
  description?: string;
  content: string;
  /** Where the skill was imported from, if not written in-app. */
  sourceInfo?: { importedFrom: SkillSource; originPath?: string };
}

export interface UpdatePlatformSkillRequest {
  name?: string;
  description?: string;
  content?: string;
}

/**
 * Fields FastOwl writes onto `task.metadata` for a cloud (PostHog Code)
 * run. Stored loosely (metadata is `Record<string, unknown>`); this
 * interface documents the shape the poller + UI rely on.
 */
export interface PostHogCodeTaskMetadata {
  /** Remote PostHog task id. */
  posthogTaskId: string;
  /** Remote run id (the `run/` response). */
  posthogRunId?: string;
  /** PostHog project (team) id the task was created under. */
  posthogProjectId: string;
  /** PostHog host the task lives on, e.g. https://us.posthog.com. */
  posthogHost: string;
  /** Deep link to the run's log/console in the PostHog UI. */
  posthogLogUrl?: string;
  /** PR URL once the cloud run opens one. */
  posthogPrUrl?: string;
  /** Last remote run status we observed. */
  posthogStatus?: string;
}

/**
 * Cloud task providers FastOwl can delegate a task to. A provider runs the
 * whole agent loop on its own sandbox and opens a PR; FastOwl kicks off the
 * run and reconciles status/transcript back. `posthog_code` is live today;
 * the other two are planned drop-ins (see docs/CLOUD_PROVIDERS.md).
 */
export type CloudProviderType = 'posthog_code' | 'codex_cloud' | 'claude_code' | 'selfhosted';

/**
 * A provider id as it may actually arrive at runtime — including one this build
 * has never heard of.
 *
 * `CloudProviderType` is the closed set of providers *this* build knows how to
 * register, and it should stay closed: a `Record<CloudProviderType, ...>` that
 * stops compiling when a provider is added is a useful reminder to add its
 * label and logo. But the desktop app is a released Electron binary, so users
 * run old versions against a newer backend indefinitely. Anything that *reads*
 * a provider id off the wire — task metadata, an environment row, an API
 * response — must therefore accept a string it does not recognise and degrade,
 * rather than treat it as absent.
 *
 * The `(string & {})` intersection is the standard trick for "any string, but
 * keep autocompleting the known ones".
 */
export type AnyCloudProviderType = CloudProviderType | (string & {});

/**
 * Neutral, provider-agnostic cloud-run metadata stored on
 * `task.metadata.cloudTask`. Supersedes the legacy `posthog*` fields; a
 * read-through helper ({@link readCloudTaskMeta}) maps old tasks forward.
 */
export interface CloudTaskMetadata {
  /**
   * Which provider owns this task. Deliberately the permissive type: this is
   * deserialised from a JSON blob written by whichever backend version was
   * running at the time, so it may name a provider this build does not know.
   */
  provider: AnyCloudProviderType;
  /** Remote task id on the provider. */
  remoteTaskId: string;
  /** Remote run id, once a run has started. */
  remoteRunId?: string;
  /** Last remote status observed. */
  status?: string;
  /** Deep link to the run's log/console in the provider's UI. */
  logUrl?: string;
  /** PR URL once the run opens one. */
  prUrl?: string;
  /** Provider-specific extras. */
  extra?: Record<string, unknown>;
}

/**
 * Resolve which cloud provider owns a task from its `provider` column
 * (preferred) or its metadata, falling back to the legacy `posthog*`
 * fields. Returns null for a task with no cloud association.
 */
export function readCloudTaskProvider(task: {
  provider?: string;
  metadata?: Record<string, unknown> | null;
}): AnyCloudProviderType | null {
  // Any non-empty string is a provider id. This used to filter through a
  // hand-maintained allowlist, which meant a provider added to the union but
  // not to that array — or, worse, a provider from a newer backend arriving at
  // an older client — silently resolved to null, and the task then rendered as
  // if it had no cloud run at all. Null must mean "no cloud run", not "a cloud
  // run I have not been taught about".
  if (typeof task.provider === 'string' && task.provider.trim()) {
    return task.provider;
  }
  const meta = task.metadata ?? {};
  const cloud = meta.cloudTask as CloudTaskMetadata | undefined;
  if (typeof cloud?.provider === 'string' && cloud.provider.trim()) {
    return cloud.provider;
  }
  if (typeof meta.posthogTaskId === 'string' && meta.posthogTaskId) {
    return 'posthog_code';
  }
  return null;
}

/**
 * Read the neutral cloud metadata for a task, mapping legacy `posthog*`
 * fields forward when `metadata.cloudTask` isn't present. Returns null if
 * the task carries no cloud run.
 */
export function readCloudTaskMeta(task: {
  metadata?: Record<string, unknown> | null;
}): CloudTaskMetadata | null {
  const meta = task.metadata ?? {};
  const cloud = meta.cloudTask as CloudTaskMetadata | undefined;
  if (cloud && cloud.remoteTaskId) return cloud;
  if (typeof meta.posthogTaskId === 'string' && meta.posthogTaskId) {
    return {
      provider: 'posthog_code',
      remoteTaskId: meta.posthogTaskId,
      remoteRunId: meta.posthogRunId as string | undefined,
      status: meta.posthogStatus as string | undefined,
      logUrl: meta.posthogLogUrl as string | undefined,
      prUrl: meta.posthogPrUrl as string | undefined,
    };
  }
  return null;
}

export interface GenerateTaskMetadataRequest {
  prompt: string;
  /** Optional env hint for resolving the cloud provider. */
  assignedEnvironmentId?: string;
}

export interface GenerateTaskMetadataResponse {
  title: string;
  description: string;
  suggestedPriority: TaskPriority;
}
