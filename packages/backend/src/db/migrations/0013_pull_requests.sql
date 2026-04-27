-- Pull-request DB-as-cache table. One row per user-authored open PR
-- in a watched repo, plus any PR ever opened by a task (kept after
-- merge/close for filtering).
--
-- last_polled_at drives the TTL the prCache layer enforces. Fresh row
-- → return it; stale → fetch via the batched GraphQL helper, upsert,
-- return.
--
-- Event-cursor columns survive backend restart so review/comment/CI
-- deltas don't false-fire after every deploy.

CREATE TABLE "pull_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"task_id" text,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"state" text NOT NULL,
	"merged_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_review_id" text,
	"last_review_comment_id" text,
	"last_comment_id" text,
	"last_check_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pull_requests_workspace_repo_number" ON "pull_requests" USING btree ("workspace_id","repository_id","number");
--> statement-breakpoint
CREATE INDEX "idx_pull_requests_workspace" ON "pull_requests" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "idx_pull_requests_repository" ON "pull_requests" USING btree ("repository_id");
--> statement-breakpoint
CREATE INDEX "idx_pull_requests_task" ON "pull_requests" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_pull_requests_state_last_polled" ON "pull_requests" USING btree ("state","last_polled_at");
--> statement-breakpoint
ALTER TABLE "pull_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pull_requests_workspace" ON "pull_requests" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
