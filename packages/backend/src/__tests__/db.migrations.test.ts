import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations, getMigrations } from '../db/index.js';

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('creates the migrations table and runs every migration exactly once', () => {
    runMigrations(db);

    const applied = db
      .prepare('SELECT name FROM migrations ORDER BY id')
      .all()
      .map((r: any) => r.name);

    expect(applied).toEqual(getMigrations().map((m) => m.name));

    // Running again should be a no-op
    runMigrations(db);
    const afterSecondRun = db
      .prepare('SELECT COUNT(*) as c FROM migrations')
      .get() as { c: number };
    expect(afterSecondRun.c).toBe(getMigrations().length);
  });

  it('creates the core tables', () => {
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    for (const expected of [
      'workspaces',
      'repositories',
      'integrations',
      'environments',
      'tasks',
      'agents',
      'inbox_items',
      'settings',
      'migrations',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('adds the repository_id column to tasks (migration 002)', () => {
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all()
      .map((r: any) => r.name);
    expect(cols).toContain('repository_id');
  });

  it('adds the branch column to tasks (migration 003)', () => {
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all()
      .map((r: any) => r.name);
    expect(cols).toContain('branch');
  });

  it('adds the terminal_output column to tasks (migration 004)', () => {
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all()
      .map((r: any) => r.name);
    expect(cols).toContain('terminal_output');
  });

  it("renames legacy 'automated' task types to 'code_writing' (migration 005)", () => {
    // Run through migration 004 only, then seed a legacy row, then run 005
    const early = getMigrations().slice(0, 4); // 001..004
    db.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    for (const m of early) {
      db.exec(m.sql);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(m.name);
    }

    // Seed: workspace + legacy 'automated' task
    db.prepare(
      "INSERT INTO workspaces (id, name, settings) VALUES (?, ?, ?)"
    ).run('ws1', 'Default', '{}');
    db.prepare(
      "INSERT INTO tasks (id, workspace_id, type, status, priority, title, description) VALUES (?, ?, 'automated', 'queued', 'medium', ?, ?)"
    ).run('t1', 'ws1', 'Legacy task', 'was automated');

    // Now run all migrations (005 should pick up and rename)
    runMigrations(db);

    const row = db.prepare('SELECT type FROM tasks WHERE id = ?').get('t1') as { type: string };
    expect(row.type).toBe('code_writing');
  });
});
