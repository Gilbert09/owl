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

import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  uniqueIndex,
  index,
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

export const users = pgTable('users', {
  id: text('id').primaryKey(), // == auth.users.id (uuid)
  email: text('email').notNull(),
  githubUsername: text('github_username'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    localPath: text('local_path'),
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

// ---------- Environments ----------

export const environments = pgTable(
  'environments',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Execution always happens inside a `@fastowl/daemon` process that
    // dials into the backend. 'local' means the daemon runs on the
    // user's own desktop machine (bundled with the Electron app);
    // 'remote' means the daemon runs on a separate machine paired via
    // an explicit token. See docs/DAEMON_EVERYWHERE.md.
    type: text('type').notNull(), // 'local' | 'remote'
    status: text('status').notNull().default('disconnected'),
    config: jsonb('config').notNull(),
    // Long-lived token the daemon presents on every reconnect. We store
    // a SHA-256 hash only — raw token is handed to the daemon once at
    // pairing time and never leaves its disk.
    deviceTokenHash: text('device_token_hash'),
    // Updated whenever a daemon sends any WS traffic. Drives the
    // "connected" status in the desktop and scheduler gating.
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastConnected: timestamp('last_connected', { withTimezone: true }),
    error: text('error'),
    /**
     * When true, FastOwl spawns autonomous Claude tasks on this env with
     * `--dangerously-skip-permissions`, which lets Claude run bash / file
     * edits / MCP calls without prompting. Appropriate for throwaway
     * daemon VMs where the blast radius is bounded. Dangerous for
     * `local` envs (your own machine) — defaults off; toggle from
     * Settings → Environments if you know what you're doing.
     *
     * `false` falls back to `--permission-mode acceptEdits`, which will
     * still block on bash prompts the scheduler can't answer, so
     * autonomous runs on a strict env are best-effort.
     */
    autonomousBypassPermissions: boolean('autonomous_bypass_permissions')
      .notNull()
      .default(false),
    /**
     * Historically toggled between PTY and structured rendering.
     * Slice 4c collapsed the two paths — structured is now the only
     * runtime. Column is kept for rollback safety; always `'structured'`.
     */
    renderer: text('renderer').notNull().default('structured'),
    /**
     * Tool names the user has pre-approved for this env — hook checks
     * this list before surfacing a permission prompt. Scoped per-env
     * (not per-task) so repeated "always allow Read" clicks stick
     * across the env's whole task history. Populated by the desktop
     * "Allow always" button. Example: `["Read", "Grep", "Bash(git *)"]`.
     */
    toolAllowlist: jsonb('tool_allowlist').notNull().default([]),
    /**
     * Version string reported by the daemon on its most recent hello.
     * Format `<pkgVersion>+<shortSha>` (e.g. `0.1.0+a1b2c3d`). Null
     * when no daemon has ever paired. Compared against the backend's
     * own build SHA to surface "stale daemon" warnings in the desktop.
     */
    daemonVersion: text('daemon_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index('idx_environments_owner').on(t.ownerId),
    deviceTokenIdx: index('idx_environments_device_token').on(t.deviceTokenHash),
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
    type: text('type').notNull(), // 'code_writing' | 'pr_response' | 'pr_review' | 'manual'
    status: text('status').notNull().default('pending'),
    priority: text('priority').notNull().default('medium'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    prompt: text('prompt'),
    assignedAgentId: text('assigned_agent_id'),
    assignedEnvironmentId: text('assigned_environment_id').references(
      () => environments.id,
      { onDelete: 'set null' }
    ),
    repositoryId: text('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    branch: text('branch'),
    terminalOutput: text('terminal_output').notNull().default(''),
    /**
     * JSONL event log for structured-renderer tasks. Array of
     * `AgentEvent` objects (from @fastowl/shared). Null for PTY tasks.
     * Bounded by agentStructured.ts (last N events / size cap).
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

// ---------- Agents ----------

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('idle'),
    attention: text('attention').notNull().default('none'),
    currentTaskId: text('current_task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    /**
     * Per-run token handed to the child via FASTOWL_PERMISSION_TOKEN
     * (strict mode only). Persisted so agents surviving a backend
     * restart can re-register the same token in permissionService on
     * resume — otherwise the child's in-flight PreToolUse hooks would
     * 401 with a "token not recognised" error.
     */
    permissionToken: text('permission_token'),
    terminalOutput: text('terminal_output').notNull().default(''),
    lastActivity: timestamp('last_activity', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    environmentIdx: index('idx_agents_environment').on(t.environmentId),
    workspaceIdx: index('idx_agents_workspace').on(t.workspaceId),
  })
);

// ---------- Inbox items ----------

export const inboxItems = pgTable(
  'inbox_items',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status').notNull().default('unread'),
    priority: text('priority').notNull().default('medium'),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    source: jsonb('source').notNull(),
    actions: jsonb('actions').notNull().default([]),
    data: jsonb('data'),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
    actionedAt: timestamp('actioned_at', { withTimezone: true }),
  },
  (t) => ({
    workspaceIdx: index('idx_inbox_workspace').on(t.workspaceId),
    statusIdx: index('idx_inbox_status').on(t.status),
  })
);

// ---------- Global settings (key/value) ----------

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- Backlog (Continuous Build) ----------

export const backlogSources = pgTable(
  'backlog_sources',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // currently only 'markdown_file'
    enabled: boolean('enabled').notNull().default(true),
    environmentId: text('environment_id').references(() => environments.id, {
      onDelete: 'set null',
    }),
    repositoryId: text('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    config: jsonb('config').notNull().default({}),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('idx_backlog_sources_workspace').on(t.workspaceId),
  })
);

export const backlogItems = pgTable(
  'backlog_items',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => backlogSources.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    text: text('text').notNull(),
    parentExternalId: text('parent_external_id'),
    completed: boolean('completed').notNull().default(false),
    blocked: boolean('blocked').notNull().default(false),
    claimedTaskId: text('claimed_task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    orderIndex: integer('order_index').notNull().default(0),
    /**
     * Count of consecutive task failures for this item. Reset to 0 on
     * success. The scheduler uses this for backoff + eventual blocking
     * so a deterministically broken TODO doesn't infinite-loop the queue.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Timestamp of the last failed task on this item — drives backoff. */
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceExternalUq: uniqueIndex('uq_backlog_items_source_external').on(
      t.sourceId,
      t.externalId
    ),
    sourceIdx: index('idx_backlog_items_source').on(t.sourceId),
    workspaceIdx: index('idx_backlog_items_workspace').on(t.workspaceId),
    claimedIdx: index('idx_backlog_items_claimed').on(t.claimedTaskId),
  })
);
