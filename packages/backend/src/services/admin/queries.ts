import { and, count, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  ADMIN_PAGE_LIMIT_DEFAULT,
  ADMIN_PAGE_LIMIT_MAX,
  ADMIN_SEARCH_MIN_LENGTH,
  type AdminPage,
  type AdminPlan,
  type AdminTaskDetail,
  type AdminTaskSummary,
  type AdminUserDetail,
  type AdminUserSummary,
  type AdminWorkspaceDetail,
  type AdminWorkspaceSummary,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  integrations as integrationsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { deriveEntitlement } from '../billing/entitlements.js';
import { taskColumnsNoTranscript } from '../taskSerialize.js';

/**
 * Every cross-tenant read the operator console makes.
 *
 * All the Drizzle lives here and `routes/admin/*` never touches it, so the
 * egress test has one file to import and one place to assert against.
 *
 * # Why getPoolDbClient() explicitly, everywhere
 *
 * The admin router mounts before `ownerScope`, so `getDbClient()` would
 * resolve to the pool anyway — today. Relying on mount order for RLS posture
 * is exactly the `fleet_hosts` bug read backwards (prod, 2026-08-03:
 * `permission denied for table fleet_hosts`, because a pool-only table was
 * read from an owner-scoped request). State the intent in code so moving a
 * route cannot silently change which rows it can see.
 *
 * # Egress
 *
 * Per CLAUDE.md: never `.select()`, always an `as const` projection typed with
 * `Pick<>` so `tsc` fails if a consumer later reads a column the projection
 * drops. That `Pick` is the regression guard — without it a projection
 * re-bloats one convenient field at a time.
 */

// ============================================================================
// Pagination + search
// ============================================================================

/**
 * A cursor is `<iso timestamp>|<id>`, matching the `(createdAt desc, id desc)`
 * ordering. Keyed on both because `createdAt` is not unique — a page boundary
 * landing between two rows created in the same millisecond would otherwise
 * either repeat or skip them.
 */
interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const sep = raw.indexOf('|');
  if (sep <= 0) return null;
  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

/** Clamp a caller-supplied limit. An unbounded admin list is a table scan. */
export function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return ADMIN_PAGE_LIMIT_DEFAULT;
  return Math.min(Math.floor(n), ADMIN_PAGE_LIMIT_MAX);
}

/**
 * Escape a user-supplied `ilike` pattern.
 *
 * `%` and `_` are wildcards, so an unescaped search for `a_b` matches `axb`
 * and a search for `%` matches everything — which on a cross-tenant table is
 * "return the entire user list" dressed up as a search. Backslash first, or it
 * re-escapes the escapes.
 */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** A search term worth running, or null. */
export function searchTerm(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < ADMIN_SEARCH_MIN_LENGTH) return null;
  return `%${escapeLike(trimmed)}%`;
}

/**
 * Keyset predicate for `(createdAt desc, id desc)`.
 *
 * Typed against `AnyPgColumn` rather than one table's columns so the same
 * helper serves users, workspaces and tasks — Drizzle's column types carry
 * their table name, so a concrete type here would bind this to whichever
 * table happened to be written first.
 */
function beforeCursor(
  table: { createdAt: AnyPgColumn; id: AnyPgColumn },
  cursor: Cursor | null
): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(table.createdAt, cursor.createdAt),
    and(eq(table.createdAt, cursor.createdAt), lt(table.id, cursor.id))
  );
}

/** Fetch limit+1, use the extra row to decide whether a next page exists. */
function toPage<T extends { createdAt: Date; id: string }, R>(
  rows: T[],
  limit: number,
  map: (row: T) => R
): AdminPage<R> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(map),
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]!) : null,
  };
}

function plan(value: string | null): AdminPlan | null {
  return value === 'free' || value === 'unlimited' ? value : null;
}

// ============================================================================
// Users
// ============================================================================

/**
 * Deliberately WITHOUT polarCustomerId / polarSubscriptionId /
 * subscriptionEventAt. A Polar id rendered in a browser list view is a support
 * liability with no read use; it belongs on the detail read, where an operator
 * is actually chasing a billing problem.
 */
export const ADMIN_USER_COLUMNS = {
  id: usersTable.id,
  email: usersTable.email,
  githubUsername: usersTable.githubUsername,
  isAdmin: usersTable.isAdmin,
  plan: usersTable.plan,
  planOverride: usersTable.planOverride,
  subscriptionStatus: usersTable.subscriptionStatus,
  currentPeriodEnd: usersTable.currentPeriodEnd,
  cancelAtPeriodEnd: usersTable.cancelAtPeriodEnd,
  createdAt: usersTable.createdAt,
} as const;

export const ADMIN_USER_DETAIL_COLUMNS = {
  ...ADMIN_USER_COLUMNS,
  updatedAt: usersTable.updatedAt,
  polarCustomerId: usersTable.polarCustomerId,
  polarSubscriptionId: usersTable.polarSubscriptionId,
  subscriptionEventAt: usersTable.subscriptionEventAt,
} as const;

type AdminUserRow = Pick<typeof usersTable.$inferSelect, keyof typeof ADMIN_USER_COLUMNS>;
type AdminUserDetailRow = Pick<
  typeof usersTable.$inferSelect,
  keyof typeof ADMIN_USER_DETAIL_COLUMNS
>;

/** Statuses that count against the free plan's active-task allowance. */
const ACTIVE_TASK_STATUSES = ['pending', 'queued', 'in_progress'] as const;

function toUserSummary(row: AdminUserRow, workspaceCount: number): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    githubUsername: row.githubUsername,
    isAdmin: row.isAdmin,
    plan: (plan(row.plan) ?? 'free') as AdminPlan,
    planOverride: plan(row.planOverride),
    // Reuses the billing module's own precedence rather than reimplementing
    // `planOverride ?? plan` — if that rule ever changes, the console must
    // change with it, not drift into showing a different answer than the gate
    // actually enforces.
    effectivePlan: deriveEntitlement({ plan: row.plan, planOverride: row.planOverride }).plan,
    subscriptionStatus: row.subscriptionStatus,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    createdAt: row.createdAt.toISOString(),
    workspaceCount,
  };
}

export interface AdminUserFilters {
  q?: unknown;
  plan?: unknown;
  admin?: unknown;
  limit?: unknown;
  before?: unknown;
}

export async function listAdminUsers(filters: AdminUserFilters): Promise<AdminPage<AdminUserSummary>> {
  const db = getPoolDbClient();
  const limit = clampLimit(filters.limit);
  const term = searchTerm(filters.q);

  const where: (SQL | undefined)[] = [beforeCursor(usersTable, decodeCursor(filters.before as string))];
  if (term) where.push(ilike(usersTable.email, term));
  if (filters.plan === 'free' || filters.plan === 'unlimited') {
    // Filter on EFFECTIVE plan — a comped account whose `plan` is still 'free'
    // is unlimited, and an operator searching for unlimited accounts means the
    // ones that behave that way.
    where.push(
      filters.plan === 'unlimited'
        ? or(eq(usersTable.planOverride, 'unlimited'), and(eq(usersTable.plan, 'unlimited'), sql`${usersTable.planOverride} is distinct from 'free'`))
        : and(
            sql`${usersTable.planOverride} is distinct from 'unlimited'`,
            or(eq(usersTable.plan, 'free'), eq(usersTable.planOverride, 'free'))
          )
    );
  }
  if (filters.admin === true || filters.admin === 'true') where.push(eq(usersTable.isAdmin, true));

  const rows = await db
    .select(ADMIN_USER_COLUMNS)
    .from(usersTable)
    .where(and(...where.filter(Boolean)))
    .orderBy(desc(usersTable.createdAt), desc(usersTable.id))
    .limit(limit + 1);

  const counts = await workspaceCountsFor(rows.map((r) => r.id));
  return toPage(rows, limit, (row) => toUserSummary(row, counts.get(row.id) ?? 0));
}

/** One grouped count query rather than N per-row ones. */
async function workspaceCountsFor(ownerIds: string[]): Promise<Map<string, number>> {
  if (ownerIds.length === 0) return new Map();
  const rows = await getPoolDbClient()
    .select({ ownerId: workspacesTable.ownerId, n: count() })
    .from(workspacesTable)
    .where(inArray(workspacesTable.ownerId, ownerIds))
    .groupBy(workspacesTable.ownerId);
  return new Map(rows.map((r) => [r.ownerId, Number(r.n)]));
}

export async function getAdminUser(id: string): Promise<AdminUserDetail | null> {
  const db = getPoolDbClient();
  const rows: AdminUserDetailRow[] = await db
    .select(ADMIN_USER_DETAIL_COLUMNS)
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const workspaces = await listWorkspaceRowsForOwner(id);
  const [activeTasks] = await db
    .select({ n: count() })
    .from(tasksTable)
    .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
    .where(
      and(
        eq(workspacesTable.ownerId, id),
        inArray(tasksTable.status, [...ACTIVE_TASK_STATUSES])
      )
    );

  return {
    ...toUserSummary(row, workspaces.length),
    updatedAt: row.updatedAt.toISOString(),
    polarCustomerId: row.polarCustomerId,
    polarSubscriptionId: row.polarSubscriptionId,
    subscriptionEventAt: row.subscriptionEventAt?.toISOString() ?? null,
    activeTaskCount: Number(activeTasks?.n ?? 0),
    workspaces: workspaces.map((w) => toWorkspaceSummary(w, row.email)),
  };
}

/** The email a user row would have, for a mutation's confirm-by-email gate. */
export async function getAdminUserEmail(id: string): Promise<string | null> {
  const rows = await getPoolDbClient()
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);
  return rows[0]?.email ?? null;
}

// ============================================================================
// Workspaces
// ============================================================================

/**
 * Excludes `logo` (jsonb, can hold a data URL) and `settings` (jsonb, never
 * rendered in a list) — both named in CLAUDE.md's egress rules.
 */
export const ADMIN_WORKSPACE_COLUMNS = {
  id: workspacesTable.id,
  ownerId: workspacesTable.ownerId,
  name: workspacesTable.name,
  description: workspacesTable.description,
  createdAt: workspacesTable.createdAt,
  updatedAt: workspacesTable.updatedAt,
} as const;

type AdminWorkspaceRow = Pick<
  typeof workspacesTable.$inferSelect,
  keyof typeof ADMIN_WORKSPACE_COLUMNS
>;

function toWorkspaceSummary(row: AdminWorkspaceRow, ownerEmail: string | null): AdminWorkspaceSummary {
  return {
    id: row.id,
    ownerId: row.ownerId,
    ownerEmail,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function listWorkspaceRowsForOwner(ownerId: string): Promise<AdminWorkspaceRow[]> {
  return getPoolDbClient()
    .select(ADMIN_WORKSPACE_COLUMNS)
    .from(workspacesTable)
    .where(eq(workspacesTable.ownerId, ownerId))
    .orderBy(desc(workspacesTable.createdAt), desc(workspacesTable.id));
}

export interface AdminWorkspaceFilters {
  q?: unknown;
  ownerId?: unknown;
  limit?: unknown;
  before?: unknown;
}

export async function listAdminWorkspaces(
  filters: AdminWorkspaceFilters
): Promise<AdminPage<AdminWorkspaceSummary>> {
  const db = getPoolDbClient();
  const limit = clampLimit(filters.limit);
  const term = searchTerm(filters.q);

  const where: (SQL | undefined)[] = [
    beforeCursor(workspacesTable, decodeCursor(filters.before as string)),
  ];
  if (term) where.push(ilike(workspacesTable.name, term));
  if (typeof filters.ownerId === 'string' && filters.ownerId) {
    where.push(eq(workspacesTable.ownerId, filters.ownerId));
  }

  // Owner email comes from a join projecting ONLY the email — never the whole
  // user row, which would drag the Polar columns into a workspace list.
  const rows = await db
    .select({ ...ADMIN_WORKSPACE_COLUMNS, ownerEmail: usersTable.email })
    .from(workspacesTable)
    .innerJoin(usersTable, eq(workspacesTable.ownerId, usersTable.id))
    .where(and(...where.filter(Boolean)))
    .orderBy(desc(workspacesTable.createdAt), desc(workspacesTable.id))
    .limit(limit + 1);

  return toPage(rows, limit, (row) => toWorkspaceSummary(row, row.ownerEmail));
}

export async function getAdminWorkspace(id: string): Promise<AdminWorkspaceDetail | null> {
  const db = getPoolDbClient();
  const rows = await db
    .select({ ...ADMIN_WORKSPACE_COLUMNS, ownerEmail: usersTable.email })
    .from(workspacesTable)
    .innerJoin(usersTable, eq(workspacesTable.ownerId, usersTable.id))
    .where(eq(workspacesTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const [repos] = await db
    .select({ n: count() })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.workspaceId, id));
  const [tasksTotal] = await db
    .select({ n: count() })
    .from(tasksTable)
    .where(eq(tasksTable.workspaceId, id));
  const [tasksActive] = await db
    .select({ n: count() })
    .from(tasksTable)
    .where(
      and(eq(tasksTable.workspaceId, id), inArray(tasksTable.status, [...ACTIVE_TASK_STATUSES]))
    );
  // The integration TYPE only. `config` holds encrypted credentials and has no
  // business leaving the backend on an operator read — knowing a provider is
  // configured is the whole question; knowing its secret is never the answer.
  const providers = await db
    .select({ type: integrationsTable.type })
    .from(integrationsTable)
    .where(eq(integrationsTable.workspaceId, id));

  return {
    ...toWorkspaceSummary(row, row.ownerEmail),
    repositoryCount: Number(repos?.n ?? 0),
    taskCount: Number(tasksTotal?.n ?? 0),
    activeTaskCount: Number(tasksActive?.n ?? 0),
    providers: [...new Set(providers.map((p) => p.type))].sort(),
  };
}

// ============================================================================
// Tasks
// ============================================================================

/**
 * The cloud fields, computed IN SQL so the `metadata` jsonb never ships.
 *
 * A task list across every tenant would otherwise pull one metadata blob per
 * row for five scalars — the pattern CLAUDE.md names (see
 * `cloudPollerEgress.test.ts`, and `prMonitor.fastPollWorkspace` deriving a
 * check count from `last_summary` rather than selecting it).
 *
 * The COALESCE arms are NOT optional: `readCloudTaskMeta` in @talyn/shared
 * falls back to the legacy flat `posthog*` keys for tasks written before the
 * cloudTask envelope existed, and this SQL is required to agree with it. That
 * agreement is pinned by `adminCloudMetaSql.test.ts` against seeded rows of
 * both shapes — `readCloudTaskMeta` stays the canonical definition and the SQL
 * has to match it, not the other way round.
 */
export const ADMIN_TASK_LIST_COLUMNS = {
  id: tasksTable.id,
  workspaceId: tasksTable.workspaceId,
  type: tasksTable.type,
  status: tasksTable.status,
  title: tasksTable.title,
  createdAt: tasksTable.createdAt,
  updatedAt: tasksTable.updatedAt,
  completedAt: tasksTable.completedAt,
  provider: sql<string | null>`coalesce(
    ${tasksTable.metadata} -> 'cloudTask' ->> 'provider',
    case when ${tasksTable.metadata} ->> 'posthogTaskId' is not null then 'posthog_code' end
  )`.as('provider'),
  remoteRunId: sql<string | null>`coalesce(
    ${tasksTable.metadata} -> 'cloudTask' ->> 'remoteRunId',
    ${tasksTable.metadata} ->> 'posthogRunId'
  )`.as('remote_run_id'),
  cloudStatus: sql<string | null>`coalesce(
    ${tasksTable.metadata} -> 'cloudTask' ->> 'status',
    ${tasksTable.metadata} ->> 'posthogStatus'
  )`.as('cloud_status'),
  fleetHost: sql<
    string | null
  >`${tasksTable.metadata} -> 'cloudTask' -> 'extra' ->> 'host'`.as('fleet_host'),
  phase: sql<string | null>`${tasksTable.metadata} -> 'cloudTask' -> 'extra' ->> 'phase'`.as(
    'phase'
  ),
  costUsd: sql<
    number | null
  >`(${tasksTable.metadata} -> 'cloudTask' -> 'extra' ->> 'costUsd')::double precision`.as(
    'cost_usd'
  ),
} as const;

/**
 * The same envelope-then-legacy precedence the SQL above implements, in JS.
 *
 * Exported so `adminCloudMetaSql.test.ts` can assert the two agree over the
 * same seeded rows. `readCloudTaskMeta` is the canonical source; this is a
 * projection of it onto the five columns the list renders.
 */
export function cloudFieldsFromMetadata(metadata: Record<string, unknown> | null): {
  provider: string | null;
  remoteRunId: string | null;
  cloudStatus: string | null;
  fleetHost: string | null;
  phase: string | null;
  costUsd: number | null;
} {
  const meta = metadata ?? {};
  const cloud = meta.cloudTask as Record<string, unknown> | undefined;
  const extra = (cloud?.extra ?? {}) as Record<string, unknown>;
  const legacyId = typeof meta.posthogTaskId === 'string' ? meta.posthogTaskId : null;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const cost = extra.costUsd;
  return {
    provider: str(cloud?.provider) ?? (legacyId ? 'posthog_code' : null),
    remoteRunId: str(cloud?.remoteRunId) ?? str(meta.posthogRunId),
    cloudStatus: str(cloud?.status) ?? str(meta.posthogStatus),
    fleetHost: str(extra.host),
    phase: str(extra.phase),
    costUsd: typeof cost === 'number' ? cost : cost != null ? Number(cost) : null,
  };
}

type AdminTaskListRow = {
  [K in keyof typeof ADMIN_TASK_LIST_COLUMNS]: K extends keyof typeof tasksTable.$inferSelect
    ? (typeof tasksTable.$inferSelect)[K]
    : unknown;
};

export interface AdminTaskFilters {
  ownerId?: unknown;
  workspaceId?: unknown;
  status?: unknown;
  provider?: unknown;
  host?: unknown;
  limit?: unknown;
  before?: unknown;
}

export async function listAdminTasks(
  filters: AdminTaskFilters
): Promise<AdminPage<AdminTaskSummary>> {
  const db = getPoolDbClient();
  const limit = clampLimit(filters.limit);

  const where: (SQL | undefined)[] = [beforeCursor(tasksTable, decodeCursor(filters.before as string))];
  if (typeof filters.workspaceId === 'string' && filters.workspaceId) {
    where.push(eq(tasksTable.workspaceId, filters.workspaceId));
  }
  if (typeof filters.ownerId === 'string' && filters.ownerId) {
    where.push(eq(workspacesTable.ownerId, filters.ownerId));
  }
  if (typeof filters.status === 'string' && filters.status) {
    where.push(eq(tasksTable.status, filters.status));
  }
  if (typeof filters.provider === 'string' && filters.provider) {
    where.push(sql`${tasksTable.metadata} -> 'cloudTask' ->> 'provider' = ${filters.provider}`);
  }
  if (typeof filters.host === 'string' && filters.host) {
    where.push(
      sql`${tasksTable.metadata} -> 'cloudTask' -> 'extra' ->> 'host' = ${filters.host}`
    );
  }

  const rows = await db
    .select({
      ...ADMIN_TASK_LIST_COLUMNS,
      workspaceName: workspacesTable.name,
      ownerEmail: usersTable.email,
    })
    .from(tasksTable)
    .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
    .innerJoin(usersTable, eq(workspacesTable.ownerId, usersTable.id))
    .where(and(...where.filter(Boolean)))
    .orderBy(desc(tasksTable.createdAt), desc(tasksTable.id))
    .limit(limit + 1);

  return toPage(rows as unknown as (AdminTaskListRow & {
    createdAt: Date;
    id: string;
    workspaceName: string;
    ownerEmail: string;
  })[], limit, (row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    ownerEmail: row.ownerEmail,
    type: row.type,
    status: row.status,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    provider: (row.provider as string | null) ?? null,
    remoteRunId: (row.remoteRunId as string | null) ?? null,
    cloudStatus: (row.cloudStatus as string | null) ?? null,
    fleetHost: (row.fleetHost as string | null) ?? null,
    phase: (row.phase as string | null) ?? null,
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
  }));
}

/**
 * One task, optionally with its transcript.
 *
 * The transcript is opt-in and the ROUTE audits that read — it is another
 * tenant's agent conversation, the most sensitive thing this console can
 * display, and recording the access is what makes displaying it defensible.
 * Without the flag this uses `taskColumnsNoTranscript`, the mandated
 * projection, so the blob never leaves Postgres.
 */
export async function getAdminTask(
  id: string,
  opts: { transcript?: boolean } = {}
): Promise<AdminTaskDetail | null> {
  const db = getPoolDbClient();
  const columns = opts.transcript
    ? { ...taskColumnsNoTranscript, transcript: tasksTable.transcript }
    : taskColumnsNoTranscript;

  const rows = await db
    .select({ ...columns, workspaceName: workspacesTable.name, ownerEmail: usersTable.email })
    .from(tasksTable)
    .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
    .innerJoin(usersTable, eq(workspacesTable.ownerId, usersTable.id))
    .where(eq(tasksTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const metadata = (row.metadata ?? null) as Record<string, unknown> | null;
  const cloud = cloudFieldsFromMetadata(metadata);
  const result = (row.result ?? {}) as Record<string, unknown>;

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    ownerEmail: row.ownerEmail,
    type: row.type,
    status: row.status,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    ...cloud,
    prompt: row.prompt ?? null,
    repositoryId: row.repositoryId ?? null,
    branch: row.branch ?? null,
    error: typeof result.error === 'string' ? result.error : null,
    prUrl:
      (typeof (metadata?.cloudTask as Record<string, unknown> | undefined)?.prUrl === 'string'
        ? ((metadata?.cloudTask as Record<string, unknown>).prUrl as string)
        : null) ?? (typeof result.prUrl === 'string' ? result.prUrl : null),
    transcript: opts.transcript
      ? (((row as { transcript?: unknown }).transcript as unknown[] | null) ?? null)
      : null,
  };
}

/** Whether a task exists, for mutation routes that need to 404 first. */
export async function adminTaskExists(id: string): Promise<boolean> {
  const rows = await getPoolDbClient()
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(eq(tasksTable.id, id))
    .limit(1);
  return Boolean(rows[0]);
}
