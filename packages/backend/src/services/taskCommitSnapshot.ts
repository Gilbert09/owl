import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { tasks as tasksTable } from '../db/schema.js';
import { gitService } from './git.js';
import { resolveTaskGitContext } from './gitContext.js';
import { generateCommitMessage } from './ai.js';
import { withTaskGitLog } from './gitLogService.js';
import { emitTaskUpdate } from './websocket.js';

export type AutoCommitResult =
  | { committed: true; sha: string; message: string }
  | {
      committed: false;
      reason: 'no-branch' | 'no-env' | 'no-repo' | 'no-changes' | 'error';
      error?: string;
    };

// Per-file diff cap — the snapshot gets stored as JSON in the `tasks`
// row, so we bound each diff to keep the payload reasonable. Files
// that exceed this get a truncation marker so the UI still shows
// *something*. Same value the pre-refactor approve path used.
const FILE_DIFF_CAP = 50_000;

/**
 * Commit the task branch's pending work + persist a file-list-and-
 * diffs snapshot onto `task.metadata.finalFiles`. Called on every
 * `in_progress → awaiting_review` transition.
 *
 * Keeping this separate from push/PR opens the door to:
 *   - The Files tab staying complete even when the env's offline
 *     (reads fall back to the snapshot).
 *   - The working tree being clean the moment the agent exits, so
 *     a new task can run against the same repo immediately.
 *   - Follow-up prompts stacking new commits on top of the branch
 *     instead of amending.
 *
 * Commit message: generated fresh via `generateCommitMessage`, same
 * helper the old approve path used.
 *
 * Failure policy: callers should still flip the task to
 * `awaiting_review` even when this returns `committed: false`.
 * Empty-changeset / env-offline cases are not fatal — the UI
 * gracefully falls back to whatever snapshot is on metadata.
 */
export async function autoCommitAndSnapshot(taskId: string): Promise<AutoCommitResult> {
  const tag = `[autoCommit ${taskId.slice(0, 8)}]`;
  console.log(`${tag}: start`);

  const db = getDbClient();
  const rows = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    console.warn(`${tag}: task row missing`);
    return { committed: false, reason: 'error', error: 'task not found' };
  }

  if (!row.branch) {
    console.log(`${tag}: no branch → skipping`);
    return { committed: false, reason: 'no-branch' };
  }
  if (!row.assignedEnvironmentId) {
    console.log(`${tag}: no assigned env → skipping`);
    return { committed: false, reason: 'no-env' };
  }

  const gitContext = await resolveTaskGitContext(
    {
      repositoryId: row.repositoryId ?? undefined,
      assignedEnvironmentId: row.assignedEnvironmentId,
    },
    row.assignedEnvironmentId
  );
  if (!gitContext) {
    console.log(`${tag}: repo has no localPath → skipping`);
    return { committed: false, reason: 'no-repo' };
  }

  const envId = row.assignedEnvironmentId;
  const branch = row.branch;
  const { workingDirectory, baseBranch } = gitContext;
  console.log(
    `${tag}: env=${envId} branch=${branch} base=${baseBranch} wd=${workingDirectory}`
  );

  // Wrap the whole body in `withTaskGitLog` (ctx.run) rather than
  // `enterTaskGitLog` (ctx.enterWith). The `run` variant establishes
  // a fresh AsyncLocalStorage scope that reliably propagates through
  // every awaited git call, including resolutions that continue in
  // pools/callbacks (daemon WS RPC, promise.all) — `enterWith` from
  // inside an event-emitter callback (handleStructuredExit) is
  // unreliable in that regard and can silently drop entries.
  const result = await withTaskGitLog<AutoCommitResult>(taskId, async () => {
    try {
      // Defensive checkout: the agent may have drifted off the branch
      // or never landed cleanly. Committing on the wrong branch is
      // exactly the silent-bug shape that produced "approve did
      // nothing" regressions in the old flow.
      const before = await gitService.getCurrentBranch(envId, workingDirectory);
      if (before !== branch) {
        console.warn(`${tag}: not on task branch (on ${before}); checking out ${branch}`);
        await gitService.checkoutBranch(envId, branch, workingDirectory);
        const after = await gitService.getCurrentBranch(envId, workingDirectory);
        if (after !== branch) {
          return {
            committed: false,
            reason: 'error',
            error: `could not switch to task branch ${branch} (still on ${after})`,
          } as const;
        }
      }

      const [diffStat, diff] = await Promise.all([
        gitService.getDiffStat(envId, branch, baseBranch, workingDirectory),
        gitService.getDiff(envId, branch, baseBranch, workingDirectory),
      ]);
      const message = await generateCommitMessage({
        title: row.title,
        prompt: row.prompt ?? undefined,
        diffStat,
        diff,
        preferredEnvId: envId,
      });

      const sha = await gitService.commitAll(envId, message, workingDirectory);
      if (!sha) {
        console.log(`${tag}: commitAll found nothing to stage (no-changes)`);
        return { committed: false, reason: 'no-changes' } as const;
      }

      await writeFinalFilesSnapshot(taskId, envId, baseBranch, workingDirectory, row, tag, branch);

      console.log(`${tag}: committed ${sha.slice(0, 10)} · ${message.split('\n')[0]}`);
      return { committed: true, sha, message } as const;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag}: auto-commit failed:`, err);
      return { committed: false, reason: 'error', error: msg } as const;
    }
  });

  // Persist success/failure state on metadata so the UI can surface
  // "auto-commit couldn't run" without the user having to tail
  // backend logs. Clears the error key on success.
  await persistAutoCommitStatus(taskId, result);
  return result;
}

/**
 * Writes a short status marker to `task.metadata.autoCommit` so the
 * desktop can show e.g. "commit deferred — env offline" on
 * awaiting_review. The metadata is visible to the approve handler's
 * safety-net call so it can tell whether a prior attempt succeeded.
 */
async function persistAutoCommitStatus(
  taskId: string,
  result: AutoCommitResult
): Promise<void> {
  const db = getDbClient();
  const rows = await db
    .select({ metadata: tasksTable.metadata, workspaceId: tasksTable.workspaceId })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) return;
  const existing = (row.metadata as Record<string, unknown>) ?? {};
  const nextStatus = {
    committed: result.committed,
    at: new Date().toISOString(),
    ...(result.committed
      ? { sha: result.sha }
      : { reason: result.reason, error: 'error' in result ? result.error : undefined }),
  };
  const next = { ...existing, autoCommit: nextStatus };
  await db
    .update(tasksTable)
    .set({ metadata: next, updatedAt: new Date() })
    .where(eq(tasksTable.id, taskId));
  emitTaskUpdate(row.workspaceId, taskId, { metadata: next });
}

/**
 * Compute `{ files[], perFileDiffs }` against base and persist on
 * `task.metadata.finalFiles`. Overwrites on each call — follow-up
 * rounds produce a fresh cumulative snapshot. Emits `task:updated`
 * so the desktop Files tab refreshes without a round-trip.
 *
 * Exposed separately so `/approve`'s defensive re-run can reuse it
 * when a pre-existing task landed in awaiting_review before this
 * refactor was deployed.
 */
export async function writeFinalFilesSnapshot(
  taskId: string,
  envId: string,
  baseBranch: string,
  workingDirectory: string,
  taskRow: { metadata: unknown; workspaceId: string },
  tag: string,
  // When set, query against the commit range `base..branch` rather
  // than the working tree. Use this at the approve step, after the
  // commit has landed on the task branch — a working-tree query can
  // return empty if an earlier helper happened to check out base.
  branch?: string
): Promise<void> {
  try {
    const files = await gitService.getChangedFiles(envId, baseBranch, workingDirectory, branch);
    const snapshot = await Promise.all(
      files.map(async (f) => {
        if (f.binary) return { ...f, diff: '' };
        let diff = '';
        try {
          diff = await gitService.getFileDiff(envId, baseBranch, f.path, workingDirectory, branch);
        } catch (err) {
          console.warn(`${tag}: snapshot diff failed for ${f.path}:`, err);
        }
        if (diff.length > FILE_DIFF_CAP) {
          diff = diff.slice(0, FILE_DIFF_CAP) + '\n[… truncated …]';
        }
        return { ...f, diff };
      })
    );

    const db = getDbClient();
    const existingMetadata = (taskRow.metadata as Record<string, unknown>) ?? {};
    const nextMetadata = { ...existingMetadata, finalFiles: snapshot };
    await db
      .update(tasksTable)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(tasksTable.id, taskId));
    emitTaskUpdate(taskRow.workspaceId, taskId, { metadata: nextMetadata });
    console.log(`${tag}: snapshotted ${snapshot.length} file diff(s) to metadata`);
  } catch (err) {
    // Snapshot failure is non-fatal — the commit itself succeeded
    // and the live-git path will still work for as long as the env
    // stays connected. We just lose the offline-fallback guarantee.
    console.warn(`${tag}: snapshot write failed (non-fatal):`, err);
  }
}
