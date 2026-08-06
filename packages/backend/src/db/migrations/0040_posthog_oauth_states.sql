-- In-flight PostHog OAuth authorization codes (PKCE).
--
-- The GitHub App flow keeps its pending states in a process-local Map. That is
-- survivable there because a lost state only costs the user a re-click, but it
-- is wrong for two reasons this table fixes: every deploy briefly runs old and
-- new instances at once (see services/advisoryLock.ts), so the browser can come
-- back to the instance that did NOT mint the state, and PKCE means the row now
-- holds the `code_verifier` — the thing that makes the returned code
-- redeemable. Losing that mid-flight turns a successful authorization into an
-- "invalid state, try again", every time the callback lands on the other
-- instance.
--
-- Rows are single-use (the callback DELETEs on redemption) and short-lived:
-- PostHog expires an authorization code after 5 minutes
-- (AUTHORIZATION_CODE_EXPIRE_SECONDS), so a state that outlives that window is
-- worthless. Nothing here is a long-term secret; the issued tokens land on the
-- `integrations` row, encrypted.
CREATE TABLE IF NOT EXISTS "posthog_oauth_states" (
  -- The opaque `state` parameter, and the whole CSRF defence: a callback whose
  -- state doesn't match a row we minted is refused before the code is spent.
  "state" text PRIMARY KEY,

  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- Who started the flow. The callback has no session (it is a browser redirect
  -- from PostHog), so this is the only record of whose consent this is, and it
  -- is what the auto-provisioned cloud environment gets attached to.
  "user_id" text NOT NULL,

  -- PKCE verifier. Encrypted at rest with the same envelope as every other
  -- credential (services/tokenCrypto.ts) rather than stored bare: on its own it
  -- is useless, but paired with a leaked authorization code it completes the
  -- exchange, and there is no reason for it to be readable.
  "code_verifier_enc" jsonb NOT NULL,

  -- The PostHog instance being authorized (us/eu cloud, or self-hosted). Pinned
  -- at start time so the token exchange cannot be pointed somewhere else by the
  -- callback, and so the resulting credentials record the host they belong to.
  "host" text NOT NULL,

  -- Which front end started the flow ('web' | 'desktop'), recorded server-side
  -- so it selects between "render a close-this-tab page" and "redirect to the
  -- WEB_APP_URL constant" — never a caller-supplied destination.
  "client" text NOT NULL DEFAULT 'desktop',

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- The sweep predicate. Expired rows are deleted opportunistically on each
-- start, so this keeps that from turning into a seq scan as the table churns.
CREATE INDEX IF NOT EXISTS "idx_posthog_oauth_states_expires_at"
  ON "posthog_oauth_states" ("expires_at");
--> statement-breakpoint
-- `POST /posthog/oauth/start` runs behind ownerScope, i.e. as the
-- `authenticated` role with RLS in force (db/scope.ts), so the standard
-- workspace-owner policy + GRANT are both required. Shipping the table
-- RLS-enabled with neither is what broke merge_queue_entries in 0033: the
-- `permission denied` aborts the request transaction and cascades 25P02 onto
-- every later query. The public callback runs on the pool role instead (no JWT
-- to scope by), which owns the table and so bypasses the policy.
GRANT SELECT, INSERT, DELETE ON "posthog_oauth_states" TO "authenticated";
--> statement-breakpoint
ALTER TABLE "posthog_oauth_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "posthog_oauth_states_workspace" ON "posthog_oauth_states" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
