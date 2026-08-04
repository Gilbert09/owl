import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import type { Request } from 'express';
import {
  type AdminAuditAction,
  type AdminAuditEntry,
  type AdminAuditTargetKind,
  type AdminPage,
} from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { adminAuditLog } from '../../db/schema.js';
import { clampLimit } from './queries.js';

/**
 * The operator console's audit trail.
 *
 * # Per-handler, never middleware
 *
 * Middleware cannot see before/after state, cannot tell "fleetd refused" from
 * "we never dialled", and has to guess the target from a URL. Every one of
 * those distinctions is the reason the log exists, so the recording happens
 * where the mutation does.
 *
 * # Two shapes, because the two side effects have different rollback stories
 *
 * `withRemoteAudit` — an HTTP call to another machine cannot be rolled back,
 * so the row is written as `pending` BEFORE dialling and settled after. If the
 * backend dies mid-call the trail still says "we were about to drain
 * hetzner-64", which is the only question anyone actually asks afterwards.
 *
 * `withTransactionalAudit` — a local UPDATE, so the mutation and its audit row
 * commit or roll back together. If the audit cannot be written, the comp does
 * not happen. Cheap, and the right posture for the only mutations that move
 * money and privilege.
 */

export interface AuditActor {
  id: string;
  email: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuditEntryInput {
  action: AdminAuditAction;
  targetKind: AdminAuditTargetKind;
  targetId: string;
  reason: string;
  /** The validated request body MINUS reason/confirm. */
  params?: Record<string, unknown>;
}

/** Read the actor off a request. `requireAdmin` guarantees a user is present. */
export function auditActor(req: Request): AuditActor {
  const user = req.user;
  if (!user) throw new Error('auditActor() called on an unauthenticated request');
  return {
    id: user.id,
    email: user.email,
    ip: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    requestId:
      typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined,
  };
}

/**
 * The two fields every mutating fleetd endpoint requires.
 *
 * A helper rather than two inline properties so they cannot be forgotten one
 * call site at a time — fleetd rejects a body missing either, and discovering
 * that per-endpoint is how half the mutations ship broken.
 *
 * `actor` is the operator's EMAIL. fleetd writes it into its own per-run JSON
 * ledger and its goldens log; an email is something somebody reading that
 * ledger at 2am can act on, and a UUID is not.
 */
export function fleetActorFields(actor: AuditActor, reason: string): {
  actor: string;
  reason: string;
} {
  return { actor: actor.email || actor.id, reason };
}

function baseRow(actor: AuditActor, entry: AuditEntryInput) {
  return {
    id: randomUUID(),
    actorId: actor.id,
    actorEmail: actor.email,
    action: entry.action,
    targetKind: entry.targetKind,
    targetId: entry.targetId,
    reason: entry.reason,
    params: (entry.params ?? null) as object | null,
    requestId: actor.requestId ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  };
}

/**
 * Audit a REMOTE mutation: write `pending`, dial out, settle.
 *
 * Returns whatever `fn` returns. If `fn` throws, the row lands as `error` with
 * the message and the error is rethrown — the caller still fails, the trail
 * still records the attempt.
 */
export async function withRemoteAudit<T>(
  actor: AuditActor,
  entry: AuditEntryInput,
  fn: () => Promise<T>
): Promise<T> {
  const db = getPoolDbClient();
  const row = baseRow(actor, entry);
  await db.insert(adminAuditLog).values({ ...row, outcome: 'pending' });

  const started = Date.now();
  try {
    const result = await fn();
    await settle(db, row.id, 'ok', Date.now() - started, null);
    return result;
  } catch (err) {
    await settle(db, row.id, 'error', Date.now() - started, errorText(err));
    throw err;
  }
}

/**
 * Settling must not turn a successful mutation into a failure.
 *
 * If the drain happened and only the bookkeeping UPDATE failed, throwing here
 * would make the operator retry a mutation that already took effect. Log
 * loudly and move on — a row stuck on `pending` is itself a legible signal.
 */
async function settle(
  db: Database,
  id: string,
  outcome: 'ok' | 'error',
  durationMs: number,
  error: string | null
): Promise<void> {
  try {
    await db
      .update(adminAuditLog)
      .set({ outcome, durationMs, error })
      .where(eq(adminAuditLog.id, id));
  } catch (err) {
    console.error(`[admin-audit] failed to settle ${id} as ${outcome}:`, err);
  }
}

/**
 * Audit a LOCAL mutation: the change and its audit row in one transaction.
 *
 * `fn` receives the transaction handle and must do its writes through it, or
 * the atomicity this exists for is lost. It returns the value to hand back
 * plus the before/after state to record.
 */
export async function withTransactionalAudit<T>(
  actor: AuditActor,
  entry: AuditEntryInput,
  fn: (tx: Database) => Promise<{ result: T; before?: unknown; after?: unknown }>
): Promise<T> {
  const started = Date.now();
  return getPoolDbClient().transaction(async (tx) => {
    const { result, before, after } = await fn(tx as unknown as Database);
    await tx.insert(adminAuditLog).values({
      ...baseRow(actor, entry),
      outcome: 'ok',
      durationMs: Date.now() - started,
      before: (before ?? null) as object | null,
      after: (after ?? null) as object | null,
    });
    return result;
  });
}

/**
 * Record a sensitive READ.
 *
 * Only one qualifies: fetching another tenant's task transcript. It is the
 * most sensitive thing this console can display, and recording the access is
 * what makes displaying it defensible. Fire-and-forget — a failure to log must
 * never fail the read, or an audit outage becomes a console outage.
 */
export function recordAuditedRead(actor: AuditActor, entry: AuditEntryInput): void {
  const db = getPoolDbClient();
  void db
    .insert(adminAuditLog)
    .values({ ...baseRow(actor, entry), outcome: 'ok' })
    .catch((err) => {
      console.error('[admin-audit] failed to record read:', err);
    });
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 1000);
}

// ============================================================================
// Reads
// ============================================================================

const AUDIT_COLUMNS = {
  id: adminAuditLog.id,
  at: adminAuditLog.at,
  actorId: adminAuditLog.actorId,
  actorEmail: adminAuditLog.actorEmail,
  action: adminAuditLog.action,
  targetKind: adminAuditLog.targetKind,
  targetId: adminAuditLog.targetId,
  reason: adminAuditLog.reason,
  params: adminAuditLog.params,
  before: adminAuditLog.before,
  after: adminAuditLog.after,
  outcome: adminAuditLog.outcome,
  error: adminAuditLog.error,
  durationMs: adminAuditLog.durationMs,
} as const;

export interface AuditFilters {
  actorId?: unknown;
  action?: unknown;
  targetKind?: unknown;
  targetId?: unknown;
  limit?: unknown;
  before?: unknown;
}

/**
 * The trail, newest first.
 *
 * Read-only by design: the API exposes no delete, so from outside the database
 * the log is append-only. That is most of what makes it worth having.
 */
export async function listAuditEntries(
  filters: AuditFilters
): Promise<AdminPage<AdminAuditEntry>> {
  const db = getPoolDbClient();
  const limit = clampLimit(filters.limit);

  const where: (SQL | undefined)[] = [];
  const cursor = decodeAuditCursor(filters.before);
  if (cursor) {
    where.push(
      or(
        lt(adminAuditLog.at, cursor.at),
        and(eq(adminAuditLog.at, cursor.at), lt(adminAuditLog.id, cursor.id))
      )
    );
  }
  if (typeof filters.actorId === 'string' && filters.actorId) {
    where.push(eq(adminAuditLog.actorId, filters.actorId));
  }
  if (typeof filters.action === 'string' && filters.action) {
    where.push(eq(adminAuditLog.action, filters.action));
  }
  if (typeof filters.targetKind === 'string' && filters.targetKind) {
    where.push(eq(adminAuditLog.targetKind, filters.targetKind));
  }
  if (typeof filters.targetId === 'string' && filters.targetId) {
    where.push(eq(adminAuditLog.targetId, filters.targetId));
  }

  const rows = await db
    .select(AUDIT_COLUMNS)
    .from(adminAuditLog)
    .where(and(...where.filter(Boolean)))
    .orderBy(desc(adminAuditLog.at), desc(adminAuditLog.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      actorId: row.actorId,
      actorEmail: row.actorEmail,
      action: row.action as AdminAuditAction,
      targetKind: row.targetKind as AdminAuditTargetKind,
      targetId: row.targetId,
      reason: row.reason,
      params: (row.params ?? null) as Record<string, unknown> | null,
      before: (row.before ?? null) as Record<string, unknown> | null,
      after: (row.after ?? null) as Record<string, unknown> | null,
      outcome: row.outcome as AdminAuditEntry['outcome'],
      error: row.error,
      durationMs: row.durationMs,
    })),
    nextCursor: hasMore && last ? `${last.at.toISOString()}|${last.id}` : null,
  };
}

function decodeAuditCursor(raw: unknown): { at: Date; id: string } | null {
  if (typeof raw !== 'string' || !raw) return null;
  const sep = raw.indexOf('|');
  if (sep <= 0) return null;
  const at = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(at.getTime()) || !id) return null;
  return { at, id };
}
