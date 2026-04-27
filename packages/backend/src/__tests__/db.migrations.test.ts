import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';

describe('Drizzle migration', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it('creates every expected table when applied to a fresh database', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    const result = await testDb.pglite.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tables = result.rows.map((r) => r.table_name);

    for (const expected of [
      'users',
      'workspaces',
      'repositories',
      'integrations',
      'environments',
      'tasks',
      'agents',
      'inbox_items',
      'settings',
      'backlog_sources',
      'backlog_items',
      'pull_requests',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('pull_requests has the expected columns + (workspace, repo, number) is unique', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    const colsRes = await testDb.pglite.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pull_requests'
    `);
    const cols = colsRes.rows.map((r) => r.column_name);
    for (const c of [
      'id',
      'workspace_id',
      'repository_id',
      'task_id',
      'owner',
      'repo',
      'number',
      'state',
      'merged_at',
      'last_polled_at',
      'last_summary',
      'last_review_id',
      'last_review_comment_id',
      'last_comment_id',
      'last_check_digest',
    ]) {
      expect(cols).toContain(c);
    }

    // Unique constraint on (workspace_id, repository_id, number) is the
    // upsert key the poller relies on. Without it, the same PR seen
    // twice in one tick would double-insert.
    const idxRes = await testDb.pglite.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'pull_requests'
    `);
    const uq = idxRes.rows.find(
      (r) => r.indexname === 'uq_pull_requests_workspace_repo_number'
    );
    expect(uq).toBeDefined();
    expect(uq?.indexdef).toMatch(/UNIQUE/);
    expect(uq?.indexdef).toMatch(/workspace_id/);
    expect(uq?.indexdef).toMatch(/repository_id/);
    expect(uq?.indexdef).toMatch(/number/);
  });

  it('workspaces and environments have owner_id columns', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    for (const table of ['workspaces', 'environments']) {
      const result = await testDb.pglite.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table}'
      `);
      const cols = result.rows.map((r) => r.column_name);
      expect(cols).toContain('owner_id');
    }
  });

  it('gives tasks the expected columns (repository_id, branch, terminal_output, metadata)', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    const result = await testDb.pglite.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks'
    `);
    const cols = result.rows.map((r) => r.column_name);

    expect(cols).toContain('repository_id');
    expect(cols).toContain('branch');
    expect(cols).toContain('terminal_output');
    expect(cols).toContain('metadata');
  });

  it('backlog_sources has a repository_id column', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    const result = await testDb.pglite.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'backlog_sources'
    `);
    const cols = result.rows.map((r) => r.column_name);
    expect(cols).toContain('repository_id');
  });

  it('enables RLS on every user-scoped table (settings stays global)', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    const result = await testDb.pglite.query<{ tablename: string; rowsecurity: boolean }>(`
      SELECT tablename, rowsecurity FROM pg_tables
      WHERE schemaname = 'public'
    `);
    const map = new Map(result.rows.map((r) => [r.tablename, r.rowsecurity]));

    for (const table of [
      'users',
      'workspaces',
      'environments',
      'repositories',
      'integrations',
      'tasks',
      'agents',
      'inbox_items',
      'backlog_sources',
      'backlog_items',
      'pull_requests',
    ]) {
      expect(map.get(table)).toBe(true);
    }
    expect(map.get('settings')).toBe(false);
  });
});
