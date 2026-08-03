import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  ADMIN_CONFIRM_MISMATCH,
  ADMIN_GRANT_DISABLED,
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_REQUIRED,
  ADMIN_SELF_MUTATION_FORBIDDEN,
  type AdminCapability,
} from '@talyn/shared';
import { rateLimit } from '../../middleware/rateLimit.js';

/**
 * Guards for the operator console's mutating routes.
 *
 * These COMPOSE with `requireAdmin` rather than replacing it. `requireAdmin`
 * answers "is this an operator"; these answer "is this operator allowed to do
 * this specific thing, to this specific target, right now". Keeping them
 * separate means the read gate and the write gate cannot drift apart — there is
 * no path where relaxing one quietly relaxes the other.
 *
 * # Why guards at all, when there is one boolean and one operator
 *
 * Until now `is_admin` gated a read-only debug panel. It is about to gate
 * `plan_override` and `is_admin` itself. A roles table would be the textbook
 * answer and the wrong one here — there is one operator, and a permission model
 * nobody administers is a permission model that drifts out of date. What is
 * worth having is a handful of cheap, specific refusals that make the two
 * genuinely dangerous mutations hard to perform by accident and impossible to
 * perform invisibly.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireReason`. Every audit row's `reason` comes from here. */
      adminReason?: string;
    }
  }
}

/**
 * A refusal the admin routes can throw from anywhere and have mapped once.
 *
 * Throwing rather than writing the response inline is what lets a guard live
 * inside a handler (where it can see the target row) instead of only in the
 * middleware chain (where it can only see the URL).
 */
export class AdminGuardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminGuardError';
  }
}

export function handleAdminGuardError(err: unknown, res: Response): boolean {
  if (!(err instanceof AdminGuardError)) return false;
  res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return true;
}

/**
 * Every mutating route requires a reason, in the JSON body.
 *
 * One channel in — not a header, not a query param — because one channel is one
 * thing to test and one thing to get wrong. The reason is persisted verbatim on
 * the audit row; a reason gate that does not persist the reason is theatre.
 */
export const requireReason: RequestHandler = (req, res, next) => {
  const raw = (req.body as { reason?: unknown } | undefined)?.reason;
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (!reason) {
    res
      .status(400)
      .json({ success: false, error: 'A reason is required.', code: ADMIN_REASON_REQUIRED });
    return;
  }
  if (reason.length > ADMIN_REASON_MAX_LENGTH) {
    res.status(400).json({
      success: false,
      error: `Reason must be ${ADMIN_REASON_MAX_LENGTH} characters or fewer.`,
      code: ADMIN_REASON_REQUIRED,
    });
    return;
  }
  req.adminReason = reason;
  next();
};

/** The reason `requireReason` accepted. Throws if the guard was not applied. */
export function adminReason(req: Request): string {
  const reason = req.adminReason;
  if (!reason) {
    // A programming error, not a user one: a mutating route was wired up
    // without requireReason in front of it, and the audit row would have been
    // written with an empty reason.
    throw new Error('adminReason() called on a route without requireReason');
  }
  return reason;
}

/**
 * Refuse a mutation whose target is the caller.
 *
 * Blocks two things at once: the quiet self-comp, and the "operator demotes
 * self, nobody can get back in" foot-gun. If you genuinely need to comp your
 * own account, that is what psql is for — and the fact that it leaves shell
 * history instead of a silent API call is the feature, not the inconvenience.
 */
export function notSelf(req: Request, targetUserId: string): void {
  if (req.user?.id && req.user.id === targetUserId) {
    throw new AdminGuardError(
      403,
      ADMIN_SELF_MUTATION_FORBIDDEN,
      'You cannot perform this action on your own account.'
    );
  }
}

/**
 * Require the caller to have typed the target's email.
 *
 * The "type the repo name to delete it" pattern. No new server state, no TTL,
 * no token endpoint — and it makes a mis-clicked table row or a blind
 * cross-site POST unexecutable, because either would have to already know which
 * specific account it meant. Compared case-insensitively: the operator is
 * reading the address off the screen, not proving they can match its casing.
 */
export function requireConfirm(req: Request, expectedEmail: string): void {
  const raw = (req.body as { confirm?: unknown } | undefined)?.confirm;
  const confirm = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!confirm || confirm !== expectedEmail.trim().toLowerCase()) {
    throw new AdminGuardError(
      400,
      ADMIN_CONFIRM_MISMATCH,
      "Type the target account's email address to confirm."
    );
  }
}

/**
 * Whether this deploy permits minting another operator.
 *
 * Default OFF. Granting admin is the one mutation that permanently widens the
 * blast radius of every other mutation, so it sits behind a deploy-time flag
 * rather than a runtime check: a stolen operator session can read and comp —
 * bad, but auditable and reversible — and cannot create a second operator to
 * survive the first being revoked.
 */
export function adminGrantEnabled(): boolean {
  return process.env.TALYN_ADMIN_GRANT_ENABLED === '1';
}

export function requireAdminGrantEnabled(): void {
  if (!adminGrantEnabled()) {
    throw new AdminGuardError(
      403,
      ADMIN_GRANT_DISABLED,
      'Granting admin is disabled on this deployment (TALYN_ADMIN_GRANT_ENABLED).'
    );
  }
}

/**
 * What this deploy lets an operator do, reported by `GET /admin/me`.
 *
 * The console uses it to hide a button the server would refuse. It is NOT the
 * permission model — every one of these is re-checked server-side on the call
 * itself. This is the UI's copy of the answer, and it being a copy is why it is
 * safe for it to be wrong.
 */
export function adminCapabilities(): AdminCapability[] {
  const caps: AdminCapability[] = [
    'fleet.read',
    'fleet.mutate',
    'product.read',
    'product.comp',
    'product.task_mutate',
  ];
  if (adminGrantEnabled()) caps.push('product.grant_admin');
  return caps;
}

/**
 * A tighter budget for mutations than for reads.
 *
 * Operators click; they do not script. 20/min is far above any real rate of
 * deliberate, reasoned actions and far below anything that looks like a loop —
 * so a runaway retry or a stuck confirm dialog stops before it drains a fleet
 * host one call at a time.
 */
export function adminMutationLimit(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    max: 20,
    keyFn: (req: Request) => req.user?.id ?? req.ip ?? 'unknown',
    message: 'Too many admin mutations — slow down.',
  });
}

/**
 * Wrap a handler so AdminGuardError becomes its response and anything else
 * propagates to the API error handler untouched.
 */
export function withGuards(
  fn: (req: Request, res: Response) => Promise<void> | void
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!handleAdminGuardError(err, res)) next(err);
    }
  };
}
