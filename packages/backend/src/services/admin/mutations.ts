import { eq, sql } from 'drizzle-orm';
import type { AdminPlan } from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { tasks as tasksTable, users as usersTable } from '../../db/schema.js';
import { rowToTask, taskColumnsNoTranscript } from '../taskSerialize.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { getCloudProvider } from '../cloudProviders/registry.js';
import { clearWatched } from '../cloudProviders/taskWatch.js';
import { taskQueueService } from '../taskQueue.js';
import { emitTaskStatus } from '../websocket.js';
import { readCloudTaskProvider } from '@talyn/shared';

/**
 * The state changes the operator console can make.
 *
 * Each function does ONLY the mutation — the audit row, the reason gate and
 * the confirm gate are the route's job (see routes/admin/product.ts). Keeping
 * them apart means a mutation cannot be reached without passing through the
 * guards, because the guards are the only thing that calls it.
 *
 * Everything here takes a `tx` so it can run inside `withTransactionalAudit`:
 * the change and its audit row commit together, or neither does. A comp with
 * no record of who granted it is the outcome that posture exists to prevent.
 */

/**
 * How many operators would remain if this user were demoted.
 *
 * Run inside the same transaction as the demotion, so a concurrent demotion
 * cannot slip between the check and the write and leave zero admins. The only
 * ways back in are `TALYN_ADMIN_EMAILS` (needs a redeploy) or hand SQL, so
 * locking everyone out is recoverable but genuinely disruptive.
 */
export async function countOtherAdmins(tx: Database, excludingUserId: string): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(sql`${usersTable.isAdmin} = true and ${usersTable.id} <> ${excludingUserId}`);
  return Number(rows[0]?.n ?? 0);
}

export interface PlanOverrideResult {
  before: { plan: string; planOverride: string | null };
  after: { plan: string; planOverride: string | null };
}

/**
 * Set or clear the manual comp flag.
 *
 * Writes `plan_override` and NOTHING ELSE. `plan` belongs to Polar's webhook
 * handler — a manual write there is silently reverted by the next
 * subscription event, which looks like the comp "wearing off" days later with
 * no trace of why.
 */
export async function setPlanOverride(
  tx: Database,
  userId: string,
  planOverride: AdminPlan | null
): Promise<PlanOverrideResult | null> {
  const rows = await tx
    .select({ plan: usersTable.plan, planOverride: usersTable.planOverride })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const before = rows[0];
  if (!before) return null;

  await tx
    .update(usersTable)
    .set({ planOverride, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));

  return {
    before: { plan: before.plan, planOverride: before.planOverride },
    after: { plan: before.plan, planOverride },
  };
}

export interface AdminFlagResult {
  before: { isAdmin: boolean };
  after: { isAdmin: boolean };
}

/**
 * Grant or revoke operator access.
 *
 * Writes `users.is_admin` directly and deliberately does NOT touch the
 * `TALYN_ADMIN_EMAILS` path in verifyTokenAndGetUser — that path is
 * promote-only by design, and a revocation here would be undone by the target
 * signing in again if their email were still on the env list.
 */
export async function setAdminFlag(
  tx: Database,
  userId: string,
  isAdmin: boolean
): Promise<AdminFlagResult | null> {
  const rows = await tx
    .select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const before = rows[0];
  if (!before) return null;

  await tx
    .update(usersTable)
    .set({ isAdmin, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));

  return { before: { isAdmin: before.isAdmin }, after: { isAdmin } };
}

export interface TaskStateResult {
  before: { status: string };
  after: { status: string };
  workspaceId: string;
}

/**
 * Put a task back in the queue.
 *
 * Mirrors `POST /tasks/:id/retry` with two differences, both deliberate:
 *
 *  - No paywall gate. An operator retrying somebody's stuck task on their
 *    behalf is support, not consumption, and 402-ing that would be absurd.
 *  - The cloud metadata is cleared so dispatch starts a FRESH run rather than
 *    short-circuiting on the idempotency check and re-adopting the dead one —
 *    which is the failure this is usually being used to fix.
 */
export async function retryTask(tx: Database, taskId: string): Promise<TaskStateResult | null> {
  const rows = await tx
    .select({ status: tasksTable.status, workspaceId: tasksTable.workspaceId })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const before = rows[0];
  if (!before) return null;

  await tx
    .update(tasksTable)
    .set({ status: 'queued', result: null, completedAt: null, updatedAt: new Date() })
    .where(eq(tasksTable.id, taskId));

  return {
    before: { status: before.status },
    after: { status: 'queued' },
    workspaceId: before.workspaceId,
  };
}

/** Post-commit side effects for a retry. Not in the transaction on purpose. */
export async function afterRetry(taskId: string, workspaceId: string): Promise<void> {
  // Clearing the cloud envelope goes through the metadata mutex, which is a
  // separate serialisation domain from the transaction — running it inside
  // would deadlock against a concurrent poller patch.
  await patchTaskMetadata(taskId, (meta) => {
    const next = { ...meta };
    delete next.posthogTaskId;
    delete next.posthogRunId;
    delete next.posthogStatus;
    delete next.cloudTask;
    return next;
  });
  emitTaskStatus(workspaceId, taskId, 'queued');
  void taskQueueService.processQueue();
}

/**
 * Stop a running task and mark it cancelled.
 *
 * The remote cancel happens BEFORE the transaction, deliberately. It is an
 * HTTP call to a vendor, and holding a pooled Postgres connection open across
 * it would tie up the pool for the length of someone else's timeout. It is
 * also best-effort by nature — the local task is cancelled either way, and
 * whether the vendor run actually stopped is recorded so the audit trail says
 * "cancelled, but the run may still open a PR" rather than implying it died.
 */
export async function cancelRemoteRun(taskId: string): Promise<{ ok: boolean; error?: string }> {
  const rows = await getPoolDbClient()
    .select(taskColumnsNoTranscript)
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  if (!rows[0]) return { ok: false, error: 'task not found' };

  const task = rowToTask(rows[0]);
  const provider = getCloudProvider(readCloudTaskProvider(task));
  // Drop the transcript stream regardless of whether the remote cancel works
  // — nothing is going to read it now, and a live stream against a run we
  // believe is dead is a leak that outlives the task.
  provider?.stopStreaming(taskId);

  if (!provider?.cancel) return { ok: true };

  try {
    await provider.cancel(task);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[admin] remote cancel failed for ${taskId}:`, err);
    return { ok: false, error: message };
  }
}

export async function killTask(
  tx: Database,
  taskId: string,
  remote: { ok: boolean; error?: string }
): Promise<TaskStateResult | null> {
  const rows = await tx
    .select({ status: tasksTable.status, workspaceId: tasksTable.workspaceId })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const before = rows[0];
  if (!before) return null;

  const result = {
    success: false,
    error: remote.ok
      ? 'Cancelled by a Talyn operator'
      : `Cancelled by a Talyn operator. The remote run could not be stopped and may still finish: ${remote.error}`,
  };
  const now = new Date();
  await tx
    .update(tasksTable)
    .set({ status: 'cancelled', result, completedAt: now, updatedAt: now })
    .where(eq(tasksTable.id, taskId));

  return {
    before: { status: before.status },
    after: { status: 'cancelled' },
    workspaceId: before.workspaceId,
  };
}

/** Post-commit side effects for a kill. */
export function afterKill(taskId: string, workspaceId: string, remote: { ok: boolean }): void {
  clearWatched(taskId);
  emitTaskStatus(workspaceId, taskId, 'cancelled', {
    success: false,
    error: remote.ok
      ? 'Cancelled by a Talyn operator'
      : 'Cancelled by a Talyn operator. The remote run could not be stopped.',
  });
}
