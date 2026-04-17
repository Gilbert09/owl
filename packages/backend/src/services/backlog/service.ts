import { v4 as uuid } from 'uuid';
import type {
  BacklogItem,
  BacklogSource,
  BacklogSourceConfig,
  BacklogSourceType,
  MarkdownFileBacklogConfig,
} from '@fastowl/shared';
import { DB } from '../../db/index.js';
import { environmentService } from '../environment.js';
import { parseMarkdownBacklog, type ParsedBacklogItem } from './parser.js';

export interface SyncResult {
  added: number;
  updated: number;
  retired: number;
}

class BacklogService {
  private db: DB | null = null;

  init(db: DB): void {
    this.db = db;
  }

  // ---------- Sources ----------

  listSources(workspaceId: string): BacklogSource[] {
    const db = this.requireDb();
    const rows = db
      .prepare('SELECT * FROM backlog_sources WHERE workspace_id = ? ORDER BY created_at ASC')
      .all(workspaceId);
    return rows.map((row) => rowToSource(row));
  }

  getSource(id: string): BacklogSource | null {
    const db = this.requireDb();
    const row = db.prepare('SELECT * FROM backlog_sources WHERE id = ?').get(id);
    return row ? rowToSource(row) : null;
  }

  createSource(input: {
    workspaceId: string;
    type: BacklogSourceType;
    config: BacklogSourceConfig;
    environmentId?: string;
    enabled?: boolean;
  }): BacklogSource {
    const db = this.requireDb();
    const id = uuid();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO backlog_sources (id, workspace_id, type, enabled, environment_id, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.workspaceId,
      input.type,
      input.enabled === false ? 0 : 1,
      input.environmentId ?? null,
      JSON.stringify(input.config),
      now,
      now
    );
    return this.getSource(id)!;
  }

  updateSource(
    id: string,
    patch: { enabled?: boolean; environmentId?: string; config?: BacklogSourceConfig }
  ): BacklogSource | null {
    const db = this.requireDb();
    const existing = this.getSource(id);
    if (!existing) return null;

    const updates: string[] = [];
    const values: unknown[] = [];

    if (patch.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(patch.enabled ? 1 : 0);
    }
    if (patch.environmentId !== undefined) {
      updates.push('environment_id = ?');
      values.push(patch.environmentId || null);
    }
    if (patch.config !== undefined) {
      updates.push('config = ?');
      values.push(JSON.stringify(patch.config));
    }

    if (updates.length === 0) return existing;

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE backlog_sources SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return this.getSource(id);
  }

  deleteSource(id: string): boolean {
    const db = this.requireDb();
    const result = db.prepare('DELETE FROM backlog_sources WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ---------- Items ----------

  listItems(sourceId: string): BacklogItem[] {
    const db = this.requireDb();
    const rows = db
      .prepare('SELECT * FROM backlog_items WHERE source_id = ? ORDER BY order_index ASC')
      .all(sourceId);
    return rows.map((row) => rowToItem(row));
  }

  listItemsForWorkspace(workspaceId: string): BacklogItem[] {
    const db = this.requireDb();
    const rows = db
      .prepare('SELECT * FROM backlog_items WHERE workspace_id = ? ORDER BY order_index ASC')
      .all(workspaceId);
    return rows.map((row) => rowToItem(row));
  }

  /**
   * Read the source's content from its environment and upsert items.
   *
   * Items that were present before but aren't in the new parse are marked
   * completed (they either got checked off or were removed outright). Keeping
   * them around preserves the history of which task implemented which item.
   */
  async syncSource(sourceId: string): Promise<SyncResult> {
    const db = this.requireDb();
    const source = this.getSource(sourceId);
    if (!source) throw new Error(`Backlog source ${sourceId} not found`);

    const content = await readSourceContent(source);
    const parsed = parseSourceContent(source.config, content);

    const existingItems = this.listItems(sourceId);
    const existingByExternalId = new Map(existingItems.map((it) => [it.externalId, it]));
    const parsedExternalIds = new Set(parsed.map((it) => it.externalId));
    const now = new Date().toISOString();

    let added = 0;
    let updated = 0;
    let retired = 0;

    const upsert = db.prepare(
      `INSERT INTO backlog_items
         (id, source_id, workspace_id, external_id, text, parent_external_id, completed, blocked, order_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, external_id) DO UPDATE SET
         text = excluded.text,
         parent_external_id = excluded.parent_external_id,
         completed = excluded.completed,
         blocked = excluded.blocked,
         order_index = excluded.order_index,
         updated_at = excluded.updated_at`
    );

    const retire = db.prepare(
      `UPDATE backlog_items SET completed = 1, updated_at = ? WHERE id = ?`
    );

    const tx = db.transaction(() => {
      for (const item of parsed) {
        const existing = existingByExternalId.get(item.externalId);
        if (existing) {
          const differs =
            existing.text !== item.text ||
            (existing.parentExternalId ?? null) !== (item.parentExternalId ?? null) ||
            existing.completed !== item.completed ||
            existing.blocked !== item.blocked ||
            existing.orderIndex !== item.orderIndex;
          if (differs) updated++;
        } else {
          added++;
        }
        upsert.run(
          existing?.id ?? uuid(),
          sourceId,
          source.workspaceId,
          item.externalId,
          item.text,
          item.parentExternalId ?? null,
          item.completed ? 1 : 0,
          item.blocked ? 1 : 0,
          item.orderIndex,
          existing?.createdAt ?? now,
          now
        );
      }

      for (const existing of existingItems) {
        if (!parsedExternalIds.has(existing.externalId) && !existing.completed) {
          retire.run(now, existing.id);
          retired++;
        }
      }

      db.prepare('UPDATE backlog_sources SET last_synced_at = ?, updated_at = ? WHERE id = ?').run(
        now,
        now,
        sourceId
      );
    });
    tx();

    return { added, updated, retired };
  }

  /** Claim an item: mark it as owned by a task. */
  claimItem(itemId: string, taskId: string): void {
    const db = this.requireDb();
    db.prepare(
      `UPDATE backlog_items SET claimed_task_id = ?, updated_at = ? WHERE id = ?`
    ).run(taskId, new Date().toISOString(), itemId);
  }

  /** Release an item (e.g. its task failed or was cancelled). */
  releaseItem(itemId: string): void {
    const db = this.requireDb();
    db.prepare(
      `UPDATE backlog_items SET claimed_task_id = NULL, updated_at = ? WHERE id = ?`
    ).run(new Date().toISOString(), itemId);
  }

  /** Mark an item completed — used when a task wrapping it is approved. */
  completeItem(itemId: string): void {
    const db = this.requireDb();
    db.prepare(
      `UPDATE backlog_items SET completed = 1, updated_at = ? WHERE id = ?`
    ).run(new Date().toISOString(), itemId);
  }

  /**
   * Pick the next actionable item from a source: unblocked, not completed,
   * not claimed, in source order. Returns null if nothing's ready.
   */
  nextActionableItem(sourceId: string): BacklogItem | null {
    const db = this.requireDb();
    const row = db
      .prepare(
        `SELECT * FROM backlog_items
         WHERE source_id = ? AND completed = 0 AND blocked = 0 AND claimed_task_id IS NULL
         ORDER BY order_index ASC
         LIMIT 1`
      )
      .get(sourceId);
    return row ? rowToItem(row) : null;
  }

  findByClaimedTask(taskId: string): BacklogItem | null {
    const db = this.requireDb();
    const row = db.prepare('SELECT * FROM backlog_items WHERE claimed_task_id = ?').get(taskId);
    return row ? rowToItem(row) : null;
  }

  private requireDb(): DB {
    if (!this.db) throw new Error('Backlog service not initialized');
    return this.db;
  }
}

export const backlogService = new BacklogService();

// ---------- helpers ----------

async function readSourceContent(source: BacklogSource): Promise<string> {
  if (source.config.type === 'markdown_file') {
    const envId = source.environmentId ?? (await firstLocalEnvironmentId());
    if (!envId) throw new Error('No environment available to read backlog source');
    const { stdout, code } = await environmentService.exec(
      envId,
      `cat "${escapeShell(source.config.path)}"`
    );
    if (code !== 0) {
      throw new Error(`Failed to read ${source.config.path} (exit ${code})`);
    }
    return stdout;
  }
  throw new Error(`Unsupported backlog source type: ${(source.config as { type: string }).type}`);
}

function parseSourceContent(
  config: BacklogSourceConfig,
  content: string
): ParsedBacklogItem[] {
  if (config.type === 'markdown_file') {
    const md = config as MarkdownFileBacklogConfig;
    return parseMarkdownBacklog(content, { section: md.section });
  }
  return [];
}

async function firstLocalEnvironmentId(): Promise<string | null> {
  const envs = environmentService.getAllEnvironments();
  return envs.find((e) => e.type === 'local')?.id ?? null;
}

function escapeShell(value: string): string {
  return value.replace(/(["\\$`])/g, '\\$1');
}

function rowToSource(row: any): BacklogSource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    enabled: row.enabled === 1,
    environmentId: row.environment_id || undefined,
    config: JSON.parse(row.config),
    lastSyncedAt: row.last_synced_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToItem(row: any): BacklogItem {
  return {
    id: row.id,
    sourceId: row.source_id,
    workspaceId: row.workspace_id,
    externalId: row.external_id,
    text: row.text,
    parentExternalId: row.parent_external_id || undefined,
    completed: row.completed === 1,
    blocked: row.blocked === 1,
    claimedTaskId: row.claimed_task_id || undefined,
    orderIndex: row.order_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
