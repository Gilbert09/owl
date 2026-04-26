import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { tasks as tasksTable } from '../db/schema.js';
import { emitTaskUpdate } from './websocket.js';

/**
 * Per-task serializer for `tasks.metadata` read-modify-write patches.
 *
 * Why this exists: `gitService.runGit` records each git command via a
 * fire-and-forget `void recordGitCommand(...)`. That writes
 * `metadata.gitLog` asynchronously, on its own write chain. Other
 * metadata writers (autoCommit status, finalFiles snapshot,
 * pullRequest result, scheduler rollback marker) used to do their own
 * `SELECT metadata → modify → UPDATE` outside that chain — so a slow
 * writer's UPDATE could land after a concurrent gitLog UPDATE,
 * silently clobbering the just-appended entries (and vice versa,
 * losing the autoCommit field).
 *
 * Forensic on the user's prod DB found tasks where the autoCommit
 * commit DID happen — SHA is real, on origin — but `metadata.autoCommit`
 * came out `undefined` AND the matching gitLog entries (`add -A`,
 * `commit -m`, etc.) were missing, while later cleanup entries
 * survived. Classic stale-write race.
 *
 * This serializer makes every patch share one chain per taskId. Each
 * patch runs SELECT → user fn → UPDATE → emit, head-of-line, in order.
 * Different taskIds run independently. The fire-and-forget gitLog
 * writer also routes through here — same chain, no torn writes
 * between gitLog and autoCommit/finalFiles/PR writers.
 */

export type MetadataPatch = (
  existing: Record<string, unknown>
) => Record<string, unknown>;

export interface PatchResult {
  metadata: Record<string, unknown>;
  workspaceId: string;
}

const chains = new Map<string, Promise<unknown>>();

/**
 * Apply `patch` to `tasks.metadata` for `taskId`, serialized against
 * every other patch + gitLog write for the same taskId.
 *
 * Returns `{ metadata, workspaceId }` on success — workspaceId is
 * exposed so callers that emit their own dedicated WS events (e.g.
 * the gitLog writer) can target the right room without re-querying.
 *
 * Returns `null` if the task row no longer exists. Throws are
 * propagated to the caller; the chain swallows the error so the
 * next patch isn't poisoned.
 */
export async function patchTaskMetadata(
  taskId: string,
  patch: MetadataPatch
): Promise<PatchResult | null> {
  const prev = chains.get(taskId) ?? Promise.resolve();
  const next = prev.then(() => runPatch(taskId, patch));
  chains.set(
    taskId,
    next.catch(() => {})
  );
  return (await next) as PatchResult | null;
}

/**
 * Drain the current per-task chain — resolves once every queued
 * patch + log write for `taskId` has settled. Lets callers force a
 * sync point before reading metadata back.
 */
export async function drainTaskMetadata(taskId: string): Promise<void> {
  const head = chains.get(taskId);
  if (!head) return;
  await head;
}

/**
 * Test-only: clear all chains. Lets tests start each case with a
 * clean serializer.
 */
export function _resetTaskMetadataMutex(): void {
  chains.clear();
}

async function runPatch(
  taskId: string,
  patch: MetadataPatch
): Promise<PatchResult | null> {
  const db = getDbClient();
  const rows = await db
    .select({
      metadata: tasksTable.metadata,
      workspaceId: tasksTable.workspaceId,
    })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const existing = (row.metadata as Record<string, unknown>) ?? {};
  const next = patch(existing);

  await db
    .update(tasksTable)
    .set({ metadata: next, updatedAt: new Date() })
    .where(eq(tasksTable.id, taskId));

  emitTaskUpdate(row.workspaceId, taskId, { metadata: next });
  return { metadata: next, workspaceId: row.workspaceId };
}
