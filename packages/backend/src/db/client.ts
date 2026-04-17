import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * The Drizzle query builder that every service/route consumes. Both the
 * real postgres-js client and the in-process pglite client used by tests
 * satisfy this shape.
 */
export type Database = PostgresJsDatabase<typeof schema>;

interface Handle {
  db: Database;
  /** Underlying connection. Only defined for real Postgres (postgres-js). */
  close: () => Promise<void>;
}

let singleton: Handle | null = null;

/**
 * Initialize a Drizzle client from a DATABASE_URL. Supabase's transaction-
 * mode pooler (port 6543, `pooler.supabase.com`) disables prepared statements,
 * so we detect that and pass `prepare: false` — otherwise every insert fails
 * with "prepared statement does not exist".
 */
function createPostgresHandle(connectionString: string): Handle {
  const url = new URL(connectionString);
  const isPooler = url.hostname.includes('pooler.supabase.com');
  const sql = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    prepare: !isPooler,
  });
  const db = drizzle(sql, { schema, casing: 'snake_case' }) as Database;
  return {
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * Get the process-wide Drizzle client, initializing it on first use. Throws
 * if `DATABASE_URL` isn't set — the backend cannot start without Postgres.
 */
export function getDbClient(): Database {
  if (singleton) return singleton.db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Point it at a Postgres (Supabase) instance.'
    );
  }
  singleton = createPostgresHandle(url);
  return singleton.db;
}

/**
 * Close the underlying Postgres connection. No-op for test-injected clients
 * (their lifecycle belongs to the test).
 */
export async function closeDbClient(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}

/**
 * Inject a Drizzle client for tests. The caller owns the connection — we
 * don't close it. Typically paired with `@electric-sql/pglite`.
 */
export function setDbClient(db: Database): void {
  singleton = { db, close: async () => {} };
}

/** Clear the process-wide client. Tests call this in afterEach/afterAll. */
export function resetDbClient(): void {
  singleton = null;
}
