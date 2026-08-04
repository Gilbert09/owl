// The operator console's contract (admin.talyn.dev ⇄ /api/v1/admin).
//
// Split out of index.ts because this surface is cross-tenant and nothing in
// the product apps should reach for it by accident — a separate file makes
// "why is apps/web importing AdminUserSummary?" a visible question in review.
//
// Everything here is JSON-over-the-wire, so timestamps are ISO strings rather
// than Dates. The backend's own view types (FleetHostView, the Drizzle row
// types) stay in the backend; these are what actually crosses the boundary.

// ============================================================================
// Access
// ============================================================================

/**
 * What a mutation the deploy actually permits.
 *
 * Reported by `GET /admin/me` so the console can hide a button the server will
 * refuse, rather than showing it and failing on click. NOT a permission model —
 * the server checks these itself on every call; this is the UI's copy.
 */
export type AdminCapability =
  | 'fleet.read'
  | 'fleet.mutate'
  | 'product.read'
  | 'product.comp'
  | 'product.grant_admin'
  | 'product.task_mutate';

export interface AdminAccess {
  admin: boolean;
  email: string | null;
  capabilities: AdminCapability[];
}

// ============================================================================
// Audit
// ============================================================================

/**
 * Every action the audit log records.
 *
 * This union IS the `admin_audit_log.action` column's contract — the column is
 * plain text, so this is the only place the vocabulary is written down. Adding
 * a mutation means adding a member here first.
 */
export type AdminAuditAction =
  | 'fleet.drain'
  | 'fleet.run.cancel'
  | 'fleet.golden.gc'
  | 'fleet.golden.pin'
  | 'fleet.golden.rebake'
  | 'user.plan_override'
  | 'user.admin'
  | 'task.retry'
  | 'task.kill'
  // The one READ we audit: another tenant's agent conversation is the most
  // sensitive thing this console can show, and recording the access is what
  // makes showing it defensible.
  | 'task.transcript.read';

export type AdminAuditTargetKind = 'host' | 'run' | 'golden' | 'user' | 'workspace' | 'task';

/**
 * 'pending' means we wrote the row and then dialled out. A row STUCK on
 * pending is itself the signal — we started something and never learned how it
 * ended, which is exactly the state a crash mid-drain leaves behind.
 */
export type AdminAuditOutcome = 'pending' | 'ok' | 'error';

export interface AdminAuditEntry {
  id: string;
  at: string;
  actorId: string;
  actorEmail: string;
  action: AdminAuditAction;
  targetKind: AdminAuditTargetKind;
  targetId: string;
  reason: string;
  params: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  outcome: AdminAuditOutcome;
  error: string | null;
  durationMs: number | null;
}

// ============================================================================
// Requests
// ============================================================================

/** Every mutating admin request carries a reason. Enforced server-side. */
export interface AdminMutationRequest {
  reason: string;
}

/**
 * The two escalation mutations additionally require typing the TARGET's email.
 *
 * The "type the repo name to delete it" pattern: no new server state, no TTL,
 * and it makes a mis-clicked table row or a blind cross-site POST unexecutable,
 * because either would have to already know which specific account it meant.
 */
export interface AdminConfirmRequest extends AdminMutationRequest {
  confirm: string;
}

/** Bounds shared by every paginated admin list. */
export const ADMIN_PAGE_LIMIT_DEFAULT = 50;
export const ADMIN_PAGE_LIMIT_MAX = 100;
/** Shorter than this and an `ilike` scan is just "return everything, slowly". */
export const ADMIN_SEARCH_MIN_LENGTH = 2;
/** Long enough to say why; short enough that the column is not a document store. */
export const ADMIN_REASON_MAX_LENGTH = 500;

export interface AdminPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

// ============================================================================
// Error codes
// ============================================================================
//
// Exported as consts, mirroring TASK_LIMIT_ERROR_CODE, so the console branches
// on `code` and never on a message string. A message is copy; a code is API.

export const ADMIN_REASON_REQUIRED = 'reason_required';
export const ADMIN_SELF_MUTATION_FORBIDDEN = 'self_mutation_forbidden';
export const ADMIN_CONFIRM_MISMATCH = 'confirm_mismatch';
export const ADMIN_GRANT_DISABLED = 'admin_grant_disabled';
export const ADMIN_LAST_ADMIN = 'last_admin';
export const ADMIN_HOST_UNKNOWN = 'host_unknown';
export const ADMIN_HOST_OFFLINE = 'host_offline';
export const ADMIN_HOST_NOT_DIALABLE = 'host_not_dialable';
export const ADMIN_FLEET_NOT_CONFIGURED = 'fleet_not_configured';
export const ADMIN_FLEET_UNREACHABLE = 'fleet_unreachable';

// ============================================================================
// Fleet
// ============================================================================

/** Why a live read of a host failed. `unreachable` is by far the common one. */
export type AdminFleetLiveErrorCode =
  | typeof ADMIN_HOST_OFFLINE
  | typeof ADMIN_HOST_NOT_DIALABLE
  | typeof ADMIN_FLEET_NOT_CONFIGURED
  | typeof ADMIN_FLEET_UNREACHABLE;

/** fleetd's `GET /v1/capacity`. */
export interface AdminFleetCapacity {
  draining: boolean;
  runsLive: number;
  runsMax: number;
  memReservedMib: number;
  memBudgetMib: number;
  accepting: boolean;
}

/**
 * fleetd's metrics snapshot, passed through whole.
 *
 * Deliberately loose: the fleet ships on its own cadence and adding a counter
 * there must not need a release here. The console reads known keys defensively
 * and renders the rest generically.
 */
export type AdminFleetMetrics = Record<string, unknown>;

/**
 * A host row.
 *
 * `live` is null whenever we could not or would not dial — and `liveError`
 * says which. That pairing is the whole degradation contract: the fleet page is
 * the page you open BECAUSE a host is misbehaving, so a dead box must render as
 * a row with a reason, never as a failed request.
 */
export interface AdminFleetHost {
  name: string;
  apiEndpoint: string | null;
  version: string | null;
  reportedAt: string;
  draining: boolean;
  runsLive: number;
  runsMax: number;
  memReservedMib: number;
  memBudgetMib: number;
  diskFreeMib: number;
  maxIdleSeconds: number;
  /** Derived from reportedAt: false once the host stops reporting. */
  online: boolean;
  /** Online, not draining, has capacity, and advertised somewhere to dial. */
  dispatchable: boolean;
  live: AdminFleetCapacity | null;
  liveError: string | null;
  liveErrorCode: AdminFleetLiveErrorCode | null;
}

export interface AdminFleetHostDetail extends AdminFleetHost {
  /** The registry's last stored snapshot — present even when the host is down. */
  metrics: AdminFleetMetrics | null;
  /** Fresh from the host when reachable; null otherwise. */
  liveMetrics: AdminFleetMetrics | null;
  runsByStatus: Record<string, number> | null;
}

export type AdminRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * A run, joined from two sources that each know something the other doesn't.
 *
 * The fleet's own run store is IN-MEMORY (plus a per-run JSON ledger for crash
 * adoption), so run history dies with the process. The durable record is the
 * `tasks` row. Neither alone answers "what is happening on the fleet":
 *
 *   - `orphan: true` — live on a host with no task behind it. A microVM burning
 *     memory for nobody, and the single most valuable thing this page surfaces.
 *   - `live: null` on a non-terminal task — the task believes it is running and
 *     the host has never heard of it. Usually a fleetd restart.
 */
export interface AdminRunRow {
  runId: string;
  host: string | null;
  taskId: string | null;
  workspaceId: string | null;
  ownerEmail: string | null;
  repo: string | null;
  status: AdminRunStatus | null;
  phase: string | null;
  adopted: boolean;
  slot: number | null;
  goldenLayer: string | null;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  deadline: string | null;
  lastHeartbeat: string | null;
  lastActivity: string | null;
  costUsd: number | null;
  prUrl: string | null;
  error: string | null;
  orphan: boolean;
}

/**
 * The runs page: durable rows, plus which hosts we could not reach.
 *
 * `degraded` is not decoration. Without it a fan-out that lost a host
 * under-reports silently, and an operator reads a short list as "the fleet is
 * idle" rather than "we could not ask one of the boxes".
 */
export interface AdminRunIndex {
  items: AdminRunRow[];
  nextCursor: string | null;
  degraded: Array<{ host: string; error: string }>;
}

/** One run, as the host currently sees it. */
export interface AdminRunDetail {
  run: AdminRunRow;
  terminal: boolean;
}

/** One transcript entry. `seq` is assigned host-side, not by the guest. */
export interface AdminRunEvent {
  seq: number;
  at: string;
  event: Record<string, unknown>;
}

export interface AdminRunEventPage {
  events: AdminRunEvent[];
  cursor: number;
  terminal: boolean;
}

/** A baked image. `diskBytes` is reflink-aware and is the one that bills. */
export interface AdminGolden {
  key: string;
  path: string;
  layer: 'base' | 'repo';
  contentSha: string | null;
  repoSlug: string | null;
  baseBranch: string | null;
  repoCommit: string | null;
  packageManager: string | null;
  builtAt: string | null;
  apparentBytes: number;
  diskBytes: number;
  inUse: boolean;
  operatorPinned: boolean;
  selectable: boolean;
}

export interface AdminGoldensView {
  goldens: AdminGolden[];
  baseGolden: string | null;
  baseOsSha: string | null;
  freePct: number | null;
}

/**
 * What a golden GC actually did.
 *
 * `triggered` is the field that matters. The fleet's GC is DISK-PRESSURE
 * driven: below `force` it only evicts when free space is under the low-water
 * mark (15%), so on a healthy disk it correctly removes nothing. Reporting
 * "GC complete" for that — which the console did at first — reads as "your
 * images are gone" when they are all still there.
 */
export interface AdminGcResult {
  freePctBefore: number;
  freePctAfter: number;
  /** False when the disk was above the threshold, so nothing was considered. */
  triggered: boolean;
  removed: string[];
  /**
   * Blocks the evicted images actually occupied, not their apparent size. A
   * golden sharing all its extents with another reclaims nothing, and
   * reporting its apparent size would make a GC that achieved nothing look
   * like it had worked.
   */
  freedBytes: number;
  protected: number;
  candidates: number;
}

export interface AdminRebakeStatus {
  slug: string | null;
  baseBranch: string | null;
  actor: string | null;
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/**
 * A derived operator signal. NOT a stored table.
 *
 * Every one of these is already a counter in the fleet's metrics snapshot;
 * materialising them would mean a second source of truth that can disagree with
 * the host it describes. The console computes them per request instead.
 */
export type AdminIncidentKind =
  | 'admission_rejection'
  | 'run_failure'
  | 'reaper_orphan'
  | 'wedged_run'
  | 'egress_denied'
  | 'golden_stale'
  | 'rebake_failure'
  | 'host_offline'
  | 'host_draining';

export type AdminIncidentSeverity = 'info' | 'warn' | 'critical';

export interface AdminIncident {
  kind: AdminIncidentKind;
  severity: AdminIncidentSeverity;
  host: string | null;
  /** e.g. the admission reason (`mem`, `max_runs`) or the failure reason. */
  detail: string | null;
  count: number;
  observedAt: string;
}

// ============================================================================
// Fleet mutation bodies
// ============================================================================
//
// `actor` is absent from every one of these ON PURPOSE. fleetd requires it, but
// the backend fills it from req.user — a client-supplied actor on an audit log
// is a field an attacker gets to write.

export interface AdminDrainRequest extends AdminMutationRequest {
  draining: boolean;
}

export interface AdminGoldenGcRequest extends AdminMutationRequest {
  force?: boolean;
  dryRun?: boolean;
  minAge?: string;
}

export interface AdminGoldenPinRequest extends AdminMutationRequest {
  path: string;
  pinned: boolean;
}

export interface AdminGoldenRebakeRequest extends AdminMutationRequest {
  repo: string;
  baseBranch: string;
}

// ============================================================================
// Product
// ============================================================================

export type AdminPlan = 'free' | 'unlimited';

export interface AdminUserSummary {
  id: string;
  email: string;
  githubUsername: string | null;
  isAdmin: boolean;
  /** Written exclusively by Polar webhooks. */
  plan: AdminPlan;
  /** The manual comp flag. Wins over `plan` when set. */
  planOverride: AdminPlan | null;
  /** plan_override ?? plan — what entitlement checks actually use. */
  effectivePlan: AdminPlan;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  workspaceCount: number;
}

export interface AdminUserDetail extends AdminUserSummary {
  updatedAt: string;
  /** Only on the detail read — a Polar id in a list view is a liability with
   *  no read use, and it is exactly what a support escalation needs here. */
  polarCustomerId: string | null;
  polarSubscriptionId: string | null;
  subscriptionEventAt: string | null;
  activeTaskCount: number;
  workspaces: AdminWorkspaceSummary[];
}

export interface AdminWorkspaceSummary {
  id: string;
  ownerId: string;
  ownerEmail: string | null;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminWorkspaceDetail extends AdminWorkspaceSummary {
  repositoryCount: number;
  taskCount: number;
  activeTaskCount: number;
  /** Provider types with credentials configured. Never the credentials. */
  providers: string[];
}

export interface AdminTaskSummary {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  ownerEmail: string | null;
  type: string;
  status: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Derived in SQL from metadata.cloudTask so the jsonb never ships. */
  provider: string | null;
  remoteRunId: string | null;
  cloudStatus: string | null;
  fleetHost: string | null;
  phase: string | null;
  costUsd: number | null;
}

export interface AdminTaskDetail extends AdminTaskSummary {
  prompt: string | null;
  repositoryId: string | null;
  branch: string | null;
  error: string | null;
  prUrl: string | null;
  /** Present only with ?transcript=1, and that read is audited. */
  transcript: unknown[] | null;
}

export interface AdminPlanOverrideRequest extends AdminConfirmRequest {
  planOverride: AdminPlan | null;
}

export interface AdminGrantRequest extends AdminConfirmRequest {
  isAdmin: boolean;
}
