import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import * as schema from '../../db/schema.js';
import { setDbClient, resetDbClient, type Database } from '../../db/client.js';

const MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  '../../db/migrations/0000_initial.sql'
);

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

  // drizzle-kit generates a file with `--> statement-breakpoint` between
  // statements. Splitting on that marker gives us one call per statement.
  const sqlText = fs.readFileSync(MIGRATION_SQL_PATH, 'utf-8');
  const statements = sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await pglite.exec(stmt);
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
