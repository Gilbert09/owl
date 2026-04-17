-- Row-level security. The backend always connects with the Supabase
-- service-role key, which bypasses RLS — our app-level owner_id filters
-- in the routes are the primary enforcement. These policies exist as
-- defense in depth: if anyone ever talks to this database with a user
-- JWT or the anon key (e.g. a future direct-from-client feature, or a
-- misconfigured admin query), they only see their own rows.
--
-- `settings` stays global (no RLS, no owner).
-- `backlog_items.items` nested under `backlog_sources` — reached via a
-- two-hop subquery so a single policy covers both paths.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "environments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "repositories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inbox_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "backlog_sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "backlog_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Top-level tables: owner_id matches caller.
CREATE POLICY "users_self" ON "users" FOR ALL
  USING (id = auth.uid()::text)
  WITH CHECK (id = auth.uid()::text);
--> statement-breakpoint
CREATE POLICY "workspaces_owner" ON "workspaces" FOR ALL
  USING (owner_id = auth.uid()::text)
  WITH CHECK (owner_id = auth.uid()::text);
--> statement-breakpoint
CREATE POLICY "environments_owner" ON "environments" FOR ALL
  USING (owner_id = auth.uid()::text)
  WITH CHECK (owner_id = auth.uid()::text);
--> statement-breakpoint

-- Workspace-scoped tables.
CREATE POLICY "repositories_workspace" ON "repositories" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
CREATE POLICY "integrations_workspace" ON "integrations" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
CREATE POLICY "tasks_workspace" ON "tasks" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
CREATE POLICY "agents_workspace" ON "agents" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
CREATE POLICY "inbox_items_workspace" ON "inbox_items" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
CREATE POLICY "backlog_sources_workspace" ON "backlog_sources" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
CREATE POLICY "backlog_items_workspace" ON "backlog_items" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
