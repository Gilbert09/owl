import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import {
  AUTO_KEEP_DEFAULT_ERROR_CODE,
  FREE_PLAN_ACTIVE_TASK_LIMIT,
  FREE_PLAN_MERGE_QUEUE_LIMIT,
  MERGE_QUEUE_LIMIT_ERROR_CODE,
  TASK_LIMIT_ERROR_CODE,
  type BillingStatus,
} from '@talyn/shared';
import {
  getDbClient,
  getPoolDbClient,
  getScopedDb,
  isRealPostgres,
} from '../../db/client.js';
import {
  pullRequests as pullRequestsTable,
  tasks as tasksTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { advisoryLockKey, withBlockingAdvisoryLock } from '../advisoryLock.js';

/**
 * Plan entitlements — the provider-agnostic seam every limit check goes
 * through. Nothing in here knows about Polar beyond "webhooks maintain
 * `users.plan`"; the Polar client/webhook adapter lives alongside in
 * services/billing/ and can be swapped without touching enforcement.
 *
 * Free plan: at most FREE_ACTIVE_TASK_LIMIT tasks in an active status at
 * once, counted across every workspace the user owns. Paid/comped: no limit.
 */

export const FREE_ACTIVE_TASK_LIMIT = FREE_PLAN_ACTIVE_TASK_LIMIT;
export const FREE_MERGE_QUEUE_LIMIT = FREE_PLAN_MERGE_QUEUE_LIMIT;

/** Statuses that occupy a free-plan slot (mirrors the desktop's ACTIVE_TASK_STATUSES). */
export const ACTIVE_TASK_STATUSES = ['pending', 'queued', 'in_progress'] as const;

export type EffectivePlan = 'free' | 'unlimited';

export interface Entitlement {
  plan: EffectivePlan;
  source: 'default' | 'subscription' | 'override' | 'billing_disabled';
}

/** Thrown by the gate when a free owner is at their active-task limit. */
export class TaskLimitError extends Error {
  readonly code = TASK_LIMIT_ERROR_CODE;
  constructor(
    readonly limit: number,
    readonly active: number
  ) {
    super(
      `Free plan is limited to ${limit} active tasks (${active} in use). ` +
        `Upgrade for unlimited tasks, or wait for a task to finish.`
    );
    this.name = 'TaskLimitError';
  }
}

/** Thrown by the gate when a free owner's merge queue is full. */
export class MergeQueueLimitError extends Error {
  readonly code = MERGE_QUEUE_LIMIT_ERROR_CODE;
  constructor(
    readonly limit: number,
    readonly queued: number,
    /** How many PRs the refused call was trying to add. >1 for a stack. */
    readonly adding = 1
  ) {
    super(
      adding > 1
        ? `This stack needs ${adding} merge-queue slots. Free plan is limited to ` +
          `${limit} PRs in the merge queue (${queued} queued). Upgrade for an ` +
          `unlimited queue, or wait for a queued PR to land.`
        : `Free plan is limited to ${limit} PRs in the merge queue (${queued} queued). ` +
          `Upgrade for an unlimited queue, or wait for a queued PR to land.`
    );
    this.name = 'MergeQueueLimitError';
  }
}

/**
 * Thrown when a free owner tries to turn ON the workspace default "auto-keep
 * new PRs mergeable".
 *
 * A FEATURE gate rather than a usage cap: the other two errors mean "wait for a
 * slot", this one means "there is no free version of this". Kept a distinct
 * class so the 402 carries its own code and the client can pitch accordingly
 * instead of quoting a limit the user is not at.
 */
export class AutoKeepDefaultPlanError extends Error {
  readonly code = AUTO_KEEP_DEFAULT_ERROR_CODE;
  constructor() {
    super(
      'Auto-keeping every new PR mergeable is an Unlimited feature. ' +
        'Upgrade to turn it on, or arm individual PRs by hand.'
    );
    this.name = 'AutoKeepDefaultPlanError';
  }
}

/**
 * Whether billing is configured at all. When the Polar env group is absent
 * (local dev, CI, self-hosted) task limits are NOT enforced — a paywall with
 * no way to pay would brick task creation at 3 with zero recourse. Partial
 * config is a boot error (validateEnv), so checking one var here is enough;
 * this also doubles as a production kill switch.
 */
export function billingEnabled(): boolean {
  return Boolean(process.env.POLAR_ACCESS_TOKEN);
}

/** Pure entitlement derivation from a users-row billing projection. */
export function deriveEntitlement(
  row: { plan: string; planOverride: string | null } | undefined
): Entitlement {
  if (!row) return { plan: 'free', source: 'default' };
  if (row.planOverride === 'unlimited' || row.planOverride === 'free') {
    return { plan: row.planOverride, source: 'override' };
  }
  if (row.plan === 'unlimited') return { plan: 'unlimited', source: 'subscription' };
  return { plan: 'free', source: 'default' };
}

/**
 * Resolve the effective plan for an owner: manual override first (the comp
 * flag — set via SQL, never by webhooks), then the webhook-driven plan.
 */
export async function resolveEntitlement(ownerId: string): Promise<Entitlement> {
  if (!billingEnabled()) return { plan: 'unlimited', source: 'billing_disabled' };

  const rows = await getDbClient()
    .select({ plan: usersTable.plan, planOverride: usersTable.planOverride })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  return deriveEntitlement(rows[0]);
}

/**
 * The full billing snapshot served by `GET /billing/status` and pushed on
 * the `subscription:updated` WS event.
 */
export async function buildBillingStatus(ownerId: string): Promise<BillingStatus> {
  const activeTasks = await countActiveTasks(ownerId);
  const queuedPrs = await countQueuedPrs(ownerId);
  if (!billingEnabled()) {
    return {
      billingEnabled: false,
      plan: 'unlimited',
      planSource: 'billing_disabled',
      cancelAtPeriodEnd: false,
      activeTasks,
      activeTaskLimit: null,
      queuedPrs,
      mergeQueueLimit: null,
    };
  }

  const rows = await getDbClient()
    .select({
      plan: usersTable.plan,
      planOverride: usersTable.planOverride,
      subscriptionStatus: usersTable.subscriptionStatus,
      currentPeriodEnd: usersTable.currentPeriodEnd,
      cancelAtPeriodEnd: usersTable.cancelAtPeriodEnd,
    })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  const row = rows[0];
  const entitlement = deriveEntitlement(row);

  return {
    billingEnabled: true,
    plan: entitlement.plan,
    planSource: entitlement.source,
    ...(row?.subscriptionStatus ? { subscriptionStatus: row.subscriptionStatus } : {}),
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    ...(row?.currentPeriodEnd ? { currentPeriodEnd: row.currentPeriodEnd.toISOString() } : {}),
    activeTasks,
    activeTaskLimit: entitlement.plan === 'free' ? FREE_ACTIVE_TASK_LIMIT : null,
    queuedPrs,
    mergeQueueLimit: entitlement.plan === 'free' ? FREE_MERGE_QUEUE_LIMIT : null,
  };
}

/**
 * The count query, exported unexecuted so the egress test can `.toSQL()` it:
 * a pure count over tasks joined to the owner's workspaces — must never ship
 * task columns (transcript!) to the backend.
 */
export function countActiveTasksQuery(ownerId: string, excludeTaskId?: string) {
  const conditions = [
    eq(workspacesTable.ownerId, ownerId),
    inArray(tasksTable.status, [...ACTIVE_TASK_STATUSES]),
  ];
  if (excludeTaskId) conditions.push(ne(tasksTable.id, excludeTaskId));
  return getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(tasksTable)
    .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
    .where(and(...conditions));
}

/** How many active tasks the owner has right now, across all their workspaces. */
export async function countActiveTasks(
  ownerId: string,
  excludeTaskId?: string
): Promise<number> {
  const rows = await countActiveTasksQuery(ownerId, excludeTaskId);
  return rows[0]?.count ?? 0;
}

/**
 * Same contract as countActiveTasksQuery, for the merge queue: a pure count
 * of the owner's queued PRs, exported unexecuted for the egress test — must
 * never ship pull_requests columns (lastSummary!) to the backend. The
 * `state = 'open'` guard is belt-and-braces: merge/close clears mergeQueued,
 * but a stale row must never eat a free slot.
 */
export function countQueuedPrsQuery(ownerId: string, excludePrIds?: string | string[]) {
  const exclude =
    excludePrIds === undefined ? [] : Array.isArray(excludePrIds) ? excludePrIds : [excludePrIds];
  const conditions = [
    eq(workspacesTable.ownerId, ownerId),
    eq(pullRequestsTable.mergeQueued, true),
    eq(pullRequestsTable.state, 'open'),
  ];
  if (exclude.length === 1) conditions.push(ne(pullRequestsTable.id, exclude[0]!));
  else if (exclude.length > 1) conditions.push(notInArray(pullRequestsTable.id, exclude));
  return getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(pullRequestsTable)
    .innerJoin(workspacesTable, eq(pullRequestsTable.workspaceId, workspacesTable.id))
    .where(and(...conditions));
}

/** How many PRs the owner has in the merge queue, across all their workspaces. */
export async function countQueuedPrs(
  ownerId: string,
  excludePrIds?: string | string[]
): Promise<number> {
  const rows = await countQueuedPrsQuery(ownerId, excludePrIds);
  return rows[0]?.count ?? 0;
}

interface GateOptions {
  /**
   * A task being re-activated (retry/start/PATCH) rather than created —
   * excluded from the count so an idempotent re-queue of a still-active task
   * can never self-block.
   */
  excludeTaskId?: string;
}

/**
 * Run `fn` (which creates or re-activates one task) unless the owner is a
 * free user already at the limit, in which case throw TaskLimitError.
 *
 * Race safety: two concurrent creations at 2/3 must not both pass, so the
 * free-plan path serializes per owner on a transaction-scoped advisory lock
 * (the only advisory flavour safe through Supabase's transaction-mode
 * pooler — see services/advisoryLock.ts):
 *
 * - Inside an ownerScope request transaction (routes), the lock is taken on
 *   that transaction and held until the task insert COMMITS — a concurrent
 *   request blocks on the lock and then counts the committed row.
 * - On the unscoped pool (watchers), withBlockingAdvisoryLock holds a pure
 *   mutex transaction open while `fn`'s pool statements auto-commit, so the
 *   insert is durable before the mutex releases.
 * - On pglite (tests) the lock is skipped — the single-connection harness
 *   would self-deadlock, and cross-connection races don't exist there.
 *
 * Unlimited/comped owners skip both the lock and the count entirely.
 */
export async function withTaskLimitGate<T>(
  ownerId: string,
  options: GateOptions,
  fn: () => Promise<T>
): Promise<T> {
  return withFreePlanGate(
    ownerId,
    `taskLimit:${ownerId}`,
    async () => {
      const active = await countActiveTasks(ownerId, options.excludeTaskId);
      if (active >= FREE_ACTIVE_TASK_LIMIT) {
        throw new TaskLimitError(FREE_ACTIVE_TASK_LIMIT, active);
      }
    },
    fn
  );
}

/**
 * Run `fn` (which puts one PR into the merge queue) unless the owner is a
 * free user whose queue is already full, in which case throw
 * MergeQueueLimitError. `excludePrId` keeps re-arming an already-queued PR
 * (method change, fast off/on toggle) from self-blocking at the limit.
 */
export async function withMergeQueueLimitGate<T>(
  ownerId: string,
  options: {
    /**
     * PRs excluded from the count — the ones this call is (re-)queuing, so an
     * idempotent re-arm of an already-queued PR can never self-block. A stack
     * passes every member.
     */
    excludePrId?: string | string[];
    /**
     * How many PRs this call adds. A stack is ALL-OR-NOTHING: enqueuing only
     * the bottom of it produces a stack that silently stops halfway, because
     * the retarget of rung 4 only happens if rung 4 is in the queue.
     */
    adding?: number;
  },
  fn: () => Promise<T>
): Promise<T> {
  const adding = options.adding ?? 1;
  return withFreePlanGate(
    ownerId,
    `mergeQueueLimit:${ownerId}`,
    async () => {
      const queued = await countQueuedPrs(ownerId, options.excludePrId);
      if (queued + adding > FREE_MERGE_QUEUE_LIMIT) {
        throw new MergeQueueLimitError(FREE_MERGE_QUEUE_LIMIT, queued, adding);
      }
    },
    fn
  );
}

/** The shared count-then-act choreography behind both free-plan gates. */
async function withFreePlanGate<T>(
  ownerId: string,
  lockName: string,
  assertWithinLimit: () => Promise<void>,
  fn: () => Promise<T>
): Promise<T> {
  const entitlement = await resolveEntitlement(ownerId);
  if (entitlement.plan !== 'free') return fn();

  if (!isRealPostgres()) {
    await assertWithinLimit();
    return fn();
  }

  const scoped = getScopedDb();
  if (scoped) {
    // Route path: piggyback on the request's ownerScope transaction so the
    // lock outlives the check AND the insert, releasing only at commit.
    const key = advisoryLockKey(lockName).toString();
    await scoped.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
    await assertWithinLimit();
    return fn();
  }

  // Watcher path: dedicated mutex transaction on the pool.
  return withBlockingAdvisoryLock(getPoolDbClient(), lockName, async () => {
    await assertWithinLimit();
    return fn();
  });
}

/**
 * Gate for re-activating an existing task (retry / start / PATCH to an
 * active status). Counts everything except the task itself.
 */
export async function assertCanActivateTask(ownerId: string, taskId: string): Promise<void> {
  await withTaskLimitGate(ownerId, { excludeTaskId: taskId }, async () => undefined);
}

/**
 * Gate for turning ON the workspace default "auto-keep new PRs mergeable".
 *
 * Callers MUST only invoke this on an OFF→ON transition. A workspace that
 * already has the setting on predates the gate and keeps it — the product
 * promise is that nobody loses a feature they were already using. Turning it
 * off is always allowed, and gives that grandfathered state up.
 *
 * Deliberately not a `withFreePlanGate` wrapper: there is nothing to count and
 * nothing to serialize, so it needs neither the advisory lock nor the race
 * safety those gates buy.
 */
export async function assertCanEnableAutoKeepDefault(ownerId: string): Promise<void> {
  const entitlement = await resolveEntitlement(ownerId);
  if (entitlement.plan === 'free') throw new AutoKeepDefaultPlanError();
}
