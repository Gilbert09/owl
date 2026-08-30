import {
  getApiRoot,
  getConfig,
  getWebSocketUrl,
} from './config.js';
import type {
  Workspace,
  Environment,
  Task,
  CreateWorkspaceRequest,
  CreateTaskRequest,
  CreateMcpTokenRequest,
  CreateMcpTokenResponse,
  McpToken,
  ApiResponse,
  BillingOrder,
  BillingStatus,
  CheckoutSessionResponse,
  CreateCheckoutRequest,
  WSEvent,
  DebugEvent,
  DebugCategory,
  DebugSnapshot,
  ListSkillsResponse,
  PlatformSkill,
  CreatePlatformSkillRequest,
  UpdatePlatformSkillRequest,
  ExternalQueueState,
  AdminAccess,
  AdminAuditEntry,
  AdminFleetHost,
  AdminFleetHostDetail,
  AdminGoldensView,
  AdminIncident,
  AdminDrainRequest,
  AdminGcResult,
  AdminGoldenGcRequest,
  AdminGoldenPinRequest,
  AdminGoldenDeleteRequest,
  AdminGoldenDeleteResult,
  AdminGoldenRebakeRequest,
  AdminGrantRequest,
  AdminMutationRequest,
  AdminPage,
  AdminPlanOverrideRequest,
  AdminRebakeStatus,
  AdminRunDetail,
  AdminRunEventPage,
  AdminRunIndex,
  AdminTaskDetail,
  AdminTaskSummary,
  AdminUserDetail,
  AdminUserSummary,
  AdminWorkspaceDetail,
  AdminWorkspaceSummary,
} from '@talyn/shared';
// Value import (not a type): the SSE frame parser the admin transcript stream
// shares with the backend proxy and the fleet client.
import { createSseJsonParser } from '@talyn/shared';

export {
  configureApiClient,
  getApiBaseUrl,
  getMcpEndpoint,
  type ApiClientConfig,
} from './config.js';

// ============================================================================
// HTTP Client
// ============================================================================

/**
 * The current access token, via the host app's session store. Returns null
 * when we're not logged in; callers surface a clear error then.
 */
async function getAuthToken(): Promise<string | null> {
  return getConfig().getAccessToken();
}

/**
 * A transport-level failure reaching the backend: `fetch` itself rejected
 * (offline, DNS, TLS, connection refused, or the hosted backend down / cold-
 * starting) rather than returning an HTTP error status. The native rejection is
 * an opaque `TypeError: Failed to fetch` with a minified stack and no hint of
 * which call failed — this wraps it with the method, path, and online state so a
 * captured exception is actually identifiable.
 */
export class ApiNetworkError extends Error {
  readonly method: string;
  readonly path: string;
  readonly online: boolean;

  constructor(method: string, path: string, cause: unknown) {
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    super(
      `Could not reach backend: ${method} ${path} — ${
        online ? 'backend unreachable' : 'browser is offline'
      }`,
      { cause }
    );
    this.name = 'ApiNetworkError';
    this.method = method;
    this.path = path;
    this.online = online;
  }
}

/**
 * An HTTP-level failure the backend answered deliberately: carries the
 * status and the machine-readable `code` from the ApiResponse envelope so
 * callers can branch (e.g. `task_limit_reached` → upgrade modal) instead of
 * string-matching the human message.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Deduped session recovery, run when the backend 401s a request we sent a
 * token with. The host supplies the actual refresh (see
 * ApiClientConfig.recoverSession — it owns the "is this session really dead?"
 * judgement); this only guarantees that concurrent 401s share ONE in-flight
 * attempt, so a burst of failing polls can't stampede the single-use,
 * rotating refresh token.
 */
let sessionRecovery: Promise<boolean> | null = null;

async function recoverSession(): Promise<boolean> {
  sessionRecovery ??= (async () => {
    try {
      return await getConfig().recoverSession();
    } catch {
      return false;
    } finally {
      sessionRecovery = null;
    }
  })();
  return sessionRecovery;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isRetry = false
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Identifies the build to the backend's paywall exemption
    // (services/billing/clientGate.ts). That check is fail-closed, so this
    // header omitted or unrecognised means ENFORCE — it is no longer a way
    // to opt out of the free-plan limits.
    'X-Talyn-Client-Version': getConfig().clientVersion,
  };
  const token = await getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${getApiRoot()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // fetch only rejects on a transport failure (never on an HTTP error
    // status). Rethrow with context so an outage/offline blip is identifiable
    // instead of a bare, un-symbolicated "TypeError: Failed to fetch".
    throw new ApiNetworkError(method, path, err);
  }

  if (response.status === 401 && token && !isRetry) {
    // The backend rejected our token. Try to recover the session (see
    // recoverSession) and replay the request once with the fresh token;
    // a second 401 falls through to the normal error path.
    if (await recoverSession()) {
      return request<T>(method, path, body, true);
    }
  }

  // The edge proxy in front of the hosted backend answers with plain text
  // ("upstream error", "upstream request timeout") when the backend can't
  // respond — parse defensively so an outage reads as "backend unreachable"
  // instead of a JSON SyntaxError.
  const text = await response.text();
  let data: ApiResponse<T> | null = null;
  try {
    data = JSON.parse(text) as ApiResponse<T>;
  } catch {
    throw new Error(
      `Backend unreachable (HTTP ${response.status}${
        text ? `: ${text.slice(0, 80)}` : ''
      })`
    );
  }

  if (!data.success) {
    throw new ApiError(data.error || 'Request failed', response.status, data.code);
  }

  return data.data as T;
}

/**
 * A request whose response is NOT an `ApiResponse` envelope.
 *
 * Two admin endpoints stream or pass through: the Prometheus text scrape and
 * the run-transcript SSE proxy. `request()` reads the whole body as text and
 * JSON.parses it, which would buffer a stream forever and reject a text/plain
 * body — so those need the raw `Response`.
 *
 * Everything else about the transport is identical, deliberately: same auth
 * header, same client-version header, same 401-recover-and-replay, same
 * ApiNetworkError wrapping. Diverging on any of those is how one endpoint ends
 * up being the only thing that doesn't survive a token refresh.
 */
async function rawRequest(
  method: string,
  path: string,
  init: { accept?: string; signal?: AbortSignal } = {},
  isRetry = false
): Promise<Response> {
  const headers: Record<string, string> = {
    'X-Talyn-Client-Version': getConfig().clientVersion,
  };
  if (init.accept) headers.Accept = init.accept;
  const token = await getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${getApiRoot()}${path}`, {
      method,
      headers,
      signal: init.signal,
    });
  } catch (err) {
    throw new ApiNetworkError(method, path, err);
  }

  if (response.status === 401 && token && !isRetry) {
    if (await recoverSession()) {
      return rawRequest(method, path, init, true);
    }
  }

  if (!response.ok) {
    // An error body here IS the JSON envelope — only the success path is raw.
    const text = await response.text().catch(() => '');
    let code: string | undefined;
    let message = `Request failed (HTTP ${response.status})`;
    try {
      const parsed = JSON.parse(text) as ApiResponse<never>;
      if (parsed.error) message = parsed.error;
      code = parsed.code;
    } catch {
      if (text) message = text.slice(0, 200);
    }
    throw new ApiError(message, response.status, code);
  }

  return response;
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

// Environments — cloud-provider markers are auto-provisioned by the backend
// on integration connect, so the client only ever reads or removes them.
export const environments = {
  list: () => request<Environment[]>('GET', '/environments'),
  get: (id: string) => request<Environment>('GET', `/environments/${id}`),
  delete: (id: string) => request<void>('DELETE', `/environments/${id}`),
};

// MCP tokens — long-lived personal tokens for the hosted MCP endpoint.
export const mcpTokens = {
  list: () => request<McpToken[]>('GET', '/mcp-tokens'),
  create: (data: CreateMcpTokenRequest = {}) =>
    request<CreateMcpTokenResponse>('POST', '/mcp-tokens', data),
  revoke: (id: string) => request<void>('DELETE', `/mcp-tokens/${id}`),
};

// Task metadata generation response
export interface TaskMetadata {
  title: string;
  description: string;
  suggestedPriority: 'low' | 'medium' | 'high' | 'urgent';
}

// Tasks
export const tasks = {
  list: (params?: {
    workspaceId?: string;
    // Single status or a comma-separated list (e.g. "completed,failed,cancelled").
    status?: string;
    type?: string;
    // Cursor pagination: at most `limit` rows, ordered createdAt desc, older
    // than the `before` createdAt (ISO). Used for the finished-task history.
    limit?: number;
    before?: string;
  }) => {
    const query = new URLSearchParams();
    if (params?.workspaceId) query.set('workspaceId', params.workspaceId);
    if (params?.status) query.set('status', params.status);
    if (params?.type) query.set('type', params.type);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.before) query.set('before', params.before);
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
  stop: (id: string) => request<Task>('POST', `/tasks/${id}/stop`),
  // Generate task metadata from prompt using AI
  generateMetadata: (prompt: string) =>
    request<TaskMetadata>('POST', '/tasks/generate-metadata', { prompt }),
  // Kick a PostHog Code (cloud) task's log stream/backfill on demand.
  // Transcript events arrive over the WS, so the response is just ok.
  refreshLogs: (id: string) => request<void>('POST', `/tasks/${id}/refresh-logs`),
  // Viewing heartbeat — the backend only streams a cloud task's logs while
  // a client keeps re-announcing that the task screen is open.
  watch: (id: string, watched = true) =>
    request<void>('POST', `/tasks/${id}/watch`, { watched }),
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

// One GitHub App installation the connected user can access (per account/org).
// Drives the "is the Talyn app installed on this org?" coverage UI.
export interface GitHubInstallation {
  accountLogin: string;
  accountType: 'User' | 'Organization';
  suspended: boolean;
  repositorySelection: 'all' | 'selected';
}

// GitHub OAuth + repo discovery only. Every PR-management surface
// (list / get / create / merge / review / comment) was removed in
// Phase 7 — the new pull_requests client (see below) replaces the
// list/get path; "manage on github" is the user's deliberate
// model for everything actionable.
export const github = {
  getStatus: (workspaceId?: string) => {
    const query = workspaceId ? `?workspaceId=${workspaceId}` : '';
    return request<GitHubStatus>('GET', `/github/status${query}`);
  },
  // GitHub App install flow (webhooks + hybrid auth). Returns two stateful URLs
  // sharing one single-use state — `installUrl` (OAuth authorize, used to first
  // connect) and `manageUrl` (the installations/new page, used to install on
  // another org or add repos once connected). Open one in the browser; GitHub
  // redirects back through /github/app/callback, which records the installation
  // + user token (and re-discovers every install).
  installViaApp: (workspaceId: string) =>
    request<{ installUrl: string; manageUrl: string; state: string }>(
      'POST',
      '/github/app/install-url',
      { workspaceId }
    ),
  disconnect: (workspaceId: string) =>
    request<void>('POST', '/github/disconnect', { workspaceId }),
  getUser: (workspaceId: string) =>
    request<GitHubUser>('GET', `/github/user?workspaceId=${workspaceId}`),
  // The GitHub App installations the connected user can access (one per
  // account/org). A watched repo is only tracked if its owner has an active
  // (non-suspended) installation here.
  listInstallations: (workspaceId: string) =>
    request<GitHubInstallation[]>(
      'GET',
      `/github/installations?workspaceId=${workspaceId}`
    ),
  listRepos: (workspaceId: string) =>
    request<GitHubRepo[]>('GET', `/github/repos?workspaceId=${workspaceId}`),
  // User's own repos + all their orgs' repos, merged. Expensive — the
  // desktop caches this in localStorage behind a manual refresh.
  listAllRepos: (workspaceId: string) =>
    request<GitHubRepo[]>('GET', `/github/all-repos?workspaceId=${workspaceId}`),
  listOrgs: (workspaceId: string) =>
    request<Array<{ login: string; avatar_url: string }>>(
      'GET',
      `/github/orgs?workspaceId=${workspaceId}`
    ),
  listOrgRepos: (workspaceId: string, org: string) =>
    request<GitHubRepo[]>(
      'GET',
      `/github/orgs/${encodeURIComponent(org)}/repos?workspaceId=${workspaceId}`
    ),
};

// PostHog Code (cloud tasks) integration — per-workspace credentials.
export interface PostHogCodeStatus {
  connected: boolean;
  projectId?: string;
  host?: string;
  /** How this workspace authenticates. Absent on a workspace that has never
   *  connected. A pre-OAuth install reports `personal_api_key` and keeps its
   *  existing card — nothing about it changes. */
  authMethod?: 'personal_api_key' | 'oauth';
  /** OAuth only: the grant was revoked (in PostHog, or by reuse protection) and
   *  the user has to reconnect. Nothing else can recover it. */
  needsReauth?: boolean;
  /** Whether the backend is configured to offer the OAuth flow at all. False on
   *  a deployment without POSTHOG_OAUTH_* set — self-hosted, or local dev. */
  oauthAvailable?: boolean;
}

export const posthog = {
  getStatus: (workspaceId: string) =>
    request<PostHogCodeStatus>('GET', `/posthog/status?workspaceId=${workspaceId}`),
  /**
   * Start the OAuth flow. Returns the PostHog authorize URL to open — the host
   * app opens it (system browser on desktop, same tab on web); the backend
   * callback finishes the exchange, so no token ever reaches the client.
   */
  startOAuth: (workspaceId: string, opts?: { host?: string; projectId?: string }) =>
    request<{ authorizeUrl: string }>('POST', '/posthog/oauth/start', {
      workspaceId,
      ...opts,
    }),
  saveConfig: (
    workspaceId: string,
    config: { apiKey: string; projectId: string; host?: string }
  ) =>
    request<PostHogCodeStatus>('PUT', '/posthog/config', { workspaceId, ...config }),
  test: (workspaceId: string) =>
    request<{ connected: boolean; error?: string }>('POST', '/posthog/test', {
      workspaceId,
    }),
  disconnect: (workspaceId: string) =>
    request<void>('DELETE', `/posthog/config?workspaceId=${workspaceId}`),
};

// Cloud task providers — the registered providers + their per-workspace
// connection status. Generic surface so a new provider shows up without a
// desktop change.
export interface CloudProviderInfo {
  type: string;
  displayName: string;
  capabilities?: { model?: boolean; runtimeAdapter?: boolean };
  connected: boolean;
}

export const cloudProviders = {
  list: (workspaceId: string) =>
    request<CloudProviderInfo[]>('GET', `/cloud-providers?workspaceId=${workspaceId}`),
  /** Validate + store credentials for a provider, then auto-provision its env. */
  saveConfig: (type: string, workspaceId: string, config: Record<string, string>) =>
    request<{ connected: boolean }>('PUT', `/cloud-providers/${type}/config`, {
      workspaceId,
      ...config,
    }),
  test: (type: string, workspaceId: string) =>
    request<{ connected: boolean; error?: string }>('POST', `/cloud-providers/${type}/test`, {
      workspaceId,
    }),
  disconnect: (type: string, workspaceId: string) =>
    request<void>('DELETE', `/cloud-providers/${type}/config?workspaceId=${workspaceId}`),
};

// Skills — platform CRUD, repo discovery, usage stats.
export const skills = {
  list: (workspaceId: string, repositoryId?: string, refresh?: boolean) => {
    const query = new URLSearchParams({ workspaceId });
    if (repositoryId) query.set('repositoryId', repositoryId);
    if (refresh) query.set('refresh', '1');
    return request<ListSkillsResponse>('GET', `/skills?${query.toString()}`);
  },
  get: (id: string) => request<PlatformSkill>('GET', `/skills/${id}`),
  repoContent: (workspaceId: string, repositoryId: string, name: string) => {
    const query = new URLSearchParams({ workspaceId, repositoryId, name });
    return request<{ content: string; repoPath: string }>(
      'GET',
      `/skills/repo/content?${query.toString()}`
    );
  },
  create: (data: CreatePlatformSkillRequest) => request<PlatformSkill>('POST', '/skills', data),
  update: (id: string, data: UpdatePlatformSkillRequest) =>
    request<PlatformSkill>('PATCH', `/skills/${id}`, data),
  remove: (id: string) => request<void>('DELETE', `/skills/${id}`),
};

// Watched Repositories
export interface WatchedRepo {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
}

// PullRequests — read-only client for the Phase 1-3 backend surface.
export type PRBlockingReason =
  | 'mergeable'
  | 'merge_conflicts'
  | 'changes_requested'
  | 'checks_failed'
  // Mergeable, but non-required checks are failing — de-emphasised (amber)
  // rather than the hard red 'checks_failed'.
  | 'checks_failed_optional'
  | 'blocked'
  | 'unknown';

export type PRMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type PRReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type PRState = 'open' | 'closed' | 'merged';

export interface PRChecks {
  total: number;
  passed: number;
  failed: number;
  inProgress: number;
  skipped: number;
}

export type PRCheckState =
  | 'success'
  | 'failure'
  | 'pending'
  | 'in_progress'
  | 'skipped';

export interface PRCheckContext {
  name: string;
  state: PRCheckState;
  url: string | null;
  /**
   * Whether GitHub marks this check required for the PR. null when the
   * fetch didn't carry per-check required-ness. A *failing* check with
   * `required === false` doesn't block the merge — it's rendered amber
   * ("not required") rather than a blocking red.
   */
  required?: boolean | null;
}

/**
 * The persisted lastSummary jsonb from `pull_requests`. Same shape the
 * backend's `summaryToJsonb` writes — minimal columns for instant
 * render without a round-trip.
 */
export interface PRSummaryShape {
  title: string;
  author: string;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  /** When the PR was opened on GitHub. Optional for rows cached before
   *  this field was tracked. */
  createdAt?: string;
  updatedAt: string;
  url: string;
  mergeable: PRMergeable;
  mergeStateStatus: string;
  reviewDecision: PRReviewDecision;
  /**
   * Review state for the approval badge: GitHub's `reviewDecision` when the
   * base branch enforces required reviews, otherwise derived from the actual
   * reviews + outstanding requests (so repos without branch protection still
   * show Approved / Awaiting review). Absent on rows cached before this field. */
  effectiveReviewDecision?: PRReviewDecision;
  blockingReason: PRBlockingReason;
  checks: PRChecks;
  /** Unresolved review threads (capped at the first 100). Optional for
   *  rows cached before this field was tracked. */
  unresolvedReviewThreads?: number;
  /** Whether the viewer was asked to review directly, via a team, or both.
   *  `teams` lists the viewer's own requested teams (`org/team`). Drives the
   *  Review tab's "Requested" column. Absent on older cached rows. */
  reviewRequestVia?: { direct: boolean; teams: string[] };
  /** The PR's labels. An external merge queue (trunk.io) publishes a submitted
   *  PR's state ONLY as labels — `externalQueueStatusFromLabels` reads them.
   *  Absent on rows cached before labels shipped in the summary. */
  labels?: string[];
}

export interface PRRow {
  id: string;
  workspaceId: string;
  repositoryId: string;
  taskId: string | null;
  owner: string;
  repo: string;
  number: number;
  state: PRState;
  /**
   * True when the PR is awaiting the user's review — they're a requested
   * reviewer (directly or via a team) and haven't reviewed it yet. Cleared
   * once they submit a review, so an approved PR leaves the "Review" list.
   */
  reviewRequested: boolean;
  /** True when the PR was opened by the user. Drives the "Mine" tab. */
  authored: boolean;
  /**
   * True when the user manually added this PR to their list — typically one
   * someone ELSE wrote, tracked for its CI. Also drives the "Mine" tab: that
   * page's cohort is `authored || watching`.
   *
   * Separate from {@link authored} because the backend rewrites `authored` and
   * `reviewRequested` from GitHub's searches on every poll, so this is the only
   * flag a manual choice can survive in. NOTE that WS echoes carry it only when
   * they CHANGE it — preserve the current value with `??` (never `||`: an
   * un-watch sends `false`).
   */
  watching: boolean;
  mergedAt: string | null;
  lastPolledAt: string;
  summary: PRSummaryShape;
  /** When true, the backend watcher keeps this PR mergeable (repeatedly fires
   *  a "get mergeable" cloud run on any blocker, indefinitely). */
  autoKeepMergeable: boolean;
  /** Watcher guard state: consecutive failed auto-runs + whether it's paused
   *  (3 failures with no progress). Null when the watcher is off. */
  autoMergeState?: { attempts: number; paused: boolean } | null;
  /** True when this PR is in the Talyn merge queue (merges one-by-one per
   *  repo+base, auto-fixing conflicts via a cloud run). */
  mergeQueued: boolean;
  /** Merge method used when this PR's turn comes. */
  mergeMethod: 'merge' | 'squash' | 'rebase';
  /** Queue state: coarse status + 1-based position within its (repo, base)
   *  group. Null when the PR isn't queued. */
  mergeQueueState?: {
    status: 'waiting' | 'fixing' | 'merging' | 'blocked';
    attempts: number;
    position: number;
    /** Why the PR is blocked (only set when status === 'blocked'). */
    reason?: string;
  } | null;
  /** Merge queue v2 payload — full status vocabulary, per-head budgets,
   *  auto-merge state. Null when not queued; absent from pre-v2 echoes. */
  mergeQueue?: MergeQueuePublic | null;
  createdAt: string;
  updatedAt: string;
}

/** The v2 merge-queue badge payload (backend toPublicMergeQueue). */
export interface MergeQueuePublic {
  status:
    | 'queued'
    | 'awaiting_ci'
    | 'awaiting_review'
    | 'automerge_armed'
    /** Submitted to an external merge queue (trunk.io / GitHub native), which
     *  owns the merge from here; its progress shows up in the PR's labels. */
    | 'awaiting_external'
    /** Part of a merge stack, parked because the PR its base branch belongs to
     *  hasn't merged yet. Merging now would land it in that PR's branch rather
     *  than the real base. Self-heals when the parent lands — the backend
     *  retargets this PR onto the parent's base and returns it to the queue.
     *  Never needs a user action, so it is a wait, not a block. */
    | 'awaiting_stack'
    | 'fixing'
    | 'merging'
    | 'blocked'
    | 'blocked_manual'
    | 'merged'
    | 'removed';
  position: number;
  blockedCode?: string | null;
  /** Actionable reason when blocked/blocked_manual. */
  reason?: string;
  /** Flavor of the in-flight fix run when status === 'fixing'. */
  fixKind?: 'blockers' | 'resign';
  /** Short sha the retry budgets are scoped to (reset on every push). */
  headShaShort?: string;
  budgets?: {
    fixRuns: [number, number];
    checkReruns: [number, number];
    resigns: [number, number];
  };
  autoMerge?: { armed: boolean; armedBy?: 'talyn' | 'user' };
  /**
   * Merge stack: the PR this one is — or was — stacked on.
   *
   * The server's answer, resolved when the entry was evaluated. The client can
   * derive stack membership itself from the open rows (`linkStack` in
   * `@talyn/shared`, the same rule the backend uses), and should for anything
   * structural like ordering or grouping. This field is what that derivation
   * CANNOT give: the parent of a PR that has already been retargeted, whose
   * branch link is gone. Present while parked, and after a retarget.
   */
  stackParentNumber?: number | null;
  /** External merge queue: which door the PR was handed over through, the
   *  resubmit budget for the current head, and where the provider itself says
   *  the PR is (read off its own PR comment — the authoritative channel; the
   *  PR's labels are only a fallback). Absent when neither is known. */
  external?: {
    via?: 'auto_merge' | 'label' | 'comment';
    submits?: [number, number];
    state?: ExternalQueueState;
  };
}

/** Result of POST /pull-requests/:id/merge-queue/stack. */
export interface MergeStackResult {
  /** Members the server actually touched, root-first (= merge order). */
  pullRequestIds: string[];
  /**
   * Members the server resolved but could not act on. Surfaced rather than
   * dropped: the client's own derivation may show a different stack size, and
   * it must not be the authority on what happened.
   */
  skipped: Array<{ pullRequestId: string; reason: string }>;
}

/** One row of GET /pull-requests/:id/merge-queue/timeline. */
export interface MergeQueueTimelineEvent {
  at: string;
  fromStatus: string | null;
  toStatus: string;
  trigger: string;
  code: string | null;
  message: string;
  detail: Record<string, unknown> | null;
}

/**
 * Always-fresh GraphQL detail returned alongside the persisted row by
 * GET /pull-requests/:id. recentReviews/comments are limited to the
 * last 5 each — the Reviews tab paginates further on demand.
 */
export interface PRFreshDetail {
  recentReviews: Array<{
    id: string;
    author: string;
    state: string;
    submittedAt: string | null;
    url: string;
  }>;
  recentReviewComments: Array<{
    id: string;
    author: string;
    createdAt: string;
    url: string;
  }>;
  recentComments: Array<{
    id: string;
    author: string;
    createdAt: string;
    url: string;
  }>;
  // The fresh fetch returns the full PRSummary shape — include the
  // body for the Overview tab.
  body: string;
  // Per-check rows behind the rollup counts (live fetch only).
  checkContexts: PRCheckContext[];
}

/**
 * One changed file in a PR. Mirrors GitHub's `/pulls/:n/files` payload:
 * `patch` is the unified diff (absent for binary files / very large
 * diffs GitHub omits).
 */
export interface PRFile {
  sha: string;
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

/** Full review/comment detail for the PR detail Reviews tab. */
export interface PRReviewDetailReview {
  id: string;
  author: string;
  avatarUrl: string | null;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED. */
  state: string;
  body: string;
  submittedAt: string | null;
  url: string;
}

export interface PRReviewThreadComment {
  id: string;
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface PRReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  diffHunk: string | null;
  comments: PRReviewThreadComment[];
}

export interface PRConversationComment {
  id: string;
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface PRReviewDetail {
  reviews: PRReviewDetailReview[];
  threads: PRReviewThread[];
  comments: PRConversationComment[];
}

export const pullRequests = {
  list: (params: {
    workspaceId: string;
    state?: 'open' | 'closed' | 'merged' | 'all';
    repo?: string;
    taskOnly?: boolean;
    search?: string;
    relationship?: 'authored' | 'review_requested' | 'watching' | 'all';
  }) => {
    const query = new URLSearchParams();
    query.set('workspaceId', params.workspaceId);
    if (params.state) query.set('state', params.state);
    if (params.repo) query.set('repo', params.repo);
    if (params.taskOnly) query.set('taskOnly', 'true');
    if (params.search) query.set('search', params.search);
    if (params.relationship) query.set('relationship', params.relationship);
    return request<PRRow[]>('GET', `/pull-requests?${query.toString()}`);
  },
  get: (id: string) =>
    request<{ row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null }>(
      'GET',
      `/pull-requests/${id}`
    ),
  refresh: (id: string) =>
    request<PRRow>('POST', `/pull-requests/${id}/refresh`),
  /**
   * Track an arbitrary PR by URL, so its CI shows up on My PRs.
   *
   * Two-phase when the PR's repo isn't in the workspace: the first call throws
   * an {@link ApiError} with `status: 409` and `code: 'repo_not_watched'`
   * (carrying nothing that costs GitHub budget — the check runs before any API
   * call), and the caller re-sends with `confirmAddRepo` once the user has
   * agreed to add the repo. `alreadyTracked` means the PR was already on the
   * list; that is a 200, not an error.
   */
  watch: (params: { workspaceId: string; url: string; confirmAddRepo?: boolean }) =>
    request<PRRow & { repoAdded: boolean; alreadyTracked: boolean }>(
      'POST',
      '/pull-requests/watch',
      params
    ),
  /** Stop tracking a manually watched PR. Never cancels a queue entry or an
   *  armed watcher — it only clears the flag (and drops the row when nothing
   *  else references it). */
  unwatch: (id: string) =>
    request<{ deleted: boolean }>('DELETE', `/pull-requests/${id}/watch`),
  focus: (id: string, focused = true) =>
    request<null>('POST', `/pull-requests/${id}/focus`, { focused }),
  // Toggle the auto-keep-mergeable watcher for a PR (repeatedly fires a
  // "get this PR mergeable" cloud run until it's clean, then keeps watching).
  setAutoKeepMergeable: (id: string, enabled: boolean) =>
    request<null>('POST', `/pull-requests/${id}/auto-keep-mergeable`, { enabled }),
  // Add/remove a PR from the Talyn merge queue. When enabled, the backend
  // merges it (per `method`, default squash) as soon as it's clean, serialized
  // per repo+base, auto-firing a cloud run to fix conflicts/behind branches.
  /**
   * Add/remove ONE PR. For a PR that is part of a live stack — anything with
   * `mergeQueue.stackParentNumber`, or a base branch that is another open PR's
   * head — route the DEQUEUE through {@link setMergeQueueStack} instead:
   * dropping one member here leaves every PR stacked above it parked forever.
   */
  setMergeQueue: (
    id: string,
    enabled: boolean,
    method?: 'merge' | 'squash' | 'rebase'
  ) => request<null>('POST', `/pull-requests/${id}/merge-queue`, { enabled, method }),
  /**
   * Enqueue (or dequeue) a whole stack of dependent PRs in one call.
   *
   * `id` may be ANY member — the server resolves the chain itself, so a stale
   * client list can never enqueue an unrelated PR. Enabling always takes the
   * PRs `id` is based on (you cannot land it without them); pass
   * `includeDescendants` to also take the PRs stacked on top of it. Disabling
   * always cascades UPWARD: every descendant is parked on this PR and would
   * wait forever otherwise, so a stack member's dequeue must route here rather
   * than through {@link setMergeQueue}.
   *
   * Gated ONCE against the free-plan merge-queue cap for the whole set: a stack
   * that doesn't fit is refused whole (402, `merge_queue_limit_reached`) with
   * nothing enqueued, because a stack that stops halfway has nothing to say why.
   */
  setMergeQueueStack: (
    id: string,
    enabled: boolean,
    opts?: { method?: 'merge' | 'squash' | 'rebase'; includeDescendants?: boolean }
  ) =>
    request<MergeStackResult>('POST', `/pull-requests/${id}/merge-queue/stack`, {
      enabled,
      method: opts?.method,
      includeDescendants: opts?.includeDescendants,
    }),
  // The merge-queue entry's audit timeline (transitions + remediations with
  // reasons), newest first — powers the detail sheet's "Merge queue" section.
  mergeQueueTimeline: (id: string) =>
    request<{ events: MergeQueueTimelineEvent[] }>(
      'GET',
      `/pull-requests/${id}/merge-queue/timeline`
    ),
  // Tell the backend which list is on screen so it can hard-poll that cohort
  // and slack-poll the other. 'none' = the GitHub panel isn't visible.
  setView: (workspaceId: string, view: 'mine' | 'review' | 'all' | 'none') =>
    request<null>('POST', `/pull-requests/view`, { workspaceId, view }),
  files: (id: string) =>
    request<PRFile[]>('GET', `/pull-requests/${id}/files`),
  reviews: (id: string) =>
    request<PRReviewDetail>('GET', `/pull-requests/${id}/reviews`),
  /**
   * Merge the PR — or, when its base branch is behind an external merge queue
   * (trunk.io / GitHub native), SUBMIT it to that queue instead and answer
   * `{ merged: false, submitted: true }`. Talyn can't merge such a branch: its
   * ruleset exempts only that system's App.
   *
   * `alreadyTerminal` means the button was clicked on a PR that had ALREADY
   * merged or closed on GitHub — the row was stale. Nothing was merged by this
   * call; the backend reconciled the row and broadcast the correction.
   */
  merge: (id: string, method: 'merge' | 'squash' | 'rebase' = 'squash') =>
    request<{
      sha?: string;
      merged: boolean;
      message: string;
      submitted?: boolean;
      via?: 'auto_merge' | 'label';
      alreadyTerminal?: boolean;
    }>('POST', `/pull-requests/${id}/merge`, { method }),
};

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

// Debug tooling (developer-only internals view)
export const debug = {
  getEvents: (params?: {
    category?: DebugCategory;
    service?: string;
    limit?: number;
    owner?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.category) qs.set('category', params.category);
    if (params?.service) qs.set('service', params.service);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.owner) qs.set('owner', params.owner);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<DebugEvent[]>('GET', `/debug/events${suffix}`);
  },
  getSnapshot: (owner?: string) =>
    request<DebugSnapshot>('GET', `/debug/snapshot${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`),
  clearEvents: () => request<{ cleared: boolean }>('DELETE', '/debug/events'),
  // Whether the current user may see the debug surface (admin-gated server-side).
  getAccess: () => request<{ admin: boolean }>('GET', '/debug/access'),
};

// ============================================================================
// WebSocket Client
// ============================================================================

type EventHandler<T = unknown> = (payload: T) => void;

// How often the client pings the server to prove the socket is alive.
// The backend replies to `{type:'ping'}` with `connection:status {pong}`.
const HEARTBEAT_INTERVAL_MS = 25_000;
/**
 * How long a ping may go unanswered before the socket is considered dead.
 *
 * The server answers `{type:'ping'}` synchronously on receipt, so a healthy
 * round trip is milliseconds — this is ~1000x that. It sits just under one
 * heartbeat interval so a genuine miss is caught on the very next tick rather
 * than the one after.
 */
const PONG_TIMEOUT_MS = 20_000;
/**
 * A tick arriving later than this multiple of the interval means the timer was
 * throttled or frozen, not that the socket is slow — browsers clamp background
 * timers to ~1/min and freeze them outright for a bfcached page.
 */
const THROTTLED_TICK_FACTOR = 1.5;
// Backoff cap. We retry forever (a dev backend restart shouldn't leave the
// list permanently frozen until app relaunch) but never wait longer than this.
const MAX_RECONNECT_DELAY_MS = 30_000;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectTimer: number | null = null;
  // Drives only the backoff curve, not a give-up threshold — reset to 0 on
  // every successful open so the next outage starts fast again.
  private reconnectAttempts = 0;
  private heartbeatTimer: number | null = null;
  // True once a ping has been sent and we're still waiting for its pong. If
  // the next heartbeat tick fires while still awaiting, the socket is a
  // zombie (half-open after sleep / killed backend) and we force a reconnect.
  private awaitingPong = false;
  /** When the outstanding ping was sent — wall clock, not tick count. */
  private pingSentAt = 0;
  /** When the previous heartbeat tick ran, to detect a throttled/frozen gap. */
  private lastTickAt = 0;
  private lifecycleBound = false;
  private subscribedWorkspaces: Set<string> = new Set();
  // Admin Debug-panel owner filter, re-sent on (re)connect so the server keeps
  // streaming only the selected account's events. undefined = all.
  private debugFilter: string | undefined;
  private authenticated = false;
  /** One console.error per outage; later attempts only warn (see onerror). */
  private errorLoggedSinceOpen = false;

  async connect(): Promise<void> {
    this.bindLifecycle();
    // Bail if a socket is already open or mid-handshake — re-entry from a
    // focus/online wake would otherwise orphan the in-flight socket.
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    )
      return;

    const token = await getAuthToken();
    if (!token) {
      // Defer until we have a session — callers usually gate this behind
      // the AuthProvider so it's a transient case on cold start.
      console.log('WebSocket connect deferred: no auth token yet');
      return;
    }
    console.log('Connecting to WebSocket...');
    // Token rides in the first frame after open, not the URL, so it
    // doesn't end up in access/edge logs. The backend closes the
    // socket if auth doesn't arrive within its handshake window.
    this.authenticated = false;
    this.ws = new WebSocket(getWebSocketUrl());

    this.ws.onopen = () => {
      console.log('WebSocket opened; authenticating…');
      this.reconnectAttempts = 0;
      this.errorLoggedSinceOpen = false;
      this.ws?.send(JSON.stringify({ type: 'auth', token }));
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WSEvent;
        const payload = data.payload as
          | { connected?: boolean; pong?: boolean }
          | undefined;
        // Any pong clears the in-flight heartbeat — the socket is alive.
        if (data.type === 'connection:status' && payload?.pong) {
          this.awaitingPong = false;
          return;
        }
        // The server emits connection:status {connected:true} only
        // after auth succeeds. That's our signal to resubscribe.
        if (
          data.type === 'connection:status' &&
          payload?.connected &&
          !this.authenticated
        ) {
          this.authenticated = true;
          for (const workspaceId of this.subscribedWorkspaces) {
            this.send({ type: 'subscribe', workspaceId });
          }
          if (this.debugFilter !== undefined) {
            this.send({ type: 'debug:filter', owner: this.debugFilter });
          }
        }
        this.emit(data.type, data.payload);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.authenticated = false;
      this.stopHeartbeat();
      this.emit('connection:status', { connected: false });
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // The browser Event carries no diagnostics ("[object Event]") —
      // describe the socket state instead. console.error becomes a PostHog
      // $exception via autocapture, so it's reserved for a REAL outage: the
      // connection still failing on the 3rd+ reconnect attempt (~7s of
      // backoff). Single-blip drops — every backend deploy disconnects each
      // client once — stay at console.warn and never reach error tracking.
      // errorLoggedSinceOpen keeps it to one $exception per outage (an
      // extended outage used to flood the project with one identical event
      // per retry).
      const detail = `WebSocket error on ${getWebSocketUrl()} (readyState=${this.ws?.readyState}, reconnectAttempts=${this.reconnectAttempts})`;
      if (this.reconnectAttempts >= 3 && !this.errorLoggedSinceOpen) {
        this.errorLoggedSinceOpen = true;
        console.error(detail);
      } else {
        console.warn(detail);
      }
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
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

  /**
   * Admin Debug panel: tell the server which account's debug events to stream
   * to this client (account id, 'system', 'all', or undefined for all). The
   * server only fans matching events to us, so a single-user filter doesn't
   * pull everyone's traffic over the wire.
   */
  setDebugFilter(owner: string | undefined): void {
    this.debugFilter = owner;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'debug:filter', owner: owner ?? null });
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
    // Already a reconnect queued — don't stack timers (focus/online events
    // and an onclose can all fire near-simultaneously).
    if (this.reconnectTimer) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /**
   * Heartbeat: ping the server every interval. If a tick fires while the
   * previous ping is still unanswered, the socket is half-open (laptop slept,
   * backend was killed without a clean close) — terminate it so onclose runs
   * and the backoff loop reconnects.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.lastTickAt = Date.now();
    this.heartbeatTimer = window.setInterval(() => {
      const now = Date.now();
      const sinceLastTick = now - this.lastTickAt;
      this.lastTickAt = now;
      if (this.ws?.readyState !== WebSocket.OPEN) return;

      // A tick that arrived far too late tells us the TIMER was suspended,
      // not that the socket is unhealthy — so it must not be used as
      // evidence either way. Re-ping and judge on the next one. Without
      // this, returning to a backgrounded tab reliably killed a perfectly
      // good socket and started reconnect churn: the old check simply read
      // "a tick fired while awaitingPong" as proof of death.
      if (sinceLastTick > HEARTBEAT_INTERVAL_MS * THROTTLED_TICK_FACTOR) {
        this.awaitingPong = true;
        this.pingSentAt = now;
        this.send({ type: 'ping' });
        return;
      }

      if (this.awaitingPong) {
        // Wall clock, not "one tick has passed".
        if (now - this.pingSentAt < PONG_TIMEOUT_MS) return;
        console.warn('WebSocket heartbeat missed; reconnecting');
        this.awaitingPong = false;
        this.ws.close();
        return;
      }

      this.awaitingPong = true;
      this.pingSentAt = now;
      this.send({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingPong = false;
  }

  /**
   * Reconnect immediately when the app comes back to life, instead of waiting
   * out the backoff. Bound once, lazily, the first time we connect.
   *
   * A hidden browser tab is the case that forces this. Browsers throttle
   * background `setInterval` to at best once a minute and freeze it outright
   * for a bfcached page, so the heartbeat below cannot keep a backgrounded
   * socket honest — the socket will die and the ping that was supposed to
   * notice won't run. Rather than fight the throttle, we accept the drop and
   * make coming back fast and certain:
   *
   *   focus            — desktop window refocused, tab reselected
   *   visibilitychange — tab shown again (fires when `focus` does not, e.g.
   *                      switching back to an already-focused window)
   *   pageshow         — restored from bfcache, where timers were frozen
   *                      wholesale and the socket is almost certainly stale
   *   online           — network came back
   */
  private bindLifecycle(): void {
    if (this.lifecycleBound || typeof window === 'undefined') return;
    this.lifecycleBound = true;
    const wake = () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Looks open — but after a freeze or sleep "open" is exactly what a
        // half-open socket looks like, and its onclose may never fire. Ping
        // now; a missing pong trips the zombie check on the next tick.
        this.probeLiveness();
        return;
      }
      if (this.ws?.readyState === WebSocket.CONNECTING) return;
      // Cancel any pending backoff timer and retry now from a clean slate.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
      void this.connect();
    };
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') wake();
      });
    }
  }

  /**
   * Force an immediate liveness check on a socket we believe is open, and
   * restart the heartbeat cadence from now. Used on wake, where the interval
   * timer may have been throttled or frozen for minutes.
   */
  private probeLiveness(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.awaitingPong) {
      // A ping was already outstanding across the sleep/hide. Nothing came
      // back, so stop trusting this socket and let onclose → backoff run.
      this.awaitingPong = false;
      this.ws.close();
      return;
    }
    this.startHeartbeat();
    this.awaitingPong = true;
    this.pingSentAt = Date.now();
    this.send({ type: 'ping' });
  }
}

// Billing — plan status, hosted checkout, hosted customer portal.
export const billing = {
  status: () => request<BillingStatus>('GET', '/billing/status'),
  checkout: (data: CreateCheckoutRequest) =>
    request<CheckoutSessionResponse>('POST', '/billing/checkout', data),
  portal: () => request<CheckoutSessionResponse>('POST', '/billing/portal'),
  orders: () => request<BillingOrder[]>('GET', '/billing/orders'),
  invoice: (orderId: string) =>
    request<CheckoutSessionResponse>('POST', `/billing/orders/${orderId}/invoice`),
};

// ============================================================================
// Admin (admin.talyn.dev — the operator console)
// ============================================================================
//
// Cross-tenant and admin-gated server-side. Read endpoints only for now;
// mutations land with the audit service behind them.
//
// Nothing here sends an `actor` field. fleetd requires one on every mutating
// call, but the backend fills it from req.user — a client-supplied actor on an
// audit log is a field an attacker gets to write. Do not "helpfully" add it.

function adminQuery(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

const adminFleet = {
  /**
   * The host list. `live=false` skips dialling entirely and answers from the
   * registry, which is what the list should render first — a page that waits
   * on N tailnet round trips before showing anything is a page you cannot use
   * during the incident you opened it for.
   */
  hosts: (opts?: { live?: boolean }) =>
    request<AdminFleetHost[]>('GET', `/admin/fleet/hosts${adminQuery({ live: opts?.live })}`),
  host: (name: string) =>
    request<AdminFleetHostDetail>('GET', `/admin/fleet/hosts/${encodeURIComponent(name)}`),
  /** fleetd's Prometheus scrape, passed through as text. */
  metrics: (name: string) =>
    rawRequest('GET', `/admin/fleet/hosts/${encodeURIComponent(name)}/metrics`, {
      accept: 'text/plain',
    }).then((r) => r.text()),
  runs: (params?: { host?: string; status?: string; limit?: number; before?: string }) =>
    request<AdminRunIndex>('GET', `/admin/fleet/runs${adminQuery({ ...params })}`),
  run: (host: string, runId: string) =>
    request<AdminRunDetail>(
      'GET',
      `/admin/fleet/hosts/${encodeURIComponent(host)}/runs/${encodeURIComponent(runId)}`
    ),
  events: (host: string, runId: string, params?: { after?: number; limit?: number }) =>
    request<AdminRunEventPage>(
      'GET',
      `/admin/fleet/hosts/${encodeURIComponent(host)}/runs/${encodeURIComponent(
        runId
      )}/events${adminQuery({ ...params })}`
    ),
  goldens: (name: string) =>
    request<AdminGoldensView>('GET', `/admin/fleet/hosts/${encodeURIComponent(name)}/goldens`),
  rebakeStatus: (name: string) =>
    request<AdminRebakeStatus>(
      'GET',
      `/admin/fleet/hosts/${encodeURIComponent(name)}/goldens/rebake`
    ),
  incidents: () => request<AdminIncident[]>('GET', '/admin/fleet/incidents'),

  // Mutations. Each is addressed to ONE named host — a fan-out with a single
  // shared reason produces N audit rows from one click with no way to tell
  // which host accepted it. None of these sends `actor`: the backend fills it
  // from req.user, because a client-supplied actor on an audit log is a field
  // an attacker gets to write.
  drain: (host: string, body: AdminDrainRequest) =>
    request<{ draining: boolean }>(
      'POST',
      `/admin/fleet/hosts/${encodeURIComponent(host)}/drain`,
      body
    ),
  cancelRun: (host: string, runId: string, body: AdminMutationRequest) =>
    request<{ cancelled: boolean }>(
      'POST',
      `/admin/fleet/hosts/${encodeURIComponent(host)}/runs/${encodeURIComponent(runId)}/cancel`,
      body
    ),
  goldensGc: (host: string, body: AdminGoldenGcRequest) =>
    request<AdminGcResult>(
      'POST',
      `/admin/fleet/hosts/${encodeURIComponent(host)}/goldens/gc`,
      body
    ),
  goldensPin: (host: string, body: AdminGoldenPinRequest) =>
    request<{ path: string; pinned: boolean }>(
      'POST',
      `/admin/fleet/hosts/${encodeURIComponent(host)}/goldens/pin`,
      body
    ),
  goldensDelete: (host: string, body: AdminGoldenDeleteRequest) =>
    request<AdminGoldenDeleteResult>(
      'POST',
      `/admin/fleet/hosts/${encodeURIComponent(host)}/goldens/delete`,
      body
    ),
  goldensRebake: (host: string, body: AdminGoldenRebakeRequest) =>
    request<Record<string, unknown>>(
      'POST',
      `/admin/fleet/hosts/${encodeURIComponent(host)}/goldens/rebake`,
      body
    ),

  /**
   * Follow a run's transcript live.
   *
   * `fetch` + ReadableStream, NOT `EventSource`. EventSource cannot set an
   * Authorization header, and the alternative — putting the JWT in the query
   * string — is the thing the WS auth path already refuses to do, because
   * tokens in URLs land in access logs and the edge proxy's request log.
   *
   * Resolves when the run goes terminal, the stream ends, or `signal` aborts.
   * A broken stream is not fatal: the caller still has the cursor endpoint and
   * can resume from `frame.cursor`.
   */
  async followRun(
    host: string,
    runId: string,
    opts: {
      after?: number;
      signal: AbortSignal;
      onFrame: (frame: AdminRunEventPage) => void;
    }
  ): Promise<void> {
    const resp = await rawRequest(
      'GET',
      `/admin/fleet/hosts/${encodeURIComponent(host)}/runs/${encodeURIComponent(
        runId
      )}/stream${adminQuery({ after: opts.after })}`,
      { accept: 'text/event-stream', signal: opts.signal }
    );
    if (!resp.body) return;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseJsonParser<AdminRunEventPage>();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          opts.onFrame(frame);
          if (frame.terminal) return;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  },
};

export const admin = {
  /**
   * Whether the caller is an operator, and what this deploy lets them do.
   *
   * Deliberately NOT admin-gated server-side: it answers `{admin:false}` rather
   * than 403 so the console can render "this is for Talyn operators" instead of
   * an error page. It is the only admin call a non-admin's browser ever makes.
   */
  me: () => request<AdminAccess>('GET', '/admin/me'),
  fleet: adminFleet,
  users: {
    list: (params?: { q?: string; plan?: string; admin?: boolean; limit?: number; before?: string }) =>
      request<AdminPage<AdminUserSummary>>('GET', `/admin/users${adminQuery({ ...params })}`),
    get: (id: string) => request<AdminUserDetail>('GET', `/admin/users/${encodeURIComponent(id)}`),
    /**
     * Comp an account, or take a comp away.
     *
     * `confirm` must be the TARGET's email — the "type the repo name to
     * delete it" pattern, which makes a mis-clicked row or a blind cross-site
     * POST unexecutable because either would have to already know which
     * account it meant.
     */
    setPlanOverride: (id: string, body: AdminPlanOverrideRequest) =>
      request<{ plan: string; planOverride: string | null }>(
        'POST',
        `/admin/users/${encodeURIComponent(id)}/plan-override`,
        body
      ),
    /** Grant or revoke operator access. 403s unless the deploy opts in. */
    setAdmin: (id: string, body: AdminGrantRequest) =>
      request<{ isAdmin: boolean }>('POST', `/admin/users/${encodeURIComponent(id)}/admin`, body),
  },
  workspaces: {
    list: (params?: { q?: string; ownerId?: string; limit?: number; before?: string }) =>
      request<AdminPage<AdminWorkspaceSummary>>(
        'GET',
        `/admin/workspaces${adminQuery({ ...params })}`
      ),
    get: (id: string) =>
      request<AdminWorkspaceDetail>('GET', `/admin/workspaces/${encodeURIComponent(id)}`),
  },
  tasks: {
    list: (params?: {
      ownerId?: string;
      workspaceId?: string;
      status?: string;
      provider?: string;
      host?: string;
      limit?: number;
      before?: string;
    }) => request<AdminPage<AdminTaskSummary>>('GET', `/admin/tasks${adminQuery({ ...params })}`),
    /** `transcript: true` is audited server-side — it is another tenant's
     *  agent conversation, and recording the access is what makes it OK. */
    get: (id: string, opts?: { transcript?: boolean }) =>
      request<AdminTaskDetail>(
        'GET',
        `/admin/tasks/${encodeURIComponent(id)}${adminQuery({ transcript: opts?.transcript })}`
      ),
    /** Put a stuck task back in the queue, with a fresh cloud run. */
    retry: (id: string, body: AdminMutationRequest) =>
      request<{ status: string }>('POST', `/admin/tasks/${encodeURIComponent(id)}/retry`, body),
    /** Stop a running task. The remote cancel is best-effort; the response
     *  says whether it landed, because the run may still open a PR. */
    kill: (id: string, body: AdminMutationRequest) =>
      request<{ status: string; remoteCancelled: boolean }>(
        'POST',
        `/admin/tasks/${encodeURIComponent(id)}/kill`,
        body
      ),
  },
  audit: {
    list: (params?: {
      actorId?: string;
      action?: string;
      targetKind?: string;
      targetId?: string;
      limit?: number;
      before?: string;
    }) => request<AdminPage<AdminAuditEntry>>('GET', `/admin/audit${adminQuery({ ...params })}`),
  },
};

// Account-level self-service.
export const users = {
  /**
   * Wipe the calling account: every owned workspace (and everything under
   * it), the user row, and the auth user. Developer tool — the caller is
   * expected to clear local state and reload afterwards.
   */
  wipeMe: () => request<void>('DELETE', '/users/me'),
};

// Singleton instance
export const wsClient = new WebSocketClient();

// ============================================================================
// Combined API export
// ============================================================================

export const api = {
  workspaces,
  environments,
  tasks,
  github,
  posthog,
  cloudProviders,
  repositories,
  pullRequests,
  skills,
  mcpTokens,
  debug,
  billing,
  users,
  admin,
  ws: wsClient,
};
