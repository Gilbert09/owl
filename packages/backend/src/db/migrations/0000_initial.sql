CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"attention" text DEFAULT 'none' NOT NULL,
	"current_task_id" text,
	"terminal_output" text DEFAULT '' NOT NULL,
	"last_activity" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backlog_items" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"external_id" text NOT NULL,
	"text" text NOT NULL,
	"parent_external_id" text,
	"completed" boolean DEFAULT false NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"claimed_task_id" text,
	"order_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backlog_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"environment_id" text,
	"repository_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"config" jsonb NOT NULL,
	"last_connected" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'unread' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"source" jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb,
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"actioned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"local_path" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"prompt" text,
	"assigned_agent_id" text,
	"assigned_environment_id" text,
	"repository_id" text,
	"branch" text,
	"terminal_output" text DEFAULT '' NOT NULL,
	"result" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_current_task_id_tasks_id_fk" FOREIGN KEY ("current_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_source_id_backlog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."backlog_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_claimed_task_id_tasks_id_fk" FOREIGN KEY ("claimed_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_sources" ADD CONSTRAINT "backlog_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_sources" ADD CONSTRAINT "backlog_sources_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_sources" ADD CONSTRAINT "backlog_sources_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_environment_id_environments_id_fk" FOREIGN KEY ("assigned_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agents_environment" ON "agents" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_agents_workspace" ON "agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_backlog_items_source_external" ON "backlog_items" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "idx_backlog_items_source" ON "backlog_items" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_backlog_items_workspace" ON "backlog_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_backlog_items_claimed" ON "backlog_items" USING btree ("claimed_task_id");--> statement-breakpoint
CREATE INDEX "idx_backlog_sources_workspace" ON "backlog_sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_workspace" ON "inbox_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_status" ON "inbox_items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integrations_workspace_type" ON "integrations" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX "idx_repositories_workspace" ON "repositories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_workspace" ON "tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tasks_repository" ON "tasks" USING btree ("repository_id");