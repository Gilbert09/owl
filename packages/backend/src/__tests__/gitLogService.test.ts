import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  recordGitCommand,
  withTaskGitLog,
  getGitLog,
  type GitLogEntry,
} from '../services/gitLogService.js';
import {
  patchTaskMetadata,
  drainTaskMetadata,
} from '../services/taskMetadataMutex.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { type Database } from '../db/client.js';
import { workspaces as workspacesTable, tasks as tasksTable } from '../db/schema.js';

async function seedTask(db: Database, id = 't1'): Promise<void> {
  await db.insert(workspacesTable).values({
    id: 'ws1',
    ownerId: TEST_USER_ID,
    name: 'ws',
    settings: {},
  });
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'queued',
    priority: 'medium',
    title: 't',
    description: 'd',
    metadata: {},
  });
}

function makeEntry(overrides: Partial<GitLogEntry> = {}): GitLogEntry {
  return {
    ts: new Date().toISOString(),
    command: 'git status --porcelain',
    exitCode: 0,
    stdoutPreview: '',
    stderrPreview: '',
    durationMs: 5,
    ...overrides,
  };
}

describe('gitLogService', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const h = await createTestDb();
    db = h.db;
    cleanup = h.cleanup;
    await seedUser(db);
    await seedTask(db);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('is a no-op when no task context is active', async () => {
    await recordGitCommand(makeEntry());
    const rows = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'))
      .limit(1);
    const meta = (rows[0]?.metadata as Record<string, unknown>) ?? {};
    expect(meta.gitLog).toBeUndefined();
  });

  it('persists one entry inside withTaskGitLog', async () => {
    await withTaskGitLog('t1', async () => {
      await recordGitCommand(makeEntry({ command: 'git fetch origin main' }));
    });

    const log = await getGitLog('t1');
    expect(log).toHaveLength(1);
    expect(log[0].command).toBe('git fetch origin main');
  });

  it('preserves every entry when many commands race concurrently', async () => {
    // This is the behaviour we care most about: the approve flow
    // fires git ops via Promise.all and the diff-snapshot step fires
    // one getFileDiff per changed file. Before serialization was
    // added, these raced on the read-modify-write of
    // `tasks.metadata.gitLog` and most entries got clobbered — the
    // Git tab would shrink from 6 entries mid-run to 2 at completion.
    const N = 25;
    await withTaskGitLog('t1', async () => {
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          recordGitCommand(
            makeEntry({
              // Each entry is distinguishable so we can assert the set
              // of survivors, not just the count.
              command: `git cmd-${i.toString().padStart(2, '0')}`,
              durationMs: i,
            })
          )
        )
      );
    });

    const log = await getGitLog('t1');
    expect(log).toHaveLength(N);
    const commands = new Set(log.map((e) => e.command));
    for (let i = 0; i < N; i++) {
      expect(commands.has(`git cmd-${i.toString().padStart(2, '0')}`)).toBe(true);
    }
  });

  it('keeps logs for different tasks independent under concurrency', async () => {
    await db.insert(tasksTable).values({
      id: 't2',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'queued',
      priority: 'medium',
      title: 't2',
      description: 'd',
      metadata: {},
    });

    // Interleave writes for two tasks to make sure the per-taskId
    // serialization doesn't accidentally stitch them together.
    const results = [
      withTaskGitLog('t1', () =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            recordGitCommand(makeEntry({ command: `t1-cmd-${i}`, durationMs: i }))
          )
        )
      ),
      withTaskGitLog('t2', () =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            recordGitCommand(makeEntry({ command: `t2-cmd-${i}`, durationMs: i }))
          )
        )
      ),
    ];
    await Promise.all(results);

    const log1 = await getGitLog('t1');
    const log2 = await getGitLog('t2');
    expect(log1).toHaveLength(10);
    expect(log2).toHaveLength(10);
    expect(log1.every((e) => e.command.startsWith('t1-'))).toBe(true);
    expect(log2.every((e) => e.command.startsWith('t2-'))).toBe(true);
  });

  it('preserves gitLog entries across concurrent metadata patches (autoCommit/finalFiles/pullRequest)', async () => {
    // The actual user-reported bug: open a completed task after a
    // restart, the `git commit` entry (and several others from the
    // autoCommit phase) is missing from metadata.gitLog.
    //
    // Root cause: pre-mutex, `void recordGitCommand(...)` from
    // gitService.runGit was a fire-and-forget metadata RMW. When
    // writeFinalFilesSnapshot / persistAutoCommitStatus /
    // openPullRequestForTask read metadata, modified it, and wrote it
    // back, they used a stale snapshot — clobbering whatever gitLog
    // entries had landed since their SELECT. Forensic on prod found
    // tasks where the autoCommit's own commands (add -A, commit, ...)
    // were entirely absent while later cleanup entries survived.
    //
    // This test fires the same shape: gitLog appends interleaved with
    // metadata patches that touch other fields. With the per-task
    // mutex, both must survive end-to-end.
    const N = 30;
    await withTaskGitLog('t1', async () => {
      // Mix of gitLog appends and other-field patches, all racing.
      const work: Array<Promise<unknown>> = [];
      for (let i = 0; i < N; i++) {
        work.push(
          recordGitCommand(
            makeEntry({ command: `git op-${i.toString().padStart(2, '0')}` })
          )
        );
        if (i === 5) {
          work.push(
            patchTaskMetadata('t1', (existing) => ({
              ...existing,
              autoCommit: { committed: true, sha: 'abc1234567', advanceOk: true },
            }))
          );
        }
        if (i === 12) {
          work.push(
            patchTaskMetadata('t1', (existing) => ({
              ...existing,
              finalFiles: [{ path: 'src/foo.ts', diff: '+x' }],
            }))
          );
        }
        if (i === 20) {
          work.push(
            patchTaskMetadata('t1', (existing) => ({
              ...existing,
              pullRequest: { number: 42, url: 'https://example/pr/42' },
            }))
          );
        }
      }
      await Promise.all(work);
    });

    // After the chain drains, every gitLog entry AND every metadata
    // field must be present. Pre-mutex, finalFiles' UPDATE would
    // clobber the gitLog entries written between its SELECT and its
    // UPDATE — and vice versa.
    await drainTaskMetadata('t1');

    const log = await getGitLog('t1');
    expect(log).toHaveLength(N);
    const commands = new Set(log.map((e) => e.command));
    for (let i = 0; i < N; i++) {
      expect(commands.has(`git op-${i.toString().padStart(2, '0')}`)).toBe(true);
    }

    const rows = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'))
      .limit(1);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect(meta.autoCommit).toMatchObject({ committed: true, sha: 'abc1234567' });
    expect(meta.finalFiles).toEqual([{ path: 'src/foo.ts', diff: '+x' }]);
    expect(meta.pullRequest).toMatchObject({ number: 42 });
  });

  it('persisted metadata survives a fresh DB read after the chain drains (simulates app restart)', async () => {
    // Mirrors the user-facing symptom: after closing and reopening
    // the app, the git log should match what was visible mid-run.
    // The "restart" is just a fresh SELECT on the same row — the
    // chain serializer is in-process, so any state that didn't make
    // it to the DB before drain is gone forever after a real restart.
    await withTaskGitLog('t1', async () => {
      await Promise.all([
        recordGitCommand(makeEntry({ command: 'git add -A' })),
        recordGitCommand(makeEntry({ command: 'git diff --cached --quiet' })),
        recordGitCommand(makeEntry({ command: 'git commit -m "msg"' })),
        recordGitCommand(makeEntry({ command: 'git rev-parse HEAD' })),
        // The exact pattern that ate b5a3db2b's commit entry pre-fix:
        // finalFiles patch racing with the surrounding gitLog appends.
        patchTaskMetadata('t1', (existing) => ({
          ...existing,
          finalFiles: [{ path: 'a.ts', diff: '+1' }],
        })),
        recordGitCommand(makeEntry({ command: 'git diff -M --numstat main' })),
        recordGitCommand(makeEntry({ command: 'git checkout main' })),
        recordGitCommand(makeEntry({ command: 'git branch -D fastowl/x' })),
      ]);
    });

    await drainTaskMetadata('t1');

    // Fresh SELECT off the DB — no in-memory cache, no chain state.
    const rows = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'))
      .limit(1);
    const meta = rows[0].metadata as { gitLog?: GitLogEntry[]; finalFiles?: unknown };

    expect(meta.gitLog?.map((e) => e.command)).toEqual([
      'git add -A',
      'git diff --cached --quiet',
      'git commit -m "msg"',
      'git rev-parse HEAD',
      'git diff -M --numstat main',
      'git checkout main',
      'git branch -D fastowl/x',
    ]);
    expect(meta.finalFiles).toEqual([{ path: 'a.ts', diff: '+1' }]);
  });

  it('caps the persisted log at MAX_ENTRIES to keep metadata bounded', async () => {
    // MAX_ENTRIES is 200 internally; write more and assert the tail
    // wins (slice(-MAX_ENTRIES)).
    const N = 220;
    await withTaskGitLog('t1', async () => {
      for (let i = 0; i < N; i++) {
        await recordGitCommand(makeEntry({ command: `cmd-${i}`, durationMs: i }));
      }
    });

    const log = await getGitLog('t1');
    expect(log).toHaveLength(200);
    // First surviving entry should be cmd-20 (dropped: 0..19).
    expect(log[0].command).toBe('cmd-20');
    expect(log[199].command).toBe('cmd-219');
  });
});
