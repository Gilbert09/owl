import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  recordGitCommand,
  withTaskGitLog,
  getGitLog,
  type GitLogEntry,
} from '../services/gitLogService.js';
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
