import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type DrizzleClient = ReturnType<typeof createDrizzleClient>;

/**
 * Create a Drizzle-wrapped Postgres client from a DATABASE_URL.
 *
 * Uses `postgres-js` under the hood. We expose both the wrapped `db`
 * (query builder) and the raw `sql` handle so services that need
 * transactions, raw SQL, or connection lifecycle can reach for it.
 */
export function createDrizzleClient(connectionString: string) {
  const sql = postgres(connectionString, {
    // Conservative defaults for a single-instance backend. Revisit when
    // we scale horizontally.
    max: 10,
    idle_timeout: 20,
    // Supabase Postgres wants SSL; postgres-js picks it up from sslmode=
    // in the URL. If you pass an IP/hostname without sslmode, you'll
    // need to opt into `ssl: 'require'` here.
  });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return { db, sql, schema } as const;
}

let singleton: DrizzleClient | null = null;

/**
 * Get the process-wide Drizzle client. Initialized on first call from
 * `DATABASE_URL`. Throws if the env var is unset.
 */
export function getDbClient(): DrizzleClient {
  if (singleton) return singleton;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Point it at a Postgres (Supabase) instance.'
    );
  }
  singleton = createDrizzleClient(url);
  return singleton;
}

/** For tests that want to inject their own client. */
export function setDbClient(client: DrizzleClient): void {
  singleton = client;
}

/** For tests that need a clean slate. */
export function resetDbClient(): void {
  singleton = null;
}
