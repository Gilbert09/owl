import { EventEmitter } from 'events';
import { randomBytes, timingSafeEqual } from 'crypto';
import { v4 as uuid } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import type { PermissionDecision, PermissionRequest } from '@fastowl/shared';
import { getDbClient, type Database } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';

/**
 * If the user doesn't respond in this long, the hook auto-denies. The
 * CLI itself can handle longer-running prompts, but we'd rather fail
 * fast than leave a subshell wedged forever waiting for a click.
 */
const DECISION_TIMEOUT_MS = 10 * 60 * 1000;

export interface PermissionContext {
  agentId: string;
  environmentId: string;
  workspaceId: string;
  taskId?: string;
  sessionId?: string;
}

export interface PendingRequest extends PermissionRequest {
  /** Opaque token the child hook must present; proves the request is genuine. */
  runToken: string;
  environmentId: string;
  resolve: (value: { decision: PermissionDecision; reason?: string }) => void;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

/**
 * In-process registry of in-flight permission prompts. Owns two sides:
 *
 *   - **Hook side** (`requestDecision`): called by `agentStructuredService`
 *     when the child's PreToolUse hook POSTs in. Either hits the env
 *     allowlist and resolves immediately, or registers a pending entry
 *     and returns a Promise that resolves when the desktop responds.
 *
 *   - **UI side** (`respond`): called by the Express route the desktop
 *     hits. Looks up the pending entry by `requestId`, resolves it,
 *     optionally persists the tool into the env's allowlist.
 *
 * The `runToken` layer exists so a malicious process on the same host
 * can't POST arbitrary permission requests to the backend — only the
 * child we spawned knows the token for that specific run.
 */
class PermissionService extends EventEmitter {
  private pending: Map<string, PendingRequest> = new Map();
  /** Map: runToken → environmentId. Set when the structured run starts. */
  private runTokens: Map<string, { environmentId: string; agentId: string; taskId?: string }> =
    new Map();

  private get db(): Database {
    return getDbClient();
  }

  /** Mint a per-run token. Passed into the child env; hook sends it back. */
  registerRun(ctx: PermissionContext): string {
    const token = randomBytes(24).toString('hex');
    this.runTokens.set(token, {
      environmentId: ctx.environmentId,
      agentId: ctx.agentId,
      taskId: ctx.taskId,
    });
    return token;
  }

  /** Call when the run ends so the token can't be reused. */
  unregisterRun(token: string): void {
    this.runTokens.delete(token);
    // Resolve any still-pending requests on this token as denied so
    // the CLI doesn't hang if it was waiting when we got killed.
    for (const [id, req] of this.pending) {
      if (req.runToken === token) {
        clearTimeout(req.timer);
        req.resolve({ decision: 'deny', reason: 'agent terminated before decision' });
        this.pending.delete(id);
      }
    }
  }

  /**
   * Validate a hook-side token (timing-safe). Returns the run's
   * context, or null if the token is bogus.
   */
  verifyRunToken(
    token: string | undefined
  ): { environmentId: string; agentId: string; taskId?: string } | null {
    if (!token) return null;
    for (const [stored, ctx] of this.runTokens) {
      if (stored.length !== token.length) continue;
      const a = Buffer.from(stored);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return ctx;
    }
    return null;
  }

  /**
   * The child's hook just asked to use `toolName`. Decide, optionally
   * waiting on the user.
   *
   * Flow:
   *   1. Already in env allowlist → immediate allow.
   *   2. Otherwise register pending, emit 'request', await user click
   *      (or timeout → deny).
   */
  async requestDecision(
    runToken: string,
    toolName: string,
    toolInput: unknown,
    toolUseId: string | undefined,
    sessionId: string | undefined
  ): Promise<{ requestId: string; decision: PermissionDecision; reason?: string }> {
    const ctx = this.verifyRunToken(runToken);
    if (!ctx) {
      return { requestId: '(unknown-run)', decision: 'deny', reason: 'invalid run token' };
    }

    const allowed = await this.isPreApproved(ctx.environmentId, toolName);
    const requestId = uuid();

    if (allowed) {
      // Emit a synthetic record so the UI still shows the tool call was
      // gated but silently approved — keeps the transcript honest about
      // what ran under the user's standing approvals.
      const requestedAt = new Date().toISOString();
      this.emit('auto_allowed', {
        requestId,
        ...ctx,
        toolName,
        toolInput,
        toolUseId,
        sessionId,
        requestedAt,
      });
      return { requestId, decision: 'allow', reason: 'pre-approved for this environment' };
    }

    return new Promise((resolve) => {
      const requestedAt = new Date().toISOString();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ requestId, decision: 'deny', reason: 'approval timed out' });
        this.emit('expired', { requestId, ...ctx, toolName });
      }, DECISION_TIMEOUT_MS);

      const pending: PendingRequest = {
        requestId,
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        environmentId: ctx.environmentId,
        toolName,
        toolInput,
        toolUseId,
        sessionId,
        runToken,
        requestedAt,
        resolve: (value) => {
          clearTimeout(pending.timer);
          this.pending.delete(requestId);
          resolve({ requestId, ...value });
        },
        expiresAt: Date.now() + DECISION_TIMEOUT_MS,
        timer,
      };
      this.pending.set(requestId, pending);
      this.emit('request', pending);
    });
  }

  /**
   * Called by the desktop-facing route. Optionally persists the tool
   * onto the env's allowlist so the next request for the same tool is
   * instant.
   */
  async respond(
    requestId: string,
    decision: PermissionDecision,
    opts: { persist?: boolean; reason?: string } = {}
  ): Promise<boolean> {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    if (decision === 'allow' && opts.persist) {
      await this.addToAllowlist(pending.environmentId, pending.toolName).catch((err) => {
        console.error('[permissionService] allowlist persist failed:', err);
      });
    }

    pending.resolve({ decision, reason: opts.reason });
    this.emit('resolved', {
      requestId,
      decision,
      persist: Boolean(opts.persist),
      agentId: pending.agentId,
      taskId: pending.taskId,
      toolName: pending.toolName,
    });
    return true;
  }

  /** Enumerate currently-pending requests scoped to a task. For reconnect replay. */
  listPendingForTask(taskId: string): PendingRequest[] {
    const out: PendingRequest[] = [];
    for (const req of this.pending.values()) {
      if (req.taskId === taskId) out.push(req);
    }
    return out;
  }

  private async isPreApproved(environmentId: string, toolName: string): Promise<boolean> {
    const rows = await this.db
      .select({ toolAllowlist: environmentsTable.toolAllowlist })
      .from(environmentsTable)
      .where(eq(environmentsTable.id, environmentId))
      .limit(1);
    const list = (rows[0]?.toolAllowlist as string[] | null) ?? [];
    return list.includes(toolName);
  }

  private async addToAllowlist(environmentId: string, toolName: string): Promise<void> {
    // jsonb || jsonb merges arrays; we guard against duplicates by
    // reading first, but the race is benign — dupes are deduped on
    // read (Array.includes short-circuits).
    const rows = await this.db
      .select({ toolAllowlist: environmentsTable.toolAllowlist })
      .from(environmentsTable)
      .where(eq(environmentsTable.id, environmentId))
      .limit(1);
    const current = (rows[0]?.toolAllowlist as string[] | null) ?? [];
    if (current.includes(toolName)) return;
    const next = [...current, toolName];
    await this.db
      .update(environmentsTable)
      .set({ toolAllowlist: next, updatedAt: new Date() })
      .where(eq(environmentsTable.id, environmentId));
  }
}

export const permissionService = new PermissionService();
