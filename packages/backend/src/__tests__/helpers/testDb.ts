import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import * as schema from '../../db/schema.js';
import { setDbClient, resetDbClient, type Database } from '../../db/client.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

/**
 * Spin up a fresh in-memory Postgres via pglite, apply the Drizzle migration,
 * and register it as the process-wide DB client. Returns the client and a
 * teardown function.
 *
 * Tests run with real Postgres semantics — jsonb, booleans, timestamp with
 * time zone — so row-conversion helpers and query logic are exercised
 * exactly as in production.
 */
export async function createTestDb(): Promise<{
  db: Database;
  pglite: PGlite;
  cleanup: () => Promise<void>;
}> {
  const pglite = new PGlite();
  const db = drizzlePglite(pglite, { schema, casing: 'snake_case' }) as unknown as Database;

  // Apply every generated migration in order. drizzle-kit names them
  // `NNNN_<slug>.sql` and writes `--> statement-breakpoint` between
  // statements; splitting on that marker gives one call per statement.
  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrationFiles) {
    const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await pglite.exec(stmt);
    }
  }

  setDbClient(db);

  return {
    db,
    pglite,
    cleanup: async () => {
      resetDbClient();
      await pglite.close();
    },
  };
}

/**
 * Seed a user row. Tests that insert workspaces/environments must reference
 * an existing user since owner_id is NOT NULL. Defaults to a stable id so
 * tests can cross-reference without wiring the id through every helper.
 */
export async function seedUser(
  db: Database,
  overrides: Partial<{ id: string; email: string }> = {}
): Promise<{ id: string; email: string }> {
  const id = overrides.id ?? 'user-test';
  const email = overrides.email ?? `${id}@example.test`;
  await db.insert(schema.users).values({ id, email }).onConflictDoNothing();
  return { id, email };
}

/** Stable test user id — every fixture defaults to this unless overridden. */
export const TEST_USER_ID = 'user-test';
