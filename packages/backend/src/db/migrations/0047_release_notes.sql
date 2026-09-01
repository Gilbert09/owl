-- Release notes — the "What's new" feed.
--
-- One row per published release, written once by the publish workflow after
-- electron-builder has created the GitHub release, and read by every signed-in
-- client to decide whether to open the What's new modal.
--
-- No owner_id and no workspace_id: what shipped in 0.2.61 is the same fact for
-- everybody, so this is global content and the read route is mounted before
-- ownerScope. It is the one product table where RLS has nothing to filter.
--
-- `sort_key` exists because `?since=` is a range scan and versions do not sort
-- as text ("0.2.9" > "0.2.10"). It is versionSortKey() from @talyn/shared:
-- major*10^12 + minor*10^6 + patch. The 10^6 stride is load-bearing, not
-- cosmetic — Talyn ships a patch release every night, so a 10^3 stride would
-- collide inside three years. bigint because the result exceeds int4.
--
-- `highlights` may be an empty array. A nightly that carried nothing a user
-- would notice still gets a row: that is what keeps the `?since=` window
-- correct and stops CI re-summarising a version it has already looked at.
CREATE TABLE IF NOT EXISTS "release_notes" (
	"version" text PRIMARY KEY NOT NULL,
	"sort_key" bigint NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"highlights" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_release_notes_sort_key" ON "release_notes" USING btree ("sort_key");
--> statement-breakpoint
-- Defense in depth (0024/0025 pattern). The backend pool connects as the
-- privileged role, and both routes here run outside ownerScope, so this policy
-- is not what enforces access — it just means a JWT/anon connection that ever
-- reaches this table can read it and nothing more. Writes are the publish
-- workflow's alone, authenticated by TALYN_RELEASE_INGEST_SECRET, so the
-- `authenticated` role is granted SELECT only.
ALTER TABLE "release_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "release_notes_read" ON "release_notes" FOR SELECT USING (true);
--> statement-breakpoint
GRANT SELECT ON "release_notes" TO "authenticated";
