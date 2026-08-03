-- The operator console's audit trail.
--
-- admin.talyn.dev can drain a fleet host, cancel someone's run, comp an
-- account and grant admin. Until now `is_admin` gated a read-only debug panel;
-- it is about to gate revenue and privilege, and the only thing that makes
-- that defensible is being able to answer "who did this, when, and why"
-- afterwards. That question is the entire specification for this table.
--
-- Two shapes of write land here (services/admin/audit.ts):
--
--   * REMOTE mutations (fleetd drain/cancel/gc/pin/rebake) insert `pending`
--     BEFORE dialling out and settle to ok/error after. An HTTP call to
--     another machine cannot be rolled back, so the row has to exist before
--     the side effect does — if the backend dies mid-call the trail still
--     says "we were about to drain hetzner-64", which is the only question
--     anyone actually asks after an incident.
--
--   * LOCAL mutations (plan_override, is_admin, task retry/kill) write the
--     mutation and this row in ONE transaction. If the audit cannot be
--     written, the comp does not happen. That is the right posture for the
--     only mutations that move money and privilege.
CREATE TABLE IF NOT EXISTS "admin_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,

	-- No FK to users, and the email is denormalised, both on purpose: the
	-- trail must outlive an account wipe (DELETE /users/me cascades) and must
	-- still NAME a person after that person's row is gone. Same reasoning as
	-- billing_events.user_id in 0030.
	"actor_id" text NOT NULL,
	"actor_email" text NOT NULL,

	-- 'fleet.drain', 'user.plan_override', 'task.transcript.read', … The
	-- AdminAuditAction union in @talyn/shared is this column's contract.
	"action" text NOT NULL,
	-- host | run | golden | user | workspace | task
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,

	-- Required by every mutating route. A reason gate that does not persist
	-- the reason is theatre, so this is NOT NULL.
	"reason" text NOT NULL,

	-- The validated request body MINUS reason/confirm (they have their own
	-- column / are a UI gate, and duplicating them here just invites drift).
	"params" jsonb,
	-- Before/after state for local mutations. Null for remote ones — fleetd
	-- owns that state and we would be recording a guess.
	"before" jsonb,
	"after" jsonb,

	-- 'pending' | 'ok' | 'error'. A row stuck on 'pending' is itself the
	-- signal: we started something and never learned how it ended.
	"outcome" text NOT NULL,
	"error" text,
	"duration_ms" integer,

	"request_id" text,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
-- "What happened lately" — the console's default view.
CREATE INDEX IF NOT EXISTS "idx_admin_audit_at" ON "admin_audit_log" USING btree ("at" DESC);
--> statement-breakpoint
-- "What has this operator been doing" — the question asked about a
-- compromised or departing account.
CREATE INDEX IF NOT EXISTS "idx_admin_audit_actor" ON "admin_audit_log" USING btree ("actor_id","at" DESC);
--> statement-breakpoint
-- "Who has touched this host / user / run" — the question asked from a
-- detail page, and the one worth an index because it is read per-pageview.
CREATE INDEX IF NOT EXISTS "idx_admin_audit_target" ON "admin_audit_log" USING btree ("target_kind","target_id","at" DESC);
--> statement-breakpoint
-- Backend-pool-only surface: RLS enabled with NO policy and NO grant to
-- `authenticated` (the 0025 mcp_tokens / 0030 billing_events / 0038
-- fleet_hosts posture). Only the privileged pool role, which bypasses RLS,
-- touches this table. A JWT connection must never be able to read who comped
-- whom — and the API exposes no delete, so the trail is append-only from
-- outside the database.
ALTER TABLE "admin_audit_log" ENABLE ROW LEVEL SECURITY;
