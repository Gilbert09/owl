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

  // pglite doesn't ship Supabase's `auth` schema. Our RLS policies call
  // `auth.uid()`, so stub it here — returns null when no JWT claim is set,
  // which (combined with pglite running as superuser) leaves test queries
  // effectively RLS-bypassing. Matches prod behaviour where the backend
  // connects with the service-role key.
  await pglite.exec(`CREATE SCHEMA IF NOT EXISTS auth`);
  await pglite.exec(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
    LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')
    $$;
  `);

  // Supabase ships an `authenticated` role; pglite doesn't. Migration 0024
  // GRANTs table access to it (and the RLS-enforcement tests `SET ROLE` to
  // it), so create it here. NOLOGIN/NOINHERIT mirrors Supabase's definition.
  await pglite.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
      END IF;
    END $$;
  `);

  // Apply the migrations THE JOURNAL LISTS, in journal order — not every .sql
  // file on disk.
  //
  // Production runs drizzle's `migrate()`, which reads meta/_journal.json and
  // ignores anything not in it. This helper used to readdir the folder instead,
  // so a migration added without a journal entry ran here and NOT in
  // production: every test passed, the deploy came up, and the first request to
  // touch the new table got `relation "fleet_hosts" does not exist`. A test
  // database that is more permissive than production validates something
  // production will never do.
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf-8'),
  ) as { entries: { tag: string }[] };
  const migrationFiles = journal.entries.map((e) => `${e.tag}.sql`);

  for (const file of migrationFiles) {
    const full = path.join(MIGRATIONS_DIR, file);
    if (!fs.existsSync(full)) {
      // The journal naming a file that is not there is the mirror-image
      // mistake, and just as invisible if it were skipped quietly.
      throw new Error(
        `migration journal lists ${file} but it does not exist in ${MIGRATIONS_DIR}`,
      );
    }
    const sqlText = fs.readFileSync(full, 'utf-8');
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
