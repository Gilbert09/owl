import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { randomBytes, timingSafeEqual } from 'crypto';
import { getDbClient } from '../db/client.js';
import {
  users as usersTable,
  workspaces as workspacesTable,
  environments as environmentsTable,
  tasks as tasksTable,
  agents as agentsTable,
  inboxItems as inboxItemsTable,
  repositories as repositoriesTable,
  backlogSources as backlogSourcesTable,
} from '../db/schema.js';
import { getSupabaseServiceClient } from '../services/supabase.js';

export interface AuthUser {
  id: string;
  email: string;
  githubUsername?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Parse the JWT from an `Authorization: Bearer <token>` header. Returns null
 * (not undefined) so callers can differentiate "header missing" from "header
 * malformed." We treat both as unauthenticated.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * Verify a Supabase access token and resolve to an app user. Does one
 * round-trip to Supabase's /auth/v1/user (via the service client). On first
 * sight of a user we upsert a row in our mirror `users` table so FK'd
 * ownership columns line up.
 *
 * Returns null on any failure — we never leak Supabase's underlying error
 * to the caller.
 */
export async function verifyTokenAndGetUser(token: string): Promise<AuthUser | null> {
  const supabase = getSupabaseServiceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  const email = data.user.email ?? '';
  const githubUsername =
    (data.user.user_metadata?.user_name as string | undefined) ??
    (data.user.user_metadata?.preferred_username as string | undefined);

  await enforceAllowList(email);

  const db = getDbClient();
  const now = new Date();
  await db
    .insert(usersTable)
    .values({
      id: data.user.id,
      email,
      githubUsername: githubUsername ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        email,
        githubUsername: githubUsername ?? null,
        updatedAt: now,
      },
    });

  return { id: data.user.id, email, githubUsername };
}

/**
 * Optional email allow-list. If FASTOWL_ALLOWED_EMAILS is set (comma-separated),
 * only those emails are permitted — convenient for the single-user phase.
 * Unset == everyone.
 *
 * Throws AuthError so the middleware turns it into a 403.
 */
async function enforceAllowList(email: string): Promise<void> {
  const raw = process.env.FASTOWL_ALLOWED_EMAILS;
  if (!raw) return;
  const allowed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(email.toLowerCase())) {
    throw new AuthError('forbidden', 'Email is not on the allow-list');
  }
}

export class AuthError extends Error {
  constructor(public code: 'unauthorized' | 'forbidden', message: string) {
    super(message);
  }
}

// ---------- Internal proxy auth ----------
//
// The daemon runs a local HTTP proxy on the VM that funnels REST calls
// from child processes (claude → fastowl / MCP) over its authenticated
// WS. On the backend side, the WS handler re-issues those requests as
// localhost HTTP calls with two headers:
//   - `X-Fastowl-Internal-User: <uuid>` — the user id the proxy should
//     act as (resolved from env.owner_id).
//   - `X-Fastowl-Internal-Token: <secret>` — a per-process secret that
//     proves the call originated inside this backend. Never leaves memory.
//
// The secret is minted once at boot with `randomBytes(48)` and held in
// a module-private closure. Loss of the process = loss of the secret,
// by design.

const INTERNAL_SECRET = randomBytes(48).toString('hex');

/** Backend-internal consumer — WS proxy handler — calls this to get the
 *  two headers it needs to dispatch an authenticated localhost request. */
export function internalProxyHeaders(userId: string): Record<string, string> {
  return {
    'x-fastowl-internal-user': userId,
    'x-fastowl-internal-token': INTERNAL_SECRET,
  };
}

/**
 * Check and consume the internal auth headers if present. Returns the
 * AuthUser when they're valid, null when absent, throws `AuthError`
 * when present-but-invalid (caller surfaces 401).
 */
async function checkInternalAuth(req: Request): Promise<AuthUser | null> {
  const providedToken = req.headers['x-fastowl-internal-token'];
  const providedUser = req.headers['x-fastowl-internal-user'];
  if (!providedToken || !providedUser) return null;
  if (typeof providedToken !== 'string' || typeof providedUser !== 'string') {
    throw new AuthError('unauthorized', 'Malformed internal auth headers');
  }

  // Constant-time comparison so timing attacks can't reveal the secret.
  // Pad to fixed length first (Buffer.from on a shorter/longer string
  // would length-leak on the timingSafeEqual call).
  const providedBuf = Buffer.from(providedToken);
  const expectedBuf = Buffer.from(INTERNAL_SECRET);
  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new AuthError('unauthorized', 'Invalid internal token');
  }

  // Resolve the user — internal requests always identify by user id.
  const db = getDbClient();
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, providedUser))
    .limit(1);
  if (!rows[0]) {
    throw new AuthError('unauthorized', 'Internal user not found');
  }
  return {
    id: rows[0].id,
    email: rows[0].email,
    githubUsername: rows[0].githubUsername ?? undefined,
  };
}

/**
 * Express middleware: requires a valid Supabase JWT. Populates `req.user`.
 * Any failure (missing, malformed, expired, forbidden) short-circuits with
 * 401/403 — downstream handlers can assume `req.user` is defined.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 1) Internal proxy headers take precedence. Set by the daemon WS
    //    handler making localhost calls on behalf of a device-token-
    //    authenticated daemon. No JWT round-trip to Supabase.
    const internalUser = await checkInternalAuth(req);
    if (internalUser) {
      req.user = internalUser;
      next();
      return;
    }

    // 2) Normal path: Supabase JWT from the Authorization header.
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ success: false, error: 'Missing bearer token' });
      return;
    }
    const user = await verifyTokenAndGetUser(token);
    if (!user) {
      res.status(401).json({ success: false, error: 'Invalid or expired token' });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    if (err instanceof AuthError && err.code === 'forbidden') {
      res.status(403).json({ success: false, error: err.message });
      return;
    }
    if (err instanceof AuthError && err.code === 'unauthorized') {
      res.status(401).json({ success: false, error: err.message });
      return;
    }
    console.error('Auth middleware failed:', err);
    res.status(500).json({ success: false, error: 'Auth check failed' });
  }
}

// ---------- Ownership helpers ----------
//
// Every resource traces back to either a workspace or an environment. Both
// carry owner_id. These helpers fetch + assert ownership in one call so
// routes can say `const ws = await requireWorkspaceAccess(req, id)` and
// not worry about the join pattern.

/**
 * Throws NotFound if the workspace doesn't exist OR doesn't belong to the
 * requester. We return 404 (not 403) so we don't leak existence.
 */
export async function requireWorkspaceAccess(
  req: Request,
  workspaceId: string
): Promise<void> {
  const userId = assertUser(req).id;
  const db = getDbClient();
  const rows = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  if (!rows[0]) throw new AccessError('workspace not found');

  const ownerRows = await db
    .select({ ownerId: workspacesTable.ownerId })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  if (ownerRows[0]?.ownerId !== userId) {
    throw new AccessError('workspace not found');
  }
}

/** Same as requireWorkspaceAccess but for environments. */
export async function requireEnvironmentAccess(
  req: Request,
  environmentId: string
): Promise<void> {
  const userId = assertUser(req).id;
  const db = getDbClient();
  const rows = await db
    .select({ ownerId: environmentsTable.ownerId })
    .from(environmentsTable)
    .where(eq(environmentsTable.id, environmentId))
    .limit(1);
  if (!rows[0] || rows[0].ownerId !== userId) {
    throw new AccessError('environment not found');
  }
}

/**
 * Look up a task's workspace, then assert ownership. Returns the task's
 * workspaceId so callers don't have to re-fetch.
 */
export async function requireTaskAccess(req: Request, taskId: string): Promise<string> {
  const db = getDbClient();
  const rows = await db
    .select({ workspaceId: tasksTable.workspaceId })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  if (!rows[0]) throw new AccessError('task not found');
  await requireWorkspaceAccess(req, rows[0].workspaceId);
  return rows[0].workspaceId;
}

/** Same as requireTaskAccess but for agents. Returns the agent's workspaceId. */
export async function requireAgentAccess(req: Request, agentId: string): Promise<string> {
  const db = getDbClient();
  const rows = await db
    .select({ workspaceId: agentsTable.workspaceId })
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1);
  if (!rows[0]) throw new AccessError('agent not found');
  await requireWorkspaceAccess(req, rows[0].workspaceId);
  return rows[0].workspaceId;
}

/** Inbox items are workspace-scoped. */
export async function requireInboxAccess(req: Request, itemId: string): Promise<string> {
  const db = getDbClient();
  const rows = await db
    .select({ workspaceId: inboxItemsTable.workspaceId })
    .from(inboxItemsTable)
    .where(eq(inboxItemsTable.id, itemId))
    .limit(1);
  if (!rows[0]) throw new AccessError('inbox item not found');
  await requireWorkspaceAccess(req, rows[0].workspaceId);
  return rows[0].workspaceId;
}

/** Repositories belong to a workspace. */
export async function requireRepositoryAccess(req: Request, repoId: string): Promise<string> {
  const db = getDbClient();
  const rows = await db
    .select({ workspaceId: repositoriesTable.workspaceId })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.id, repoId))
    .limit(1);
  if (!rows[0]) throw new AccessError('repository not found');
  await requireWorkspaceAccess(req, rows[0].workspaceId);
  return rows[0].workspaceId;
}

/** Backlog sources belong to a workspace. */
export async function requireBacklogSourceAccess(req: Request, sourceId: string): Promise<string> {
  const db = getDbClient();
  const rows = await db
    .select({ workspaceId: backlogSourcesTable.workspaceId })
    .from(backlogSourcesTable)
    .where(eq(backlogSourcesTable.id, sourceId))
    .limit(1);
  if (!rows[0]) throw new AccessError('source not found');
  await requireWorkspaceAccess(req, rows[0].workspaceId);
  return rows[0].workspaceId;
}

/** Narrow req.user from optional → required after requireAuth has run. */
export function assertUser(req: Request): AuthUser {
  if (!req.user) {
    throw new Error('assertUser called before requireAuth middleware');
  }
  return req.user;
}

export class AccessError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Convenience wrapper so route handlers can write:
 *   try { await requireWorkspaceAccess(req, id); } catch (e) { return handleAccessError(e, res); }
 */
export function handleAccessError(err: unknown, res: Response): void {
  if (err instanceof AccessError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  console.error('Unexpected access error:', err);
  res.status(500).json({ success: false, error: 'Internal error' });
}
