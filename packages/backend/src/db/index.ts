import path from 'path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { getDbClient, type Database } from './client.js';

/**
 * Resolve the absolute path to the Drizzle migrations folder. It ships at
 * `src/db/migrations` in source; compiled output preserves that layout under
 * `dist/db/migrations`. __dirname works for both `tsx` (dev) and `node` (prod).
 */
const MIGRATIONS_FOLDER = path.resolve(__dirname, 'migrations');

/**
 * Initialize the database: connect, run pending migrations, return the
 * Drizzle client. Every service/route consumes this return value.
 *
 * Throws if `DATABASE_URL` is unset or migrations fail — both are fatal
 * for boot so callers shouldn't try to recover.
 */
export async function initDatabase(): Promise<Database> {
  const db = getDbClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

export type { Database } from './client.js';
