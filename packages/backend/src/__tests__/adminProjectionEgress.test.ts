import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import {
  tasks as tasksTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import {
  ADMIN_TASK_LIST_COLUMNS,
  ADMIN_USER_COLUMNS,
  ADMIN_WORKSPACE_COLUMNS,
} from '../services/admin/queries.js';
import type { Database } from '../db/client.js';

/**
 * Egress guards for the operator console's list reads.
 *
 * The sibling of projectionEgress.test.ts, and it matters more here: these are
 * the only queries in the codebase that read EVERY tenant's rows at once, so a
 * column that re-bloats costs the whole table rather than one workspace's
 * worth. CLAUDE.md names the expensive ones — `tasks.transcript`,
 * `workspaces.logo` — and adds two this surface introduces: `users`' Polar
 * ids, which are a support liability with no read use in a list view, and the
 * `metadata` jsonb the task list derives five scalars from.
 *
 * `.toSQL()` renders without executing, so this asserts the projected column
 * set directly rather than inferring it from a result.
 */

let db: Database;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterEach(async () => {
  await cleanup();
});

describe('admin user projection', () => {
  it('never emits the Polar columns', () => {
    const { sql } = db.select(ADMIN_USER_COLUMNS).from(usersTable).toSQL();
    expect(sql).not.toContain('polar_customer_id');
    expect(sql).not.toContain('polar_subscription_id');
    expect(sql).not.toContain('subscription_event_at');
  });

  it('still selects what the list renders', () => {
    const { sql } = db.select(ADMIN_USER_COLUMNS).from(usersTable).toSQL();
    for (const col of ['"email"', '"is_admin"', '"plan"', '"plan_override"']) {
      expect(sql).toContain(col);
    }
  });

  it('a bare select() DOES emit them (guards this test)', () => {
    // Without this inverse the assertions above would still pass if the
    // column were renamed or the table changed underneath them.
    const { sql } = db.select().from(usersTable).toSQL();
    expect(sql).toContain('polar_customer_id');
  });
});

describe('admin workspace projection', () => {
  it('never emits logo or settings', () => {
    // `logo` is jsonb that can hold a data URL; `settings` is jsonb no list
    // view renders. Both are named in CLAUDE.md's egress rules.
    const { sql } = db.select(ADMIN_WORKSPACE_COLUMNS).from(workspacesTable).toSQL();
    expect(sql).not.toContain('"logo"');
    expect(sql).not.toContain('"settings"');
  });

  it('a bare select() DOES emit them (guards this test)', () => {
    const { sql } = db.select().from(workspacesTable).toSQL();
    expect(sql).toContain('"logo"');
    expect(sql).toContain('"settings"');
  });
});

describe('admin task list projection', () => {
  it('never emits the transcript blob', () => {
    const { sql } = db.select(ADMIN_TASK_LIST_COLUMNS).from(tasksTable).toSQL();
    expect(sql).not.toContain('"transcript"');
  });

  it('never ships the metadata jsonb whole — it extracts in SQL instead', () => {
    // The point of the projection. Selecting `metadata` and reading five
    // scalars off it in JS would pull one blob per row across every tenant;
    // the `->>` extraction ships only the scalars.
    const { sql } = db.select(ADMIN_TASK_LIST_COLUMNS).from(tasksTable).toSQL();
    expect(sql).toMatch(/->>/);
    expect(sql).not.toMatch(/select\s+"tasks"\."metadata"/i);
  });

  it('never emits result or description either', () => {
    // Neither is rendered in a list, and `result` is jsonb.
    const { sql } = db.select(ADMIN_TASK_LIST_COLUMNS).from(tasksTable).toSQL();
    expect(sql).not.toContain('"result"');
    expect(sql).not.toContain('"description"');
  });

  it('a bare select() DOES emit transcript and result (guards this test)', () => {
    const { sql } = db.select().from(tasksTable).toSQL();
    expect(sql).toContain('transcript');
    expect(sql).toContain('result');
  });
});
