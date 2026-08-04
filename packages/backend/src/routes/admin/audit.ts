import { Router } from 'express';
import type { ApiResponse } from '@talyn/shared';
import { listAuditEntries } from '../../services/admin/audit.js';

/**
 * The audit trail's read side.
 *
 * There is no delete and no update, deliberately: from outside the database
 * the log is append-only, and that is most of what makes it worth having. An
 * operator who can erase the record of their own action has an audit log in
 * name only.
 */
export function adminAuditRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const page = await listAuditEntries({
      actorId: req.query.actorId,
      action: req.query.action,
      targetKind: req.query.targetKind,
      targetId: req.query.targetId,
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({ success: true, data: page } as ApiResponse<typeof page>);
  });

  return router;
}
