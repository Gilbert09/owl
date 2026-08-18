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
      'settings',
      'pull_requests',
      'github_installations',
    ]) {
      expect(tables).toContain(expected);
    }

    // The local-execution tables are dropped in the cloud-only refactor;
    // inbox_items is dropped with the inbox feature removal.
    for (const gone of ['agents', 'backlog_sources', 'backlog_items', 'inbox_items']) {
      expect(tables).not.toContain(gone);
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

  it('gives merge_queue_entries the stack columns + indexes the branch lookups', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    const colsRes = await testDb.pglite.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'merge_queue_entries'
    `);
    const cols = colsRes.rows.map((r) => r.column_name);
    expect(cols).toContain('stack_parent_number');
    expect(cols).toContain('retarget_attempts');

    // Resolving a stack parent asks "which open PR's HEAD is this branch?" —
    // the reverse of every other base-branch lookup, and branch names live
    // only inside the last_summary jsonb. Without these expression indexes
    // every group walk sequential-scans pull_requests.
    const idxRes = await testDb.pglite.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'pull_requests'
    `);
    const names = idxRes.rows.map((r) => r.indexname);
    expect(names).toContain('idx_pr_repo_head_branch');
    expect(names).toContain('idx_pr_repo_base_branch');
    const head = idxRes.rows.find((r) => r.indexname === 'idx_pr_repo_head_branch');
    expect(head?.indexdef).toMatch(/headBranch/);
    expect(head?.indexdef).toMatch(/repository_id/);
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

  it('gives tasks the cloud-only columns and drops the local-exec ones', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    const result = await testDb.pglite.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks'
    `);
    const cols = result.rows.map((r) => r.column_name);

    expect(cols).toContain('repository_id');
    expect(cols).toContain('branch');
    expect(cols).toContain('assigned_environment_id');
    expect(cols).toContain('transcript');
    expect(cols).toContain('metadata');
    // Local-execution columns are gone.
    expect(cols).not.toContain('terminal_output');
    expect(cols).not.toContain('assigned_agent_id');
  });

  it('slims environments to a secret-free marker (no daemon columns)', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    const result = await testDb.pglite.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'environments'
    `);
    const cols = result.rows.map((r) => r.column_name);
    expect(cols).toContain('type');
    expect(cols).toContain('config');
    for (const gone of [
      'device_token_hash',
      'last_seen_at',
      'autonomous_bypass_permissions',
      'renderer',
      'tool_allowlist',
      'daemon_version',
      'auto_update_daemon',
    ]) {
      expect(cols).not.toContain(gone);
    }
  });

  it('enables RLS on every surviving user-scoped table (settings stays global)', async () => {
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
      'pull_requests',
    ]) {
      expect(map.get(table)).toBe(true);
    }
    expect(map.get('settings')).toBe(false);
  });

  it('creates admin_audit_log as a backend-pool-only table (RLS on, no policy)', async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    const colsRes = await testDb.pglite.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'admin_audit_log'
    `);
    const cols = colsRes.rows.map((r) => r.column_name);
    for (const c of [
      'id',
      'at',
      'actor_id',
      'actor_email',
      'action',
      'target_kind',
      'target_id',
      'reason',
      'params',
      'before',
      'after',
      'outcome',
      'error',
      'duration_ms',
      'request_id',
      'ip',
      'user_agent',
    ]) {
      expect(cols).toContain(c);
    }

    // The security property is RLS enabled with NO policy: only the
    // privileged pool role (which bypasses RLS) can read or write. Assert
    // both halves rather than trusting the migration's comment — an
    // `authenticated` policy added here later would silently expose who
    // comped whom to any JWT connection.
    const rlsRes = await testDb.pglite.query<{ rowsecurity: boolean }>(`
      SELECT rowsecurity FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'admin_audit_log'
    `);
    expect(rlsRes.rows[0]?.rowsecurity).toBe(true);

    const polRes = await testDb.pglite.query<{ policyname: string }>(`
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'admin_audit_log'
    `);
    expect(polRes.rows).toHaveLength(0);

    // The trail must survive an account wipe, which cascades from users.
    // A FK on actor_id would take the audit row with it — the one row you
    // most want after an account is deleted.
    const fkRes = await testDb.pglite.query<{ constraint_name: string }>(`
      SELECT tc.constraint_name FROM information_schema.table_constraints tc
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'admin_audit_log'
        AND tc.constraint_type = 'FOREIGN KEY'
    `);
    expect(fkRes.rows).toHaveLength(0);
  });
});
