import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let serviceClient: SupabaseClient | null = null;

/**
 * Backend Supabase client, using the service-role key. Bypasses RLS — every
 * query we fan out through Drizzle is already app-level scoped by owner_id,
 * and RLS is defense-in-depth for direct DB access.
 *
 * Used by the auth middleware to verify JWTs (`auth.getUser(token)`) and
 * in a few places that need to read `auth.users`.
 */
export function getSupabaseServiceClient(): SupabaseClient {
  if (serviceClient) return serviceClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Needed to verify auth tokens and upsert users.'
    );
  }

  serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}

/** Is Supabase configured (is auth available)? Used to fail fast at startup. */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Test-only hook so specs can inject a stubbed client. */
export function setSupabaseServiceClientForTesting(client: SupabaseClient | null): void {
  serviceClient = client;
}
