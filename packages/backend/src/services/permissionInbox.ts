import { v4 as uuid } from 'uuid';
import { eq, and } from 'drizzle-orm';
import type { InboxItem } from '@fastowl/shared';
import { getDbClient, type Database } from '../db/client.js';
import { inboxItems as inboxItemsTable, tasks as tasksTable } from '../db/schema.js';
import { permissionService, type PendingRequest } from './permissionService.js';
import { emitInboxNew } from './websocket.js';

/**
 * Coalesces permission-prompt events into a single inbox item per task.
 *
 * Design: most strict-mode runs fire several PreToolUse prompts in a
 * row (agent tries a tool, we approve, agent tries another). Creating
 * one inbox item per prompt would swamp the inbox. Instead:
 *
 *   - First pending prompt on a task → insert an `agent_question`
 *     item, `data.pendingRequestIds` tracks open prompts.
 *   - Subsequent prompts on the same task → update the item's summary
 *     + counter, append to `pendingRequestIds`.
 *   - Each resolution removes the requestId from the item. When the
 *     list is empty → mark `actioned` (auto-dismiss).
 *
 * Lives in its own module so the service machinery stays testable
 * independently of inbox side-effects.
 */
interface TrackedItem {
  inboxItemId: string;
  taskId: string;
  workspaceId: string;
  pendingRequestIds: Set<string>;
  /**
   * Resolves once the initial INSERT for this item has landed in the
   * DB. Concurrent "update" requests await this before firing their
   * UPDATE — otherwise the UPDATE can land while the row still
   * doesn't exist, silently hitting 0 rows.
   */
  insertReady: Promise<void>;
}

class PermissionInboxService {
  /** Map task_id → tracked inbox entry. */
  private byTask: Map<string, TrackedItem> = new Map();

  private get db(): Database {
    return getDbClient();
  }

  /**
   * Subscribe to permissionService events. Idempotent — safe to call
   * once at backend init.
   */
  init(): void {
    permissionService.on('request', (pending: PendingRequest) => {
      this.onRequest(pending).catch((err) => {
        console.error('[permissionInbox] onRequest failed:', err);
      });
    });
    permissionService.on('resolved', (ev: { requestId: string; taskId?: string }) => {
      this.onResolved(ev).catch((err) => {
        console.error('[permissionInbox] onResolved failed:', err);
      });
    });
  }

  private async onRequest(pending: PendingRequest): Promise<void> {
    if (!pending.taskId) return;

    // Claim the task synchronously before any await. This is what
    // prevents two concurrent requests for the same task from both
    // taking the "create" branch and inserting two inbox rows.
    const existing = this.byTask.get(pending.taskId);
    if (existing) {
      existing.pendingRequestIds.add(pending.requestId);
      const count = existing.pendingRequestIds.size;
      // Wait for the initial insert to land before updating — a row
      // that doesn't exist can't be updated.
      await existing.insertReady.catch(() => {});
      await this.db
        .update(inboxItemsTable)
        .set({
          summary: `${pending.toolName} + ${count - 1} more tool${count > 2 ? 's' : ''} awaiting approval`,
          data: {
            pendingRequestIds: Array.from(existing.pendingRequestIds),
            latestTool: pending.toolName,
          },
        })
        .where(eq(inboxItemsTable.id, existing.inboxItemId));
      return;
    }

    const inboxId = uuid();
    let markInsertDone: () => void = () => {};
    let markInsertFailed: (err: unknown) => void = () => {};
    const insertReady = new Promise<void>((resolve, reject) => {
      markInsertDone = resolve;
      markInsertFailed = reject;
    });
    const tracked: TrackedItem = {
      inboxItemId: inboxId,
      taskId: pending.taskId,
      workspaceId: '', // filled below once we read the task row
      pendingRequestIds: new Set([pending.requestId]),
      insertReady,
    };
    this.byTask.set(pending.taskId, tracked);

    // Resolve workspace + title from the task row.
    const taskRows = await this.db
      .select({ workspaceId: tasksTable.workspaceId, title: tasksTable.title })
      .from(tasksTable)
      .where(eq(tasksTable.id, pending.taskId))
      .limit(1);
    if (!taskRows[0]) {
      // No such task — unclaim and bail. Let any waiters proceed (the
      // update will be a no-op against a missing inboxId).
      this.byTask.delete(pending.taskId);
      markInsertFailed(new Error(`task ${pending.taskId} not found`));
      return;
    }
    const { workspaceId, title } = taskRows[0];
    tracked.workspaceId = workspaceId;

    const item: InboxItem = {
      id: inboxId,
      workspaceId,
      type: 'agent_question',
      status: 'unread',
      priority: 'high',
      title: `Approve ${pending.toolName}?`,
      summary: `"${title}" needs approval for ${pending.toolName}`,
      source: { type: 'agent', id: pending.taskId, name: title },
      actions: [
        { id: '1', label: 'Review', type: 'primary', action: 'view_task' },
      ],
      data: {
        pendingRequestIds: Array.from(tracked.pendingRequestIds),
        latestTool: pending.toolName,
      },
      createdAt: new Date().toISOString(),
    };

    try {
      await this.db.insert(inboxItemsTable).values({
        id: inboxId,
        workspaceId,
        type: 'agent_question',
        status: 'unread',
        priority: 'high',
        title: item.title,
        summary: item.summary,
        source: item.source,
        actions: item.actions,
        data: item.data,
        createdAt: new Date(),
      });
      markInsertDone();
    } catch (err) {
      markInsertFailed(err);
      throw err;
    }

    emitInboxNew(workspaceId, item);
  }

  private async onResolved(ev: { requestId: string; taskId?: string }): Promise<void> {
    if (!ev.taskId) return;
    const tracked = this.byTask.get(ev.taskId);
    if (!tracked) return;
    tracked.pendingRequestIds.delete(ev.requestId);

    if (tracked.pendingRequestIds.size === 0) {
      // Last pending resolved — auto-action the item so it drops off
      // the "needs attention" list.
      this.byTask.delete(ev.taskId);
      await this.db
        .update(inboxItemsTable)
        .set({
          status: 'actioned',
          actionedAt: new Date(),
          data: { pendingRequestIds: [] },
        })
        .where(
          and(
            eq(inboxItemsTable.id, tracked.inboxItemId),
            // Only if it's still unread — respect a user who already
            // clicked through and actioned it some other way.
            eq(inboxItemsTable.status, 'unread')
          )
        );
      return;
    }

    // Still open prompts — just patch the counter.
    const remaining = tracked.pendingRequestIds.size;
    await this.db
      .update(inboxItemsTable)
      .set({
        summary:
          remaining === 1
            ? '1 tool awaiting approval'
            : `${remaining} tools awaiting approval`,
        data: { pendingRequestIds: Array.from(tracked.pendingRequestIds) },
      })
      .where(eq(inboxItemsTable.id, tracked.inboxItemId));
  }

  /** Test hook: reset in-memory state. */
  _resetForTests(): void {
    this.byTask.clear();
  }
}

export const permissionInboxService = new PermissionInboxService();
