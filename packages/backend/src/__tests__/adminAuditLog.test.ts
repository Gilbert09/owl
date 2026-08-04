import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { adminAuditLog, users as usersTable } from '../db/schema.js';
import {
  auditActor,
  fleetActorFields,
  listAuditEntries,
  recordAuditedRead,
  withRemoteAudit,
  withTransactionalAudit,
  type AuditActor,
} from '../services/admin/audit.js';
import type { Database } from '../db/client.js';

/**
 * The audit trail's two write shapes, and why they differ.
 *
 * A remote mutation (drain a host, cancel a run) is an HTTP call to another
 * machine and cannot be rolled back — so the row is written BEFORE dialling
 * and settled after. If the backend dies mid-call the trail still says "we
 * were about to drain hetzner-64", which is the only question anyone asks
 * after an incident. Asserting the ORDER is the point: a row written after a
 * successful call records nothing about the calls that never returned.
 *
 * A local mutation (comp an account, grant admin) commits with its audit row
 * or not at all. If the audit cannot be written, the comp does not happen.
 */

const OPERATOR = 'user-operator';
let db: Database;
let cleanup: () => Promise<void>;

const actor: AuditActor = {
  id: OPERATOR,
  email: 'op@talyn.dev',
  ip: '10.0.0.1',
  userAgent: 'admin-console',
  requestId: 'req-1',
};

async function rows() {
  return db.select().from(adminAuditLog);
}

beforeEach(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  cleanup = testDb.cleanup;
  await seedUser(db, { id: OPERATOR, email: 'op@talyn.dev' });
  await seedUser(db, { id: 'user-alice', email: 'alice@example.test' });
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('withRemoteAudit', () => {
  it('writes the row BEFORE the remote call, as pending', async () => {
    // The assertion the whole shape exists for.
    let seenDuringCall: Array<{ outcome: string }> = [];
    await withRemoteAudit(
      actor,
      { action: 'fleet.drain', targetKind: 'host', targetId: 'hetzner-64', reason: 'rebooting fleetd' },
      async () => {
        seenDuringCall = await rows();
        return 'ok';
      }
    );
    expect(seenDuringCall).toHaveLength(1);
    expect(seenDuringCall[0]!.outcome).toBe('pending');
  });

  it('settles to ok with a duration', async () => {
    await withRemoteAudit(
      actor,
      { action: 'fleet.drain', targetKind: 'host', targetId: 'hetzner-64', reason: 'rebooting fleetd' },
      async () => 'done'
    );
    const [row] = await rows();
    expect(row!.outcome).toBe('ok');
    expect(row!.error).toBeNull();
    expect(row!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns the callback value untouched', async () => {
    const result = await withRemoteAudit(
      actor,
      { action: 'fleet.drain', targetKind: 'host', targetId: 'h', reason: 'why' },
      async () => ({ draining: true })
    );
    expect(result).toEqual({ draining: true });
  });

  it('settles to error and RETHROWS when the remote call fails', async () => {
    // The caller must still fail — the operator has to know the host was not
    // told — while the trail records the attempt.
    await expect(
      withRemoteAudit(
        actor,
        { action: 'fleet.drain', targetKind: 'host', targetId: 'hetzner-64', reason: 'why' },
        async () => {
          throw new Error('fleet unreachable at https://h:8080');
        }
      )
    ).rejects.toThrow(/fleet unreachable/);

    const [row] = await rows();
    expect(row!.outcome).toBe('error');
    expect(row!.error).toContain('fleet unreachable');
  });

  it('does not fail a successful mutation when only the settle write fails', async () => {
    // The drain already happened. Throwing here would make the operator retry
    // a mutation that took effect. A row stuck on `pending` is the signal.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = db.update.bind(db);
    let calls = 0;
    vi.spyOn(db, 'update').mockImplementation(((...args: unknown[]) => {
      calls += 1;
      if (calls === 1) throw new Error('db is on fire');
      return (original as never)(...(args as []));
    }) as never);

    await expect(
      withRemoteAudit(
        actor,
        { action: 'fleet.drain', targetKind: 'host', targetId: 'h', reason: 'why' },
        async () => 'fine'
      )
    ).resolves.toBe('fine');
    expect(spy).toHaveBeenCalled();
  });

  it('records the actor, target, reason and request context verbatim', async () => {
    await withRemoteAudit(
      actor,
      {
        action: 'fleet.golden.gc',
        targetKind: 'golden',
        targetId: '/var/lib/fleet/goldens/repo/x.img',
        reason: 'disk at 92%, reclaiming stale repo layers',
        params: { force: true, dryRun: false },
      },
      async () => null
    );
    const [row] = await rows();
    expect(row!.actorId).toBe(OPERATOR);
    expect(row!.actorEmail).toBe('op@talyn.dev');
    expect(row!.action).toBe('fleet.golden.gc');
    expect(row!.targetKind).toBe('golden');
    expect(row!.targetId).toBe('/var/lib/fleet/goldens/repo/x.img');
    expect(row!.reason).toBe('disk at 92%, reclaiming stale repo layers');
    expect(row!.params).toEqual({ force: true, dryRun: false });
    expect(row!.ip).toBe('10.0.0.1');
    expect(row!.userAgent).toBe('admin-console');
    expect(row!.requestId).toBe('req-1');
  });
});

describe('withTransactionalAudit', () => {
  it('commits the mutation and its audit row together', async () => {
    await withTransactionalAudit(
      actor,
      { action: 'user.plan_override', targetKind: 'user', targetId: 'user-alice', reason: 'comped for beta feedback' },
      async (tx) => {
        await tx
          .update(usersTable)
          .set({ planOverride: 'unlimited' })
          .where(eq(usersTable.id, 'user-alice'));
        return { result: undefined, before: { planOverride: null }, after: { planOverride: 'unlimited' } };
      }
    );

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, 'user-alice'));
    expect(user!.planOverride).toBe('unlimited');
    const [row] = await rows();
    expect(row!.outcome).toBe('ok');
    expect(row!.before).toEqual({ planOverride: null });
    expect(row!.after).toEqual({ planOverride: 'unlimited' });
  });

  it('rolls the MUTATION back when the audit insert fails', async () => {
    // The posture that matters for the mutations that move money and
    // privilege: no audit row means the change did not happen.
    await expect(
      withTransactionalAudit(
        actor,
        {
          action: 'user.plan_override',
          targetKind: 'user',
          targetId: 'user-alice',
          // NOT NULL on the column; a null reason makes the insert fail,
          // which is the failure this case needs to provoke.
          reason: null as unknown as string,
        },
        async (tx) => {
          await tx
            .update(usersTable)
            .set({ planOverride: 'unlimited' })
            .where(eq(usersTable.id, 'user-alice'));
          return { result: undefined };
        }
      )
    ).rejects.toThrow();

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, 'user-alice'));
    expect(user!.planOverride).toBeNull();
    expect(await rows()).toHaveLength(0);
  });

  it('rolls the AUDIT back when the mutation fails', async () => {
    await expect(
      withTransactionalAudit(
        actor,
        { action: 'user.admin', targetKind: 'user', targetId: 'user-alice', reason: 'promoting' },
        async () => {
          throw new Error('nope');
        }
      )
    ).rejects.toThrow('nope');
    expect(await rows()).toHaveLength(0);
  });
});

describe('the trail outlives the actor', () => {
  it('survives deleting the user who performed the action', async () => {
    // DELETE /users/me cascades. An FK on actor_id would take the audit row
    // with it — the one row you most want after an account is deleted.
    await withRemoteAudit(
      actor,
      { action: 'fleet.drain', targetKind: 'host', targetId: 'h', reason: 'why' },
      async () => null
    );
    await db.delete(usersTable).where(eq(usersTable.id, OPERATOR));
    const remaining = await rows();
    expect(remaining).toHaveLength(1);
    // And it still NAMES a person, which is why the email is denormalised.
    expect(remaining[0]!.actorEmail).toBe('op@talyn.dev');
  });
});

describe('recordAuditedRead', () => {
  it('records a transcript read', async () => {
    recordAuditedRead(actor, {
      action: 'task.transcript.read',
      targetKind: 'task',
      targetId: 'task-1',
      reason: 'operator opened the transcript',
    });
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
    const [row] = await rows();
    expect(row!.action).toBe('task.transcript.read');
    expect(row!.outcome).toBe('ok');
  });
});

describe('auditActor', () => {
  it('reads identity and request context off the request', () => {
    const req = {
      user: { id: 'u1', email: 'a@b.test', isAdmin: true },
      ip: '1.2.3.4',
      headers: { 'user-agent': 'UA', 'x-request-id': 'rid' },
    } as unknown as Request;
    expect(auditActor(req)).toEqual({
      id: 'u1',
      email: 'a@b.test',
      ip: '1.2.3.4',
      userAgent: 'UA',
      requestId: 'rid',
    });
  });

  it('throws rather than writing an anonymous audit row', () => {
    expect(() => auditActor({ headers: {} } as unknown as Request)).toThrow(/unauthenticated/);
  });
});

describe('fleetActorFields', () => {
  it('sends the operator EMAIL as the actor', () => {
    // fleetd writes this into its own ledger; an email is actionable at 2am
    // and a UUID is not.
    expect(fleetActorFields(actor, 'because')).toEqual({
      actor: 'op@talyn.dev',
      reason: 'because',
    });
  });

  it('falls back to the id when there is no email', () => {
    expect(fleetActorFields({ id: 'u1', email: '' }, 'r').actor).toBe('u1');
  });
});

describe('listAuditEntries', () => {
  beforeEach(async () => {
    for (const [i, action] of (['fleet.drain', 'user.plan_override', 'fleet.drain'] as const).entries()) {
      await withRemoteAudit(
        actor,
        { action, targetKind: 'host', targetId: `t-${i}`, reason: `reason ${i}` },
        async () => null
      );
    }
  });

  it('returns newest first', async () => {
    const page = await listAuditEntries({});
    expect(page.items).toHaveLength(3);
    expect(page.items[0]!.targetId).toBe('t-2');
  });

  it('filters by action', async () => {
    const page = await listAuditEntries({ action: 'fleet.drain' });
    expect(page.items.map((i) => i.targetId).sort()).toEqual(['t-0', 't-2']);
  });

  it('filters by target', async () => {
    const page = await listAuditEntries({ targetKind: 'host', targetId: 't-1' });
    expect(page.items).toHaveLength(1);
  });

  it('paginates without repeating', async () => {
    const first = await listAuditEntries({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await listAuditEntries({ limit: 2, before: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = new Set([...first.items, ...second.items].map((i) => i.id));
    expect(ids.size).toBe(3);
  });

  it('carries the reason through to the read', async () => {
    // A reason gate that does not survive to the page an operator reads is
    // theatre with extra steps.
    const page = await listAuditEntries({});
    expect(page.items.map((i) => i.reason)).toContain('reason 1');
  });
});
