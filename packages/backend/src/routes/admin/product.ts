import { Router } from 'express';
import type { ApiResponse } from '@talyn/shared';
import {
  getAdminTask,
  getAdminUser,
  getAdminWorkspace,
  listAdminTasks,
  getAdminUserEmail,
  listAdminUsers,
  listAdminWorkspaces,
} from '../../services/admin/queries.js';
import {
  auditActor,
  recordAuditedRead,
  withTransactionalAudit,
} from '../../services/admin/audit.js';
import {
  adminReason,
  AdminGuardError,
  adminMutationLimit,
  notSelf,
  requireAdminGrantEnabled,
  requireConfirm,
  requireReason,
  withGuards,
} from './guards.js';
import {
  afterKill,
  afterRetry,
  cancelRemoteRun,
  countOtherAdmins,
  killTask,
  retryTask,
  setAdminFlag,
  setPlanOverride,
} from '../../services/admin/mutations.js';
import { ADMIN_LAST_ADMIN, type AdminPlan } from '@talyn/shared';

/**
 * Cross-tenant product reads for the operator console.
 *
 * Mounted (via routes/admin/index.ts) BEFORE `ownerScope`, which is the only
 * reason any of this returns rows at all: under RLS these queries would come
 * back empty rather than erroring, so the console would look like a working
 * page with nothing in it. `routes/adminProduct.test.ts` asserts a read
 * returns ANOTHER owner's rows, which is the check that placement is real
 * rather than intended.
 *
 * Every query lives in services/admin/queries.ts — nothing here touches
 * Drizzle, so the egress test has exactly one file to assert against.
 */
export function adminProductRoutes(): Router {
  const router = Router();

  router.get('/users', async (req, res) => {
    const page = await listAdminUsers({
      q: req.query.q,
      plan: req.query.plan,
      admin: req.query.admin,
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({ success: true, data: page } as ApiResponse<typeof page>);
  });

  router.get('/users/:id', async (req, res) => {
    const user = await getAdminUser(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    res.json({ success: true, data: user } as ApiResponse<typeof user>);
  });

  router.get('/workspaces', async (req, res) => {
    const page = await listAdminWorkspaces({
      q: req.query.q,
      ownerId: req.query.ownerId,
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({ success: true, data: page } as ApiResponse<typeof page>);
  });

  router.get('/workspaces/:id', async (req, res) => {
    const workspace = await getAdminWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ success: false, error: 'Workspace not found' });
      return;
    }
    res.json({ success: true, data: workspace } as ApiResponse<typeof workspace>);
  });

  router.get('/tasks', async (req, res) => {
    const page = await listAdminTasks({
      ownerId: req.query.ownerId,
      workspaceId: req.query.workspaceId,
      status: req.query.status,
      provider: req.query.provider,
      host: req.query.host,
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({ success: true, data: page } as ApiResponse<typeof page>);
  });

  /**
   * One task. `?transcript=1` additionally returns the run's conversation log.
   *
   * That read is AUDITED — it is another tenant's agent conversation, the
   * single most sensitive thing this console can display, and recording the
   * access is what makes displaying it defensible. It is the only READ on this
   * whole surface that writes an audit row; everything else here is metadata.
   *
   * Without the flag the transcript blob never leaves Postgres.
   */
  router.get('/tasks/:id', async (req, res) => {
    const wantsTranscript = req.query.transcript === '1' || req.query.transcript === 'true';
    const task = await getAdminTask(req.params.id, { transcript: wantsTranscript });
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    if (wantsTranscript) {
      // Logged AFTER the 404 check, so the trail records transcripts actually
      // shown rather than ids someone typed. Fire-and-forget: a logging
      // failure must not fail the read, or an audit outage is a console
      // outage. `reason` is not solicited for a read — the console cannot
      // sensibly prompt on every page load — so it records the access itself.
      recordAuditedRead(auditActor(req), {
        action: 'task.transcript.read',
        targetKind: 'task',
        targetId: task.id,
        reason: 'operator opened the transcript',
        params: { workspaceId: task.workspaceId, ownerEmail: task.ownerEmail },
      });
    }
    res.json({ success: true, data: task } as ApiResponse<typeof task>);
  });

  // --------------------------------------------------------------------
  // Mutations
  //
  // Each is guarded in the same order, and the order matters: exists →
  // not-self → deploy-permits → confirm. Checking `confirm` before the target
  // exists would let someone probe for accounts by watching which error came
  // back.
  // --------------------------------------------------------------------

  const limit = adminMutationLimit();

  /**
   * Comp an account, or take a comp away.
   *
   * Writes `plan_override` only. `plan` is Polar's column, and a manual write
   * there is silently reverted by the next subscription webhook — which reads
   * as the comp "wearing off" days later with nothing to explain it.
   */
  router.post(
    '/users/:id/plan-override',
    limit,
    requireReason,
    withGuards(async (req, res) => {
      const body = req.body as { planOverride?: unknown };
      const value = body.planOverride;
      if (value !== null && value !== 'free' && value !== 'unlimited') {
        throw new AdminGuardError(
          400,
          'invalid_plan',
          "planOverride must be 'free', 'unlimited', or null."
        );
      }

      const email = await getAdminUserEmail(req.params.id);
      if (!email) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }
      notSelf(req, req.params.id);
      requireConfirm(req, email);

      const result = await withTransactionalAudit(
        auditActor(req),
        {
          action: 'user.plan_override',
          targetKind: 'user',
          targetId: req.params.id,
          reason: adminReason(req),
          params: { planOverride: value, email },
        },
        async (tx) => {
          const changed = await setPlanOverride(tx, req.params.id, value as AdminPlan | null);
          if (!changed) throw new AdminGuardError(404, 'not_found', 'User not found');
          return { result: changed.after, before: changed.before, after: changed.after };
        }
      );

      res.json({ success: true, data: result });
    })
  );

  /**
   * Grant or revoke operator access.
   *
   * Off unless the deploy opts in (TALYN_ADMIN_GRANT_ENABLED). Granting admin
   * is the one mutation that permanently widens the blast radius of every
   * other one, so a stolen operator session can read and comp — bad, but
   * auditable and reversible — and cannot mint a second operator to survive
   * the first being revoked.
   */
  router.post(
    '/users/:id/admin',
    limit,
    requireReason,
    withGuards(async (req, res) => {
      const body = req.body as { isAdmin?: unknown };
      if (typeof body.isAdmin !== 'boolean') {
        throw new AdminGuardError(400, 'invalid_request', 'isAdmin must be a boolean.');
      }

      const email = await getAdminUserEmail(req.params.id);
      if (!email) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }
      notSelf(req, req.params.id);
      requireAdminGrantEnabled();
      requireConfirm(req, email);

      const result = await withTransactionalAudit(
        auditActor(req),
        {
          action: 'user.admin',
          targetKind: 'user',
          targetId: req.params.id,
          reason: adminReason(req),
          params: { isAdmin: body.isAdmin, email },
        },
        async (tx) => {
          // Checked INSIDE the transaction so a concurrent demotion cannot
          // slip between the count and the write and leave zero operators.
          if (body.isAdmin === false && (await countOtherAdmins(tx, req.params.id)) === 0) {
            throw new AdminGuardError(
              409,
              ADMIN_LAST_ADMIN,
              'That would leave no admins. Promote someone else first.'
            );
          }
          const changed = await setAdminFlag(tx, req.params.id, body.isAdmin as boolean);
          if (!changed) throw new AdminGuardError(404, 'not_found', 'User not found');
          return { result: changed.after, before: changed.before, after: changed.after };
        }
      );

      res.json({ success: true, data: result });
    })
  );

  /** Put a stuck task back in the queue, with a fresh cloud run. */
  router.post(
    '/tasks/:id/retry',
    limit,
    requireReason,
    withGuards(async (req, res) => {
      const outcome = await withTransactionalAudit(
        auditActor(req),
        {
          action: 'task.retry',
          targetKind: 'task',
          targetId: req.params.id,
          reason: adminReason(req),
        },
        async (tx) => {
          const changed = await retryTask(tx, req.params.id);
          if (!changed) throw new AdminGuardError(404, 'not_found', 'Task not found');
          return { result: changed, before: changed.before, after: changed.after };
        }
      );

      // After the commit: clearing the cloud envelope goes through the
      // metadata mutex, a different serialisation domain, and dispatching
      // inside the transaction would hold a pooled connection across it.
      await afterRetry(req.params.id, outcome.workspaceId);
      res.json({ success: true, data: outcome.after });
    })
  );

  /** Stop a running task. */
  router.post(
    '/tasks/:id/kill',
    limit,
    requireReason,
    withGuards(async (req, res) => {
      // Before the transaction: this is an HTTP call to a vendor, and holding
      // a pooled Postgres connection across somebody else's timeout would tie
      // up the pool. Best-effort by nature — the local task is cancelled
      // either way, and whether the vendor run actually stopped is recorded.
      const remote = await cancelRemoteRun(req.params.id);

      const outcome = await withTransactionalAudit(
        auditActor(req),
        {
          action: 'task.kill',
          targetKind: 'task',
          targetId: req.params.id,
          reason: adminReason(req),
          params: { remoteCancelled: remote.ok, remoteError: remote.error ?? null },
        },
        async (tx) => {
          const changed = await killTask(tx, req.params.id, remote);
          if (!changed) throw new AdminGuardError(404, 'not_found', 'Task not found');
          return { result: changed, before: changed.before, after: changed.after };
        }
      );

      afterKill(req.params.id, outcome.workspaceId, remote);
      res.json({ success: true, data: { ...outcome.after, remoteCancelled: remote.ok } });
    })
  );

  return router;
}
