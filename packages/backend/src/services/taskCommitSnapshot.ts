import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { tasks as tasksTable } from '../db/schema.js';
import { gitService } from './git.js';
import { resolveTaskGitContext } from './gitContext.js';
import { generateCommitMessage } from './ai.js';
import { withTaskGitLog } from './gitLogService.js';
import { patchTaskMetadata } from './taskMetadataMutex.js';

/**
 * Outcome of an auto-commit attempt.
 *
 * `advanceOk` is the contract for the caller (handleStructuredExit /
 * maybeAutoFinishAgentTask / /ready-for-review): if false, the caller
 * MUST NOT transition the task to `awaiting_review` — there's an
 * unresolved problem (dirty tree, no work landed, env failure) and
 * silently advancing means losing data or shipping a phantom PR.
 */
export type AutoCommitResult =
  | { committed: true; sha: string; message: string; advanceOk: true }
  | {
      committed: false;
      reason:
        | 'no-branch'
        | 'no-env'
        | 'no-repo'
        | 'no-changes-prior-commits'
        | 'no-changes-no-commits'
        | 'wrong-branch'
        | 'dirty-after-commit'
        | 'error';
      error?: string;
      /**
       * What the working tree looked like at the moment we made the
       * decision — handy for the UI to render "you have these
       * uncommitted files" without round-tripping the env.
       */
      porcelain?: string;
      advanceOk: boolean;
    };

const FILE_DIFF_CAP = 50_000;

/**
 * Commit the task branch's pending work + persist a file-list-and-
 * diffs snapshot onto `task.metadata.finalFiles`. Called on every
 * `in_progress → awaiting_review` transition.
 *
 * Hardening (Session 21): the caller checks `result.advanceOk`. We
 * refuse to advance the task when the working tree is still dirty
 * after the commit attempt, OR when nothing landed (no fresh commit
 * AND no prior commit on the branch). Those used to silently slip
 * through as `no-changes` and the user would arrive at awaiting_review
 * with uncommitted files.
 *
 * Every metadata write — autoCommit status, finalFiles snapshot,
 * gitLog entries from inner gitService calls — routes through the
 * shared per-task mutex (`patchTaskMetadata`), so concurrent writers
 * can't clobber each other's fields. Pre-mutex this race lost
 * `metadata.autoCommit` from completed tasks even when the SHA was
 * real on origin.
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
    return finalize(taskId, tag, {
      committed: false,
      reason: 'error',
      error: 'task not found',
      advanceOk: false,
    });
  }

  if (!row.branch) {
    console.log(`${tag}: no branch → skipping`);
    return finalize(taskId, tag, {
      committed: false,
      reason: 'no-branch',
      advanceOk: false,
    });
  }
  if (!row.assignedEnvironmentId) {
    console.log(`${tag}: no assigned env → skipping`);
    return finalize(taskId, tag, {
      committed: false,
      reason: 'no-env',
      advanceOk: false,
    });
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
    return finalize(taskId, tag, {
      committed: false,
      reason: 'no-repo',
      advanceOk: false,
    });
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
        try {
          await gitService.checkoutBranch(envId, branch, workingDirectory);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${tag}: checkout ${branch} failed:`, err);
          return {
            committed: false,
            reason: 'wrong-branch',
            error: `could not switch to task branch ${branch}: ${msg}`,
            advanceOk: false,
          } as const;
        }
        const after = await gitService.getCurrentBranch(envId, workingDirectory);
        if (after !== branch) {
          return {
            committed: false,
            reason: 'wrong-branch',
            error: `still on ${after} after checkout`,
            advanceOk: false,
          } as const;
        }
      }

      // Snapshot the working-tree state BEFORE attempting to commit
      // so the post-commit verifier has something to compare against
      // and the UI/logs can show "we found these dirty files at
      // awaiting_review time".
      const dirtyBefore = await gitService.getPorcelainStatus(envId, workingDirectory);
      console.log(
        `${tag}: pre-commit dirty=${dirtyBefore.length > 0} (${dirtyBefore.split('\n').filter(Boolean).length} lines)`
      );

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

      // Post-commit verification: working tree MUST be clean. If it's
      // not, autoCommit "succeeded" by exit code but didn't actually
      // capture the user's work — the symptom we keep hitting at
      // awaiting_review.
      const dirtyAfter = await gitService.getPorcelainStatus(envId, workingDirectory);
      if (dirtyAfter.length > 0) {
        console.error(
          `${tag}: DIRTY AFTER COMMIT — ${dirtyAfter.split('\n').filter(Boolean).length} files still uncommitted`
        );
        console.error(`${tag}: porcelain:\n${dirtyAfter.slice(0, 2000)}`);
        return {
          committed: false,
          reason: 'dirty-after-commit',
          error:
            `Working tree is still dirty after \`git add -A && git commit\`. ` +
            `${dirtyAfter.split('\n').filter(Boolean).length} file(s) uncommitted. ` +
            `Most likely cause: autoCommit ran in a different working directory ` +
            `than the agent. Check env=${envId} wd=${workingDirectory} branch=${branch}.`,
          porcelain: dirtyAfter,
          advanceOk: false,
        } as const;
      }

      if (!sha) {
        // Nothing was staged. That's only OK if the branch already
        // has at least one commit ahead of base — meaning the agent
        // committed its own work. Zero ahead AND clean tree means
        // literally nothing happened, so we refuse to advance.
        const ahead = await gitService.commitsAhead(
          envId,
          branch,
          baseBranch,
          workingDirectory
        );
        console.log(`${tag}: nothing to stage; branch is ${ahead} commit(s) ahead of ${baseBranch}`);
        if (ahead === 0) {
          return {
            committed: false,
            reason: 'no-changes-no-commits',
            error: `Branch ${branch} has no commits ahead of ${baseBranch} and nothing was staged. The agent didn't produce any changes.`,
            porcelain: dirtyBefore,
            advanceOk: false,
          } as const;
        }
        // Snapshot the existing branch diffs so the Files tab still
        // populates even though FastOwl didn't add a fresh commit.
        await writeFinalFilesSnapshot(taskId, envId, baseBranch, workingDirectory, tag, branch);
        return {
          committed: false,
          reason: 'no-changes-prior-commits',
          advanceOk: true,
        } as const;
      }

      await writeFinalFilesSnapshot(taskId, envId, baseBranch, workingDirectory, tag, branch);

      console.log(`${tag}: committed ${sha.slice(0, 10)} · ${message.split('\n')[0]}`);
      return {
        committed: true,
        sha,
        message,
        advanceOk: true,
      } as const;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag}: auto-commit threw:`, err);
      return {
        committed: false,
        reason: 'error',
        error: msg,
        advanceOk: false,
      } as const;
    }
  });

  return finalize(taskId, tag, result);
}

/**
 * Persist the autoCommit outcome on `task.metadata.autoCommit` and
 * return the same result. Routed through the per-task mutex so a
 * concurrent gitLog append (still in flight from inner runGit calls)
 * can't clobber the field — the original symptom that motivated this
 * rewrite.
 */
async function finalize(
  taskId: string,
  tag: string,
  result: AutoCommitResult
): Promise<AutoCommitResult> {
  const status: Record<string, unknown> = {
    committed: result.committed,
    advanceOk: result.advanceOk,
    at: new Date().toISOString(),
  };
  if (result.committed) {
    status.sha = result.sha;
    status.message = result.message;
  } else {
    status.reason = result.reason;
    if (result.error) status.error = result.error;
    if (result.porcelain) status.porcelain = result.porcelain.slice(0, 4000);
  }

  try {
    await patchTaskMetadata(taskId, (existing) => ({
      ...existing,
      autoCommit: status,
    }));
  } catch (err) {
    console.error(`${tag}: failed to persist autoCommit status:`, err);
  }
  return result;
}

/**
 * Compute `{ files[], perFileDiffs }` against base and persist on
 * `task.metadata.finalFiles`. Overwrites on each call — follow-up
 * rounds produce a fresh cumulative snapshot. Emits via the shared
 * mutex so the desktop Files tab refreshes without a round-trip and
 * other writers don't get clobbered.
 *
 * Always reads fresh metadata via the mutex's internal SELECT — the
 * caller no longer hands in a stale snapshot.
 */
export async function writeFinalFilesSnapshot(
  taskId: string,
  envId: string,
  baseBranch: string,
  workingDirectory: string,
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

    await patchTaskMetadata(taskId, (existing) => ({
      ...existing,
      finalFiles: snapshot,
    }));
    console.log(`${tag}: snapshotted ${snapshot.length} file diff(s) to metadata`);
  } catch (err) {
    // Snapshot failure is non-fatal — the commit itself succeeded
    // and the live-git path will still work for as long as the env
    // stays connected. We just lose the offline-fallback guarantee.
    console.warn(`${tag}: snapshot write failed (non-fatal):`, err);
  }
}
