import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DATA_DIR = process.env.FASTOWL_DATA_DIR || path.join(os.homedir(), '.fastowl');
const DB_PATH = path.join(DATA_DIR, 'fastowl.db');

export function initDatabase(): Database.Database {
  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Run migrations
  runMigrations(db);

  return db;
}

export function runMigrations(db: Database.Database): void {
  // Create migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const migrations = getMigrations();
  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map((row: any) => row.name)
  );

  for (const migration of migrations) {
    if (!applied.has(migration.name)) {
      console.log(`Running migration: ${migration.name}`);
      db.exec(migration.sql);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration.name);
    }
  }
}

export interface Migration {
  name: string;
  sql: string;
}

export function getMigrations(): Migration[] {
  return [
    {
      name: '001_initial_schema',
      sql: `
        -- Workspaces
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          settings TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Repositories
        CREATE TABLE repositories (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          local_path TEXT,
          default_branch TEXT NOT NULL DEFAULT 'main',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Integrations
        CREATE TABLE integrations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          config TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(workspace_id, type)
        );

        -- Environments
        CREATE TABLE environments (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'disconnected',
          config TEXT NOT NULL,
          last_connected TEXT,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Tasks
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          priority TEXT NOT NULL DEFAULT 'medium',
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          prompt TEXT,
          assigned_agent_id TEXT,
          assigned_environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
          result TEXT,
          metadata TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );

        -- Agents
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'idle',
          attention TEXT NOT NULL DEFAULT 'none',
          current_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          terminal_output TEXT NOT NULL DEFAULT '',
          last_activity TEXT NOT NULL DEFAULT (datetime('now')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Inbox items
        CREATE TABLE inbox_items (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'unread',
          priority TEXT NOT NULL DEFAULT 'medium',
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          source TEXT NOT NULL,
          actions TEXT NOT NULL DEFAULT '[]',
          data TEXT,
          snoozed_until TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          read_at TEXT,
          actioned_at TEXT
        );

        -- Settings
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Indexes
        CREATE INDEX idx_tasks_workspace ON tasks(workspace_id);
        CREATE INDEX idx_tasks_status ON tasks(status);
        CREATE INDEX idx_agents_environment ON agents(environment_id);
        CREATE INDEX idx_agents_workspace ON agents(workspace_id);
        CREATE INDEX idx_inbox_workspace ON inbox_items(workspace_id);
        CREATE INDEX idx_inbox_status ON inbox_items(status);
      `,
    },
    {
      name: '002_add_task_repository',
      sql: `
        ALTER TABLE tasks ADD COLUMN repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL;
        CREATE INDEX idx_tasks_repository ON tasks(repository_id);
      `,
    },
    {
      name: '003_add_task_branch',
      sql: `
        ALTER TABLE tasks ADD COLUMN branch TEXT;
      `,
    },
    {
      name: '004_add_task_terminal_output',
      sql: `
        ALTER TABLE tasks ADD COLUMN terminal_output TEXT NOT NULL DEFAULT '';
      `,
    },
    {
      name: '005_rename_task_type_automated_to_code_writing',
      sql: `
        UPDATE tasks SET type = 'code_writing' WHERE type = 'automated';
      `,
    },
    {
      name: '006_add_backlog_tables',
      sql: `
        CREATE TABLE backlog_sources (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
          config TEXT NOT NULL DEFAULT '{}',
          last_synced_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE backlog_items (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES backlog_sources(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          external_id TEXT NOT NULL,
          text TEXT NOT NULL,
          parent_external_id TEXT,
          completed INTEGER NOT NULL DEFAULT 0,
          blocked INTEGER NOT NULL DEFAULT 0,
          claimed_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          order_index INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(source_id, external_id)
        );

        CREATE INDEX idx_backlog_sources_workspace ON backlog_sources(workspace_id);
        CREATE INDEX idx_backlog_items_source ON backlog_items(source_id);
        CREATE INDEX idx_backlog_items_workspace ON backlog_items(workspace_id);
        CREATE INDEX idx_backlog_items_claimed ON backlog_items(claimed_task_id);
      `,
    },
  ];
}

// Export database type for use in other modules
export type DB = Database.Database;
