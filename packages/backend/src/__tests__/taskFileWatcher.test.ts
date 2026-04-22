import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { AgentEvent } from '@fastowl/shared';
import { taskFileWatcher } from '../services/taskFileWatcher.js';
import { agentStructuredService } from '../services/agentStructured.js';
import { gitService } from '../services/git.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../db/schema.js';

/**
 * The service calls `gitService.getChangedFiles` exactly when the
 * debounce window fires. Asserting on that spy is a more reliable
 * signal than spying on the emit helper, because `emit` is imported
 * by destructure at module-load time and `vi.spyOn` can't reliably
 * intercept that in ESM.
 */

function makeToolUseEvent(toolName: string): AgentEvent {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: toolName,
          id: 'tu-1',
          input: { file_path: '/x' },
        },
      ],
    },
  } as unknown as AgentEvent;
}

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('taskFileWatcher', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    // init() is idempotent (guarded by an internal `attached` flag)
    // so we attach the event listener exactly once for the whole
    // suite. Between tests we let listeners stay — shutdown() only
    // clears debounce timers, not the listener.
    taskFileWatcher.init();
  });

  afterAll(() => {
    taskFileWatcher.shutdown();
  });

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {},
    });
    await db.insert(environmentsTable).values({
      id: 'env1', ownerId: TEST_USER_ID, name: 'e', type: 'local',
      status: 'connected', config: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1', workspaceId: 'ws1', name: 'a/b',
      url: 'https://github.com/a/b', localPath: '/tmp/b', defaultBranch: 'main',
    });
    const now = new Date();
    await db.insert(tasksTable).values({
      id: 't1',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 't',
      description: 'd',
      repositoryId: 'repo1',
      assignedEnvironmentId: 'env1',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });

  });

  afterEach(async () => {
    // Flush any in-flight debounce timers before tearing down the DB.
    taskFileWatcher.shutdown();
    await cleanup();
    vi.restoreAllMocks();
  });

  it('runs getChangedFiles after the debounce window when a file-mutating tool fires', async () => {
    const spy = vi.spyOn(gitService, 'getChangedFiles').mockResolvedValue([]);

    agentStructuredService.emit(
      'event',
      { taskId: 't1', workspaceId: 'ws1' },
      makeToolUseEvent('Edit')
    );

    // Before the window, no call.
    await wait(100);
    expect(spy).not.toHaveBeenCalled();

    await wait(700);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('env1', 'main', '/tmp/b');
  });

  it('coalesces a burst of events into a single getChangedFiles call', async () => {
    const spy = vi.spyOn(gitService, 'getChangedFiles').mockResolvedValue([]);

    for (let i = 0; i < 10; i++) {
      agentStructuredService.emit(
        'event',
        { taskId: 't1', workspaceId: 'ws1' },
        makeToolUseEvent('Edit')
      );
    }
    await wait(700);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not fire for pure-read tools (Read / Glob / Grep)', async () => {
    const spy = vi.spyOn(gitService, 'getChangedFiles').mockResolvedValue([]);

    agentStructuredService.emit(
      'event',
      { taskId: 't1', workspaceId: 'ws1' },
      makeToolUseEvent('Read')
    );
    agentStructuredService.emit(
      'event',
      { taskId: 't1', workspaceId: 'ws1' },
      makeToolUseEvent('Glob')
    );
    await wait(700);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps different tasks independent (no cross-task coalescing)', async () => {
    const now = new Date();
    await db.insert(tasksTable).values({
      id: 't2',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 'b',
      description: 'd',
      repositoryId: 'repo1',
      assignedEnvironmentId: 'env1',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });

    const spy = vi.spyOn(gitService, 'getChangedFiles').mockResolvedValue([]);

    agentStructuredService.emit(
      'event',
      { taskId: 't1', workspaceId: 'ws1' },
      makeToolUseEvent('Edit')
    );
    agentStructuredService.emit(
      'event',
      { taskId: 't2', workspaceId: 'ws1' },
      makeToolUseEvent('Write')
    );
    await wait(700);

    // Two tasks → two independent debounce timers → two refresh calls.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('silently skips when the task has no assignedEnvironmentId', async () => {
    await db.insert(tasksTable).values({
      id: 't-no-env',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'queued',
      priority: 'medium',
      title: 't',
      description: 'd',
      repositoryId: 'repo1',
      assignedEnvironmentId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const spy = vi.spyOn(gitService, 'getChangedFiles').mockResolvedValue([]);

    agentStructuredService.emit(
      'event',
      { taskId: 't-no-env', workspaceId: 'ws1' },
      makeToolUseEvent('Edit')
    );
    await wait(700);

    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores events without a taskId', async () => {
    const spy = vi.spyOn(gitService, 'getChangedFiles').mockResolvedValue([]);

    agentStructuredService.emit(
      'event',
      { workspaceId: 'ws1' }, // no taskId
      makeToolUseEvent('Edit')
    );
    await wait(700);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores non-assistant events', async () => {
    const spy = vi.spyOn(gitService, 'getChangedFiles').mockResolvedValue([]);

    agentStructuredService.emit(
      'event',
      { taskId: 't1', workspaceId: 'ws1' },
      { type: 'system', subtype: 'init' } as unknown as AgentEvent
    );
    await wait(700);
    expect(spy).not.toHaveBeenCalled();
  });
});
