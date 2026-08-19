// Drizzle schema for FastOwl's Postgres database.
//
// This is the source of truth for the schema — hand-rolled SQLite migrations
// (001-007) are being retired in favor of drizzle-kit's generated migrations.
// When adding a column, add it here, then `npm run db:generate` to produce
// the next SQL migration.
//
// Type choices:
//   - text for IDs: we generate UUIDs via `uuid()` in code and keep them as
//     strings so the same id flows through websocket messages etc.
//   - jsonb for structured payloads (settings, config, metadata, result,
//     actions). Query-able + indexable when we need it.
//   - timestamp with time zone for all dates. Postgres default.
//   - boolean for flags. No more 0/1 int masquerading as boolean.

import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  bigserial,
  doublePrecision,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ---------- Users ----------
//
// Mirror of Supabase's `auth.users`, keyed by the same UUID. We never write
// to `auth.users` directly — Supabase owns it — but we store our own row
// per authenticated user so we can FK ownership columns against it and hang
// app-specific fields (github_username, preferences) off it later.
//
// Rows are upserted by the JWT-verifying middleware on the first request
// after sign-in.

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(), // == auth.users.id (uuid)
    email: text('email').notNull(),
    githubUsername: text('github_username'),
    // Gates the developer Debug panel + its WS stream, which expose backend
    // internals across all accounts. Off by default.
    isAdmin: boolean('is_admin').notNull().default(false),
    // ---- Billing (Polar) ----
    // `plan` is driven exclusively by Polar webhooks; `plan_override` is the
    // manual comp flag (set via SQL, never touched by webhooks) and wins when
    // present. Entitlement checks read effective plan = plan_override ?? plan.
    plan: text('plan').notNull().default('free'), // 'free' | 'unlimited'
    planOverride: text('plan_override'), // 'free' | 'unlimited' | null
    polarCustomerId: text('polar_customer_id'),
    polarSubscriptionId: text('polar_subscription_id'),
    subscriptionStatus: text('subscription_status'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    // Timestamp of the last-applied Polar event for this subscription —
    // out-of-order webhook deliveries older than this are ignored.
    subscriptionEventAt: timestamp('subscription_event_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Fallback webhook→user mapping when an event lacks our external id.
    polarCustomerIdx: index('idx_users_polar_customer').on(t.polarCustomerId),
  })
);

// ---------- Billing events (webhook audit + idempotency) ----------
//
// One row per Polar webhook delivery, keyed by the standard-webhooks
// `webhook-id` header. The insert-or-conflict on this table is the webhook
// handler's idempotency gate; `applied` records whether the event mutated a
// users row (false for ignored types, stale out-of-order events, and events
// we couldn't map to a user). Backend-pool-only surface: RLS is enabled with
// no `authenticated` policy (0025 mcp_tokens precedent), so JWT connections
// can never read it. `user_id` has no FK on purpose — the audit trail must
// survive an account wipe.
export const billingEvents = pgTable('billing_events', {
  eventId: text('event_id').primaryKey(),
  eventType: text('event_type').notNull(),
  subscriptionId: text('subscription_id'),
  userId: text('user_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  applied: boolean('applied').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- Admin audit log (operator console) ----------
//
// One row per mutating action taken from admin.talyn.dev — and per read of
// another tenant's task transcript, which is the single most sensitive read
// on that surface. `is_admin` used to gate a read-only debug panel; it now
// gates draining a fleet host, comping an account and granting admin, and
// what makes that defensible is being able to answer "who, when, why"
// afterwards.
//
// Same backend-pool-only posture as billing_events: RLS on, no policy, no
// grant, so a JWT connection can never read it. `actor_id` has no FK and
// `actor_email` is denormalised so the trail outlives an account wipe and
// still names a person afterwards. See 0039 for the two write shapes
// (pending-then-settle for remote calls, one transaction for local ones).
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: text('id').primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: text('actor_id').notNull(),
    actorEmail: text('actor_email').notNull(),
    // The AdminAuditAction union in @talyn/shared is this column's contract.
    action: text('action').notNull(),
    targetKind: text('target_kind').notNull(), // host|run|golden|user|workspace|task
    targetId: text('target_id').notNull(),
    reason: text('reason').notNull(),
    params: jsonb('params'),
    before: jsonb('before'),
    after: jsonb('after'),
    outcome: text('outcome').notNull(), // 'pending' | 'ok' | 'error'
    error: text('error'),
    durationMs: integer('duration_ms'),
    requestId: text('request_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => ({
    atIdx: index('idx_admin_audit_at').on(t.at),
    actorIdx: index('idx_admin_audit_actor').on(t.actorId, t.at),
    targetIdx: index('idx_admin_audit_target').on(t.targetKind, t.targetId, t.at),
  })
);

// ---------- Workspaces ----------

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    logo: jsonb('logo'),
    settings: jsonb('settings').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index('idx_workspaces_owner').on(t.ownerId),
  })
);

// ---------- Repositories ----------

export const repositories = pgTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('idx_repositories_workspace').on(t.workspaceId),
  })
);

// ---------- Integrations ----------

export const integrations = pgTable(
  'integrations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceTypeUq: uniqueIndex('uq_integrations_workspace_type').on(t.workspaceId, t.type),
  })
);

// ---------- PostHog OAuth (PKCE) states ----------
//
// In-flight authorization codes for the PostHog Code OAuth connect flow. In
// Postgres rather than a process-local Map (which is what the older GitHub App
// flow uses) because the row holds the PKCE `code_verifier`: every deploy runs
// two instances at once, and a callback landing on the instance that didn't mint
// the state would have no way to redeem the code. Single-use and short-lived —
// PostHog expires the authorization code itself after 5 minutes.
export const posthogOauthStates = pgTable(
  'posthog_oauth_states',
  {
    /** The opaque `state` parameter — and the whole CSRF defence. */
    state: text('state').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Who consented. The callback carries no session, so this row is the only
     *  record of that, and it's who the cloud environment gets provisioned for. */
    userId: text('user_id').notNull(),
    /** PKCE verifier, encrypted (services/tokenCrypto.ts): useless alone, but it
     *  completes the exchange if paired with a leaked authorization code. */
    codeVerifierEnc: jsonb('code_verifier_enc').notNull(),
    /** The instance being authorized, pinned at start so the callback can't
     *  redirect the token exchange somewhere else. */
    host: text('host').notNull(),
    /** 'web' | 'desktop' — chooses how the flow ends, recorded server-side. */
    client: text('client').notNull().default('desktop'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresAtIdx: index('idx_posthog_oauth_states_expires_at').on(t.expiresAt),
  })
);

// ---------- GitHub App installations ----------
//
// App-owned, NOT workspace-scoped: a single GitHub App installation (on a user
// or org) can back PRs across many workspaces/owners, and one webhook delivery
// must resolve its installation without a per-workspace scan. `installationId`
// is GitHub's numeric id, stored as text per the IDs-are-text convention.
// `repoFullNames` is the App's selected-repo allowlist for this installation —
// the webhook receiver's cheap ownership filter reads it to drop deliveries for
// repos nobody watches. `suspendedAt` set ⇒ delivery is dropped+acked (pause
// for inactive accounts, or GitHub-side suspension). No RLS: this is global
// infrastructure read by the webhook pipeline running as the privileged pool.
export const githubInstallations = pgTable('github_installations', {
  installationId: text('installation_id').primaryKey(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(), // 'User' | 'Organization'
  repoFullNames: jsonb('repo_full_names').notNull().default([]),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- Environments ----------

// A cloud-only environment is a secret-free marker, one per connected
// cloud provider (auto-provisioned on integration connect). It carries no
// daemon state — the `type` (a CloudProviderType) is all a task needs to
// resolve its provider; per-workspace credentials live on `integrations`.
export const environments = pgTable(
  'environments',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // CloudProviderType: 'posthog_code' + 'claude_code' (live), 'codex_cloud'
    // (deferred). See docs/CLOUD_PROVIDERS.md.
    type: text('type').notNull(),
    status: text('status').notNull().default('connected'),
    config: jsonb('config').notNull(),
    lastConnected: timestamp('last_connected', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index('idx_environments_owner').on(t.ownerId),
  })
);

// ---------- Tasks ----------

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'code_writing' | 'pr_response' | 'pr_review'
    status: text('status').notNull().default('pending'),
    priority: text('priority').notNull().default('medium'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    prompt: text('prompt'),
    // The cloud-marker env this task is delegated to (resolves its
    // provider). `set null` if the marker is removed.
    assignedEnvironmentId: text('assigned_environment_id').references(
      () => environments.id,
      { onDelete: 'set null' }
    ),
    repositoryId: text('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    branch: text('branch'),
    /**
     * JSONL event log of `AgentEvent` objects (from @talyn/shared) —
     * the cloud run's transcript, ingested by the provider's streamer.
     */
    transcript: jsonb('transcript'),
    result: jsonb('result'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    workspaceIdx: index('idx_tasks_workspace').on(t.workspaceId),
    statusIdx: index('idx_tasks_status').on(t.status),
    repositoryIdx: index('idx_tasks_repository').on(t.repositoryId),
  })
);

// ---------- MCP tokens ----------
//
// Long-lived personal access tokens that authenticate the hosted MCP
// endpoint (`/api/v1/mcp`). Minted from the desktop "MCP server" settings
// page (gated behind the user's GitHub login) so a Claude client can drive
// FastOwl without pasting a short-lived Supabase JWT.
//
// We store only a SHA-256 hash of the token — the plaintext is shown to the
// user exactly once at creation. `token_prefix` is the human-readable head
// (e.g. `talyn_mcp_ab12`) kept for the settings list so a user can tell their
// tokens apart without us holding the secret.
export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    // The validate path looks tokens up by hash on the unscoped pool, so this
    // is the hot index. Unique so a hash collision can never authenticate two.
    tokenHashUq: uniqueIndex('uq_mcp_tokens_token_hash').on(t.tokenHash),
    ownerIdx: index('idx_mcp_tokens_owner').on(t.ownerId),
  })
);

// ---------- Global settings (key/value) ----------

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- Pull requests (DB-as-cache) ----------

/**
 * One row per user-authored open PR in a watched repo, plus any PR ever
 * opened by a task (kept after merge/close for filtering).
 *
 * This is a CACHE, not a source of truth — `last_polled_at` drives a
 * TTL the prCache layer enforces. Fresh row → return it; stale → fetch
 * from GitHub via the batched GraphQL helper, upsert, return.
 *
 * Only minimal fields are persisted. Per-check rows, file lists, and
 * raw GraphQL payloads are NOT stored — the detail-view tabs always
 * fetch fresh on open. Keeps row size bounded (~2 KB) and avoids an
 * "out of date forever" failure mode if the polling loop ever stalls.
 *
 * Event-cursor columns (`last_review_id`, etc.) survive backend restart
 * so review/comment/CI deltas don't false-fire after every deploy —
 * the in-memory state map the old prMonitor used baseline-reset on
 * boot, which is how a restart could lose unread events.
 */
export const pullRequests = pgTable(
  'pull_requests',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /**
     * Set when this PR was opened by a FastOwl task. Lets the task
     * screen pill render off this row, and lets the user filter
     * "merged PRs from my old tasks" on the GitHub page.
     */
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    state: text('state').notNull(), // 'open' | 'closed' | 'merged'
    /**
     * True when this PR is awaiting the connected user's review: they're a
     * requested reviewer (directly or via a team) AND haven't reviewed it
     * yet. The monitor reconciles this every poll, so it clears once the
     * user submits a review — which is what keeps an approved PR off the
     * GitHub page's "Review" list even when GitHub leaves a team review
     * request standing.
     */
    reviewRequested: boolean('review_requested').notNull().default(false),
    /**
     * True when the PR was opened by the connected user. Drives the "Mine"
     * tab independently of {@link reviewRequested} (a PR can be neither —
     * e.g. one the user already reviewed — and then belongs to neither tab).
     */
    authored: boolean('authored').notNull().default(false),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    /**
     * Drives the TTL: prCache returns this row if `last_polled_at` is
     * within the focused (30s) or unfocused (60s) window. Bumped on
     * every successful poll, regardless of whether anything changed.
     */
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Lightweight summary for instant rendering on the GitHub page +
     * task pill. Shape:
     *   {
     *     title, author, draft,
     *     headBranch, baseBranch, headSha, updatedAt,
     *     mergeable, mergeStateStatus, reviewDecision,
     *     blockingReason: 'mergeable' | 'merge_conflicts'
     *                   | 'changes_requested' | 'checks_failed'
     *                   | 'checks_failed_optional' | 'blocked' | 'unknown',
     *     checksTotal, checksPassed, checksFailed,
     *     checksInProgress, checksSkipped
     *   }
     */
    lastSummary: jsonb('last_summary').notNull().default({}),
    /**
     * When true, a background watcher keeps this PR mergeable: it repeatedly
     * fires a cloud "fix every blocker" run whenever the PR has a blocker and
     * no run is in flight, indefinitely — including conflicts that surface days
     * later. Survives backend restarts (the watch can span days).
     */
    autoKeepMergeable: boolean('auto_keep_mergeable').notNull().default(false),
    /**
     * Watcher bookkeeping for the runaway guard. Shape:
     *   {
     *     attempts: number,        // consecutive auto-runs that left it un-mergeable
     *     lastAutoTaskId?: string, // the run the watcher most recently launched
     *     accounted?: boolean,     // whether lastAutoTaskId's result was folded in
     *     pausedAt?: string        // ISO time we paused after 3 failed attempts
     *   }
     * `attempts` resets to 0 once the PR is observed mergeable, so a problem
     * that appears after a clean state gets a fresh batch of attempts.
     */
    autoMergeState: jsonb('auto_merge_state'),
    /**
     * When true, this PR is in the FastOwl merge queue: the merge-queue
     * processor merges it (per {@link mergeMethod}) as soon as it's clean,
     * serialized per (repo, base branch). On conflict / behind / blocked it
     * fires the same cloud "fix every blocker" run the watcher uses, then
     * merges. The PR drops off the queue once merged.
     */
    mergeQueued: boolean('merge_queued').notNull().default(false),
    /**
     * FIFO ordering within a (repo, base) group — oldest queued first. NULL
     * when not queued. A timestamp rather than an explicit position so
     * add / remove / drop-on-merge never renumbers siblings.
     */
    mergeQueuedAt: timestamp('merge_queued_at', { withTimezone: true }),
    /** Merge method used when this PR's turn comes. */
    mergeMethod: text('merge_method').notNull().default('squash'),
    /**
     * Processor bookkeeping. Shape:
     *   {
     *     attempts: number,        // consecutive fix-runs that left it un-mergeable
     *     lastFixTaskId?: string,  // the run the processor most recently launched
     *     accounted?: boolean,     // whether lastFixTaskId's result was folded in
     *     status: 'waiting' | 'fixing' | 'merging' | 'blocked',
     *     lastError?: string,
     *     lastErrorAt?: string
     *   }
     */
    mergeQueueState: jsonb('merge_queue_state'),
    // Event cursors — NULL until the first poll has populated them.
    lastReviewId: text('last_review_id'),
    lastReviewCommentId: text('last_review_comment_id'),
    lastCommentId: text('last_comment_id'),
    /**
     * Hash of `head_sha + sorted check states` — bumps whenever a
     * push lands or any check transitions. Cheaper than diffing the
     * whole rollup payload.
     */
    lastCheckDigest: text('last_check_digest'),
    /**
     * SHA-1 of the `last_summary` blob + the four event cursors. Lets the
     * poller skip re-writing the ~2 KB TOASTed `last_summary` (and its cursor
     * columns) when a poll produced byte-identical content — it then bumps only
     * the TTL timestamp, avoiding the WAL + TOAST churn that was depleting the
     * Supabase disk-IO budget. NULL until the first post-migration poll.
     */
    lastSummaryDigest: text('last_summary_digest'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One row per (workspace, repo, number). Upsert key for the
    // poller — same PR seen twice in one tick must not double-insert.
    workspaceRepoNumberUq: uniqueIndex('uq_pull_requests_workspace_repo_number').on(
      t.workspaceId,
      t.repositoryId,
      t.number
    ),
    workspaceIdx: index('idx_pull_requests_workspace').on(t.workspaceId),
    repositoryIdx: index('idx_pull_requests_repository').on(t.repositoryId),
    taskIdx: index('idx_pull_requests_task').on(t.taskId),
    // Drives the scheduler's "fetch the stalest PR first" policy.
    stateLastPolledIdx: index('idx_pull_requests_state_last_polled').on(
      t.state,
      t.lastPolledAt
    ),
  })
);

/**
 * Per-check state for the incremental check-count fast path. One row per
 * (repo, head commit, check name) — a re-run of a name upserts in place, so the
 * table is self-deduping (mirrors `dedupeLatestCheckByName`). Fed by `check_run`
 * webhooks; a PR's pill counts are derived from a `GROUP BY` here instead of a
 * GraphQL `refreshPr`. Pruned on close/merge/force-push + a TTL sweep, so it
 * only ever holds checks for currently-open, currently-tracked PRs.
 *
 * Workspace-independent: checks belong to a commit, shared by every workspace
 * tracking the PR. Backend-derived state read by the privileged pool role —
 * never shipped to the desktop (only the derived counts are), so RLS stays off,
 * like the other infra tables. See docs/INCREMENTAL_CHECK_COUNTS.md.
 */
export const prCheckStates = pgTable(
  'pr_check_states',
  {
    id: text('id').primaryKey(),
    /** `owner/repo`, lowercased — the GitHub repo, workspace-independent. */
    repoFullName: text('repo_full_name').notNull(),
    headSha: text('head_sha').notNull(),
    /** Check / status context name — the dedupe key (re-runs of a name win). */
    name: text('name').notNull(),
    source: text('source').notNull(), // 'check_run' | 'status'
    /** GitHub check_run id / status context id — debugging only. */
    externalId: text('external_id'),
    /** Normalized CheckState: success | failure | pending | in_progress | skipped | cancelled. */
    state: text('state').notNull(),
    /** Latest activity time for this check — guards against out-of-order events. */
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One row per check name on a commit — re-runs upsert in place.
    repoShaNameUq: uniqueIndex('uq_pr_check_states_repo_sha_name').on(
      t.repoFullName,
      t.headSha,
      t.name
    ),
    // Drives the count aggregate + sha-scoped pruning.
    repoShaIdx: index('idx_pr_check_states_repo_sha').on(t.repoFullName, t.headSha),
  })
);

// ---------- Merge queue v2 (first-class entries + audit log) ----------

/**
 * One row per merge-queue membership. Replaces the `mergeQueueState` jsonb
 * blob on pull_requests (kept through the dual-write migration window; see
 * services/mergeQueue/). At most ONE active (non-terminal) entry per PR —
 * terminal rows (`merged`/`removed`) are retained ~30 days as history so the
 * timeline outlives membership, and a re-queue mints a FRESH entry with fresh
 * budgets (the same semantics the old manual-requeue reset had).
 *
 * Budgets (`fix_attempts`/`rerun_attempts`/`resign_attempts`) are scoped to
 * `head_sha`: a new push resets all three — the self-healing mechanic.
 *
 * Queried BOTH from the pipeline (pool role, RLS-bypassing) and from request
 * context (dual-write, list decoration, timeline — inside withOwnerScope's
 * authenticated-role transaction), so it carries the standard workspace-owner
 * RLS policy + GRANTs (0033). NOT the billing_events pool-only pattern —
 * shipping it that way aborted every request that touched it (25P02 cascade).
 */
export const mergeQueueEntries = pgTable(
  'merge_queue_entries',
  {
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /**
     * Group key, denormalized so grouping/positions never read the summary
     * jsonb. Written at enqueue, refreshed on re-arm, and reconciled against
     * the PR's live base at the top of every evaluation (`evaluateEntry`) —
     * a PR can be retargeted by the user, by GitHub's delete-branch
     * auto-retarget, or by the merge stack's own retarget, and a stale key
     * strands the entry in a group nothing walks.
     */
    baseBranch: text('base_branch').notNull().default(''),
    /** Snapshot of the user's merge-method preference at enqueue. */
    mergeMethod: text('merge_method').notNull().default('squash'),
    /** EntryStatus — see services/mergeQueue/types.ts. */
    status: text('status').notNull().default('queued'),
    /** BlockedCode when status is blocked/blocked_manual. */
    blockedCode: text('blocked_code'),
    /** Human sentence for the badge tooltip / notification. */
    blockedReason: text('blocked_reason'),
    /** FIFO ordering within the (repo, base) group. */
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    /** Head the budgets below are scoped to. '' until first observed. */
    headSha: text('head_sha').notNull().default(''),
    fixAttempts: integer('fix_attempts').notNull().default(0),
    rerunAttempts: integer('rerun_attempts').notNull().default(0),
    resignAttempts: integer('resign_attempts').notNull().default(0),
    /**
     * Submissions to an EXTERNAL merge queue (trunk.io / GitHub native) spent
     * on this head. The provider can eject a PR (its tests fail merging with
     * the base); this bounds the resubmit loop the same way fixAttempts bounds
     * fix runs.
     */
    submitAttempts: integer('submit_attempts').notNull().default(0),
    /**
     * Every distinct blocker signature this head has been left with by a
     * COMPLETED remediation (`string[]`, lane-prefixed — see
     * `blockerSignature` / `queueSignature` in mergeQueue/decide.ts).
     *
     * This is what bounds remediation instead of a retry count. A run that
     * leaves a signature not in this list changed something, so the queue
     * keeps going; one that reproduces a signature already here has failed at
     * a problem it already failed at, and the entry blocks. That terminates
     * without a constant: the list only grows, and it can only grow as far as
     * the PR has distinct ways of being blocked.
     */
    seenSignatures: jsonb('seen_signatures'),
    /** How the live external submission was made: 'comment' | 'label' | 'auto_merge'. */
    externalSubmitVia: text('external_submit_via'),
    /** When it was made — the fallback for telling "not picked up yet" from
     *  "the provider ignored us" while the provider itself has said nothing. */
    externalSubmittedAt: timestamp('external_submitted_at', { withTimezone: true }),
    /** The provider's own last-observed answer (ExternalQueueState) — read off
     *  its PR comment, or its labels. Drives the desktop badge and R5b/R5c. */
    externalState: text('external_state'),
    externalStateAt: timestamp('external_state_at', { withTimezone: true }),
    /** The queue's own most-recent fix run (replaces lastFixTaskId in the blob). */
    fixTaskId: text('fix_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    fixTaskAccounted: boolean('fix_task_accounted').notNull().default(true),
    fixKind: text('fix_kind'), // 'blockers' | 'resign'
    /**
     * Merge stack: the PR this entry is — or was — stacked on. Set when the
     * entry parks in `awaiting_stack` (it feeds the badge's "Waiting for
     * #123") and KEPT through the retarget, where it becomes the record of
     * which PR's commits this branch may still redundantly carry after a
     * squash-merge. Never read to make a decision. The parent EDGE is derived
     * per evaluation from the summary jsonb, never persisted; a stored edge
     * would rot exactly the way base_branch did.
     */
    stackParentNumber: integer('stack_parent_number'),
    /**
     * Retargets attempted after a stack parent merged. Counts ACTIONS, not
     * successes, so a PATCH that keeps erroring is bounded too. Deliberately
     * NOT reset by a new head — a push that reset the loop guard defeats it.
     */
    retargetAttempts: integer('retarget_attempts').notNull().default(0),
    /** Signature-probe memo — valid only while it matches the current head. */
    signingCheckedSha: text('signing_checked_sha'),
    unsignedCount: integer('unsigned_count'),
    /** GitHub native auto-merge bookkeeping (Push E). */
    automergeArmedAt: timestamp('automerge_armed_at', { withTimezone: true }),
    automergeArmedBy: text('automerge_armed_by'), // 'talyn' | 'user'
    /** A Talyn-armed auto-merge we failed to disarm — the reconciler retries. */
    pendingDisarm: boolean('pending_disarm').notNull().default(false),
    /** Crash marker: set entering 'merging', before the REST call. */
    mergeStartedAt: timestamp('merge_started_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    /** Optimistic-concurrency guard — every transition is a CAS on this. */
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One ACTIVE entry per PR; terminal entries are retained history.
    activePrUq: uniqueIndex('uq_mqe_active_pr')
      .on(t.pullRequestId)
      .where(sql`${t.status} NOT IN ('merged','removed')`),
    // The group walk: FIFO within (repo, base).
    groupIdx: index('idx_mqe_group')
      .on(t.repositoryId, t.baseBranch, t.enqueuedAt)
      .where(sql`${t.status} NOT IN ('merged','removed')`),
    // Reconciler scans + the free-plan entitlement count.
    activeWsIdx: index('idx_mqe_active_ws')
      .on(t.workspaceId)
      .where(sql`${t.status} NOT IN ('merged','removed')`),
    inflightIdx: index('idx_mqe_inflight')
      .on(t.status)
      .where(sql`${t.status} IN ('merging','automerge_armed','fixing')`),
  })
);

/**
 * Per-entry audit log — one row per status transition and per fired action
 * (fix run, re-run, arm/disarm, merge attempt/refusal, budget reset,
 * notification). Powers the desktop timeline (`GET
 * /pull-requests/:id/merge-queue/timeline`) and post-incident forensics.
 * `detail` is small structured metadata (shas, task ids, attempt counts) —
 * never payloads. Pruned with its entry (FK cascade + the 30-day sweep).
 */
export const mergeQueueEvents = pgTable(
  'merge_queue_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => mergeQueueEntries.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    /** What caused it: 'webhook:check_run', 'task:terminal', 'user:enqueue', 'reconcile', … */
    trigger: text('trigger').notNull(),
    /** Machine code ('new_head_reset', 'app_refused_hard', 'rerun_fired', …). */
    code: text('code'),
    /** Human sentence for the timeline UI. */
    message: text('message').notNull().default(''),
    detail: jsonb('detail'),
  },
  (t) => ({
    entryAtIdx: index('idx_mqev_entry').on(t.entryId, t.at),
  })
);

// ---------- Skills ----------
//
// Agent skills (SKILL.md) saved to the Talyn platform, workspace-scoped.
// Repo skills are discovered live from GitHub and local skills live on the
// user's machine — neither is stored here. `content` is the table's big
// column: list queries must project it away (see SKILL_LIST_COLUMNS in
// routes/skills.ts) per the DB-egress rules.

export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Full SKILL.md text. Capped at SKILL_MAX_BYTES by the routes. */
    content: text('content').notNull(),
    /** Provenance when imported: { importedFrom: 'local'|'repo', originPath? }. */
    sourceInfo: jsonb('source_info'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('idx_skills_workspace').on(t.workspaceId),
    workspaceNameUq: uniqueIndex('uq_skills_workspace_name').on(t.workspaceId, t.name),
  })
);

// Per-workspace usage counters that drive the skill picker's
// "frequently used" ordering. Keyed by the canonical SkillKey
// (repo:<owner>/<repo>:<name> | local:<name> | platform:<id>) so all three
// skill sources share one stats store.

export const skillUsage = pgTable(
  'skill_usage',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    skillKey: text('skill_key').notNull(),
    usageCount: integer('usage_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.skillKey] }),
  })
);

// The self-hosted fleet's host registry (migration 0038).
//
// Hosts push a snapshot here every ~15s; the backend never dials them to ask.
// The fleet runs untrusted code on bare metal behind a private interface, and
// giving a hosted PaaS an inbound path to every such machine is the shape the
// whole design avoids. See the migration for the full reasoning.
export const fleetHosts = pgTable(
  'fleet_hosts',
  {
    /** The host's own name for itself. Natural key: a host that restarts or
     *  changes address is still the same host. */
    name: text('name').primaryKey(),
    /** Where the backend should dial this host's Fleet API — advertised BY the
     *  host, because only it knows which of its addresses is reachable. Null
     *  means observable but not dispatchable, which is what a host looks like
     *  before its private link is up. */
    apiEndpoint: text('api_endpoint'),
    version: text('version'),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull(),

    draining: boolean('draining').notNull().default(false),
    runsLive: integer('runs_live').notNull().default(0),
    runsMax: integer('runs_max').notNull().default(0),
    memReservedMib: integer('mem_reserved_mib').notNull().default(0),
    memBudgetMib: integer('mem_budget_mib').notNull().default(0),
    diskFreeMib: integer('disk_free_mib').notNull().default(0),
    maxIdleSeconds: doublePrecision('max_idle_seconds').notNull().default(0),

    /** Opaque on purpose: the fleet ships on its own cadence and adding a
     *  counter there must not need a migration here. */
    metrics: jsonb('metrics'),
    activeRuns: jsonb('active_runs'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reportedAtIdx: index('idx_fleet_hosts_reported_at').on(t.reportedAt),
  })
);
