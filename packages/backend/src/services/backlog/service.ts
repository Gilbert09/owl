import { v4 as uuid } from 'uuid';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  BacklogItem,
  BacklogSource,
  BacklogSourceConfig,
  BacklogSourceType,
  MarkdownFileBacklogConfig,
} from '@fastowl/shared';
import { getDbClient, type Database } from '../../db/client.js';
import {
  backlogSources as backlogSourcesTable,
  backlogItems as backlogItemsTable,
} from '../../db/schema.js';
import { environmentService } from '../environment.js';
import { parseMarkdownBacklog, type ParsedBacklogItem } from './parser.js';

export interface SyncResult {
  added: number;
  updated: number;
  retired: number;
}

class BacklogService {
  private get db(): Database {
    return getDbClient();
  }

  async init(): Promise<void> {
    // No-op — DB access goes through getDbClient(). Kept for parity with
    // other services' lifecycle (future interval wiring can live here).
  }

  // ---------- Sources ----------

  async listSources(workspaceId: string): Promise<BacklogSource[]> {
    const rows = await this.db
      .select()
      .from(backlogSourcesTable)
      .where(eq(backlogSourcesTable.workspaceId, workspaceId))
      .orderBy(asc(backlogSourcesTable.createdAt));
    return rows.map(rowToSource);
  }

  async getSource(id: string): Promise<BacklogSource | null> {
    const rows = await this.db
      .select()
      .from(backlogSourcesTable)
      .where(eq(backlogSourcesTable.id, id))
      .limit(1);
    return rows[0] ? rowToSource(rows[0]) : null;
  }

  async createSource(input: {
    workspaceId: string;
    type: BacklogSourceType;
    config: BacklogSourceConfig;
    environmentId?: string;
    repositoryId?: string;
    enabled?: boolean;
  }): Promise<BacklogSource> {
    const id = uuid();
    const now = new Date();
    await this.db.insert(backlogSourcesTable).values({
      id,
      workspaceId: input.workspaceId,
      type: input.type,
      enabled: input.enabled !== false,
      environmentId: input.environmentId ?? null,
      repositoryId: input.repositoryId ?? null,
      config: input.config,
      createdAt: now,
      updatedAt: now,
    });
    const created = await this.getSource(id);
    if (!created) throw new Error(`Backlog source ${id} vanished immediately after insert`);
    return created;
  }

  async updateSource(
    id: string,
    patch: {
      enabled?: boolean;
      environmentId?: string;
      repositoryId?: string;
      config?: BacklogSourceConfig;
    }
  ): Promise<BacklogSource | null> {
    const existing = await this.getSource(id);
    if (!existing) return null;

    const updates: Record<string, unknown> = {};
    if (patch.enabled !== undefined) updates.enabled = patch.enabled;
    if (patch.environmentId !== undefined) updates.environmentId = patch.environmentId || null;
    if (patch.repositoryId !== undefined) updates.repositoryId = patch.repositoryId || null;
    if (patch.config !== undefined) updates.config = patch.config;

    if (Object.keys(updates).length === 0) return existing;

    updates.updatedAt = new Date();
    await this.db
      .update(backlogSourcesTable)
      .set(updates)
      .where(eq(backlogSourcesTable.id, id));
    return this.getSource(id);
  }

  async deleteSource(id: string): Promise<boolean> {
    const result = await this.db
      .delete(backlogSourcesTable)
      .where(eq(backlogSourcesTable.id, id))
      .returning({ id: backlogSourcesTable.id });
    return result.length > 0;
  }

  // ---------- Items ----------

  async listItems(sourceId: string): Promise<BacklogItem[]> {
    const rows = await this.db
      .select()
      .from(backlogItemsTable)
      .where(eq(backlogItemsTable.sourceId, sourceId))
      .orderBy(asc(backlogItemsTable.orderIndex));
    return rows.map(rowToItem);
  }

  async listItemsForWorkspace(workspaceId: string): Promise<BacklogItem[]> {
    const rows = await this.db
      .select()
      .from(backlogItemsTable)
      .where(eq(backlogItemsTable.workspaceId, workspaceId))
      .orderBy(asc(backlogItemsTable.orderIndex));
    return rows.map(rowToItem);
  }

  /**
   * Read the source's content and upsert items. Items that vanish from the
   * source get marked `completed` (rather than deleted) so the historical
   * task→item link survives.
   */
  async syncSource(sourceId: string): Promise<SyncResult> {
    const source = await this.getSource(sourceId);
    if (!source) throw new Error(`Backlog source ${sourceId} not found`);

    const content = await readSourceContent(source);
    const parsed = parseSourceContent(source.config, content);

    const existingItems = await this.listItems(sourceId);
    const existingByExternalId = new Map(existingItems.map((it) => [it.externalId, it]));
    const parsedExternalIds = new Set(parsed.map((it) => it.externalId));
    const now = new Date();

    let added = 0;
    let updated = 0;
    let retired = 0;

    await this.db.transaction(async (tx) => {
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

          await tx
            .update(backlogItemsTable)
            .set({
              text: item.text,
              parentExternalId: item.parentExternalId ?? null,
              completed: item.completed,
              blocked: item.blocked,
              orderIndex: item.orderIndex,
              updatedAt: now,
            })
            .where(eq(backlogItemsTable.id, existing.id));
        } else {
          added++;
          await tx.insert(backlogItemsTable).values({
            id: uuid(),
            sourceId,
            workspaceId: source.workspaceId,
            externalId: item.externalId,
            text: item.text,
            parentExternalId: item.parentExternalId ?? null,
            completed: item.completed,
            blocked: item.blocked,
            orderIndex: item.orderIndex,
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      for (const existing of existingItems) {
        if (!parsedExternalIds.has(existing.externalId) && !existing.completed) {
          await tx
            .update(backlogItemsTable)
            .set({ completed: true, updatedAt: now })
            .where(eq(backlogItemsTable.id, existing.id));
          retired++;
        }
      }

      await tx
        .update(backlogSourcesTable)
        .set({ lastSyncedAt: now, updatedAt: now })
        .where(eq(backlogSourcesTable.id, sourceId));
    });

    return { added, updated, retired };
  }

  /** Claim an item: mark it as owned by a task. */
  async claimItem(itemId: string, taskId: string): Promise<void> {
    await this.db
      .update(backlogItemsTable)
      .set({ claimedTaskId: taskId, updatedAt: new Date() })
      .where(eq(backlogItemsTable.id, itemId));
  }

  /** Release an item (e.g. its task failed or was cancelled). */
  async releaseItem(itemId: string): Promise<void> {
    await this.db
      .update(backlogItemsTable)
      .set({ claimedTaskId: null, updatedAt: new Date() })
      .where(eq(backlogItemsTable.id, itemId));
  }

  /** Mark an item completed — used when a task wrapping it is approved. */
  async completeItem(itemId: string): Promise<void> {
    await this.db
      .update(backlogItemsTable)
      .set({ completed: true, updatedAt: new Date() })
      .where(eq(backlogItemsTable.id, itemId));
  }

  /**
   * Pick the next actionable item from a source: unblocked, not completed,
   * not claimed, in source order. Returns null if nothing's ready.
   */
  async nextActionableItem(sourceId: string): Promise<BacklogItem | null> {
    const rows = await this.db
      .select()
      .from(backlogItemsTable)
      .where(
        and(
          eq(backlogItemsTable.sourceId, sourceId),
          eq(backlogItemsTable.completed, false),
          eq(backlogItemsTable.blocked, false),
          isNull(backlogItemsTable.claimedTaskId)
        )
      )
      .orderBy(asc(backlogItemsTable.orderIndex))
      .limit(1);
    return rows[0] ? rowToItem(rows[0]) : null;
  }

  async findByClaimedTask(taskId: string): Promise<BacklogItem | null> {
    const rows = await this.db
      .select()
      .from(backlogItemsTable)
      .where(eq(backlogItemsTable.claimedTaskId, taskId))
      .limit(1);
    return rows[0] ? rowToItem(rows[0]) : null;
  }
}

export const backlogService = new BacklogService();

// ---------- helpers ----------

async function readSourceContent(source: BacklogSource): Promise<string> {
  if (source.config.type === 'markdown_file') {
    const envId = source.environmentId ?? (await firstAvailableEnvironmentId());
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

/**
 * Pick a sensible default environment for ad-hoc work (e.g. syncing a
 * backlog source that didn't specify one). Prefers local; falls back
 * to any connected daemon. Returns null if nothing executable exists.
 */
async function firstAvailableEnvironmentId(): Promise<string | null> {
  const envs = await environmentService.getAllEnvironments();
  const local = envs.find((e) => e.type === 'local');
  if (local) return local.id;
  const daemon = envs.find((e) => e.type === 'daemon' && e.status === 'connected');
  return daemon?.id ?? null;
}

function escapeShell(value: string): string {
  return value.replace(/(["\\$`])/g, '\\$1');
}

function rowToSource(row: typeof backlogSourcesTable.$inferSelect): BacklogSource {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as BacklogSource['type'],
    enabled: row.enabled,
    environmentId: row.environmentId ?? undefined,
    repositoryId: row.repositoryId ?? undefined,
    config: row.config as BacklogSourceConfig,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToItem(row: typeof backlogItemsTable.$inferSelect): BacklogItem {
  return {
    id: row.id,
    sourceId: row.sourceId,
    workspaceId: row.workspaceId,
    externalId: row.externalId,
    text: row.text,
    parentExternalId: row.parentExternalId ?? undefined,
    completed: row.completed,
    blocked: row.blocked,
    claimedTaskId: row.claimedTaskId ?? undefined,
    orderIndex: row.orderIndex,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
